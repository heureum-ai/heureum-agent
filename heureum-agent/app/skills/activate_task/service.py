# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Activate skill — spawns sub-agents to handle tasks via skill pipelines.

The main agent sees only skill headers (<available_skills>) and delegates
execution via activate_skill → sub-agent pipeline.
"""

import json
import logging
from typing import Any, Dict

from app.services.middleware.types import (
    BeforeResult,
    MiddlewareContext,
    SubagentSpawnEvent,
)

logger = logging.getLogger(__name__)

ACTIVATE_SKILL_SCHEMA = {
    "type": "function",
    "display_name": "ActivateSkill",
    "function": {
        "name": "activate_skill",
        "description": (
            "Activate a skill by spawning a sub-agent to handle the task. "
            "Review <available_skills> to choose the right skill. "
            "Provide a clear task description rewritten from the user's query."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "skill_names": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Skills to activate (from available_skills)",
                },
                "task": {
                    "type": "string",
                    "description": (
                        "Task description — rewrite the user's query into a clear, "
                        "self-contained instruction for the sub-agent."
                    ),
                },
            },
            "required": ["skill_names", "task"],
        },
    },
}


class ActivateSkill:
    """Server skill that activates skills and spawns sub-agents."""

    name = "activate_task"
    tool_schemas = [ACTIVATE_SKILL_SCHEMA]

    def __init__(self) -> None:
        self._skill_controller: Any = None
        self._create_subagent_task_fn: Any = None
        self._get_skills_prompt: Any = None
        self._middleware: Any = None  # MiddlewareRunner (optional)

    async def on_init(self, skill_controller=None, create_subagent_task_fn=None,
                       get_skills_prompt=None, middleware=None, **kwargs) -> None:
        self._skill_controller = skill_controller
        self._create_subagent_task_fn = create_subagent_task_fn
        self._get_skills_prompt = get_skills_prompt
        self._middleware = middleware

    async def execute(self, name: str, arguments: Dict[str, Any], session_id: str) -> str:
        skill_names = arguments.get("skill_names", [])
        task = arguments.get("task", "")

        if not skill_names:
            return json.dumps({"error": "skill_names required"})
        if not task:
            return json.dumps({"error": "task description required"})

        if self._skill_controller is None:
            return json.dumps({"error": "skill controller not available"})

        # Middleware check: block duplicate activate_skill calls
        if self._middleware:
            evt = SubagentSpawnEvent(
                context=MiddlewareContext(
                    session_id=session_id,
                    extras={"is_activate_skill": True},
                ),
                parent_session_id=session_id,
                child_skills=skill_names,
            )
            before_result: BeforeResult = await self._middleware.run_before(evt)
            if before_result.blocked:
                return json.dumps({
                    "error": f"activate_skill blocked: {before_result.reason}",
                })

        # plan_task included → spawn via plan pipeline
        if "plan_task" in skill_names:
            result = await self._spawn_plan_pipeline(task, session_id)
        else:
            # Simple skills (web_search_task etc.) → direct sub-agent spawn
            result = await self._spawn_simple(task, session_id, skill_names)

        # Middleware after: record accepted spawn
        if self._middleware:
            try:
                _parsed = json.loads(result)
                evt.result_status = "accepted" if _parsed.get("status") == "accepted" else "error"
            except (json.JSONDecodeError, AttributeError):
                evt.result_status = "error"
            await self._middleware.run_after(evt)

        return result

    async def _spawn_plan_pipeline(self, task: str, session_id: str) -> str:
        """plan_task activation → sub-agent spawn via plan pipeline."""
        from app.skills.plan_task.service import SpawnRequest, spawn_subagent

        skills_prompt = self._get_skills_prompt() if self._get_skills_prompt else None
        parent_skills = self._get_parent_skills(session_id)

        request = SpawnRequest(
            parent_session_id=session_id,
            task=task,
            skills=parent_skills,
            skills_prompt=skills_prompt,
        )
        result = await spawn_subagent(request, self._create_subagent_task_fn)
        return json.dumps({
            "status": result.status,
            "child_session_id": result.child_session_id,
            "message": result.message,
        })

    async def _spawn_simple(self, task: str, session_id: str,
                             skill_names: list[str]) -> str:
        """Simple skill → sub-agent spawn."""
        from app.skills.plan_task.service import SpawnRequest, spawn_subagent

        skills_prompt = self._get_skills_prompt() if self._get_skills_prompt else None

        request = SpawnRequest(
            parent_session_id=session_id,
            task=task,
            skills=skill_names,
            skills_prompt=skills_prompt,
        )
        result = await spawn_subagent(request, self._create_subagent_task_fn)
        return json.dumps({
            "status": result.status,
            "child_session_id": result.child_session_id,
            "message": result.message,
        })

    def _get_parent_skills(self, session_id: str) -> list[str] | None:
        if not self._skill_controller:
            return None
        try:
            names = self._skill_controller.get_active_skill_names(session_id)
            return list(names) if names else None
        except Exception:
            return None
