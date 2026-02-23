# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Skill-domain controller."""

import asyncio
import logging
from typing import Any, Dict, List, Optional, Set

from app.services.skills.discovery import discover_skills
from app.services.skills.metadata import load_guide_prompt

logger = logging.getLogger(__name__)


class SkillController:
    """Registry of server-side skills."""

    def __init__(self) -> None:
        self._skills, self._tool_to_skill, self._display_names = discover_skills(__file__)

    def filtered(self, allowed_tools: Set[str]) -> "_FilteredSkillController":
        """Return a wrapper that restricts tools to *allowed_tools*."""
        return _FilteredSkillController(self, allowed_tools)

    async def startup(self, **kwargs: Any) -> None:
        if not self._skills:
            return
        coroutines = []
        names: List[str] = []
        for skill in self._skills.values():
            on_init = getattr(skill, "on_init", None)
            if on_init is not None:
                coroutines.append(on_init(**kwargs))
                names.append(getattr(skill, "name", skill.__class__.__name__))
        if coroutines:
            results = await asyncio.gather(*coroutines, return_exceptions=True)
            failed: List[str] = []
            for name, result in zip(names, results):
                if isinstance(result, BaseException):
                    failed.append(name)
                    logger.warning("Skill '%s' on_init failed: %s", name, result)
            if failed:
                logger.warning("Skills initialised with failures: %s", failed)
            else:
                logger.info("All skills initialised: %s", list(self._skills.keys()))
        else:
            logger.info("All skills initialised: %s", list(self._skills.keys()))

    # -- Schema & prompt aggregation ------------------------------------------

    def get_all_tool_schemas(self) -> List[Dict[str, Any]]:
        schemas: List[Dict[str, Any]] = []
        for skill in self._skills.values():
            for schema in skill.tool_schemas:
                clean = {k: v for k, v in schema.items() if k != "display_name"}
                schemas.append(clean)
        return schemas

    def get_all_tool_names(self) -> Set[str]:
        return set(self._tool_to_skill.keys())

    @property
    def display_names(self) -> Dict[str, str]:
        return dict(self._display_names)

    def get_all_guide_prompts(self) -> List[str]:
        prompts: List[str] = []
        for skill in self._skills.values():
            body = load_guide_prompt(skill)
            if body:
                prompts.append(f'<tool_guide name="{skill.name}">\n{body}\n</tool_guide>')
        return prompts

    # -- Tool dispatch --------------------------------------------------------

    def get_skill_for_tool(self, tool_name: str) -> Optional[Any]:
        return self._tool_to_skill.get(tool_name)

    async def execute_tool(self, name: str, arguments: Dict[str, Any], session_id: str) -> str:
        skill = self._tool_to_skill.get(name)
        if skill is None:
            raise KeyError(f"No skill registered for tool: {name}")
        return await skill.execute(name, arguments, session_id)

    def get_skill(self, name: str) -> Optional[Any]:
        return self._skills.get(name)

    # -- Session / runtime helpers --------------------------------------------

    def get_state_prompts(self, session_id: str) -> List[str]:
        prompts: List[str] = []
        for skill in self._skills.values():
            fn = getattr(skill, "get_state_prompt", None)
            if fn is not None:
                prompt = fn(session_id)
                if prompt:
                    prompts.append(prompt)
        return prompts

    def clear_session(self, session_id: str) -> None:
        for skill in self._skills.values():
            fn = getattr(skill, "clear_session", None)
            if fn is not None:
                fn(session_id)

    def clear_completed_plans(self, session_id: str) -> None:
        for skill in self._skills.values():
            is_done = getattr(skill, "is_all_complete", None)
            clear = getattr(skill, "clear_session", None)
            has_unfinished = getattr(skill, "has_unfinished_steps", None)
            if is_done and clear and is_done(session_id):
                # Don't clear if sub-agents are still running
                if has_unfinished and has_unfinished(session_id):
                    continue
                clear(session_id)

    def should_force_text_only(self, session_id: str) -> bool:
        for skill in self._skills.values():
            fn = getattr(skill, "is_all_complete", None)
            if fn is not None and fn(session_id):
                return True
        return False

    def has_unfinished_work(self, session_id: str) -> bool:
        for skill in self._skills.values():
            fn = getattr(skill, "has_unfinished_steps", None)
            if fn is not None and fn(session_id):
                return True
        return False

    def build_retry_guidance(self, session_id: str, abandoned_text: str) -> Optional[str]:
        for skill in self._skills.values():
            fn = getattr(skill, "build_retry_guidance", None)
            if fn is not None:
                guidance = fn(session_id, abandoned_text)
                if guidance:
                    return guidance
        return None

    async def await_pending(self, session_id: str, timeout: float = 300.0) -> None:
        for skill in self._skills.values():
            fn = getattr(skill, "await_pending", None)
            if fn is not None:
                await fn(session_id, timeout)

    async def finalize_abandoned(self, session_id: str) -> None:
        for skill in self._skills.values():
            fn = getattr(skill, "finalize_abandoned_steps", None)
            if fn is not None:
                await fn(session_id)

    def get_live_state(self, session_id: str) -> Optional[Dict[str, Any]]:
        for skill in self._skills.values():
            fn = getattr(skill, "get_state", None)
            if fn is None:
                continue
            state = fn(session_id)
            if state is None:
                continue
            # New hierarchical plan model (SessionPlan)
            if hasattr(state, "goal") and hasattr(state, "tasks"):
                return {
                    "team": state.goal,
                    "tasks": [
                        {
                            "id": task.id,
                            "description": task.description,
                            "status": task.status,
                            "result": task.result,
                            "depends_on": task.depends_on,
                            "child_session_id": task.child_session_id,
                        }
                        for task in state.tasks.values()
                    ],
                }
        return None

    async def evaluate_response(
        self,
        user_query: str,
        response_text: str,
        output_items: list,
        llm: Any,
    ) -> Optional[Any]:
        """Delegate to evaluate_task skill if present."""
        for skill in self._skills.values():
            fn = getattr(skill, "evaluate_response", None)
            if fn is not None:
                return await fn(user_query, response_text, output_items, llm)
        return None


