# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Sub-agent spawning — isolated child agent instances for parallel task execution.

Design principles:
  - Each child uses a **new AgentService instance** → full session isolation
  - Parent connection is minimal: _announce_completion appends SystemMessage
  - Depth tracking prevents recursive spawning beyond configured limit
  - Timeout and error handling ensure cleanup on failure

NOTE: ``app.routers.agent`` is imported **lazily** inside functions that need
it (``_resolve_child_tools``, ``_execute_subagent_task``, ``_run_subagent``,
``_announce_completion``) because:
  1. Circular dependency at module load time:
     agent.py → SkillProvider → sessions_spawn/__init__ → (subagent.py)
  2. ``from … import agent_service`` would capture the *original* object;
     ``unittest.mock.patch`` on the module attribute would not be visible
     here.  Importing inside the function ensures we always read the
     current (possibly patched) value.
"""

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set

from app.config import settings
from app.models import LLMResultType, Message
from app.schemas.open_responses import MessageRole
from app.services.agent_service import AgentService
from langchain_core.messages import SystemMessage

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------


@dataclass
class ProgressStep:
    """A single tool call progress entry within a sub-agent run."""

    tool_name: str
    detail: str
    status: str = "running"  # "running" | "completed" | "failed"
    started_at: float = field(default_factory=time.time)
    completed_at: Optional[float] = None


@dataclass
class SpawnRequest:
    """Request to spawn a sub-agent."""

    parent_session_id: str
    task: str
    tools: Optional[List[str]] = None
    cleanup: str = "delete"  # "keep" or "delete"
    # Orchestrator integration
    announce: bool = True  # Whether to announce completion to parent session
    system_prompt: Optional[str] = None  # Override default subagent instructions
    orchestrator_mode: bool = False  # Skip depth/children limits
    max_iterations: Optional[int] = None  # Override default max iterations
    step_name: Optional[str] = None  # Workflow step name for UI mapping


@dataclass
class SpawnResult:
    """Result from a spawn attempt."""

    status: str  # "accepted", "forbidden", "error"
    child_session_id: str = ""
    message: str = ""


@dataclass
class SubagentRunRecord:
    """Tracks a single sub-agent run."""

    child_session_id: str
    parent_session_id: str
    task: str
    status: str = "running"  # "running", "completed", "failed", "timeout"
    started_at: float = field(default_factory=time.time)
    completed_at: Optional[float] = None
    result_summary: str = ""
    asyncio_task: Optional[asyncio.Task] = None
    progress_log: List[ProgressStep] = field(default_factory=list)
    current_iteration: int = 0
    step_name: Optional[str] = None  # Workflow step name for UI mapping


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------


class SubagentRegistry:
    """Tracks active and completed sub-agent runs."""

    # Completed records older than this are eligible for GC.
    STALE_TTL_SECONDS: float = 600  # 10 minutes

    def __init__(self) -> None:
        self._runs: Dict[str, SubagentRunRecord] = {}

    def register(self, record: SubagentRunRecord) -> None:
        self._runs[record.child_session_id] = record

    def get(self, child_session_id: str) -> Optional[SubagentRunRecord]:
        return self._runs.get(child_session_id)

    def count_active(self, parent_session_id: str) -> int:
        return sum(
            1
            for r in self._runs.values()
            if r.parent_session_id == parent_session_id and r.status == "running"
        )

    def mark_completed(
        self,
        child_session_id: str,
        status: str = "completed",
        summary: str = "",
    ) -> None:
        record = self._runs.get(child_session_id)
        if record:
            record.status = status
            record.completed_at = time.time()
            record.result_summary = summary

    def list_by_parent(self, parent_session_id: str) -> List[SubagentRunRecord]:
        """Return all runs (active and completed) for a parent session."""
        return [r for r in self._runs.values() if r.parent_session_id == parent_session_id]

    def cleanup(self, child_session_id: str) -> None:
        self._runs.pop(child_session_id, None)

    def sweep_stale(self) -> List[str]:
        """Remove completed/failed/timeout records older than STALE_TTL_SECONDS.

        Also cleans up associated depth tracking and shared service state
        for records that used cleanup="keep" (deferred cleanup).

        Returns the list of swept child_session_ids.
        """
        now = time.time()
        stale_ids: List[str] = []
        for sid, record in list(self._runs.items()):
            if record.status == "running":
                continue
            completed_at = record.completed_at or record.started_at
            if now - completed_at > self.STALE_TTL_SECONDS:
                stale_ids.append(sid)

        for sid in stale_ids:
            self._runs.pop(sid, None)
            # Clean depth tracking
            _clear_depth(sid)
            # Clean shared service state (covers deferred "keep" cleanup)
            try:
                from app.routers.agent import chain_registry, mcp_client, skill_provider
                from app.services.loop_detection import clear_session_loop_state

                mcp_client.clear_session_state(sid)
                chain_registry.clear_session(sid)
                skill_provider.clear_session(sid)
                clear_session_loop_state(sid)
            except Exception:
                pass

        if stale_ids:
            logger.info("Swept %d stale subagent records: %s", len(stale_ids), stale_ids)
        return stale_ids


# Module-level singleton
_registry = SubagentRegistry()


def get_registry() -> SubagentRegistry:
    return _registry


# ---------------------------------------------------------------------------
# Depth tracking
# ---------------------------------------------------------------------------

_session_depth: Dict[str, int] = {}


def get_subagent_depth(session_id: str) -> int:
    """Get the spawn depth of a session (0 = root)."""
    return _session_depth.get(session_id, 0)


def _set_child_depth(child_session_id: str, parent_session_id: str) -> None:
    """Set child depth = parent depth + 1."""
    parent_depth = get_subagent_depth(parent_session_id)
    _session_depth[child_session_id] = parent_depth + 1


def _clear_depth(session_id: str) -> None:
    """Remove depth tracking for a session."""
    _session_depth.pop(session_id, None)


# ---------------------------------------------------------------------------
# Session ↔ step context (for filesystem result persistence)
# ---------------------------------------------------------------------------

_session_step_context: Dict[str, Dict[str, Any]] = {}


def set_session_step_context(
    session_id: str, step_name: str, result_store: Any,
) -> None:
    """Register which orchestration step a supervisor session belongs to.

    Called by TeamExecutor after spawning a step sub-agent so that
    ``_persist_subagent_to_store`` can locate the correct result store
    and step directory.
    """
    _session_step_context[session_id] = {
        "step_name": step_name,
        "result_store": result_store,
    }


def get_session_step_context(session_id: str) -> Optional[Dict[str, Any]]:
    """Return the step context for *session_id*, or *None*."""
    return _session_step_context.get(session_id)


def clear_session_step_context(session_id: str) -> None:
    """Remove the step context for *session_id*."""
    _session_step_context.pop(session_id, None)


def _resolve_root_session_id(session_id: str) -> str:
    """Walk up the parent chain to find the root (platform) session ID.

    Sub-agent session IDs (``subagent_*``) are transient and don't exist
    in the platform DB.  This function traces the parent chain until it
    reaches a real session ID (e.g. ``sess_*``).
    """
    visited: set = set()
    current = session_id
    while current.startswith("subagent_"):
        if current in visited:
            break  # cycle guard
        visited.add(current)
        record = _registry.get(current)
        if not record:
            break
        current = record.parent_session_id
    return current


# ---------------------------------------------------------------------------
# Spawn
# ---------------------------------------------------------------------------


async def spawn_subagent(request: SpawnRequest) -> SpawnResult:
    """Spawn a sub-agent task.

    Validates depth and children limits, then creates an async task
    for the sub-agent execution.  When ``orchestrator_mode`` is set,
    depth and children limits are bypassed so the workflow engine can
    spawn as many parallel steps as needed.

    Args:
        request: The spawn request with task description and config.

    Returns:
        SpawnResult with status and child session ID.
    """
    if not request.orchestrator_mode:
        # Depth check
        depth = get_subagent_depth(request.parent_session_id)
        if depth >= settings.SUBAGENT_MAX_SPAWN_DEPTH:
            return SpawnResult(
                status="forbidden",
                message=f"Maximum spawn depth ({settings.SUBAGENT_MAX_SPAWN_DEPTH}) reached. "
                "Sub-agents cannot spawn their own sub-agents.",
            )

        # Children limit check
        active = _registry.count_active(request.parent_session_id)
        if active >= settings.SUBAGENT_MAX_CHILDREN:
            return SpawnResult(
                status="forbidden",
                message=f"Maximum concurrent children ({settings.SUBAGENT_MAX_CHILDREN}) reached.",
            )

    # Create child session
    child_session_id = f"subagent_{uuid.uuid4().hex[:12]}"
    if not request.orchestrator_mode:
        _set_child_depth(child_session_id, request.parent_session_id)

    record = SubagentRunRecord(
        child_session_id=child_session_id,
        parent_session_id=request.parent_session_id,
        task=request.task,
        step_name=request.step_name,
    )
    _registry.register(record)

    # Launch async task
    task = asyncio.create_task(
        _run_subagent(record, request),
        name=f"subagent-{child_session_id}",
    )
    record.asyncio_task = task

    log_depth = 0 if request.orchestrator_mode else get_subagent_depth(child_session_id)
    logger.info(
        "Spawned sub-agent %s for parent %s (depth=%d, orchestrator=%s, task=%s)",
        child_session_id,
        request.parent_session_id,
        log_depth,
        request.orchestrator_mode,
        request.task[:100],
    )

    return SpawnResult(
        status="accepted",
        child_session_id=child_session_id,
        message="Sub-agent spawned. It will report back when done.",
    )


# ---------------------------------------------------------------------------
# Run
# ---------------------------------------------------------------------------


def _persist_subagent_to_store(record: SubagentRunRecord) -> None:
    """Save a sub-agent result to the filesystem if a step context exists.

    No-op when the parent session is not part of an orchestrated workflow
    (i.e. ``_session_step_context`` has no entry for the parent).
    """
    ctx = get_session_step_context(record.parent_session_id)
    if not ctx:
        return
    try:
        ctx["result_store"].save_subagent_result(
            step_name=ctx["step_name"],
            child_session_id=record.child_session_id,
            task=record.task,
            status=record.status,
            result_summary=record.result_summary,
        )
    except Exception:
        logger.warning(
            "Failed to persist subagent %s to store", record.child_session_id, exc_info=True,
        )


async def _run_subagent(record: SubagentRunRecord, request: SpawnRequest) -> None:
    """Execute the sub-agent task with timeout handling."""
    try:
        result = await asyncio.wait_for(
            _execute_subagent_task(record, request),
            timeout=settings.SUBAGENT_TIMEOUT_SECONDS,
        )
        _registry.mark_completed(record.child_session_id, "completed", result)
        _persist_subagent_to_store(record)
        if request.announce:
            await _announce_completion(record, result)
    except asyncio.TimeoutError:
        logger.warning("Sub-agent %s timed out", record.child_session_id)
        _registry.mark_completed(record.child_session_id, "timeout", "Task timed out")
        _persist_subagent_to_store(record)
        if request.announce:
            await _announce_completion(record, "Sub-agent task timed out.")
    except asyncio.CancelledError:
        logger.info("Sub-agent %s cancelled", record.child_session_id)
        _registry.mark_completed(record.child_session_id, "failed", "Cancelled")
        _persist_subagent_to_store(record)
    except Exception as e:
        logger.warning("Sub-agent %s failed: %s", record.child_session_id, e)
        _registry.mark_completed(record.child_session_id, "failed", str(e))
        _persist_subagent_to_store(record)
        if request.announce:
            await _announce_completion(record, f"Sub-agent task failed: {e}")
    finally:
        # Cleanup
        clear_session_step_context(record.child_session_id)
        if request.cleanup == "delete":
            _clear_depth(record.child_session_id)
            try:
                # Lazy: circular dep + must read current (patchable) attributes
                from app.routers.agent import chain_registry, mcp_client, skill_provider
                from app.services.loop_detection import clear_session_loop_state

                mcp_client.clear_session_state(record.child_session_id)
                chain_registry.clear_session(record.child_session_id)
                skill_provider.clear_session(record.child_session_id)
                clear_session_loop_state(record.child_session_id)
            except Exception:
                pass


def _build_subagent_instructions(task: str, tool_names: List[str]) -> str:
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
        "\n## Constraints\n"
        "- Complete the task autonomously without user interaction.\n"
        "- If a tool call fails, try an alternative approach.\n"
        "- Provide a concise result summary when finished."
    )
    return "\n".join(lines)


class _FilteredSkillProvider:
    """SkillProvider wrapper that restricts tools to an allowlist."""

    def __init__(self, base, allowed_tools: Set[str]) -> None:
        self._base = base
        self._allowed = allowed_tools

    def get_all_tool_schemas(self):
        return [
            s
            for s in self._base.get_all_tool_schemas()
            if s.get("function", {}).get("name") in self._allowed
        ]

    async def execute_tool(self, name, arguments, session_id):
        if name not in self._allowed:
            raise KeyError(f"Tool '{name}' not allowed for this sub-agent")
        return await self._base.execute_tool(name, arguments, session_id)

    def get_skill_for_tool(self, tool_name):
        if tool_name not in self._allowed:
            return None
        return self._base.get_skill_for_tool(tool_name)

    def get_all_guide_prompts(self):
        return self._base.get_all_guide_prompts()

    def get_state_prompts(self, session_id):
        return self._base.get_state_prompts(session_id)

    def clear_session(self, session_id):
        self._base.clear_session(session_id)

    async def await_pending(self, session_id, timeout=300.0):
        await self._base.await_pending(session_id, timeout)


def _resolve_child_tools(
    request: SpawnRequest,
) -> tuple:
    """Resolve MCP tools and skill_provider for the child agent.

    Inherits from the global parent agent_service, optionally filtered
    by request.tools whitelist.  Approval-required tools are always
    excluded because sub-agents cannot perform interactive approval.

    Returns:
        (mcp_tools, skill_provider, tool_names) — ready for AgentService init.
    """
    # Lazy: circular dep + must read current (patchable) module attributes
    from app.routers.agent import (
        agent_service,
        mcp_client,
    )
    from app.routers.agent import skill_provider as global_skill_provider

    parent_mcp_tools = agent_service.mcp_tools or []
    child_skill_provider = global_skill_provider

    # Approval-required tools cannot be used by sub-agents (no interactive
    # approval), UNLESS orchestrator_mode is set — workflow steps are
    # pre-approved so they may use all requested tools.
    approval_required = (
        set()
        if request.orchestrator_mode
        else getattr(mcp_client, "_approval_required_tools", set())
    )

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
        if global_skill_provider:
            child_skill_provider = _FilteredSkillProvider(global_skill_provider, allowed)
    else:
        child_mcp_tools = [
            t
            for t in parent_mcp_tools
            if t.get("function", {}).get("name") not in approval_required
        ]

    # Collect tool names for the instructions
    tool_names = [t.get("function", {}).get("name", "?") for t in child_mcp_tools]
    if child_skill_provider:
        for schema in child_skill_provider.get_all_tool_schemas():
            name = schema.get("function", {}).get("name")
            if name:
                tool_names.append(name)

    return child_mcp_tools, child_skill_provider, tool_names


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


def _has_active_children(session_id: str) -> bool:
    """Check if any sub-agents are still running for this session."""
    return any(r.status == "running" for r in _registry.list_by_parent(session_id))


async def _wait_and_inject_children(
    child_service: AgentService,
    session_id: str,
    injected: set,
) -> None:
    """Wait for active sub-agents and inject results into the supervisor session."""
    await await_active_subagents(session_id, timeout=settings.SUBAGENT_TIMEOUT_SECONDS)
    for record in _registry.list_by_parent(session_id):
        if record.child_session_id in injected or record.status == "running":
            continue
        injected.add(record.child_session_id)
        label = record.status
        # Primary: in-memory result; fallback: filesystem
        summary = record.result_summary
        if not summary:
            ctx = get_session_step_context(session_id)
            if ctx:
                summary = ctx["result_store"].read_subagent_result(
                    ctx["step_name"], record.child_session_id,
                ) or ""
        content = (
            f"[Sub-agent {label}] Task: {record.task[:200]}\n"
            f"Result: {summary[:1000]}"
        )
        child_service._lc_sessions[session_id].append(SystemMessage(content=content))


async def _execute_subagent_task(
    record: SubagentRunRecord,
    request: SpawnRequest,
) -> str:
    """Run a simplified agent loop for the sub-agent.

    Creates a fresh AgentService instance with dynamically inherited tools
    and a task-specific system prompt, then loops until the LLM returns
    a text response (no more tool calls).
    """
    # Lazy: circular dep + must read current (patchable) attribute
    from app.routers.agent import _execute_tool, mcp_client

    # Resolve the root (platform) session ID so MCP file operations
    # target the real session in the platform DB, not a transient subagent ID.
    root_session_id = _resolve_root_session_id(record.child_session_id)

    # Inherit tools from parent
    child_mcp_tools, child_skill_provider, tool_names = _resolve_child_tools(request)

    # Create isolated agent service with inherited tools
    child_service = AgentService(
        mcp_tools=child_mcp_tools,
        skill_provider=child_skill_provider,
    )

    # Build dynamic instructions
    if request.system_prompt:
        instructions = request.system_prompt
    else:
        instructions = _build_subagent_instructions(request.task, tool_names)

    session_id = record.child_session_id
    # Pre-initialize child session to avoid rehydration network calls.
    child_service._lc_sessions[session_id] = []
    child_service._session_last_access[session_id] = time.time()
    messages = [
        Message(
            role=MessageRole.USER,
            content=request.task,
        )
    ]

    max_iterations = request.max_iterations or min(settings.MAX_AGENT_ITERATIONS, 20)

    try:
        injected_children: set = set()
        for iteration in range(1, max_iterations + 1):
            record.current_iteration = iteration

            result = await child_service.process_messages_with_tools(
                messages=messages,
                session_id=session_id,
                instructions=instructions,
            )

            if result.type == LLMResultType.TEXT:
                # Wait for any active sub-agents before returning
                if _has_active_children(session_id):
                    await _wait_and_inject_children(
                        child_service, session_id, injected_children,
                    )
                    messages = []
                    continue  # Re-run LLM to synthesize sub-agent results
                return result.text or "Task completed."

            # Tool calls — execute them
            if result.tool_calls:
                tool_results = []
                for tc in result.tool_calls:
                    # Track progress step
                    step = ProgressStep(
                        tool_name=tc.name,
                        detail=_tool_detail(tc.name, tc.args),
                    )
                    record.progress_log.append(step)
                    # Cap log size: keep last 200 entries
                    if len(record.progress_log) > 200:
                        record.progress_log = record.progress_log[-200:]

                    try:
                        # Use root session for MCP tools (file ops need platform session),
                        # child session for skill tools (parent tracking).
                        effective_sid = (
                            root_session_id
                            if mcp_client.is_server_tool(tc.name)
                            else session_id
                        )
                        output = await _execute_tool(tc.name, tc.args, session_id=effective_sid)
                        step.status = "completed"
                        step.completed_at = time.time()
                        tool_results.append(
                            Message(
                                role=MessageRole.TOOL,
                                content=output or f"[EMPTY_RESULT] {tc.name}",
                                tool_call_id=tc.id,
                                tool_name=tc.name,
                            )
                        )
                    except Exception as e:
                        step.status = "failed"
                        step.completed_at = time.time()
                        tool_results.append(
                            Message(
                                role=MessageRole.TOOL,
                                content=f"Error: {e}",
                                tool_call_id=tc.id,
                                tool_name=tc.name,
                            )
                        )

                await child_service.append_tool_interaction(
                    session_id,
                    messages,
                    [tc.model_dump() for tc in result.tool_calls],
                    tool_results,
                    usage=result.usage.model_dump() if result.usage else {},
                    assistant_lc_message=result.assistant_lc_message,
                )
                messages = []  # Continue without new user messages

                # Wait for any spawned sub-agents and inject results
                if _has_active_children(session_id):
                    await _wait_and_inject_children(
                        child_service, session_id, injected_children,
                    )

        return "Sub-agent reached maximum iterations."
    finally:
        await child_service.aclose()


# ---------------------------------------------------------------------------
# Announce completion
# ---------------------------------------------------------------------------


async def await_active_subagents(
    parent_session_id: str,
    timeout: float = 300.0,
    poll_interval: float = 1.0,
) -> List[SubagentRunRecord]:
    """Wait for all active sub-agents of a parent session to complete.

    Gathers the asyncio tasks for all running sub-agents and awaits them
    with a timeout.  Returns the list of (now-completed) records.

    Args:
        parent_session_id: The parent session to wait for.
        timeout: Maximum seconds to wait (default: 5 minutes).
        poll_interval: Not used directly — asyncio.wait handles timing.

    Returns:
        List of SubagentRunRecord that were active (now completed/failed/timeout).
    """
    records = _registry.list_by_parent(parent_session_id)
    active = [r for r in records if r.status == "running" and r.asyncio_task is not None]

    if not active:
        return []

    tasks = [r.asyncio_task for r in active if r.asyncio_task is not None]

    try:
        await asyncio.wait(tasks, timeout=timeout)
    except Exception:
        logger.warning(
            "Error awaiting sub-agents for parent %s",
            parent_session_id,
            exc_info=True,
        )

    return active


async def _announce_completion(
    record: SubagentRunRecord,
    summary: str,
    max_retries: int = 3,
) -> None:
    """Append a SystemMessage to the parent session announcing completion.

    Retries with exponential backoff if the parent session is locked.
    """
    msg = SystemMessage(
        content=(f"[Sub-agent completed] Task: {record.task[:200]}\nResult: {summary[:500]}")
    )

    for attempt in range(max_retries):
        try:
            # Lazy: circular dep + must read current (patchable) attribute
            from app.routers.agent import agent_service

            lc_sessions = agent_service._lc_sessions
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
