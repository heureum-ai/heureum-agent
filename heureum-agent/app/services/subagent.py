# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Sub-agent execution skeleton — isolated child agent instances for parallel task execution.

Design principles:
  - Each child uses a **new AgentService instance** → full session isolation
  - Parent connection is minimal: _announce_completion appends SystemMessage
  - This module owns the execution loop; data models, registry, and
    orchestration live in ``app.skills.plan_task.service``
  - ``SubagentContext`` is injected by the router at startup,
    breaking the circular dependency cleanly.

Dependency direction:
  - This module does NOT import from ``app.skills.plan_task.service``.
  - ``plan_task.service`` calls ``create_subagent_task`` from here.
  - Registry and depth-tracking objects are passed via duck-typed parameters.
"""

import asyncio
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from app.config import settings
from app.models import LLMResultType
from app.services.agent_service import AgentService
from langchain_core.messages import (
    AIMessage,
    HumanMessage,
    SystemMessage as LCSystemMessage,
    ToolMessage,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Dependency injection context
# ---------------------------------------------------------------------------


@dataclass
class SubagentContext:
    """Dependencies injected from the router layer to avoid circular imports.

    Set once at application startup via ``set_context()``.
    """

    agent_service: Any
    mcp_client: Any
    skill_controller: Any
    tool_controller: Any
    execute_tool: Callable
    persist_controller: Any = None  # Optional[PersistController]
    skills_prompt: Optional[str] = None  # Current session's skills_prompt
    messages: Any = None  # Optional[MessageRegistry]


_context: SubagentContext | None = None


def set_context(ctx: SubagentContext) -> None:
    """Set the module-level context (called once at router import time)."""
    global _context
    _context = ctx


def _get_context() -> SubagentContext:
    """Return the current context, raising if not yet initialized."""
    if _context is None:
        raise RuntimeError("SubagentContext not initialized — call set_context() first")
    return _context


# ---------------------------------------------------------------------------
# Public API: create_subagent_task
# ---------------------------------------------------------------------------


def create_subagent_task(
    record: Any,
    request: Any,
    registry: Any,
    clear_depth_fn: Any,
) -> asyncio.Task:
    """Create an asyncio.Task for a sub-agent run.

    All parameters are duck-typed so this module does not import data models
    from ``plan_task.service``.

    Args:
        record: SubagentRunRecord instance.
        request: SpawnRequest instance.
        registry: SubagentRegistry instance (for mark_completed).
        clear_depth_fn: Callable(session_id) to clear depth tracking.

    Returns:
        The created asyncio.Task.
    """
    task = asyncio.create_task(
        _run_subagent(record, request, registry, clear_depth_fn),
        name=f"subagent-{record.child_session_id}",
    )
    return task


# ---------------------------------------------------------------------------
# Session state cleanup (exported for router use)
# ---------------------------------------------------------------------------


def cleanup_session_state(session_id: str) -> None:
    """Clean up ctx-based session state (mcp, tool, skill, loop_detection).

    Called by the router's sweep_stale and by _run_subagent on cleanup="delete".
    """
    try:
        ctx = _get_context()
        from app.services.tools import clear_session_loop_state

        ctx.mcp_client.clear_session_state(session_id)
        ctx.tool_controller.clear_session(session_id)
        ctx.skill_controller.clear_session(session_id)
        clear_session_loop_state(session_id)
    except Exception:
        pass


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------


async def _run_subagent(
    record: Any,
    request: Any,
    registry: Any,
    clear_depth_fn: Any,
) -> None:
    """Execute the sub-agent task with timeout handling.

    Args:
        record: SubagentRunRecord (duck-typed).
        request: SpawnRequest (duck-typed).
        registry: SubagentRegistry for marking completion.
        clear_depth_fn: Callable to clear depth tracking.
    """
    final_status = "failed"
    final_summary = ""
    try:
        result = await asyncio.wait_for(
            _execute_subagent_task(record, request, registry),
            timeout=settings.SUBAGENT_TIMEOUT_SECONDS,
        )
        final_status = "completed"
        final_summary = result
        registry.mark_completed(record.child_session_id, "completed", result)
        await _announce_completion(record, result)
    except asyncio.TimeoutError:
        logger.warning("Sub-agent %s timed out", record.child_session_id)
        final_status = "timeout"
        final_summary = "Task timed out"
        registry.mark_completed(record.child_session_id, "timeout", "Task timed out")
        _message_registry = getattr(_context, "messages", None) if _context else None
        if _message_registry:
            _timeout_message, _ = await _message_registry.resolve("subagent.timeout")
        else:
            _timeout_message = "Sub-agent task timed out."
        await _announce_completion(record, _timeout_message)
    except asyncio.CancelledError:
        logger.info("Sub-agent %s cancelled", record.child_session_id)
        final_status = "failed"
        final_summary = "Cancelled"
        registry.mark_completed(record.child_session_id, "failed", "Cancelled")
    except Exception as e:
        logger.warning("Sub-agent %s failed: %s", record.child_session_id, e)
        final_status = "failed"
        final_summary = str(e)
        registry.mark_completed(record.child_session_id, "failed", str(e))
        _message_registry = getattr(_context, "messages", None) if _context else None
        if _message_registry:
            _failure_message, _ = await _message_registry.resolve("subagent.failure", error=str(e))
        else:
            _failure_message = f"Sub-agent task failed: {e}"
        await _announce_completion(record, _failure_message)
    finally:
        # Persist completion to Platform DB (best-effort)
        try:
            pc = _get_context().persist_controller
            if pc:
                await pc.subagent_run_complete(record, final_status, final_summary)
        except Exception:
            pass

        # Cleanup
        if request.cleanup == "delete":
            clear_depth_fn(record.child_session_id)
            cleanup_session_state(record.child_session_id)


def _build_subagent_instructions(task: str, tool_names: List[str], can_spawn: bool = False) -> str:
    """Build a dynamic system prompt instruction block for the sub-agent."""
    lines = [
        "You are a sub-agent spawned to complete a specific task.",
        "Focus exclusively on the task below. Do not ask the user questions.",
        "When the task is done, respond with a clear summary of what you accomplished.",
        "",
        f"## Task\n{task}",
    ]
    if tool_names:
        lines.append(f"\n## Available Tools\n{', '.join(tool_names)}")
    lines.append(
        "\n## Workflow\n"
        '1. First, call manage_todo(action="create") to break your task into steps.\n'
        "2. Execute each step, updating status via manage_todo as you go.\n"
        "3. After all steps are completed, provide a concise result summary."
    )
    constraint_lines = [
        "\n## Constraints",
        "- Complete the task autonomously without user interaction.",
        "- If a tool call fails, try an alternative approach.",
    ]
    if not can_spawn:
        constraint_lines.append("- Do NOT spawn sub-agents — execute steps directly.")
    lines.append("\n".join(constraint_lines))
    return "\n".join(lines)


def _resolve_child_tools(
    request: Any,
) -> tuple:
    """Resolve MCP tools and skill_controller for the child agent.

    Inherits from the global parent agent_service, optionally filtered
    by request.tools whitelist.  Approval-required tools are always
    excluded because sub-agents cannot perform interactive approval.

    Returns:
        (mcp_tools, skill_controller, tool_names) — ready for AgentService init.
    """
    ctx = _get_context()

    parent_mcp_tools = ctx.agent_service.mcp_tool_controller.get_tool_schemas() or []
    child_skill_controller = ctx.skill_controller

    # Approval-required tools cannot be used by sub-agents (no interactive approval)
    approval_required = getattr(ctx.mcp_client, "_approval_required_tools", set())

    if request.tools:
        # Filter MCP tools to whitelist, excluding approval-required
        allowed = set(request.tools)
        child_mcp_tools = [
            t
            for t in parent_mcp_tools
            if t.get("function", {}).get("name") in allowed
            and t.get("function", {}).get("name") not in approval_required
        ]
        # Wrap skill provider with allowlist filter
        if ctx.skill_controller:
            child_skill_controller = ctx.skill_controller.filtered(allowed)
    else:
        child_mcp_tools = [
            t
            for t in parent_mcp_tools
            if t.get("function", {}).get("name") not in approval_required
        ]

    # Collect tool names for the instructions
    tool_names = [t.get("function", {}).get("name", "?") for t in child_mcp_tools]
    if child_skill_controller:
        for schema in child_skill_controller.get_all_tool_schemas():
            name = schema.get("function", {}).get("name")
            if name:
                tool_names.append(name)

    return child_mcp_tools, child_skill_controller, tool_names


def _tool_detail(tool_name: str, args: Dict[str, Any]) -> str:
    """Extract a brief detail string from tool call arguments.

    Mirrors the frontend's ``getToolDisplay()`` logic so the polling
    response provides useful context for each progress step.
    """
    if tool_name == "bash":
        cmd = args.get("command", "")
        return str(cmd)[:80] if cmd else ""

    # Priority keys (query, url, path, pattern) — most informative
    for key in ("query", "url", "path", "pattern"):
        val = args.get(key)
        if val and isinstance(val, str):
            return val[:80]

    # Fallback: first string arg value
    for val in args.values():
        if isinstance(val, str) and val:
            return val[:80]

    return ""


def _root_session_id(parent_session_id: str, registry: Any) -> str:
    """Resolve the root session ID (non-subagent ancestor).

    If the parent itself is a subagent, walk up via the registry.
    Falls back to parent_session_id if lineage is unavailable.

    Args:
        parent_session_id: The starting session ID.
        registry: SubagentRegistry instance (duck-typed).
    """
    current = parent_session_id
    for _ in range(10):  # safety limit
        record = registry.get(current)
        if record is None:
            break
        current = record.parent_session_id
    return current


async def _execute_subagent_task(
    record: Any,
    request: Any,
    registry: Any,
) -> str:
    """Run a simplified agent loop for the sub-agent.

    Creates a fresh AgentService instance with dynamically inherited tools
    and a task-specific system prompt, then loops until the LLM returns
    a text response (no more tool calls).

    Persist hooks fire at three points:
      - Run start: after building the system prompt
      - Each message: user, assistant, tool results (fire-and-forget)
      - Run complete: handled by the caller (_run_subagent finally block)
    """
    ctx = _get_context()

    # Inherit tools from parent
    child_mcp_tools, child_skill_controller, tool_names = _resolve_child_tools(request)

    # Create isolated agent service with inherited tools
    child_service = AgentService(
        mcp_tools=child_mcp_tools,
        skill_provider=child_skill_controller,
    )

    # Build dynamic instructions — allow spawning if depth permits
    from app.skills.plan_task.service import get_subagent_depth, _config

    session_id = record.child_session_id
    depth = get_subagent_depth(session_id)
    can_spawn = depth < _config["max_spawn_depth"]
    instructions = _build_subagent_instructions(request.task, tool_names, can_spawn=can_spawn)

    # Pre-initialize child session to avoid rehydration network calls.
    child_service.message_controller.session_state_controller.set_session(session_id, [])
    messages = [HumanMessage(content=request.task)]

    # --- Persist: run start (best-effort, background) ---
    pc = ctx.persist_controller
    root_sid = _root_session_id(request.parent_session_id, registry)
    try:
        prompt, _ = child_service._prepare_prompt_and_tools(instructions=instructions)
    except Exception:
        prompt = ""
    if pc:
        asyncio.create_task(
            pc.subagent_run_start(record, root_session_id=root_sid, system_prompt=prompt)
        )

    # Message sequence counter for persist
    msg_seq = 0

    # Persist initial user message (seq=0)
    if pc:
        asyncio.create_task(
            pc.subagent_message(record, seq=msg_seq, role="user", content=request.task)
        )
    msg_seq += 1

    max_iterations = settings.SUBAGENT_MAX_ITERATIONS

    plan_retry_count = 0

    try:
        for iteration in range(1, max_iterations + 1):
            record.current_iteration = iteration

            result = await child_service.process_messages_with_tools(
                messages=messages,
                session_id=session_id,
                instructions=instructions,
                skills_prompt=request.skills_prompt,
            )

            if result.type == LLMResultType.TEXT:
                text = result.text or "Task completed."

                # Cascade: check if child skill controller has unfinished work
                if child_skill_controller and child_skill_controller.has_unfinished_work(
                    session_id
                ):
                    await child_skill_controller.await_pending(session_id)

                    if child_skill_controller.has_unfinished_work(session_id):
                        # Still unfinished — inject retry guidance
                        plan_retry_count += 1
                        if plan_retry_count > settings.MAX_PLAN_RETRIES:
                            await child_skill_controller.finalize_abandoned(session_id)
                            # fall through to return
                        else:
                            guidance = child_skill_controller.build_retry_guidance(session_id, text)
                            if ctx.messages:
                                fallback = ctx.messages.get_default("subagent.retry_fallback")
                                retry_content, _ = await ctx.messages.resolve(
                                    "loop.plan_retry",
                                    session_id=session_id,
                                    guidance=guidance or fallback,
                                )
                            else:
                                retry_content = guidance or "Continue."
                            messages.append(AIMessage(content=text))
                            messages.append(HumanMessage(content=retry_content))
                            continue
                    else:
                        # All sub-tasks done — re-run LLM to synthesize
                        if ctx.messages:
                            synthesis_content, _ = await ctx.messages.resolve(
                                "subagent.synthesis",
                                session_id=session_id,
                            )
                        else:
                            synthesis_content = "All sub-tasks completed. Synthesize the results into a concise summary."
                        messages.append(AIMessage(content=text))
                        messages.append(HumanMessage(content=synthesis_content))
                        continue

                # Normal completion — persist and return
                if pc:
                    asyncio.create_task(
                        pc.subagent_message(record, seq=msg_seq, role="assistant", content=text)
                    )
                return text

            # Tool calls — execute them in parallel
            if result.tool_calls:
                # Persist assistant tool-call turn
                tc_meta = [
                    {"name": tc.name, "args": tc.args, "id": tc.id} for tc in result.tool_calls
                ]
                if pc:
                    asyncio.create_task(
                        pc.subagent_message(
                            record,
                            seq=msg_seq,
                            role="assistant",
                            content="",
                            metadata={"tool_calls": tc_meta},
                        )
                    )
                msg_seq += 1

                # Pre-record start times for progress tracking
                _step_start_times: Dict[str, float] = {
                    tc.id: time.time() for tc in result.tool_calls
                }

                # Session ID routing wrapper:
                # MCP tools → root_sid (file sharing), Skill tools → session_id (plan state isolation)
                async def _routed_execute(name: str, args: Dict[str, Any], sid: str = "") -> str:
                    tool_sid = root_sid if name in ctx.mcp_client.display_names else sid
                    return await ctx.execute_tool(name, args, session_id=tool_sid)

                # Progress tracking callback
                async def _on_complete(tc: Any, result_str: str) -> None:
                    _dn = (
                        ctx.mcp_client.display_names.get(tc.name)
                        or ctx.skill_controller.display_names.get(tc.name)
                        or tc.name
                    )
                    is_error = result_str.startswith("Error")

                    class _Step:
                        pass

                    step = _Step()
                    step.tool_name = tc.name
                    step.detail = _tool_detail(tc.name, tc.args)
                    step.status = "failed" if is_error else "completed"
                    step.started_at = _step_start_times.get(tc.id, time.time())
                    step.completed_at = time.time()
                    step.display_name = _dn
                    record.progress_log.append(step)
                    # Cap log size: keep last 200 entries
                    if len(record.progress_log) > 200:
                        record.progress_log = record.progress_log[-200:]

                # Parallel execution via ToolController
                parallel_results = await ctx.tool_controller.execute_parallel(
                    result.tool_calls, _routed_execute, session_id, on_complete=_on_complete
                )

                tool_results = [
                    ToolMessage(
                        content=result_str,
                        tool_call_id=tc.id,
                        name=tc.name,
                    )
                    for tc, result_str in parallel_results
                ]

                # Persist each tool result
                if pc:
                    for tr in tool_results:
                        asyncio.create_task(
                            pc.subagent_message(
                                record,
                                seq=msg_seq,
                                role="tool",
                                content=tr.content,
                                tool_call_id=tr.tool_call_id or "",
                                tool_name=tr.name or "",
                            )
                        )
                        msg_seq += 1
                else:
                    msg_seq += len(tool_results)

                await child_service.append_tool_interaction(
                    session_id,
                    messages,
                    [tc.model_dump() for tc in result.tool_calls],
                    tool_results,
                    usage=result.usage.model_dump() if result.usage else {},
                    assistant_lc_message=result.assistant_lc_message,
                )
                messages = []  # Continue without new user messages

        if ctx.messages:
            max_iterations_message, _ = await ctx.messages.resolve(
                "subagent.max_iterations",
                session_id=session_id,
            )
            return max_iterations_message
        return "Sub-agent reached maximum iterations."
    finally:
        await child_service.aclose()


# ---------------------------------------------------------------------------
# Announce completion
# ---------------------------------------------------------------------------


async def _announce_completion(
    record: Any,
    summary: str,
    max_retries: int = 3,
) -> None:
    """Append a SystemMessage to the parent session announcing completion.

    Retries with exponential backoff if the parent session is locked.
    """
    ctx = _get_context()
    if ctx.messages:
        summary_text, _ = await ctx.messages.resolve(
            "subagent.completion",
            task=record.task[:200],
            summary=summary[:500],
        )
    else:
        summary_text = f"[Sub-agent completed] Task: {record.task[:200]}\nResult: {summary[:500]}"
    msg = LCSystemMessage(content=summary_text)

    for attempt in range(max_retries):
        try:
            ctx = _get_context()
            lc_sessions = ctx.agent_service._sessions
            if record.parent_session_id in lc_sessions:
                lc_sessions[record.parent_session_id].append(msg)
                logger.info(
                    "Sub-agent %s completion announced to parent %s",
                    record.child_session_id,
                    record.parent_session_id,
                )
                return
            else:
                logger.warning(
                    "Parent session %s not found for sub-agent %s",
                    record.parent_session_id,
                    record.child_session_id,
                )
                return
        except Exception as e:
            delay = 2**attempt
            logger.warning(
                "Failed to announce sub-agent completion (attempt %d/%d): %s. Retrying in %ds.",
                attempt + 1,
                max_retries,
                e,
                delay,
            )
            await asyncio.sleep(delay)

    logger.error(
        "Failed to announce sub-agent %s completion after %d retries",
        record.child_session_id,
        max_retries,
    )
