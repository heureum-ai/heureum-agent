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
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set

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

# Default client tools provided to sub-agents when no explicit tools/skills are
# specified.  Keeps the tool count well below OpenAI's 128-tool limit.
_DEFAULT_SUBAGENT_CLIENT_TOOLS: frozenset[str] = frozenset({
    "read", "write", "edit", "grep", "find", "ls",
})


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
    client_tool_schemas: List[dict] = field(default_factory=list)   # Client tool schemas for relay
    client_tool_names: Set[str] = field(default_factory=set)        # Client tool names for relay


_context: SubagentContext | None = None

# Registry of active sub-agent services keyed by session_id.
# This allows _announce_completion to find depth-1 orchestrators whose history
# lives in their own isolated child_service, not in ctx.agent_service._sessions.
_subagent_services: Dict[str, Any] = {}


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
        from app.services.client_relay import relay
        relay.clear_session(session_id)
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
    final_usage = None
    try:
        summary, usage = await asyncio.wait_for(
            _execute_subagent_task(record, request, registry),
            timeout=settings.SUBAGENT_TIMEOUT_SECONDS,
        )
        final_status = "completed"
        final_summary = summary
        final_usage = usage
        registry.mark_completed(record.child_session_id, "completed", summary)
        await _announce_completion(record, summary)
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
                usage_dict = final_usage.model_dump() if final_usage else None
                enqueue = getattr(pc, "enqueue_subagent_run_complete", None)
                if callable(enqueue):
                    enqueue(record, final_status, final_summary, usage=usage_dict)
                else:
                    await pc.subagent_run_complete(
                        record, final_status, final_summary, usage=usage_dict
                    )
        except Exception:
            pass

        # Cleanup
        if request.cleanup == "delete":
            clear_depth_fn(record.child_session_id)
            cleanup_session_state(record.child_session_id)


def _build_subagent_instructions(task: str, tool_names: List[str], can_spawn: bool = False) -> str:
    """Build a dynamic system prompt instruction block for the sub-agent."""
    if can_spawn:
        return _build_orchestrator_hybrid_instructions(task, tool_names)
    return _build_leaf_instructions(task, tool_names)


def _build_orchestrator_hybrid_instructions(task: str, tool_names: List[str]) -> str:
    """2-phase orchestrator prompt: planning → execution management."""
    # Build dynamic skill catalogue via public API
    skill_lines = ""
    try:
        ctx = _get_context()
        if ctx.skill_controller and hasattr(ctx.skill_controller, "get_delegatable_skill_map"):
            skill_map = ctx.skill_controller.get_delegatable_skill_map()
            parts = [f"- {key}: {', '.join(sorted(tools))}" for key, tools in skill_map.items()]
            if parts:
                skill_lines = (
                    "## Available Skills for Sub-agents\n"
                    "When spawning sub-agents, assign appropriate skills via the `skills` parameter:\n"
                    + "\n".join(parts) + "\n"
                    "Each sub-agent receives ONLY the tools defined in its assigned skills.\n\n"
                )
    except Exception:
        pass

    return (
        "You are an orchestrator agent. Complete the task in two phases.\n\n"
        f"## Task\n{task}\n\n"
        f"## Available Tools\n{', '.join(tool_names)}\n\n"
        + skill_lines
        + "## Phase 1: Planning\n"
        "Analyze the request systematically:\n"
        "1. **Query Analysis**: What information categories are needed?\n"
        "2. **Task Decomposition**: Break into atomic, delegatable tasks\n"
        "3. **Categorize each task**: research | analysis | synthesis | verification\n"
        "4. **Dependencies**: Which tasks can run in parallel? Which must be sequential?\n"
        "5. **Verification**: Always include a final synthesis/verification task\n\n"
        "Use manage_todo(action='create') to define your plan.\n"
        "Use manage_todo(action='thinking_checkpoint', phase='pre_plan') to begin execution.\n\n"
        "## Phase 2: Execution\n"
        "- Spawn sub-agents ONLY for tasks whose depends_on are ALL completed\n"
        "- Monitor completion via sessions_spawn_status before spawning dependent tasks\n"
        "- CRITICAL: NEVER spawn a task before its dependencies finish — "
        "always use depends_on=[predecessor_child_session_id] to chain results\n"
        "- After ALL complete, synthesize into a comprehensive summary\n"
        "- Use manage_todo(action='thinking_checkpoint', phase='post_plan') to finalize\n\n"
        "## Rules\n"
        "- Do NOT do the research yourself — always delegate via sub-agents\n"
        "- Each sub-agent task must be self-contained and specific\n"
        "- Sequential tasks (A → B) MUST use depends_on so B receives A's result\n"
        "- Final summary must directly answer the user's original request\n"
        "- Avoid creating too many tasks (max 5-7 for most queries)"
    )


