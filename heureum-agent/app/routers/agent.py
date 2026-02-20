# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Agent router - orchestrates the server-side agentic loop.

High-level loop:
  user input -> LLM response -> (optional) tool execution -> LLM response -> ...
"""

import asyncio
import atexit
import json
import logging
import time
import uuid
from collections.abc import MutableMapping
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

from app.config import ApprovalChoice, settings
from app.models import LLMResult, LLMResultType, Message, ToolCallInfo
from app.schemas.open_responses import (
    AssistantMessageItem,
    ErrorObject,
    ErrorType,
    FunctionToolCall,
    FunctionToolResult,
    ItemReferenceItem,
    ItemStatus,
    MessageItem,
    MessageRole,
    OutputTextContent,
    ReasoningItem,
    ResponseObject,
    ResponseRequest,
    ResponseStatus,
    Usage,
)
from app.services.agent_service import (
    AgentService,
    JudgeResult,
    build_tool_context,
    judge_response,
)
from app.services.loop_detection import clear_session_loop_state
from app.services.providers.mcp import MCPClient
from app.services.providers.skill import SkillProvider
from app.services.providers.tool import ToolChainRegistry
from app.services.subagent import get_registry as get_subagent_registry
from app.services.tool_hooks import hook_runner
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from langchain_core.messages import HumanMessage as _HM

logger = logging.getLogger(__name__)

router = APIRouter()

chain_registry = ToolChainRegistry()
skill_provider = SkillProvider()
mcp_client = MCPClient(chain_registry=chain_registry)
agent_service = AgentService(skill_provider=skill_provider)
_initialized = False
_init_lock = asyncio.Lock()
_session_loop_locks: Dict[str, asyncio.Lock] = {}


def _atexit_close_mcp() -> None:
    """Best-effort cleanup of MCP connections on process exit."""
    try:
        loop = asyncio.get_event_loop()
        if not loop.is_closed():
            loop.run_until_complete(mcp_client.close())
    except Exception:
        pass


atexit.register(_atexit_close_mcp)


def _get_loop_lock(session_id: str) -> asyncio.Lock:
    """Serialize full loop executions per session.

    The per-session lock guarantees that:
      1. Session history is appended in a deterministic order — concurrent
         requests for the same session cannot interleave tool-result writes.
      2. ``_active_chains`` in :class:`ToolChainRegistry` is accessed
         sequentially per session, preventing chain-step tracking races.

    The lock is intentionally coarse (one lock per session covering the
    entire agent loop).  Within a single lock acquisition, the pipelined
    tool executor (``_execute_tool_calls_pipelined``) achieves parallelism
    by running multiple tool calls concurrently via ``asyncio.wait``, so
    splitting the lock further would add complexity without measurable
    benefit.
    """
    return _session_loop_locks.setdefault(session_id, asyncio.Lock())


def _cleanup_stale_locks() -> None:
    """Remove per-session locks for evicted sessions and sweep stale subagent records."""
    sessions = getattr(agent_service, "sessions", None)
    if sessions is None or not isinstance(sessions, MutableMapping):
        return

    active_sessions = set(sessions.keys())
    stale = [
        sid
        for sid in _session_loop_locks
        if sid not in active_sessions and not _session_loop_locks[sid].locked()
    ]
    for sid in stale:
        _session_loop_locks.pop(sid, None)
        mcp_client.clear_session_state(sid)
        chain_registry.clear_session(sid)
        skill_provider.clear_session(sid)
        clear_session_loop_state(sid)

    # GC completed subagent registry entries and their deferred state
    try:
        get_subagent_registry().sweep_stale()
    except Exception:
        pass


_SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
}


def _sse_event(event: dict) -> str:
    """Format a dict as an SSE data line."""
    return f"data: {json.dumps(event)}\n\n"


def _sse_done() -> str:
    """Return the SSE stream terminator."""
    return "data: [DONE]\n\n"


async def _ensure_initialized() -> None:
    """Discover MCP tools once and cache tool schemas in AgentService."""
    global _initialized
    if _initialized:
        return

    async with _init_lock:
        if _initialized:
            return

        try:
            mcp_tools = await mcp_client.discover_tools()
            agent_service.mcp_tools = mcp_tools
            if mcp_tools:
                logger.info(
                    "MCP tools discovered: %s",
                    [t["function"]["name"] for t in mcp_tools],
                )
            # Initialise all skills (e.g. wire PlanSkill to MCP write tool)
            await skill_provider.startup(write_tool_fn=mcp_client.call_tool)
        except BaseException as e:
            logger.warning("MCP initialization failed (continuing without MCP tools): %s", e)
        _initialized = True


async def _execute_tool(
    name: str, arguments: Dict[str, Any], session_id: str = "", cwd: str = ""
) -> str:
    """Dispatch tool execution by name."""
    # Skill-owned tools
    if skill_provider.get_skill_for_tool(name) is not None:
        return await skill_provider.execute_tool(name, arguments, session_id)

    # MCP-discovered tools (filesystem, browser, etc.)
    if mcp_client.is_server_tool(name):
        return await mcp_client.call_tool(name, arguments, session_id=session_id, cwd=cwd)

    # Gracefully handle removed/unknown tools (e.g. stale sessions
    # referencing a tool that was since removed from the schema).
    return f"Error: Tool '{name}' is no longer available."


@router.post("/tools/execute")
async def execute_tool_endpoint(request: dict) -> dict:
    """Execute a single server tool and return the result.

    Called by the client to execute tools that run on the server side
    (MCP, session files, agent tools, etc.).
    """
    await _ensure_initialized()
    name = request.get("name", "")
    arguments = request.get("arguments", {})
    session_id = request.get("session_id", "")
    cwd = request.get("cwd", "")

    try:
        result = await _execute_tool(name, arguments, session_id=session_id, cwd=cwd)
        return {"output": result, "success": True}
    except NotImplementedError:
        return {"output": f"Error: unknown server tool '{name}'", "success": False}
    except Exception as e:
        logger.warning("Tool execution failed (%s): %s", name, e)
        return {"output": f"Error executing tool '{name}': {e}", "success": False}


def _parse_input(request: ResponseRequest) -> List[Message]:
    """Parse Open Responses input items into internal Message objects."""
    if isinstance(request.input, str):
        return [Message(role=MessageRole.USER, content=request.input)]

    messages: List[Message] = []
    for item in request.input:
        if isinstance(item, FunctionToolResult):
            messages.append(
                Message(
                    role=MessageRole.TOOL,
                    content=item.output,
                    tool_call_id=item.call_id,
                ),
            )
        elif isinstance(item, FunctionToolCall):
            # Handled separately by _parse_tool_call_echoes when needed.
            continue
        elif isinstance(item, (ReasoningItem, ItemReferenceItem)):
            continue
        elif isinstance(item, MessageItem):
            if isinstance(item.content, str):
                text = item.content
            else:
                text = "\n".join(cp.text for cp in item.content if hasattr(cp, "text"))
            messages.append(Message(role=item.role, content=text))
    return messages


def _parse_tool_call_echoes(request: ResponseRequest) -> Optional[Message]:
    """Rebuild an assistant tool-call message from echoed function_call items."""
    if isinstance(request.input, str):
        return None

    echoes = [item for item in request.input if isinstance(item, FunctionToolCall)]
    if not echoes:
        return None

    tool_calls = []
    for tc in echoes:
        try:
            args = json.loads(tc.arguments) if isinstance(tc.arguments, str) else tc.arguments
        except (json.JSONDecodeError, TypeError):
            args = {}
        tool_calls.append({"name": tc.name, "args": args, "id": tc.call_id})

    return Message(role=MessageRole.ASSISTANT, content="", tool_calls=tool_calls)


def _extract_session_id(request: ResponseRequest) -> str:
    """Extract session_id from metadata or generate a new one."""
    if request.metadata:
        sid = request.metadata.get("session_id")
        if sid:
            return sid
    return f"session_{uuid.uuid4().hex[:16]}"


def _extract_cwd(request: ResponseRequest) -> str:
    """Extract cwd from metadata (injected by platform proxy)."""
    if request.metadata:
        return request.metadata.get("cwd", "")
    return ""


def _text_output(
    text: str,
    status: ItemStatus = ItemStatus.COMPLETED,
) -> AssistantMessageItem:
    """Build an assistant message output item."""
    return AssistantMessageItem(
        id=f"msg_{uuid.uuid4().hex}",
        role=MessageRole.ASSISTANT,
        status=status,
        content=[OutputTextContent(text=text)],
    )


def _tool_call_output(
    name: str,
    arguments: dict,
    call_id: str,
    display_name: str | None = None,
) -> FunctionToolCall:
    """Build a function_call output item."""
    return FunctionToolCall(
        id=f"fc_{uuid.uuid4().hex}",
        call_id=call_id,
        name=name,
        arguments=json.dumps(arguments) if isinstance(arguments, dict) else arguments,
        status=ItemStatus.COMPLETED,
        display_name=display_name,
    )


def _build_response(
    output_items: list,
    status: ResponseStatus,
    session_id: str,
    created_at: int,
    model: str,
    error: ErrorObject | None = None,
    usage: Usage | None = None,
    **extra_metadata,
) -> ResponseObject:
    """Build a ResponseObject with normalized metadata/usage."""
    resolved_usage = usage or Usage.zero()

    meta: dict = {"session_id": session_id}
    tool_history = extra_metadata.pop("tool_history", None)
    if tool_history:
        meta["tool_history"] = [
            item.model_dump() if hasattr(item, "model_dump") else item for item in tool_history
        ]
    meta.update({k: v for k, v in extra_metadata.items() if v is not None})

    return ResponseObject(
        id=f"resp_{uuid.uuid4().hex}",
        created_at=created_at,
        completed_at=int(time.time()),
        model=model,
        status=status,
        output=output_items,
        usage=resolved_usage,
        error=error,
        metadata=meta,
    )


async def _safe_execute_tool(
    tc: ToolCallInfo, session_id: str = "", cwd: str = ""
) -> tuple[ToolCallInfo, str]:
    """Execute a single tool call and convert failures to readable tool output."""
    context = {"session_id": session_id, "tool_call_id": tc.id}

    # Before hooks
    hook_result = await hook_runner.run_before(tc.name, tc.args, context)
    if hook_result.blocked:
        return tc, f"Error: Tool blocked: {hook_result.reason}"
    params = hook_result.adjusted_params if hook_result.adjusted_params is not None else tc.args

    try:
        result = await _execute_tool(tc.name, params, session_id=session_id, cwd=cwd)
        if not result or (isinstance(result, str) and not result.strip()):
            result = f"[EMPTY_RESULT] {tc.name} returned no output. Consider retrying with different parameters."
        await hook_runner.run_after(tc.name, params, result, None, context)
        return tc, result
    except Exception as e:
        logger.warning("Tool execution failed (%s): %s", tc.name, e)
        err_str = f"Error executing tool '{tc.name}': {e}"
        await hook_runner.run_after(tc.name, params, None, str(e), context)
        return tc, err_str


async def _execute_tool_calls(
    tool_calls: List[ToolCallInfo],
    all_output_items: list,
    session_id: str = "",
    cwd: str = "",
) -> List[Message]:
    """Execute tool calls in parallel and append call/result items to history."""
    if not tool_calls:
        return []

    results = await asyncio.gather(
        *[_safe_execute_tool(tc, session_id=session_id, cwd=cwd) for tc in tool_calls]
    )

    tool_results: List[Message] = []
    for tc, result_str in results:
        tool_results.append(
            Message(
                role=MessageRole.TOOL,
                content=result_str,
                tool_call_id=tc.id,
                tool_name=tc.name,
            )
        )
        all_output_items.append(_tool_call_output(tc.name, tc.args, tc.id))
        all_output_items.append(
            FunctionToolResult(
                id=f"out_{uuid.uuid4().hex}",
                call_id=tc.id,
                output=result_str,
            )
        )
    return tool_results


def _make_tool_result_message(tc: ToolCallInfo, result_str: str) -> Message:
    """Build a tool-result Message from a completed tool call."""
    return Message(
        role=MessageRole.TOOL,
        content=result_str,
        tool_call_id=tc.id,
        tool_name=tc.name,
    )


def _append_tool_output_items(tc: ToolCallInfo, result_str: str, all_output_items: list) -> None:
    """Append FunctionToolCall + FunctionToolResult output items."""
    all_output_items.append(_tool_call_output(tc.name, tc.args, tc.id))
    all_output_items.append(
        FunctionToolResult(
            id=f"out_{uuid.uuid4().hex}",
            call_id=tc.id,
            output=result_str,
        )
    )


async def _execute_tool_calls_pipelined(
    tool_calls: List[ToolCallInfo],
    all_output_items: list,
    session_id: str,
    max_depth: int = 0,
    result_queue: Optional[asyncio.Queue] = None,
    cwd: str = "",
) -> Tuple[List[Message], List[ToolCallInfo]]:
    """Execute tool calls with pipelined chain follow-ups.

    Instead of waiting for *all* tools to finish before detecting chain
    follow-ups, this function uses ``asyncio.wait(FIRST_COMPLETED)`` so
    that each tool's result can immediately trigger chain follow-up calls.

    Follow-up calls that do *not* require approval are added to the
    in-flight task set immediately.  Calls that require approval are
    collected in a ``deferred_approval`` list and returned to the caller.

    Chain depth is tracked per in-flight tool call (hop count from the
    original tool), not per event-loop cycle.  This avoids completion-order
    races where late-finishing sibling calls lose their follow-ups.

    Args:
        tool_calls: Initial batch of tool calls.
        all_output_items: Mutable list for output items (modified in place).
        session_id: Current session ID.
        max_depth: Maximum chain depth (0 = use ``settings.MAX_CHAIN_DEPTH``).
        result_queue: If provided, each ``(tc, result_str)`` is put on the
            queue as soon as it completes (for streaming).

    Returns:
        ``(all_results, deferred_approval)`` — all result Messages and
        any chained calls that still need user approval.
    """
    if max_depth <= 0:
        max_depth = settings.MAX_CHAIN_DEPTH

    all_results: List[Message] = []
    deferred_approval: List[ToolCallInfo] = []

    # Map asyncio.Task -> (ToolCallInfo, hop_depth)
    pending: Dict[asyncio.Task, Tuple[ToolCallInfo, int]] = {
        asyncio.create_task(_safe_execute_tool(tc, session_id=session_id, cwd=cwd)): (
            tc,
            0,
        )
        for tc in tool_calls
    }

    while pending:
        done, _ = await asyncio.wait(pending.keys(), return_when=asyncio.FIRST_COMPLETED)

        for task in done:
            _tc_orig, hop_depth = pending.pop(task)
            tc_done, result_str = task.result()

            msg = _make_tool_result_message(tc_done, result_str)
            all_results.append(msg)
            _append_tool_output_items(tc_done, result_str, all_output_items)

            if result_queue is not None:
                await result_queue.put((tc_done, result_str))

            # Detect chain follow-ups for this single result.
            # Chain follow-ups bypass approval — the user already approved
            # the source tool, implicitly authorizing its chain steps.
            if hop_depth < max_depth:
                follow_ups = chain_registry.build_per_result(
                    tc_done,
                    msg,
                    session_id=session_id,
                )
                for fu in follow_ups:
                    pending[
                        asyncio.create_task(_safe_execute_tool(fu, session_id=session_id, cwd=cwd))
                    ] = (fu, hop_depth + 1)

    if result_queue is not None:
        await result_queue.put(None)  # sentinel

    return all_results, deferred_approval


async def _handle_chained_calls(
    chained: List[ToolCallInfo],
    session_id: str,
    created_at: int,
    model: str,
    total_usage: Usage,
    tool_call_count: int,
    all_output_items: list,
    iteration: int | None = None,
    cwd: str = "",
) -> ResponseObject | None:
    """Execute or gate chained calls, looping through follow-up chains.

    After executing a batch of chained calls, the results are fed back into
    ``chain_registry.build()`` to detect further chain steps.  This loop
    continues up to ``MAX_CHAIN_DEPTH`` times, ensuring multi-step chains
    run to completion without returning to the LLM between steps.

    Returns an approval response if any tool in a batch requires user
    approval; otherwise returns ``None`` after all chain steps complete.
    """
    current = chained
    for _ in range(settings.MAX_CHAIN_DEPTH):
        if not current:
            break

        # Chain follow-ups bypass approval — the source tool's approval
        # implicitly authorizes all steps in the chain.
        chain_results = await _execute_tool_calls(
            current, all_output_items, session_id=session_id, cwd=cwd
        )
        await agent_service.append_tool_interaction(
            session_id,
            [],
            [tc.model_dump() for tc in current],
            chain_results,
        )

        # Check for further chain steps from the results just produced.
        current = chain_registry.build(current, chain_results, session_id=session_id)

    return None


async def _handle_approval_continuation(
    session_id: str,
    messages: List[Message],
    all_output_items: list,
    created_at: int,
    model: str,
    total_usage: Usage,
    tool_call_count: int,
    cwd: str = "",
) -> tuple[ResponseObject | None, List[Message], int, Usage]:
    """Handle approval answer from previous INCOMPLETE response, if present."""
    approval_result = mcp_client.handle_approval_response(session_id, messages)
    if not approval_result:
        return None, messages, tool_call_count, total_usage

    pending_tcs = approval_result["tool_calls"]
    messages = approval_result["filtered_messages"]
    tool_call_dicts = [tc.model_dump() for tc in pending_tcs]

    if approval_result["usage"]:
        total_usage = total_usage.add(approval_result["usage"])

    if approval_result["decision"] in (
        ApprovalChoice.ALLOW_ONCE.decision,
        ApprovalChoice.ALWAYS_ALLOW.decision,
    ):
        tool_results = await _execute_tool_calls(
            pending_tcs, all_output_items, session_id=session_id, cwd=cwd
        )
        tool_call_count += len(tool_results)
    else:
        tool_results = [
            Message(
                role=MessageRole.TOOL,
                content=f"Permission denied by user for tool: {tc.name}",
                tool_call_id=tc.id,
                tool_name=tc.name,
            )
            for tc in pending_tcs
        ]

    await agent_service.append_tool_interaction(
        session_id,
        approval_result["input_messages"],
        tool_call_dicts,
        tool_results,
        usage=approval_result["usage"].model_dump() if approval_result["usage"] else {},
        assistant_lc_message=approval_result.get("assistant_lc_message"),
    )

    remaining = approval_result.get("remaining_chained", [])
    if remaining:
        chain_resp = await _handle_chained_calls(
            remaining,
            session_id,
            created_at,
            model,
            total_usage,
            tool_call_count,
            all_output_items,
            cwd=cwd,
        )
        if chain_resp:
            return chain_resp, [], tool_call_count, total_usage

    chained = chain_registry.build(pending_tcs, tool_results, session_id=session_id)
    if chained:
        chain_resp = await _handle_chained_calls(
            chained,
            session_id,
            created_at,
            model,
            total_usage,
            tool_call_count,
            all_output_items,
            cwd=cwd,
        )
        if chain_resp:
            return chain_resp, [], tool_call_count, total_usage

    return None, [], tool_call_count, total_usage


def _prepare_messages_for_session(
    request: ResponseRequest,
    session_id: str,
    messages: List[Message],
) -> List[Message]:
    """Normalize incoming messages for new-turn vs continuation semantics."""
    history = agent_service.get_history(session_id)

    if not history:
        echo_msg = _parse_tool_call_echoes(request)
        if echo_msg:
            non_tool = [m for m in messages if m.role != MessageRole.TOOL]
            tool_results = [m for m in messages if m.role == MessageRole.TOOL]
            messages = non_tool + [echo_msg] + tool_results
            logger.info(
                "Recovered %d tool call echo(es) for session %s",
                len(echo_msg.tool_calls or []),
                session_id,
            )
        return messages

    tool_results = [m for m in messages if m.role == MessageRole.TOOL]
    if tool_results:
        for tr in tool_results:
            if isinstance(agent_service, AgentService):
                agent_service.replace_tool_result(
                    session_id=session_id,
                    tool_call_id=tr.tool_call_id or "",
                    output=tr.content,
                    tool_name=tr.tool_name,
                )
            else:
                # Test/mocked service fallback.
                for i, h in enumerate(history):
                    if h.role == MessageRole.TOOL and h.tool_call_id == tr.tool_call_id:
                        history[i] = tr
                        break
        return []

    history_set = {(m.role, m.content) for m in history}
    return [m for m in messages if (m.role, m.content) not in history_set]


def _resolve_tools(
    request: ResponseRequest,
) -> Tuple[List[str], List[dict], Set[str], List[str], Dict[str, str]]:
    """Resolve tool names, schemas, client tool names, guides, and display names.

    Returns:
        (tool_names, client_tool_schemas, client_tool_names, client_tool_prompts, display_names)
    """
    client_tool_names: Set[str] = set()
    client_tool_schemas: List[dict] = []
    tool_names: List[str] = []
    client_tool_prompts: List[str] = []
    display_names: Dict[str, str] = {}

    if request.tools:
        for t in request.tools:
            client_tool_names.add(t.function.name)
            tool_names.append(t.function.name)
            client_tool_schemas.append(
                t.model_dump(exclude_none=True, exclude={"guide", "display_name"})
            )
            if t.guide:
                client_tool_prompts.append(t.guide)
            if t.display_name:
                display_names[t.function.name] = t.display_name

    # MCP tools (includes filesystem tools discovered dynamically)
    for name in mcp_client.server_tool_names:
        if name not in client_tool_names:
            tool_names.append(name)
    # Always include skill-owned tools
    for name in skill_provider.get_all_tool_names():
        if name not in tool_names:
            tool_names.append(name)

    # MCP display names
    display_names.update(mcp_client.display_names)
    # Skill display names
    display_names.update(skill_provider.display_names)

    return (
        tool_names,
        client_tool_schemas,
        client_tool_names,
        client_tool_prompts,
        display_names,
    )


@dataclass
class _LoopContext:
    request: ResponseRequest
    created_at: int
    session_id: str
    model: str
    messages: List[Message]
    tool_names: List[str]
    client_tool_schemas: List[dict] = field(default_factory=list)
    client_tool_names: Set[str] = field(default_factory=set)
    client_tool_prompts: List[str] = field(default_factory=list)
    display_names: Dict[str, str] = field(default_factory=dict)
    total_usage: Usage = field(default_factory=Usage.zero)
    tool_call_count: int = 0
    output_items: list = field(default_factory=list)
    eval_retry_count: int = 0
    cwd: str = ""


def is_tool_error(output: str) -> bool:
    """Detect tool execution failure from output string."""
    if not output:
        return False
    return (
        "Error executing tool '" in output
        or "[EMPTY_RESULT]" in output
        or output.startswith("Error:")
        or output.startswith("Error calling ")
    )


@dataclass
class _ToolCallRecord:
    """A single tool call with its success/failure status."""

    name: str
    succeeded: bool


class _LoopStateBuilder:
    """Builds a <loop_progress> XML block for LLM loop-state awareness."""

    @staticmethod
    def _extract_recent_tools(output_items: list, limit: int = 5) -> list[_ToolCallRecord]:
        """Extract recent tool call records from output items.

        Walks backwards through output_items pairing FunctionToolCall with
        its FunctionToolResult to determine success/failure.
        """
        records: list[_ToolCallRecord] = []
        # Build call_id -> name mapping and result mapping
        call_names: dict[str, str] = {}
        result_status: dict[str, bool] = {}

        for item in output_items:
            if isinstance(item, FunctionToolCall) and item.call_id:
                call_names[item.call_id] = item.name
            elif isinstance(item, FunctionToolResult) and item.call_id:
                output = item.output or ""
                failed = is_tool_error(output)
                result_status[item.call_id] = not failed

        # Collect in order, take last N
        for item in output_items:
            if isinstance(item, FunctionToolCall) and item.call_id:
                succeeded = result_status.get(item.call_id, True)
                records.append(_ToolCallRecord(name=item.name, succeeded=succeeded))

        return records[-limit:]

    @staticmethod
    def build(
        iteration: int,
        max_iterations: int,
        tool_call_count: int,
        output_items: list,
        total_usage: "Usage",
    ) -> str:
        """Build the <loop_progress> XML string for system prompt injection."""
        recent = _LoopStateBuilder._extract_recent_tools(output_items)

        lines = ["<loop_progress>"]
        lines.append(f"  iteration: {iteration}/{max_iterations}")
        lines.append(f"  tools_called: {tool_call_count}")

        if recent:
            lines.append("  recent_tools:")
            for rec in recent:
                status = "ok" if rec.succeeded else "FAILED"
                lines.append(f"    - {rec.name}: {status}")

        lines.append(
            f"  tokens_used: in={total_usage.input_tokens} out={total_usage.output_tokens}"
        )

        remaining = max_iterations - iteration
        if remaining <= 5:
            lines.append(
                f"  warning: only {remaining} iteration(s) remaining, prioritize completing the task"
            )
        if tool_call_count > 20:
            lines.append(
                "  note: high tool call count, consider whether you are making efficient progress"
            )

        lines.append("</loop_progress>")
        return "\n".join(lines)


# Prefixes used by skill retry guidance — not real user queries.
_GUIDANCE_PREFIXES = (
    "You tried to respond without finishing the plan",
    "Continue the plan.",
    "The previous response was inadequate",
    "The user's original request:",
)


def _extract_last_user_query(session_id: str) -> str:
    """Extract the most recent *real* user message from session history.

    Skips injected retry guidance messages (skill or judge) so the judge
    evaluates against the original user intent.
    """
    history = agent_service.get_history(session_id)
    for msg in reversed(history):
        if msg.role == MessageRole.USER and msg.content:
            if any(msg.content.startswith(p) for p in _GUIDANCE_PREFIXES):
                continue
            return msg.content
    return ""


async def _judge_current_response(
    llm,
    session_id: str,
    response_text: str,
    output_items: list,
) -> JudgeResult:
    """Run LLM-as-judge on the current response.

    Extracts user query from session history and builds tool context
    from output_items, then delegates to the evaluation module.
    """
    user_query = _extract_last_user_query(session_id)
    tool_ctx = build_tool_context(output_items)
    return await judge_response(llm, user_query, response_text, tool_ctx)


class _AgentLoopRunner:
    """Single-request loop runner with minimal state transitions."""

    def __init__(self, ctx: _LoopContext) -> None:
        self.ctx = ctx
        self._original_instructions = ctx.request.instructions

    async def run(self) -> ResponseObject:
        if not self.ctx.tool_names:
            return await self._run_text_only()

        async with _get_loop_lock(self.ctx.session_id):
            approval_response = await self._resume_pending_approval()
            if approval_response:
                return approval_response
            return await self._run_tool_iterations()

    async def _run_text_only(self) -> ResponseObject:
        resp = await agent_service.process_messages(
            messages=self.ctx.messages,
            session_id=self.ctx.session_id,
            instructions=self.ctx.request.instructions,
        )
        if resp.usage:
            self.ctx.total_usage = self.ctx.total_usage.add(resp.usage)
        return _build_response(
            [_text_output(resp.message)],
            ResponseStatus.COMPLETED,
            resp.session_id,
            self.ctx.created_at,
            self.ctx.model,
            usage=self.ctx.total_usage,
        )

    async def _resume_pending_approval(self) -> ResponseObject | None:
        resp, messages, tool_call_count, total_usage = await _handle_approval_continuation(
            self.ctx.session_id,
            self.ctx.messages,
            self.ctx.output_items,
            self.ctx.created_at,
            self.ctx.model,
            self.ctx.total_usage,
            self.ctx.tool_call_count,
            cwd=self.ctx.cwd,
        )
        self.ctx.messages = messages
        self.ctx.tool_call_count = tool_call_count
        self.ctx.total_usage = total_usage
        return resp

    def _get_instructions(self) -> str | None:
        """Return user-provided instructions (without runtime state)."""
        return self._original_instructions or None

    def _get_state_prompts(self, iteration: int = 1) -> list[str] | None:
        """Return per-turn runtime state prompts from active skills + loop state."""
        prompts = skill_provider.get_state_prompts(self.ctx.session_id)
        if prompts is None:
            prompts = []
        prompts.append(
            _LoopStateBuilder.build(
                iteration=iteration,
                max_iterations=settings.MAX_AGENT_ITERATIONS,
                tool_call_count=self.ctx.tool_call_count,
                output_items=self.ctx.output_items,
                total_usage=self.ctx.total_usage,
            )
        )
        return prompts or None

    async def _run_tool_iterations(self) -> ResponseObject:
        skill_provider.clear_completed_plans(self.ctx.session_id)
        for iteration in range(1, settings.MAX_AGENT_ITERATIONS + 1):
            result = await agent_service.process_messages_with_tools(
                messages=self.ctx.messages,
                session_id=self.ctx.session_id,
                instructions=self._get_instructions(),
                client_tool_schemas=self.ctx.client_tool_schemas,
                client_tool_prompts=self.ctx.client_tool_prompts,
                state_prompts=self._get_state_prompts(iteration=iteration),
            )
            self.ctx.session_id = result.session_id
            if result.usage:
                self.ctx.total_usage = self.ctx.total_usage.add(result.usage)

            if result.type == LLMResultType.TEXT:
                if skill_provider.has_unfinished_work(self.ctx.session_id):
                    # Wait for async skill work (e.g. sub-agents) to complete
                    # so their results are appended to session history.
                    await skill_provider.await_pending(self.ctx.session_id)

                    # After awaiting, check again — if all work finished,
                    # fall through to normal text handling with results in history.
                    if skill_provider.has_unfinished_work(self.ctx.session_id):
                        # Still unfinished (e.g. plan steps) — inject guidance
                        abandoned_text = result.text or ""
                        agent_service._append_to_history(
                            self.ctx.session_id,
                            self.ctx.messages,
                            abandoned_text,
                            usage=result.usage.model_dump() if result.usage else {},
                        )
                        guidance = skill_provider.build_retry_guidance(
                            self.ctx.session_id,
                            abandoned_text,
                        )
                        self.ctx.messages = [
                            Message(
                                role=MessageRole.USER,
                                content=guidance or "Continue the plan.",
                            ),
                        ]
                        continue

                    # Sub-agents completed — results are now in history.
                    # Re-run LLM so it can synthesize the sub-agent results.
                    abandoned_text = result.text or ""
                    agent_service._append_to_history(
                        self.ctx.session_id,
                        self.ctx.messages,
                        abandoned_text,
                        usage=result.usage.model_dump() if result.usage else {},
                    )
                    self.ctx.messages = [
                        Message(
                            role=MessageRole.USER,
                            content=(
                                "All sub-agents have completed. Their results have been appended to the conversation. "
                                "Please synthesize the results and provide a comprehensive response to the user."
                            ),
                        ),
                    ]
                    continue

                # Priority 2: LLM-as-judge quality gate
                if (
                    settings.ENABLE_SELF_EVALUATION
                    and self.ctx.tool_call_count > 0
                    and self.ctx.eval_retry_count < settings.MAX_EVAL_RETRIES
                ):
                    judge_result = await _judge_current_response(
                        llm=agent_service.llm,
                        session_id=self.ctx.session_id,
                        response_text=result.text or "",
                        output_items=self.ctx.output_items,
                    )
                    if not judge_result.passed:
                        self.ctx.eval_retry_count += 1
                        failed_text = result.text or ""
                        agent_service._append_to_history(
                            self.ctx.session_id,
                            self.ctx.messages,
                            failed_text,
                            usage=result.usage.model_dump() if result.usage else {},
                        )
                        user_query = _extract_last_user_query(self.ctx.session_id)
                        guidance = judge_result.guidance or "The previous response was inadequate."
                        retry_msg = (
                            f"The user's original request: {user_query}\n\n"
                            f"Your previous response was rejected: {failed_text[:500]}\n\n"
                            f"Feedback: {guidance}\n\n"
                            "Please try again with alternative approaches."
                        )
                        self.ctx.messages = [
                            Message(role=MessageRole.USER, content=retry_msg),
                        ]
                        continue

                return _build_response(
                    [_text_output(result.text)],
                    ResponseStatus.COMPLETED,
                    self.ctx.session_id,
                    self.ctx.created_at,
                    self.ctx.model,
                    usage=self.ctx.total_usage,
                    iterations=iteration,
                    tool_call_count=self.ctx.tool_call_count,
                    tool_history=self.ctx.output_items or None,
                )

            # Skills signal all work done — drop extra tool calls.
            # Only on iteration > 1 so stale completed plans from prior
            # requests don't block new tool calls (e.g. approval dialogs).
            if iteration > 1 and skill_provider.should_force_text_only(self.ctx.session_id):
                text = ""
                if result.assistant_lc_message:
                    text = agent_service._extract_text(result.assistant_lc_message.content)
                agent_service._append_to_history(
                    self.ctx.session_id,
                    self.ctx.messages,
                    text or "Task completed.",
                    usage=result.usage.model_dump() if result.usage else {},
                )
                return _build_response(
                    [_text_output(text or "Task completed.")],
                    ResponseStatus.COMPLETED,
                    self.ctx.session_id,
                    self.ctx.created_at,
                    self.ctx.model,
                    usage=self.ctx.total_usage,
                    iterations=iteration,
                    tool_call_count=self.ctx.tool_call_count,
                )

            response = await self._handle_tool_call_iteration(result, iteration)
            if response:
                return response

            self.ctx.messages = []

        return _build_response(
            [
                _text_output(
                    f"Reached maximum iterations ({settings.MAX_AGENT_ITERATIONS}).",
                    status=ItemStatus.INCOMPLETE,
                )
            ],
            ResponseStatus.INCOMPLETE,
            self.ctx.session_id,
            self.ctx.created_at,
            self.ctx.model,
            usage=self.ctx.total_usage,
            iterations=settings.MAX_AGENT_ITERATIONS,
            tool_call_count=self.ctx.tool_call_count,
            tool_history=self.ctx.output_items or None,
        )

    async def _handle_tool_call_iteration(
        self, result: Any, iteration: int
    ) -> ResponseObject | None:
        all_tool_calls = result.tool_calls or []
        client_calls, server_calls = mcp_client.classify_tool_calls(
            all_tool_calls,
            self.ctx.session_id,
            client_tool_names=self.ctx.client_tool_names,
        )

        skill_tool_names = skill_provider.get_all_tool_names()
        unsupported = [
            tc
            for tc in server_calls
            if not mcp_client.is_server_tool(tc.name)
            and tc.name not in skill_tool_names
            and not mcp_client.needs_approval(tc.name, self.ctx.session_id)
        ]
        if unsupported:
            # Return error results for unsupported tools so the LLM can
            # recover and try an available tool on the next iteration.
            error_results: list[Message] = []
            for tc in unsupported:
                error_msg = f"Error: Tool '{tc.name}' is not available. Use only the tools provided in the system prompt."
                error_result = _make_tool_result_message(tc, error_msg)
                error_results.append(error_result)
                self.ctx.messages.append(error_result)
                _append_tool_output_items(tc, error_msg, self.ctx.output_items)
            server_calls = [tc for tc in server_calls if tc not in unsupported]
            if not server_calls and not client_calls:
                # Persist the failed interaction to session history so the
                # LLM sees the error on the next iteration and can recover
                # (e.g. suggest setting CWD or use a different approach).
                await agent_service.append_tool_interaction(
                    self.ctx.session_id,
                    self.ctx.messages,
                    [tc.model_dump() for tc in all_tool_calls],
                    error_results,
                    usage=result.usage.model_dump() if result.usage else {},
                    assistant_lc_message=result.assistant_lc_message,
                )
                self.ctx.messages = []
                return None

        if any(mcp_client.needs_approval(tc.name, self.ctx.session_id) for tc in server_calls):
            info = mcp_client.request_approval(
                server_calls,
                self.ctx.session_id,
                result.usage,
                self.ctx.messages,
                assistant_lc_message=result.assistant_lc_message,
            )
            return _build_response(
                [
                    _tool_call_output(
                        "tool_approval",
                        info["question"],
                        info["approval_call_id"],
                        display_name=info["display_name"],
                    )
                ],
                ResponseStatus.INCOMPLETE,
                self.ctx.session_id,
                self.ctx.created_at,
                self.ctx.model,
                usage=self.ctx.total_usage,
                iterations=iteration,
                tool_call_count=self.ctx.tool_call_count,
                tool_history=self.ctx.output_items or None,
            )

        # Pipelined execution: run server tools and follow chain steps
        # as results arrive (FIRST_COMPLETED), instead of waiting for all.
        pipeline_results, deferred_approval = await _execute_tool_calls_pipelined(
            server_calls,
            self.ctx.output_items,
            session_id=self.ctx.session_id,
            cwd=self.ctx.cwd,
        )
        self.ctx.tool_call_count += len(pipeline_results) + len(client_calls)

        # Append client-side tool placeholders for the LLM history
        for tc in client_calls:
            pipeline_results.append(
                Message(
                    role=MessageRole.TOOL,
                    content=json.dumps(tc.args),
                    tool_call_id=tc.id,
                    tool_name=tc.name,
                )
            )

        # Record the original LLM tool-call turn (client + server together)
        await agent_service.append_tool_interaction(
            self.ctx.session_id,
            self.ctx.messages,
            [tc.model_dump() for tc in all_tool_calls],
            pipeline_results,
            usage=result.usage.model_dump(),
            assistant_lc_message=result.assistant_lc_message,
        )

        # Handle any chained calls that need user approval
        if deferred_approval:
            chain_resp = await _handle_chained_calls(
                deferred_approval,
                self.ctx.session_id,
                self.ctx.created_at,
                self.ctx.model,
                self.ctx.total_usage,
                self.ctx.tool_call_count,
                self.ctx.output_items,
                iteration=iteration,
                cwd=self.ctx.cwd,
            )
            if chain_resp:
                return chain_resp

        if client_calls:
            client_output = [_tool_call_output(tc.name, tc.args, tc.id) for tc in client_calls]
            return _build_response(
                client_output,
                ResponseStatus.INCOMPLETE,
                self.ctx.session_id,
                self.ctx.created_at,
                self.ctx.model,
                usage=self.ctx.total_usage,
                iterations=iteration,
                tool_call_count=self.ctx.tool_call_count,
                tool_history=self.ctx.output_items or None,
            )

        return None

    async def stream(self):
        """Async generator yielding SSE-formatted event strings."""
        response_id = f"resp_{uuid.uuid4().hex}"

        yield _sse_event(
            {
                "type": "response.created",
                "response": {
                    "id": response_id,
                    "status": "in_progress",
                    "model": self.ctx.model,
                    "created_at": self.ctx.created_at,
                    "metadata": {"session_id": self.ctx.session_id},
                },
            }
        )

        try:
            if not self.ctx.tool_names:
                async for event in self._stream_text_only():
                    yield event
            else:
                async with _get_loop_lock(self.ctx.session_id):
                    items_before = len(self.ctx.output_items)
                    approval_response = await self._resume_pending_approval()

                    # Emit SSE events for tools executed during approval
                    for item in self.ctx.output_items[items_before:]:
                        if isinstance(item, FunctionToolCall) and item.name != "tool_approval":
                            item_data: Dict[str, Any] = {
                                "call_id": item.call_id,
                                "name": item.name,
                                "arguments": (
                                    item.arguments
                                    if isinstance(item.arguments, str)
                                    else json.dumps(item.arguments)
                                ),
                            }
                            dn = self.ctx.display_names.get(item.name)
                            if dn:
                                item_data["display_name"] = dn
                            yield _sse_event(
                                {
                                    "type": "response.function_call.done",
                                    "item": item_data,
                                }
                            )
                        elif isinstance(item, FunctionToolResult):
                            yield _sse_event(
                                {
                                    "type": "response.tool_result.done",
                                    "call_id": item.call_id,
                                    "output": item.output,
                                    "status": (
                                        "failed"
                                        if is_tool_error(item.output or "")
                                        else "completed"
                                    ),
                                }
                            )

                    if approval_response:
                        evt = (
                            "response.completed"
                            if approval_response.status == ResponseStatus.COMPLETED
                            else "response.incomplete"
                        )
                        yield _sse_event(
                            {
                                "type": evt,
                                "response": approval_response.model_dump(mode="json"),
                            }
                        )
                    else:
                        async for event in self._stream_tool_iterations():
                            yield event
        except Exception as e:
            logger.exception("Streaming agent loop error")
            error_response = _build_response(
                [],
                ResponseStatus.FAILED,
                self.ctx.session_id,
                self.ctx.created_at,
                self.ctx.model,
                error=ErrorObject(type=ErrorType.SERVER_ERROR, message=str(e)),
            )
            yield _sse_event(
                {
                    "type": "response.failed",
                    "response": error_response.model_dump(mode="json"),
                }
            )

        yield _sse_done()

    async def _stream_llm_and_accumulate(self, use_tools: bool = True, iteration: int = 1):
        """Stream LLM chunks, yielding text deltas and returning accumulated result."""
        accumulated = None

        async for chunk in agent_service.stream_messages_with_tools(
            messages=self.ctx.messages,
            session_id=self.ctx.session_id,
            instructions=self.ctx.request.instructions,
            client_tool_schemas=self.ctx.client_tool_schemas if use_tools else None,
            client_tool_prompts=self.ctx.client_tool_prompts if use_tools else None,
            state_prompts=self._get_state_prompts(iteration=iteration),
        ):
            delta = agent_service._extract_text(chunk.content) if chunk.content else ""
            if delta:
                yield ("delta", delta)
            accumulated = chunk if accumulated is None else accumulated + chunk

        yield ("done", accumulated)

    async def _stream_text_only(self):
        """Stream a text-only LLM response (no tools)."""
        accumulated = None

        async for tag, value in self._stream_llm_and_accumulate(use_tools=False):
            if tag == "delta":
                yield _sse_event({"type": "response.output_text.delta", "delta": value})
            elif tag == "done":
                accumulated = value

        full_text = agent_service._extract_text(accumulated.content) if accumulated else ""
        usage = agent_service._extract_usage(accumulated) if accumulated else Usage.zero()

        if accumulated:
            self.ctx.total_usage = self.ctx.total_usage.add(usage)
            agent_service._append_to_history(
                self.ctx.session_id,
                self.ctx.messages,
                full_text,
                usage=usage.model_dump(),
                assistant_lc_message=accumulated,
            )

        yield _sse_event(
            {
                "type": "response.output_text.done",
                "text": full_text,
                "usage": usage.model_dump(),
            }
        )

        response = _build_response(
            [_text_output(full_text)],
            ResponseStatus.COMPLETED,
            self.ctx.session_id,
            self.ctx.created_at,
            self.ctx.model,
            usage=self.ctx.total_usage,
        )
        yield _sse_event(
            {
                "type": "response.completed",
                "response": response.model_dump(mode="json"),
            }
        )

    async def _stream_tool_iterations(self):
        """Stream the tool iteration loop, yielding SSE events."""
        skill_provider.clear_completed_plans(self.ctx.session_id)
        for iteration in range(1, settings.MAX_AGENT_ITERATIONS + 1):
            # Inject current TODO state into instructions for this iteration
            self.ctx.request.instructions = self._get_instructions()

            accumulated = None

            async for tag, value in self._stream_llm_and_accumulate(
                use_tools=True, iteration=iteration
            ):
                if tag == "delta":
                    yield _sse_event({"type": "response.output_text.delta", "delta": value})
                elif tag == "done":
                    accumulated = value

            if not accumulated:
                break

            usage = agent_service._extract_usage(accumulated)
            self.ctx.total_usage = self.ctx.total_usage.add(usage)

            if not getattr(accumulated, "tool_calls", None):
                # TEXT result — check if any skill has unfinished work
                if skill_provider.has_unfinished_work(self.ctx.session_id):
                    # Wait for async skill work (e.g. sub-agents) to complete
                    yield _sse_event(
                        {
                            "type": "response.output_text.abandoned",
                            "reason": "awaiting_subagents",
                        }
                    )
                    await skill_provider.await_pending(self.ctx.session_id)

                    # After awaiting, check again
                    if skill_provider.has_unfinished_work(self.ctx.session_id):
                        # Still unfinished (e.g. plan steps) — inject guidance
                        partial_text = agent_service._extract_text(accumulated.content)
                        agent_service._append_to_history(
                            self.ctx.session_id,
                            self.ctx.messages,
                            partial_text,
                            usage=usage.model_dump(),
                            assistant_lc_message=accumulated,
                        )
                        guidance = skill_provider.build_retry_guidance(
                            self.ctx.session_id,
                            partial_text,
                        )
                        self.ctx.messages = [
                            Message(
                                role=MessageRole.USER,
                                content=guidance or "Continue the plan.",
                            ),
                        ]
                        yield _sse_event(
                            {
                                "type": "response.output_text.abandoned",
                                "reason": "unfinished_skill",
                            }
                        )
                        continue

                    # Sub-agents completed — results are now in history.
                    partial_text = agent_service._extract_text(accumulated.content)
                    agent_service._append_to_history(
                        self.ctx.session_id,
                        self.ctx.messages,
                        partial_text,
                        usage=usage.model_dump(),
                        assistant_lc_message=accumulated,
                    )
                    self.ctx.messages = [
                        Message(
                            role=MessageRole.USER,
                            content=(
                                "All sub-agents have completed. Their results have been appended to the conversation. "
                                "Please synthesize the results and provide a comprehensive response to the user."
                            ),
                        ),
                    ]
                    continue

                # Priority 2: LLM-as-judge quality gate
                full_text = agent_service._extract_text(accumulated.content)
                if (
                    settings.ENABLE_SELF_EVALUATION
                    and self.ctx.tool_call_count > 0
                    and self.ctx.eval_retry_count < settings.MAX_EVAL_RETRIES
                ):
                    judge_result = await _judge_current_response(
                        llm=agent_service.llm,
                        session_id=self.ctx.session_id,
                        response_text=full_text,
                        output_items=self.ctx.output_items,
                    )
                    if not judge_result.passed:
                        self.ctx.eval_retry_count += 1
                        agent_service._append_to_history(
                            self.ctx.session_id,
                            self.ctx.messages,
                            full_text,
                            usage=usage.model_dump(),
                            assistant_lc_message=accumulated,
                        )
                        user_query = _extract_last_user_query(self.ctx.session_id)
                        guidance = judge_result.guidance or "The previous response was inadequate."
                        retry_msg = (
                            f"The user's original request: {user_query}\n\n"
                            f"Your previous response was rejected: {full_text[:500]}\n\n"
                            f"Feedback: {guidance}\n\n"
                            "Please try again with alternative approaches."
                        )
                        self.ctx.messages = [
                            Message(role=MessageRole.USER, content=retry_msg),
                        ]
                        yield _sse_event(
                            {
                                "type": "response.output_text.abandoned",
                                "reason": "judge_failed",
                            }
                        )
                        continue

                agent_service._append_to_history(
                    self.ctx.session_id,
                    self.ctx.messages,
                    full_text,
                    usage=usage.model_dump(),
                    assistant_lc_message=accumulated,
                )
                yield _sse_event(
                    {
                        "type": "response.output_text.done",
                        "text": full_text,
                        "usage": usage.model_dump(),
                    }
                )
                response = _build_response(
                    [_text_output(full_text)],
                    ResponseStatus.COMPLETED,
                    self.ctx.session_id,
                    self.ctx.created_at,
                    self.ctx.model,
                    usage=self.ctx.total_usage,
                    iterations=iteration,
                    tool_call_count=self.ctx.tool_call_count,
                    tool_history=self.ctx.output_items or None,
                )
                yield _sse_event(
                    {
                        "type": "response.completed",
                        "response": response.model_dump(mode="json"),
                    }
                )
                return

            # TOOL_CALL: discard narration text that was streamed alongside
            # tool_calls (e.g. "mcp_web__search를 사용하여...").
            yield _sse_event({"type": "response.output_text.abandoned", "reason": "tool_call"})

            # TOOL_CALL result — but drop if skills signal completion.
            # Only on iteration > 1 so stale plans don't block new tool calls.
            if iteration > 1 and skill_provider.should_force_text_only(self.ctx.session_id):
                full_text = agent_service._extract_text(accumulated.content) or "Task completed."
                agent_service._append_to_history(
                    self.ctx.session_id,
                    self.ctx.messages,
                    full_text,
                    usage=usage.model_dump(),
                )
                yield _sse_event(
                    {
                        "type": "response.output_text.done",
                        "text": full_text,
                        "usage": usage.model_dump(),
                    }
                )
                response = _build_response(
                    [_text_output(full_text)],
                    ResponseStatus.COMPLETED,
                    self.ctx.session_id,
                    self.ctx.created_at,
                    self.ctx.model,
                    usage=self.ctx.total_usage,
                    iterations=iteration,
                    tool_call_count=self.ctx.tool_call_count,
                    tool_history=self.ctx.output_items or None,
                )
                yield _sse_event(
                    {
                        "type": "response.completed",
                        "response": response.model_dump(mode="json"),
                    }
                )
                return

            tool_calls_info = [
                ToolCallInfo(name=tc["name"], args=tc["args"], id=tc["id"])
                for tc in accumulated.tool_calls
            ]

            usage_dump = usage.model_dump()
            for tc in tool_calls_info:
                item_data: Dict[str, Any] = {
                    "call_id": tc.id,
                    "name": tc.name,
                    "arguments": (
                        json.dumps(tc.args) if isinstance(tc.args, dict) else str(tc.args)
                    ),
                }
                dn = self.ctx.display_names.get(tc.name)
                if dn:
                    item_data["display_name"] = dn
                yield _sse_event(
                    {
                        "type": "response.function_call.done",
                        "item": item_data,
                        "usage": usage_dump,
                    }
                )

            # Build LLMResult for _handle_tool_call_iteration
            result_obj = LLMResult(
                type=LLMResultType.TOOL_CALL,
                tool_calls=tool_calls_info,
                usage=usage,
                assistant_lc_message=accumulated,
                session_id=self.ctx.session_id,
            )

            # Track original LLM call IDs to avoid duplicate SSE events
            # (LLM calls already emitted above).
            original_call_ids = {tc.id for tc in tool_calls_info}

            items_before = len(self.ctx.output_items)
            response = await self._handle_tool_call_iteration(result_obj, iteration)

            # Emit SSE events for newly executed server tools.
            # Skip original LLM function_call events (already emitted above)
            # but always emit tool_result events so the frontend can update
            # tool call status from "running" to "completed".
            for item in self.ctx.output_items[items_before:]:
                if isinstance(item, FunctionToolCall) and item.name != "tool_approval":
                    if item.call_id in original_call_ids:
                        continue
                    item_data: Dict[str, Any] = {
                        "call_id": item.call_id,
                        "name": item.name,
                        "arguments": (
                            item.arguments
                            if isinstance(item.arguments, str)
                            else json.dumps(item.arguments)
                        ),
                    }
                    dn = self.ctx.display_names.get(item.name)
                    if dn:
                        item_data["display_name"] = dn
                    yield _sse_event(
                        {
                            "type": "response.function_call.done",
                            "item": item_data,
                        }
                    )
                elif isinstance(item, FunctionToolResult):
                    yield _sse_event(
                        {
                            "type": "response.tool_result.done",
                            "call_id": item.call_id,
                            "output": item.output,
                            "status": (
                                "failed" if is_tool_error(item.output or "") else "completed"
                            ),
                        }
                    )

            # Emit live skill state only when manage_todo was executed
            # this iteration (avoids re-emitting stale TODO from previous turns).
            _todo_updated = any(
                isinstance(item, FunctionToolCall) and item.name == "manage_todo"
                for item in self.ctx.output_items[items_before:]
            )
            if _todo_updated:
                _live_state = skill_provider.get_live_state(self.ctx.session_id)
                if _live_state:
                    yield _sse_event(
                        {
                            "type": "response.todo.updated",
                            "todo": _live_state,
                        }
                    )

            if response:
                evt = (
                    "response.completed"
                    if response.status == ResponseStatus.COMPLETED
                    else "response.incomplete"
                )
                yield _sse_event(
                    {
                        "type": evt,
                        "response": response.model_dump(mode="json"),
                    }
                )
                return

            self.ctx.messages = []

        # Max iterations reached
        response = _build_response(
            [
                _text_output(
                    f"Reached maximum iterations ({settings.MAX_AGENT_ITERATIONS}).",
                    status=ItemStatus.INCOMPLETE,
                )
            ],
            ResponseStatus.INCOMPLETE,
            self.ctx.session_id,
            self.ctx.created_at,
            self.ctx.model,
            usage=self.ctx.total_usage,
            iterations=settings.MAX_AGENT_ITERATIONS,
            tool_call_count=self.ctx.tool_call_count,
            tool_history=self.ctx.output_items or None,
        )
        yield _sse_event(
            {
                "type": "response.incomplete",
                "response": response.model_dump(mode="json"),
            }
        )


@router.post("/responses", response_model=ResponseObject)
async def create_response(request: ResponseRequest) -> ResponseObject:
    """Open Responses endpoint with server-side agentic loop."""
    await _ensure_initialized()
    _cleanup_stale_locks()

    created_at = int(time.time())
    session_id = _extract_session_id(request)
    cwd = _extract_cwd(request)
    model = settings.AGENT_MODEL
    messages = _parse_input(request)

    if not messages:
        return _build_response(
            [],
            ResponseStatus.FAILED,
            session_id,
            created_at,
            model,
            error=ErrorObject(type=ErrorType.INVALID_REQUEST, message="No input messages"),
        )

    (
        tool_names,
        client_tool_schemas,
        client_tool_names,
        client_tool_prompts,
        display_names,
    ) = _resolve_tools(request)

    # Handle pending approval BEFORE _prepare_messages_for_session, because
    # the approval answer arrives as a tool-role message that
    # _prepare_messages_for_session would consume (replace_tool_result)
    # and discard before the approval handler can see it.
    raw_messages = messages
    approval_early: ResponseObject | None = None
    approval_usage = Usage.zero()
    approval_tc_count = 0
    approval_output_items: list = []
    _defer_approval_to_stream = False

    if mcp_client._pending_tool_calls.get(session_id):
        if request.stream:
            # Streaming: defer approval handling to the streaming code so
            # that chain follow-up tools (web_fetch, grep) are emitted as
            # SSE events.  Running it here would add items to output_items
            # before the streaming code measures items_before, causing the
            # chain SSE events to be silently dropped.
            _defer_approval_to_stream = True
        else:
            (
                approval_early,
                _,
                approval_tc_count,
                approval_usage,
            ) = await _handle_approval_continuation(
                session_id,
                raw_messages,
                approval_output_items,
                created_at,
                model or "default",
                Usage.zero(),
                0,
                cwd=cwd,
            )
            if approval_early:
                return approval_early
            # Approval was handled; strip the consumed tool messages so
            # _prepare_messages_for_session doesn't try to process them again.
            pending_call_ids = set()
            for m in raw_messages:
                if m.role == MessageRole.TOOL:
                    pending_call_ids.add(m.tool_call_id)
            messages = [m for m in messages if m.tool_call_id not in pending_call_ids]

    if not _defer_approval_to_stream:
        messages = _prepare_messages_for_session(request, session_id, messages)

    # Count tool results in input to carry over context from INCOMPLETE requests.
    # When the frontend sends back tool results (e.g. ask_question answer),
    # tool_call_count must be > 0 so the judge evaluates the follow-up response.
    input_tool_count = approval_tc_count + sum(
        1 for m in raw_messages if m.role == MessageRole.TOOL
    )

    ctx = _LoopContext(
        request=request,
        created_at=created_at,
        session_id=session_id,
        model=model,
        messages=messages,
        tool_names=tool_names,
        client_tool_schemas=client_tool_schemas,
        client_tool_names=client_tool_names,
        client_tool_prompts=client_tool_prompts,
        display_names=display_names,
        total_usage=approval_usage,
        tool_call_count=input_tool_count,
        output_items=approval_output_items,
        cwd=cwd,
    )

    if request.stream:
        runner = _AgentLoopRunner(ctx)
        return StreamingResponse(
            runner.stream(),
            media_type="text/event-stream",
            headers=_SSE_HEADERS,
        )

    try:
        return await _AgentLoopRunner(ctx).run()
    except NotImplementedError as e:
        logger.error("Tool not implemented: %s", e)
        return _build_response(
            [],
            ResponseStatus.FAILED,
            ctx.session_id,
            ctx.created_at,
            ctx.model,
            error=ErrorObject(
                type=ErrorType.SERVER_ERROR,
                code="tool_not_implemented",
                message=str(e),
            ),
            tool_call_count=ctx.tool_call_count,
            tool_history=ctx.output_items or None,
        )
    except Exception as e:
        logger.exception("Agent loop error")
        return _build_response(
            [],
            ResponseStatus.FAILED,
            ctx.session_id,
            ctx.created_at,
            ctx.model,
            error=ErrorObject(type=ErrorType.SERVER_ERROR, message=str(e)),
            tool_call_count=ctx.tool_call_count,
            tool_history=ctx.output_items or None,
        )


@router.get("/subagent/status/{session_id}")
async def subagent_status(session_id: str) -> dict:
    """Return sub-agent run status for the given parent session."""
    now = time.time()
    records = get_subagent_registry().list_by_parent(session_id)
    return {
        "children": [
            {
                "child_session_id": r.child_session_id,
                "task": r.task[:200],
                "status": r.status,
                "elapsed_seconds": round(now - r.started_at, 1),
                "result_summary": r.result_summary[:500] if r.result_summary else None,
                "current_iteration": r.current_iteration,
                "progress": [
                    {
                        "tool_name": s.tool_name,
                        "detail": s.detail[:100],
                        "status": s.status,
                    }
                    for s in list(r.progress_log)
                ],
            }
            for r in records
        ]
    }


@router.post("/title")
async def generate_title(request: dict) -> dict:
    """Generate a short title for a conversation based on its messages."""
    messages = request.get("messages", [])
    if not messages:
        return {"title": "New Chat"}

    conversation = "\n".join(
        f"{m['role'].capitalize()}: {m['text']}" for m in messages if m.get("text")
    )

    prompt = _HM(
        content=(
            "Generate a very short title (max 6 words) for this conversation. "
            "Return ONLY the title, no quotes or punctuation.\n\n"
            f"{conversation}"
        )
    )

    try:
        result = await agent_service.llm.ainvoke([prompt])
        title = result.content.strip().strip("\"'")
        # Truncate if too long
        if len(title) > 60:
            title = title[:57] + "..."
        return {"title": title}
    except Exception as e:
        logger.warning("Title generation failed: %s", e)
        # Fallback to first user message
        first = next((m["text"] for m in messages if m.get("role") == "user"), "New Chat")
        title = first[:60] + ("..." if len(first) > 60 else "")
        return {"title": title}
