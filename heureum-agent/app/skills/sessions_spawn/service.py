# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Sessions spawn skill — enables the agent to spawn sub-agent tasks.

Registered as a server-side skill via SkillProvider auto-discovery.
The actual spawning logic lives in app.services.subagent to keep
this module thin.
"""

import json
import logging
import time
from typing import Any, Dict

from app.services.subagent import (
    SpawnRequest,
    await_active_subagents,
    get_registry,
    spawn_subagent,
)

logger = logging.getLogger(__name__)


SESSIONS_SPAWN_TOOL_SCHEMA = {
    "type": "function",
    "display_name": "Sub-Agent",
    "function": {
        "name": "sessions_spawn",
        "description": (
            "Spawn a sub-agent to handle a self-contained task in parallel. "
            "The sub-agent runs independently with its own context and tools, "
            "and reports back when done. Use this for tasks that can be "
            "delegated without needing real-time interaction."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": "A clear, self-contained description of the task for the sub-agent.",
                },
                "tools": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Optional list of tool names the sub-agent should have access to. Defaults to all available tools.",
                },
                "cleanup": {
                    "type": "string",
                    "enum": ["keep", "delete"],
                    "description": "Whether to keep or delete the sub-agent session after completion. Defaults to 'delete'.",
                },
            },
            "required": ["task"],
        },
    },
}

SESSIONS_SPAWN_STATUS_TOOL_SCHEMA = {
    "type": "function",
    "display_name": "Sub-Agent Status",
    "function": {
        "name": "sessions_spawn_status",
        "description": (
            "Check the status of spawned sub-agents. "
            "Returns status, elapsed time, and result summary for each sub-agent. "
            "Call with no arguments to list all sub-agents for the current session, "
            "or provide a child_session_id to check a specific one."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "child_session_id": {
                    "type": "string",
                    "description": "Optional. ID of a specific sub-agent to check. If omitted, returns all sub-agents for this session.",
                },
            },
        },
    },
}


class SessionsSpawnSkill:
    """Skill for spawning and tracking sub-agent tasks."""

    name = "sessions_spawn"
    tool_schemas = [SESSIONS_SPAWN_TOOL_SCHEMA]

    # ------------------------------------------------------------------
    # Lifecycle hooks (consumed by SkillProvider)
    # ------------------------------------------------------------------

    def has_unfinished_steps(self, session_id: str) -> bool:
        """Return True if any sub-agent is still running for this parent session."""
        try:
            registry = get_registry()
            return registry.count_active(session_id) > 0
        except Exception:
            return False

    def build_retry_guidance(self, session_id: str, abandoned_text: str) -> str:
        """Build guidance for the LLM when sub-agents are still running.

        Tells the LLM to wait for sub-agents and then synthesize results.
        Includes status of each sub-agent for context.
        """
        try:
            registry = get_registry()
            records = registry.list_by_parent(session_id)

            active = [r for r in records if r.status == "running"]
            completed = [r for r in records if r.status in ("completed", "failed", "timeout")]

            parts = [
                "Sub-agents are still running. DO NOT respond to the user yet.",
                "Wait for all sub-agents to complete, then synthesize their results.",
            ]

            if completed:
                parts.append("\nCompleted sub-agents:")
                for r in completed:
                    summary = r.result_summary[:200] if r.result_summary else "No result"
                    parts.append(f"  - [{r.status}] {r.task[:100]}: {summary}")

            if active:
                parts.append(f"\nStill running: {len(active)} sub-agent(s)")
                for r in active:
                    parts.append(f"  - {r.task[:100]} (iteration {r.current_iteration})")

            return "\n".join(parts)
        except Exception:
            return "Sub-agents are still running. Wait for them to complete before responding."

    async def await_pending(self, session_id: str, timeout: float = 300.0) -> None:
        """Wait for all active sub-agents to complete (async).

        Called by the agent loop before injecting retry guidance, so that
        sub-agent results (SystemMessages) are available in the parent
        session history for the next LLM call.
        """
        try:
            await await_active_subagents(session_id, timeout=timeout)
        except Exception:
            logger.warning("await_pending failed for session %s", session_id, exc_info=True)

    async def execute(self, name: str, args: Dict[str, Any], session_id: str) -> str:
        """Execute sessions_spawn or sessions_spawn_status tool."""
        if name == "sessions_spawn":
            return await self._spawn(args, session_id)
        if name == "sessions_spawn_status":
            return await self._status(args, session_id)
        return json.dumps({"error": f"Unknown tool: {name}"})

    async def _spawn(self, args: Dict[str, Any], session_id: str) -> str:
        try:
            request = SpawnRequest(
                parent_session_id=session_id,
                task=args.get("task", ""),
                tools=args.get("tools"),
                cleanup=args.get("cleanup", "delete"),
            )
            result = await spawn_subagent(request)
            return json.dumps(
                {
                    "status": result.status,
                    "child_session_id": result.child_session_id,
                    "message": result.message,
                }
            )
        except Exception as e:
            logger.warning("Sub-agent spawn failed: %s", e)
            return json.dumps({"error": str(e)})

    async def _status(self, args: Dict[str, Any], session_id: str) -> str:
        try:
            registry = get_registry()
            child_id = args.get("child_session_id")

            if child_id:
                record = registry.get(child_id)
                if not record:
                    return json.dumps({"error": f"Sub-agent '{child_id}' not found"})
                # Verify parent ownership
                if record.parent_session_id != session_id:
                    return json.dumps({"error": f"Sub-agent '{child_id}' not found"})
                return json.dumps(self._record_to_dict(record))

            # List all sub-agents for this parent session
            records = registry.list_by_parent(session_id)
            if not records:
                return json.dumps(
                    {"message": "No sub-agents found for this session", "children": []}
                )

            return json.dumps(
                {
                    "children": [self._record_to_dict(r) for r in records],
                }
            )
        except Exception as e:
            logger.warning("Sub-agent status check failed: %s", e)
            return json.dumps({"error": str(e)})

    @staticmethod
    def _record_to_dict(record) -> Dict[str, Any]:
        elapsed = time.time() - record.started_at
        result: Dict[str, Any] = {
            "child_session_id": record.child_session_id,
            "task": record.task,
            "status": record.status,
            "elapsed_seconds": round(elapsed, 1),
        }
        if record.result_summary:
            result["result_summary"] = record.result_summary[:500]
        return result