# ---------------------------------------------------------------------------
# Private filtered wrapper (used by SkillController.filtered())
# ---------------------------------------------------------------------------


class _FilteredSkillController:
    """SkillController wrapper that restricts tools to an allowlist."""

    def __init__(self, base: SkillController, allowed_tools: Set[str]) -> None:
        self._base = base
        self._allowed = allowed_tools

    def get_all_tool_schemas(self) -> List[Dict[str, Any]]:
        return [
            s
            for s in self._base.get_all_tool_schemas()
            if s.get("function", {}).get("name") in self._allowed
        ]

    def get_all_tool_names(self) -> Set[str]:
        return self._base.get_all_tool_names() & self._allowed

    @property
    def display_names(self) -> Dict[str, str]:
        return {k: v for k, v in self._base.display_names.items() if k in self._allowed}

    async def startup(self, **kwargs: Any) -> None:
        await self._base.startup(**kwargs)

    async def execute_tool(self, name: str, arguments: Dict[str, Any], session_id: str) -> str:
        if name not in self._allowed:
            raise KeyError(f"Tool '{name}' not allowed for this sub-agent")
        return await self._base.execute_tool(name, arguments, session_id)

    def get_skill_for_tool(self, tool_name: str) -> Optional[Any]:
        if tool_name not in self._allowed:
            return None
        return self._base.get_skill_for_tool(tool_name)

    def get_skill(self, name: str) -> Optional[Any]:
        return self._base.get_skill(name)

    def get_all_guide_prompts(self) -> List[str]:
        return self._base.get_all_guide_prompts()

    def get_state_prompts(self, session_id: str) -> List[str]:
        return self._base.get_state_prompts(session_id)

    def clear_session(self, session_id: str) -> None:
        self._base.clear_session(session_id)

    def clear_completed_plans(self, session_id: str) -> None:
        self._base.clear_completed_plans(session_id)

    def should_force_text_only(self, session_id: str) -> bool:
        return self._base.should_force_text_only(session_id)

    def has_unfinished_work(self, session_id: str) -> bool:
        return self._base.has_unfinished_work(session_id)

    def build_retry_guidance(self, session_id: str, abandoned_text: str) -> Optional[str]:
        return self._base.build_retry_guidance(session_id, abandoned_text)

    async def await_pending(self, session_id: str, timeout: float = 300.0) -> None:
        await self._base.await_pending(session_id, timeout)

    async def finalize_abandoned(self, session_id: str) -> None:
        await self._base.finalize_abandoned(session_id)

    def get_live_state(self, session_id: str) -> Optional[Dict[str, Any]]:
        return self._base.get_live_state(session_id)

    async def evaluate_response(
        self,
        user_query: str,
        response_text: str,
        output_items: list,
        llm: Any,
    ) -> Optional[Any]:
        return await self._base.evaluate_response(user_query, response_text, output_items, llm)
