# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Agent router - orchestrates the server-side agentic loop.

High-level loop:
  user input -> LLM response -> (optional) tool execution -> LLM response -> ...
"""

import atexit
import asyncio
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
from app.services.agent_service import AgentService
from app.services.notification_service import NotificationService
from app.services.periodic_task_service import PeriodicTaskService
from app.services.providers.mcp import MCPClient
from app.services.todo_service import TodoService
from app.services.tool_chain import ToolChainRegistry
from fastapi import APIRouter
from fastapi.responses import StreamingResponse

logger = logging.getLogger(__name__)

router = APIRouter()

chain_registry = ToolChainRegistry()
mcp_client = MCPClient(chain_registry=chain_registry)
agent_service = AgentService()
todo_service = TodoService()
periodic_task_service = PeriodicTaskService()
notification_service = NotificationService()
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
    """Serialize full loop executions per session."""
    return _session_loop_locks.setdefault(session_id, asyncio.Lock())


def _cleanup_stale_locks() -> None:
    """Remove per-session locks for evicted sessions."""
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
        todo_service.clear_session(sid)


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
        except BaseException as e:
            logger.warning("MCP initialization failed (continuing without MCP tools): %s", e)
        _initialized = True


async def _execute_session_file_tool(
    name: str, arguments: Dict[str, Any], session_id: str
) -> str:
    """Execute session file tools via Platform API."""
    import httpx

    base = f"{settings.MCP_SERVER_URL}/api/v1/sessions/{session_id}/files"

    async with httpx.AsyncClient(timeout=30.0) as client:
        if name == "read_file":
            resp = await client.get(f"{base}/read/", params={"path": arguments.get("path", "")})
            if resp.status_code == 200:
                data = resp.json()
                return data.get("content", "(no content)")
            return f"Error: {resp.json().get('error', 'File not found')}"

        elif name == "write_file":
            resp = await client.post(f"{base}/write/", json={
                "path": arguments.get("path", ""),
                "content": arguments.get("content", ""),
                "created_by": "agent",
            })
            if resp.status_code in (200, 201):
                return f"File written: {arguments.get('path', '')}"
            return f"Error writing file: {resp.json().get('error', resp.text)}"

        elif name == "list_files":
            params = {}
            if arguments.get("path"):
                params["path"] = arguments["path"]
            resp = await client.get(f"{base}/", params=params)
            if resp.status_code == 200:
                files = resp.json()
                if not files:
                    return "No files in session."
                lines = [f"- {f['path']} ({f['size']} bytes, {f['content_type']})" for f in files]
                return "\n".join(lines)
            return f"Error listing files: {resp.text}"

        elif name == "delete_file":
            resp = await client.delete(
                f"{base}/delete-by-path/", params={"path": arguments.get("path", "")}
            )
            if resp.status_code == 204:
                return f"File deleted: {arguments.get('path', '')}"
            return f"Error deleting file: {resp.json().get('error', resp.text)}"

    return f"Unknown session file tool: {name}"


async def _execute_tool(name: str, arguments: Dict[str, Any], session_id: str = "") -> str:
    """Dispatch tool execution by name."""
    from app.config import AGENT_TOOLS, SESSION_FILE_TOOLS

    if name == "manage_periodic_task":
        return await periodic_task_service.execute(name, arguments, session_id)

    if name == "notify_user":
        return await notification_service.execute(name, arguments, session_id)

    if name in AGENT_TOOLS:
        return await todo_service.execute(name, arguments, session_id)

    if name in SESSION_FILE_TOOLS:
        return await _execute_session_file_tool(name, arguments, session_id)

    if mcp_client.is_server_tool(name):
        return await mcp_client.call_tool(name, arguments)

    # TODO: bash executor
    # TODO: browser executor
    raise NotImplementedError(f"Tool executor not implemented: {name}")


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

    try:
        result = await _execute_tool(name, arguments, session_id=session_id)
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
                Message(role=MessageRole.TOOL, content=item.output, tool_call_id=item.call_id),
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


def _tool_call_output(name: str, arguments: dict, call_id: str) -> FunctionToolCall:
    """Build a function_call output item."""
    return FunctionToolCall(
        id=f"fc_{uuid.uuid4().hex}",
        call_id=call_id,
        name=name,
        arguments=json.dumps(arguments) if isinstance(arguments, dict) else arguments,
        status=ItemStatus.COMPLETED,
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
            item.model_dump() if hasattr(item, "model_dump") else item
            for item in tool_history
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


async def _safe_execute_tool(tc: ToolCallInfo, session_id: str = "") -> tuple[ToolCallInfo, str]:
    """Execute a single tool call and convert failures to readable tool output."""
    try:
        result = await _execute_tool(tc.name, tc.args, session_id=session_id)
        return tc, result
    except Exception as e:
        logger.warning("Tool execution failed (%s): %s", tc.name, e)
        return tc, f"Error executing tool '{tc.name}': {e}"


async def _execute_tool_calls(
    tool_calls: List[ToolCallInfo],
    all_output_items: list,
    session_id: str = "",
) -> List[Message]:
    """Execute tool calls in parallel and append call/result items to history."""
    if not tool_calls:
        return []

    results = await asyncio.gather(*[_safe_execute_tool(tc, session_id=session_id) for tc in tool_calls])

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


async def _handle_chained_calls(
    chained: List[ToolCallInfo],
    session_id: str,
    created_at: int,
    model: str,
    total_usage: Usage,
    tool_call_count: int,
    all_output_items: list,
    iteration: int | None = None,
) -> ResponseObject | None:
    """Execute or gate chained calls, returning ask_question when approval is needed."""
    if any(mcp_client.needs_approval(tc.name, session_id) for tc in chained):
        unapproved = [tc for tc in chained if mcp_client.needs_approval(tc.name, session_id)]
        first = [unapproved[0]]
        remaining = unapproved[1:]
        auto = [tc for tc in chained if not mcp_client.needs_approval(tc.name, session_id)]
        info = mcp_client.request_approval(
            first + auto,
            session_id,
            None,
            [],
            remaining_chained=remaining,
        )
        return _build_response(
            [_tool_call_output("ask_question", info["question"], info["approval_call_id"])],
            ResponseStatus.INCOMPLETE,
            session_id,
            created_at,
            model,
            usage=total_usage,
            tool_call_count=tool_call_count,
            iterations=iteration,
            tool_history=all_output_items or None,
        )

    chain_results = await _execute_tool_calls(chained, all_output_items, session_id=session_id)
    await agent_service.append_tool_interaction(
        session_id,
        [],
        [tc.model_dump() for tc in chained],
        chain_results,
    )
    return None


async def _handle_approval_continuation(
    session_id: str,
    messages: List[Message],
    all_output_items: list,
    created_at: int,
    model: str,
    total_usage: Usage,
    tool_call_count: int,
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
        tool_results = await _execute_tool_calls(pending_tcs, all_output_items, session_id=session_id)
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


def _resolve_tools(request: ResponseRequest) -> Tuple[List[str], List[dict], Set[str], List[str]]:
    """Resolve tool names, schemas, client tool names, and guides from request + MCP.

    Returns:
        (tool_names, client_tool_schemas, client_tool_names, client_tool_prompts) where:
          - tool_names: all tool names (client + MCP + server) for system prompt
          - client_tool_schemas: OpenAI-format dicts for LLM binding
          - client_tool_names: names of client-side tools (for classification)
          - client_tool_prompts: guide texts provided by clients for system prompt
    """
    from app.config import AGENT_TOOLS, SESSION_FILE_TOOLS

    client_tool_names: Set[str] = set()
    client_tool_schemas: List[dict] = []
    tool_names: List[str] = []
    client_tool_prompts: List[str] = []

    if request.tools:
        for t in request.tools:
            client_tool_names.add(t.function.name)
            tool_names.append(t.function.name)
            client_tool_schemas.append(t.model_dump(exclude_none=True, exclude={"guide"}))
            if t.guide:
                client_tool_prompts.append(t.guide)

    for name in mcp_client.server_tool_names:
        if name not in client_tool_names:
            tool_names.append(name)
    # Always include session file tools (executed server-side via Platform API)
    for name in SESSION_FILE_TOOLS:
        if name not in tool_names:
            tool_names.append(name)
    # Always include agent-internal tools
    for name in AGENT_TOOLS:
        if name not in tool_names:
            tool_names.append(name)

    return tool_names, client_tool_schemas, client_tool_names, client_tool_prompts


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
    total_usage: Usage = field(default_factory=Usage.zero)
    tool_call_count: int = 0
    output_items: list = field(default_factory=list)


class _AgentLoopRunner:
    """Single-request loop runner with minimal state transitions."""

    def __init__(self, ctx: _LoopContext) -> None:
        self.ctx = ctx

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
        )
        self.ctx.messages = messages
        self.ctx.tool_call_count = tool_call_count
        self.ctx.total_usage = total_usage
        return resp

    def _augmented_instructions(self) -> str | None:
        """Return instructions augmented with current TODO state."""
        base = self.ctx.request.instructions or ""
        todo_prompt = todo_service.get_state_prompt(self.ctx.session_id)
        if todo_prompt:
            return f"{base}\n\n{todo_prompt}" if base else todo_prompt
        return base or None

    async def _run_tool_iterations(self) -> ResponseObject:
        for iteration in range(1, settings.MAX_AGENT_ITERATIONS + 1):
            result = await agent_service.process_messages_with_tools(
                messages=self.ctx.messages,
                session_id=self.ctx.session_id,
                instructions=self._augmented_instructions(),
                client_tool_schemas=self.ctx.client_tool_schemas,
                client_tool_prompts=self.ctx.client_tool_prompts,
            )
            self.ctx.session_id = result.session_id
            if result.usage:
                self.ctx.total_usage = self.ctx.total_usage.add(result.usage)

            if result.type == LLMResultType.TEXT:
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

    async def _handle_tool_call_iteration(self, result: Any, iteration: int) -> ResponseObject | None:
        from app.config import AGENT_TOOLS, SESSION_FILE_TOOLS

        all_tool_calls = result.tool_calls or []
        client_calls, server_calls = mcp_client.classify_tool_calls(
            all_tool_calls, self.ctx.session_id,
            client_tool_names=self.ctx.client_tool_names,
        )

        unsupported = [
            tc
            for tc in server_calls
            if not mcp_client.is_server_tool(tc.name)
            and tc.name not in SESSION_FILE_TOOLS
            and tc.name not in AGENT_TOOLS
            and not mcp_client.needs_approval(tc.name, self.ctx.session_id)
        ]
        if unsupported:
            raise NotImplementedError(f"Tool executor not implemented: {unsupported[0].name}")

        if any(mcp_client.needs_approval(tc.name, self.ctx.session_id) for tc in server_calls):
            info = mcp_client.request_approval(
                server_calls,
                self.ctx.session_id,
                result.usage,
                self.ctx.messages,
                assistant_lc_message=result.assistant_lc_message,
            )
            return _build_response(
                [_tool_call_output("ask_question", info["question"], info["approval_call_id"])],
                ResponseStatus.INCOMPLETE,
                self.ctx.session_id,
                self.ctx.created_at,
                self.ctx.model,
                usage=self.ctx.total_usage,
                iterations=iteration,
                tool_call_count=self.ctx.tool_call_count,
                tool_history=self.ctx.output_items or None,
            )

        tool_results = await _execute_tool_calls(server_calls, self.ctx.output_items, session_id=self.ctx.session_id)
        self.ctx.tool_call_count += len(tool_results)

        for tc in client_calls:
            tool_results.append(
                Message(
                    role=MessageRole.TOOL,
                    content=json.dumps(tc.args),
                    tool_call_id=tc.id,
                    tool_name=tc.name,
                )
            )

        await agent_service.append_tool_interaction(
            self.ctx.session_id,
            self.ctx.messages,
            [tc.model_dump() for tc in all_tool_calls],
            tool_results,
            usage=result.usage.model_dump(),
            assistant_lc_message=result.assistant_lc_message,
        )

        chained = chain_registry.build(server_calls, tool_results, session_id=self.ctx.session_id)
        if chained:
            chain_resp = await _handle_chained_calls(
                chained,
                self.ctx.session_id,
                self.ctx.created_at,
                self.ctx.model,
                self.ctx.total_usage,
                self.ctx.tool_call_count,
                self.ctx.output_items,
                iteration=iteration,
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

        yield _sse_event({
            "type": "response.created",
            "response": {
                "id": response_id,
                "status": "in_progress",
                "model": self.ctx.model,
                "created_at": self.ctx.created_at,
                "metadata": {"session_id": self.ctx.session_id},
            },
        })

        try:
            if not self.ctx.tool_names:
                async for event in self._stream_text_only():
                    yield event
            else:
                async with _get_loop_lock(self.ctx.session_id):
                    approval_response = await self._resume_pending_approval()
                    if approval_response:
                        evt = "response.completed" if approval_response.status == ResponseStatus.COMPLETED else "response.incomplete"
                        yield _sse_event({
                            "type": evt,
                            "response": approval_response.model_dump(mode="json"),
                        })
                    else:
                        async for event in self._stream_tool_iterations():
                            yield event
        except Exception as e:
            logger.exception("Streaming agent loop error")
            error_response = _build_response(
                [], ResponseStatus.FAILED, self.ctx.session_id,
                self.ctx.created_at, self.ctx.model,
                error=ErrorObject(type=ErrorType.SERVER_ERROR, message=str(e)),
            )
            yield _sse_event({
                "type": "response.failed",
                "response": error_response.model_dump(mode="json"),
            })

        yield _sse_done()

    async def _stream_llm_and_accumulate(self, use_tools: bool = True):
        """Stream LLM chunks, yielding text deltas and returning accumulated result."""
        accumulated = None

        async for chunk in agent_service.stream_messages_with_tools(
            messages=self.ctx.messages,
            session_id=self.ctx.session_id,
            instructions=self.ctx.request.instructions,
            client_tool_schemas=self.ctx.client_tool_schemas if use_tools else None,
            client_tool_prompts=self.ctx.client_tool_prompts if use_tools else None,
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
                self.ctx.session_id, self.ctx.messages, full_text,
                usage=usage.model_dump(), assistant_lc_message=accumulated,
            )

        yield _sse_event({"type": "response.output_text.done", "text": full_text, "usage": usage.model_dump()})

        response = _build_response(
            [_text_output(full_text)], ResponseStatus.COMPLETED,
            self.ctx.session_id, self.ctx.created_at, self.ctx.model,
            usage=self.ctx.total_usage,
        )
        yield _sse_event({
            "type": "response.completed",
            "response": response.model_dump(mode="json"),
        })

    async def _stream_tool_iterations(self):
        """Stream the tool iteration loop, yielding SSE events."""
        for iteration in range(1, settings.MAX_AGENT_ITERATIONS + 1):
            # Inject current TODO state into instructions for this iteration
            self.ctx.request.instructions = self._augmented_instructions()

            accumulated = None

            async for tag, value in self._stream_llm_and_accumulate(use_tools=True):
                if tag == "delta":
                    yield _sse_event({"type": "response.output_text.delta", "delta": value})
                elif tag == "done":
                    accumulated = value

            if not accumulated:
                break

            usage = agent_service._extract_usage(accumulated)
            self.ctx.total_usage = self.ctx.total_usage.add(usage)

            if not getattr(accumulated, "tool_calls", None):
                # TEXT result — final response
                full_text = agent_service._extract_text(accumulated.content)
                agent_service._append_to_history(
                    self.ctx.session_id, self.ctx.messages, full_text,
                    usage=usage.model_dump(), assistant_lc_message=accumulated,
                )
                yield _sse_event({"type": "response.output_text.done", "text": full_text, "usage": usage.model_dump()})
                response = _build_response(
                    [_text_output(full_text)], ResponseStatus.COMPLETED,
                    self.ctx.session_id, self.ctx.created_at, self.ctx.model,
                    usage=self.ctx.total_usage, iterations=iteration,
                    tool_call_count=self.ctx.tool_call_count,
                    tool_history=self.ctx.output_items or None,
                )
                yield _sse_event({
                    "type": "response.completed",
                    "response": response.model_dump(mode="json"),
                })
                return

            # TOOL_CALL result
            tool_calls_info = [
                ToolCallInfo(name=tc["name"], args=tc["args"], id=tc["id"])
                for tc in accumulated.tool_calls
            ]

            usage_dump = usage.model_dump()
            for tc in tool_calls_info:
                yield _sse_event({
                    "type": "response.function_call.done",
                    "item": {
                        "call_id": tc.id,
                        "name": tc.name,
                        "arguments": json.dumps(tc.args) if isinstance(tc.args, dict) else str(tc.args),
                    },
                    "usage": usage_dump,
                })

            # Build LLMResult for _handle_tool_call_iteration
            result_obj = LLMResult(
                type=LLMResultType.TOOL_CALL,
                tool_calls=tool_calls_info,
                usage=usage,
                assistant_lc_message=accumulated,
                session_id=self.ctx.session_id,
            )

            items_before = len(self.ctx.output_items)
            response = await self._handle_tool_call_iteration(result_obj, iteration)

            # Emit tool_result.done for newly executed server tools
            for item in self.ctx.output_items[items_before:]:
                if isinstance(item, FunctionToolResult):
                    yield _sse_event({
                        "type": "response.tool_result.done",
                        "call_id": item.call_id,
                        "output": item.output,
                        "status": "completed",
                    })

            # Emit TODO state update if active
            _todo_state = todo_service.get_state(self.ctx.session_id)
            if _todo_state:
                yield _sse_event({
                    "type": "response.todo.updated",
                    "todo": {
                        "task": _todo_state.task,
                        "steps": [
                            {"description": s.description, "status": s.status, "result": s.result}
                            for s in _todo_state.steps
                        ],
                    },
                })

            if response:
                evt = "response.completed" if response.status == ResponseStatus.COMPLETED else "response.incomplete"
                yield _sse_event({
                    "type": evt,
                    "response": response.model_dump(mode="json"),
                })
                return

            self.ctx.messages = []

        # Max iterations reached
        response = _build_response(
            [_text_output(
                f"Reached maximum iterations ({settings.MAX_AGENT_ITERATIONS}).",
                status=ItemStatus.INCOMPLETE,
            )],
            ResponseStatus.INCOMPLETE, self.ctx.session_id,
            self.ctx.created_at, self.ctx.model,
            usage=self.ctx.total_usage,
            iterations=settings.MAX_AGENT_ITERATIONS,
            tool_call_count=self.ctx.tool_call_count,
            tool_history=self.ctx.output_items or None,
        )
        yield _sse_event({
            "type": "response.incomplete",
            "response": response.model_dump(mode="json"),
        })


@router.post("/responses", response_model=ResponseObject)
async def create_response(request: ResponseRequest) -> ResponseObject:
    """Open Responses endpoint with server-side agentic loop."""
    await _ensure_initialized()
    _cleanup_stale_locks()

    created_at = int(time.time())
    session_id = _extract_session_id(request)
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

    tool_names, client_tool_schemas, client_tool_names, client_tool_prompts = _resolve_tools(request)

    # Handle pending approval BEFORE _prepare_messages_for_session, because
    # the approval answer arrives as a tool-role message that
    # _prepare_messages_for_session would consume (replace_tool_result)
    # and discard before the approval handler can see it.
    raw_messages = messages
    approval_early: ResponseObject | None = None
    approval_usage = Usage.zero()
    approval_tc_count = 0
    approval_output_items: list = []

    if mcp_client._pending_tool_calls.get(session_id):
        approval_early, _, approval_tc_count, approval_usage = (
            await _handle_approval_continuation(
                session_id,
                raw_messages,
                approval_output_items,
                created_at,
                model or "default",
                Usage.zero(),
                0,
            )
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

    messages = _prepare_messages_for_session(request, session_id, messages)

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
        total_usage=approval_usage,
        tool_call_count=approval_tc_count,
        output_items=approval_output_items,
    )

    if request.stream:
        runner = _AgentLoopRunner(ctx)
        return StreamingResponse(
            runner.stream(),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
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


@router.post("/title")
async def generate_title(request: dict) -> dict:
    """Generate a short title for a conversation based on its messages."""
    messages = request.get("messages", [])
    if not messages:
        return {"title": "New Chat"}

    conversation = "\n".join(
        f"{m['role'].capitalize()}: {m['text']}" for m in messages if m.get("text")
    )

    from langchain_core.messages import HumanMessage as _HM

    prompt = _HM(
        content=(
            "Generate a very short title (max 6 words) for this conversation. "
            "Return ONLY the title, no quotes or punctuation.\n\n"
            f"{conversation}"
        )
    )

    try:
        result = await agent_service.llm.ainvoke([prompt])
        title = result.content.strip().strip('"\'')
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
