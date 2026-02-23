# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Skill-domain controller."""

import asyncio
import logging
from typing import Any, Dict, List, Optional, Set

from app.services.skills.discovery import discover_skills
from app.services.skills.metadata import load_guide_prompt, load_skill_meta
from app.services.skills.types import SkillMeta

logger = logging.getLogger(__name__)


class SkillController:
    """Registry of server-side skills."""

    def __init__(self) -> None:
        self._skills, self._tool_to_skill, self._display_names = discover_skills(__file__)
        self._skill_meta_by_key: Dict[str, SkillMeta] = {}
        self._skill_aliases: Dict[str, Set[str]] = {}
        self._alias_to_key: Dict[str, str] = {}
        self._server_tools_by_skill: Dict[str, Set[str]] = {}

        for skill_key, skill in self._skills.items():
            meta = load_skill_meta(skill)
            self._skill_meta_by_key[skill_key] = meta

            aliases = {self._norm_name(skill_key)}
            skill_name = getattr(skill, "name", "")
            if isinstance(skill_name, str) and skill_name.strip():
                aliases.add(self._norm_name(skill_name))
            if meta.name.strip():
                aliases.add(self._norm_name(meta.name))
            self._skill_aliases[skill_key] = aliases
            for alias in aliases:
                self._alias_to_key.setdefault(alias, skill_key)

            self._server_tools_by_skill[skill_key] = self._resolve_server_tools(skill, meta)

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

    @staticmethod
    def _norm_name(name: str) -> str:
        return (name or "").strip().lower()

    def _resolve_server_tools(self, skill: Any, meta: SkillMeta) -> Set[str]:
        names = {tool for tool in meta.server_tools if tool}
        if names:
            return names
        fallback: Set[str] = set()
        for schema in getattr(skill, "tool_schemas", []):
            name = schema.get("function", {}).get("name")
            if isinstance(name, str) and name:
                fallback.add(name)
        return fallback

    def _resolve_snapshot_skills(self, skills_snapshot: Any) -> Optional[Set[str]]:
        if not skills_snapshot:
            return None
        items = (
            getattr(skills_snapshot, "skills", None)
            if not isinstance(skills_snapshot, dict)
            else skills_snapshot.get("skills")
        )
        if not isinstance(items, list) or not items:
            return None
        names: Set[str] = set()
        for item in items:
            name = None
            if isinstance(item, dict):
                name = item.get("name")
            else:
                name = getattr(item, "name", None)
            if isinstance(name, str) and name.strip():
                names.add(self._norm_name(name))
        return names or None

    def _resolve_snapshot_tools(self, skills_snapshot: Any) -> Optional[Set[str]]:
        if not skills_snapshot:
            return None
        items = (
            getattr(skills_snapshot, "skills", None)
            if not isinstance(skills_snapshot, dict)
            else skills_snapshot.get("skills")
        )
        if not isinstance(items, list) or not items:
            return None
        tools: Set[str] = set()
        for item in items:
            skill_tools = None
            if isinstance(item, dict):
                skill_tools = item.get("tools")
            else:
                skill_tools = getattr(item, "tools", None)
            if not isinstance(skill_tools, list):
                continue
            for tool_name in skill_tools:
                if isinstance(tool_name, str) and tool_name:
                    tools.add(tool_name)
        return tools or None

    def _resolve_skill_key(self, alias: str) -> Optional[str]:
        return self._alias_to_key.get(self._norm_name(alias))

    def _skill_in_snapshot(self, skill_key: str, snapshot_skills: Optional[Set[str]]) -> bool:
        if snapshot_skills is None:
            return True
        return bool(self._skill_aliases.get(skill_key, set()) & snapshot_skills)

    def _client_tools_available(self, skill_key: str, client_tools: Optional[Set[str]]) -> bool:
        meta = self._skill_meta_by_key.get(skill_key)
        if not meta or not meta.client_tools:
            return True
        required = {tool for tool in meta.client_tools if tool}
        if not required:
            return True
        # Treat missing/empty client tool lists as "unknown availability"
        # so server skills remain usable in text-only or legacy clients.
        if not client_tools:
            return True
        return required.issubset(client_tools)

    def resolve_active_skill_names(
        self,
        *,
        client_tool_names: Optional[Set[str]] = None,
        skills_snapshot: Any = None,
    ) -> Set[str]:
        """Resolve active skill keys for the current request context."""
        client_tools = (
            None
            if client_tool_names is None
            else {tool for tool in client_tool_names if tool}
        )
        snapshot_skills = self._resolve_snapshot_skills(skills_snapshot)

        active: Set[str] = set()
        for skill_key in self._skills.keys():
            if not self._skill_in_snapshot(skill_key, snapshot_skills):
                continue
            if not self._client_tools_available(skill_key, client_tools):
                continue
            active.add(skill_key)

        # Pull in dependency skills transitively.
        frontier = list(active)
        while frontier:
            current = frontier.pop()
            meta = self._skill_meta_by_key.get(current)
            if not meta:
                continue
            for dep in meta.depends_on:
                dep_key = self._resolve_skill_key(dep)
                if dep_key is None or dep_key in active:
                    continue
                if not self._client_tools_available(dep_key, client_tools):
                    continue
                active.add(dep_key)
                frontier.append(dep_key)

        return active

    def resolve_allowed_server_tools(
        self,
        *,
        client_tool_names: Optional[Set[str]] = None,
        skills_snapshot: Any = None,
    ) -> Set[str]:
        """Resolve server tool allowlist from active skills + optional snapshot."""
        allowed: Set[str] = set()
        active = self.resolve_active_skill_names(
            client_tool_names=client_tool_names,
            skills_snapshot=skills_snapshot,
        )
        for skill_key in active:
            allowed.update(self._server_tools_by_skill.get(skill_key, set()))

        snapshot_tools = self._resolve_snapshot_tools(skills_snapshot)
        if snapshot_tools:
            allowed &= snapshot_tools
        return allowed

    def get_all_tool_schemas(
        self,
        *,
        allowed_tools: Optional[Set[str]] = None,
        client_tool_names: Optional[Set[str]] = None,
        skills_snapshot: Any = None,
    ) -> List[Dict[str, Any]]:
        if allowed_tools is not None:
            allowed = set(allowed_tools)
        elif client_tool_names is not None or skills_snapshot is not None:
            allowed = self.resolve_allowed_server_tools(
                client_tool_names=client_tool_names,
                skills_snapshot=skills_snapshot,
            )
        else:
            allowed = None

        schemas: List[Dict[str, Any]] = []
        for skill in self._skills.values():
            for schema in skill.tool_schemas:
                clean = {k: v for k, v in schema.items() if k != "display_name"}
                if allowed is not None:
                    name = clean.get("function", {}).get("name")
                    if name not in allowed:
                        continue
                schemas.append(clean)
        return schemas

    def get_all_tool_names(
        self,
        *,
        allowed_tools: Optional[Set[str]] = None,
        client_tool_names: Optional[Set[str]] = None,
        skills_snapshot: Any = None,
    ) -> Set[str]:
        if allowed_tools is not None:
            return set(self._tool_to_skill.keys()) & set(allowed_tools)
        if client_tool_names is None and skills_snapshot is None:
            return set(self._tool_to_skill.keys())
        return self.resolve_allowed_server_tools(
            client_tool_names=client_tool_names,
            skills_snapshot=skills_snapshot,
        )

    @property
    def display_names(self) -> Dict[str, str]:
        return dict(self._display_names)

    def get_all_guide_prompts(
        self,
        *,
        allowed_tools: Optional[Set[str]] = None,
        client_tool_names: Optional[Set[str]] = None,
        skills_snapshot: Any = None,
    ) -> List[str]:
        active_skills: Set[str]
        if client_tool_names is not None or skills_snapshot is not None:
            active_skills = self.resolve_active_skill_names(
                client_tool_names=client_tool_names,
                skills_snapshot=skills_snapshot,
            )
        else:
            active_skills = set(self._skills.keys())

        prompts: List[str] = []
        for skill_key, skill in self._skills.items():
            if skill_key not in active_skills:
                continue
            if allowed_tools is not None:
                server_tools = self._server_tools_by_skill.get(skill_key, set())
                if not server_tools or not (server_tools & allowed_tools):
                    continue
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

    def get_all_tool_schemas(self, **kwargs: Any) -> List[Dict[str, Any]]:
        incoming = kwargs.pop("allowed_tools", None)
        merged_allowed = self._allowed if incoming is None else (self._allowed & set(incoming))
        schemas = self._base.get_all_tool_schemas(allowed_tools=merged_allowed, **kwargs)
        return [
            s
            for s in schemas
            if s.get("function", {}).get("name") in merged_allowed
        ]

    def get_all_tool_names(self, **kwargs: Any) -> Set[str]:
        incoming = kwargs.pop("allowed_tools", None)
        merged_allowed = self._allowed if incoming is None else (self._allowed & set(incoming))
        return self._base.get_all_tool_names(allowed_tools=merged_allowed, **kwargs) & merged_allowed

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

    def get_all_guide_prompts(self, **kwargs: Any) -> List[str]:
        incoming = kwargs.pop("allowed_tools", None)
        merged_allowed = self._allowed if incoming is None else (self._allowed & set(incoming))
        return self._base.get_all_guide_prompts(allowed_tools=merged_allowed, **kwargs)

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