def _build_leaf_instructions(task: str, tool_names: List[str]) -> str:
    """Leaf sub-agent prompt — direct execution without spawning."""
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
        "\n## Tool Usage Rules\n"
        "- 'ls': list directory contents — use this to see files in a directory\n"
        "- 'read': read a SINGLE FILE's content — do NOT use 'read' on a directory path\n"
        "- 'write': create or overwrite a file with given content\n"
        "- 'edit': replace specific text in an existing file\n"
        "- 'grep': search for patterns inside files\n"
        "- 'find': search for files by name or pattern\n"
        "\n## Constraints\n"
        "- Complete the task autonomously without user interaction.\n"
        "- If a tool call fails, try an alternative approach.\n"
        "- Do NOT spawn sub-agents — execute steps directly."
    )
    return "\n".join(lines)


def _resolve_child_tools(
    request: Any,
) -> tuple:
    """Resolve MCP tools and skill_controller for the child agent.

    Uses a three-tier priority:
      1. ``request.tools`` — explicit tool whitelist (backward compat)
      2. ``request.skills`` — skill-based resolution from PSA snapshot
      3. Fallback — all tools minus deny-list

    Deny-list filtering (depth-based) is always applied.

    Returns:
        (mcp_tools, skill_controller, tool_names) — ready for AgentService init.
    """
    ctx = _get_context()

    parent_mcp_tools = ctx.agent_service.mcp_tool_controller.get_tool_schemas() or []
    child_skill_controller = ctx.skill_controller

    # Resolve depth for deny-list
    from app.skills.plan_task.service import get_subagent_depth, _config

    depth = get_subagent_depth(request.parent_session_id) + 1
    max_depth = _config["max_spawn_depth"]
    denied = ctx.skill_controller.get_subagent_denied_tools(depth, max_depth)

    # Priority: explicit tools > skills > all
    if request.tools:
        allowed = set(request.tools) - denied
    elif getattr(request, "skills", None):
        # Skill-schema based resolution: SKILL.md tools only — no auto-injection
        allowed = ctx.skill_controller.resolve_skill_tools(
            request.skills, session_id=request.parent_session_id
        )
    else:
        # Fallback: all tools minus deny-list
        if denied:
            all_names = {
                t.get("function", {}).get("name") for t in parent_mcp_tools
            }
            if child_skill_controller:
                for s in child_skill_controller.get_all_tool_schemas():
                    all_names.add(s.get("function", {}).get("name"))
            allowed = all_names - denied
        else:
            allowed = None  # no filtering

    # Apply filtering
    if allowed is not None:
        child_mcp_tools = [
            t
            for t in parent_mcp_tools
            if t.get("function", {}).get("name") in allowed
        ]
        if ctx.skill_controller:
            child_skill_controller = ctx.skill_controller.filtered(allowed)
    else:
        child_mcp_tools = list(parent_mcp_tools)

    # Collect tool names for instructions
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
) -> tuple[str, "Usage"]:
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

    # Inherit tools from parent (resolves allowed set via skills/whitelist)
    child_mcp_tools, child_skill_controller, tool_names = _resolve_child_tools(request)

    # Capture client tool info at task creation time, filtered by the same
    # allow-set that _resolve_child_tools computed for MCP/skill tools.
    # This prevents passing 100+ client tools to the LLM when only a handful
    # are relevant for the sub-agent's skill scope.
    _resolved_allowed: Optional[Set[str]] = None
    if getattr(request, "tools", None):
        _resolved_allowed = set(request.tools)
    elif getattr(request, "skills", None):
        try:
            _resolved_allowed = ctx.skill_controller.resolve_skill_tools(
                request.skills, session_id=request.parent_session_id
            )
        except Exception:
            pass

    if _resolved_allowed is not None:
        child_client_schemas: List[dict] = [
            s for s in ctx.client_tool_schemas
            if s.get("function", {}).get("name") in _resolved_allowed
        ]
        child_client_names: Set[str] = ctx.client_tool_names & _resolved_allowed
        # Always supplement with default file tools so sub-agents can do file I/O
        # regardless of skill filtering. A skill may allow only "write" but the
        # sub-agent also needs read/edit/grep/find/ls to operate effectively.
        _existing_names = {s.get("function", {}).get("name") for s in child_client_schemas}
        for _s in ctx.client_tool_schemas:
            _name = _s.get("function", {}).get("name")
            if _name and _name in _DEFAULT_SUBAGENT_CLIENT_TOOLS and _name not in _existing_names:
                child_client_schemas.append(_s)
                child_client_names.add(_name)
                _existing_names.add(_name)
    else:
        # No explicit allow-set: fall back to a small default set to avoid
        # exceeding OpenAI's 128-tool limit when the full client tool list is large.
        child_client_schemas = [
            s for s in ctx.client_tool_schemas
            if s.get("function", {}).get("name") in _DEFAULT_SUBAGENT_CLIENT_TOOLS
        ]
        child_client_names = ctx.client_tool_names & _DEFAULT_SUBAGENT_CLIENT_TOOLS

    # MCP tool availability pre-validation — remove unavailable tools early
    mcp_tool_names = {t.get("function", {}).get("name") for t in child_mcp_tools}
    available_names = set(ctx.mcp_client.server_tool_names or set())
    missing = mcp_tool_names - available_names
    if missing:
        # One re-discovery attempt
        try:
            await ctx.mcp_client.discover_tools()
            available_names = set(ctx.mcp_client.server_tool_names or set())
            missing = mcp_tool_names - available_names
        except Exception:
            pass
        if missing:
            logger.warning(
                "Sub-agent %s: unavailable MCP tools removed: %s",
                session_id, missing,
            )
            child_mcp_tools = [
                t for t in child_mcp_tools
                if t.get("function", {}).get("name") not in missing
            ]
            # Rebuild tool_names list
            tool_names = [t.get("function", {}).get("name", "?") for t in child_mcp_tools]
            if child_skill_controller:
                for schema in child_skill_controller.get_all_tool_schemas():
                    n = schema.get("function", {}).get("name")
                    if n:
                        tool_names.append(n)

    # Create isolated agent service with inherited tools
    child_service = AgentService(
        mcp_tools=child_mcp_tools,
        skill_provider=child_skill_controller,
    )

    # Build dynamic instructions — allow spawning if depth permits
    from app.skills.plan_task.service import get_subagent_depth, _config

    session_id = record.child_session_id
    # Register child service so depth-2 sub-agents can announce to this orchestrator.
    # Must be registered AFTER session_id is assigned.
    _subagent_services[session_id] = child_service
    depth = get_subagent_depth(session_id)
    can_spawn = depth < _config["max_spawn_depth"]
    instructions = _build_subagent_instructions(request.task, tool_names, can_spawn=can_spawn)

    # Usage accumulator for token tracking
    from app.schemas.open_responses import Usage

    total_usage = Usage.zero()

    # Pre-initialize child session to avoid rehydration network calls.
    child_service.message_controller.session_state_controller.set_session(session_id, [])
    messages = [HumanMessage(content=request.task)]

    # --- Persist: run start (best-effort, background) ---
    pc = ctx.persist_controller
    root_sid = _root_session_id(request.parent_session_id, registry)
    try:
        prompt, _ = child_service._prepare_prompt_and_tools(instructions=instructions, is_subagent=True)
    except Exception:
        prompt = ""
    if pc:
        enqueue = getattr(pc, "enqueue_subagent_run_start", None)
        if callable(enqueue):
            enqueue(record, root_session_id=root_sid, system_prompt=prompt)
        else:
            await pc.subagent_run_start(record, root_session_id=root_sid, system_prompt=prompt)

    # Message sequence counter for persist
    msg_seq = 0

    # Persist initial user message (seq=0)
    if pc:
        enqueue = getattr(pc, "enqueue_subagent_message", None)
        if callable(enqueue):
            enqueue(record, seq=msg_seq, role="user", content=request.task)
        else:
            await pc.subagent_message(record, seq=msg_seq, role="user", content=request.task)
    msg_seq += 1

    max_iterations = settings.SUBAGENT_MAX_ITERATIONS

    plan_retry_count = 0
    _consecutive_polls = 0

    try:
        for iteration in range(1, max_iterations + 1):
            record.current_iteration = iteration

            result = await child_service.process_messages_with_tools(
                messages=messages,
                session_id=session_id,
                instructions=instructions,
                skills_prompt=request.skills_prompt,
                client_tool_schemas=child_client_schemas,
                client_tool_names=child_client_names,
                is_subagent=True,
            )

            # Accumulate usage from each iteration
            if result and result.usage:
                total_usage = total_usage.add(result.usage)

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
                    enqueue = getattr(pc, "enqueue_subagent_message", None)
                    if callable(enqueue):
                        enqueue(record, seq=msg_seq, role="assistant", content=text)
                    else:
                        await pc.subagent_message(record, seq=msg_seq, role="assistant", content=text)
                return text, total_usage

            # Tool calls — execute them in parallel
            if result.tool_calls:
                # Persist assistant tool-call turn
                tc_meta = [
                    {"name": tc.name, "args": tc.args, "id": tc.id} for tc in result.tool_calls
                ]
                if pc:
                    enqueue = getattr(pc, "enqueue_subagent_message", None)
                    if callable(enqueue):
                        enqueue(
                            record,
                            seq=msg_seq,
                            role="assistant",
                            content="",
                            metadata={"tool_calls": tc_meta},
                        )
                    else:
                        await pc.subagent_message(
                            record,
                            seq=msg_seq,
                            role="assistant",
                            content="",
                            metadata={"tool_calls": tc_meta},
                        )
                msg_seq += 1

                # Pre-record start times for progress tracking
                _step_start_times: Dict[str, float] = {
                    tc.id: time.time() for tc in result.tool_calls
                }

                # Session ID routing wrapper:
                # Client tools → relay (Electron executes), MCP tools → root_sid,
                # Skill tools → session_id (plan state isolation)
                async def _routed_execute(name: str, args: Dict[str, Any], sid: str = "") -> str:
                    if name in child_client_names:
                        from app.services.client_relay import relay
                        return await relay.request_tool(root_sid, name, args)
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
                    enqueue = getattr(pc, "enqueue_subagent_message", None)
                    for tr in tool_results:
                        if callable(enqueue):
                            enqueue(
                                record,
                                seq=msg_seq,
                                role="tool",
                                content=tr.content,
                                tool_call_id=tr.tool_call_id or "",
                                tool_name=tr.name or "",
                            )
                        else:
                            await pc.subagent_message(
                                record,
                                seq=msg_seq,
                                role="tool",
                                content=tr.content,
                                tool_call_id=tr.tool_call_id or "",
                                tool_name=tr.name or "",
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

                # Fix 8-2: Sliding window — cap session history to reduce token usage
                _hist = child_service._sessions.get(session_id)
                if _hist and len(_hist) > settings.SUBAGENT_MAX_HISTORY_SIZE:
                    _tail = _hist[-(settings.SUBAGENT_MAX_HISTORY_SIZE - 1):]
                    # Strip orphaned leading ToolMessages — they have no preceding
                    # AIMessage(tool_calls) in the retained window, which causes
                    # OpenAI "messages with role 'tool' must follow tool_calls" errors.
                    while _tail and isinstance(_tail[0], ToolMessage):
                        _tail = _tail[1:]
                    child_service._sessions[session_id] = _hist[:1] + _tail

                # Fix 8-3: Polling throttle — slow down if only polling status
                is_poll_only = all(
                    tc.name == "sessions_spawn_status" for tc in result.tool_calls
                )
                if is_poll_only:
                    _consecutive_polls += 1
                    if _consecutive_polls > settings.SUBAGENT_POLL_THROTTLE_THRESHOLD:
                        await asyncio.sleep(settings.SUBAGENT_POLL_THROTTLE_DELAY)
                else:
                    _consecutive_polls = 0

        if ctx.messages:
            max_iterations_message, _ = await ctx.messages.resolve(
                "subagent.max_iterations",
                session_id=session_id,
            )
            return max_iterations_message, total_usage
        return "Sub-agent reached maximum iterations.", total_usage
    finally:
        _subagent_services.pop(session_id, None)
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
            summary=summary[:2000],
        )
    else:
        summary_text = f"[Sub-agent completed] Task: {record.task[:200]}\nResult: {summary[:2000]}"
    msg = LCSystemMessage(content=summary_text)

    for attempt in range(max_retries):
        try:
            ctx = _get_context()
            # Check sub-agent service registry first (for depth-2 → depth-1 announcements).
            # Depth-1 orchestrators store their history in their own isolated child_service,
            # not in ctx.agent_service._sessions, so we must check the registry.
            _parent_svc = _subagent_services.get(record.parent_session_id)
            lc_sessions = _parent_svc._sessions if _parent_svc is not None else ctx.agent_service._sessions
            if record.parent_session_id in lc_sessions:
                lc_sessions[record.parent_session_id].append(msg)
                logger.info(
                    "Sub-agent %s completion announced to parent %s",
                    record.child_session_id,
                    record.parent_session_id,
                )
                # Trigger lightweight compaction check on the parent session.
                # Multiple sub-agents completing simultaneously can cause
                # context to spike unpredictably; this keeps it bounded.
                try:
                    parent_svc_for_compact = _parent_svc or ctx.agent_service
                    await parent_svc_for_compact._maybe_proactive_compact(
                        record.parent_session_id, []
                    )
                except Exception:
                    pass  # best-effort — don't block announcement
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
