# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Skill provider — SKILL.md loader, discovery, and registry API.

This module owns the entire skill lifecycle:
  1. SKILL.md frontmatter parser (no PyYAML dependency).
  2. Registry storage and discovery (synchronous, constructor-time).
  3. Public API consumed by agent_service, prompts/base, routers/agent.

Skill classes are plain Python objects — no ABC inheritance required.
The registry uses duck typing: any object with ``name``, ``tool_schemas``,
and ``execute(name, args, session_id)`` qualifies.
"""

from __future__ import annotations

import asyncio
import importlib
import logging
import os
from dataclasses import dataclass
from typing import Any, Dict, List, Optional, Set

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# SKILL.md loader
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class SkillMeta:
    """Parsed metadata + body from a SKILL.md file."""

    name: str
    description: str
    body: str
    server_tools: List[str]
    client_tools: List[str]
    depends_on: List[str]


def parse_skill_md(path: str) -> SkillMeta:
    """Parse a SKILL.md file into ``SkillMeta``.

    Format::

        ---
        name: plan
        description: Task planning and execution tracking
        ---
        Pure markdown body...

    The ``---`` delimiters are required.  Lines between them are parsed as
    simple ``key: value`` pairs; no nested structures are supported.
    """
    with open(path, encoding="utf-8") as f:
        text = f.read()

    name = ""
    description = ""
    body = text  # fallback: entire file is the body
    server_tools: List[str] = []
    client_tools: List[str] = []
    depends_on: List[str] = []

    parts = text.split("---", 2)
    if len(parts) >= 3:
        frontmatter = parts[1]
        body = parts[2].strip()
        for line in frontmatter.strip().splitlines():
            line = line.strip()
            if not line or ":" not in line:
                continue
            key, _, value = line.partition(":")
            key = key.strip().lower()
            value = value.strip()
            if key == "name":
                name = value
            elif key == "description":
                description = value
            elif key == "server_tools":
                server_tools = [t.strip() for t in value.split(",") if t.strip()]
            elif key == "client_tools":
                client_tools = [t.strip() for t in value.split(",") if t.strip()]
            elif key == "depends_on":
                depends_on = [t.strip() for t in value.split(",") if t.strip()]

    return SkillMeta(
        name=name,
        description=description,
        body=body,
        server_tools=server_tools,
        client_tools=client_tools,
        depends_on=depends_on,
    )


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _load_skill_meta(skill: Any) -> SkillMeta:
    """Load and cache SkillMeta from SKILL.md for a skill instance."""
    cached = getattr(skill, "_skill_meta_cache", None)
    if cached is not None:
        return cached

    mod = importlib.import_module(skill.__class__.__module__)
    skill_dir = os.path.dirname(os.path.abspath(mod.__file__))  # type: ignore[arg-type]
    md_path = os.path.join(skill_dir, "SKILL.md")

    if os.path.isfile(md_path):
        meta = parse_skill_md(md_path)
    else:
        meta = SkillMeta(name=skill.name, description="", body="", server_tools=[], client_tools=[], depends_on=[])

    skill._skill_meta_cache = meta
    return meta


def _load_guide_prompt(skill: Any) -> str:
    """Load SKILL.md body for a skill instance (lazy, cached)."""
    return _load_skill_meta(skill).body


def _get_tool_names(skill: Any) -> set[str]:
    """Extract tool names from a skill's ``tool_schemas``."""
    return {s["function"]["name"] for s in skill.tool_schemas}


# ---------------------------------------------------------------------------
# SkillProvider
# ---------------------------------------------------------------------------


class SkillProvider:
    """Registry of server-side skills.

    Discovers skill packages under ``app/skills/`` at construction time
    (synchronous, no I/O beyond local filesystem + importlib).

    Usage::

        skill_provider = SkillProvider()
        await skill_provider.startup(write_tool_fn=mcp_client.call_tool)
    """

    def __init__(self) -> None:
        self._skills: Dict[str, Any] = {}
        self._tool_to_skill: Dict[str, Any] = {}
        self._display_names: Dict[str, str] = {}
        self._discover()

    # ------------------------------------------------------------------
    # Discovery
    # ------------------------------------------------------------------

    def _discover(self) -> None:
        """Scan ``app/skills/`` sub-packages and register discovered skills.

        A valid skill package must:
          - Be a sub-directory of ``app/skills/`` with an ``__init__.py``
          - Expose a module-level ``skill`` attribute
          - The ``skill`` object must have ``name`` (str) and ``tool_schemas`` (list)
        """
        skills_dir = os.path.join(
            os.path.dirname(os.path.abspath(__file__)),  # providers/
            os.pardir,  # services/
            os.pardir,  # app/
            "skills",
        )
        skills_dir = os.path.normpath(skills_dir)

        if not os.path.isdir(skills_dir):
            return

        for entry in sorted(os.listdir(skills_dir)):
            if entry.startswith("_") or entry.startswith("."):
                continue
            pkg_dir = os.path.join(skills_dir, entry)
            if not os.path.isdir(pkg_dir):
                continue
            if not os.path.isfile(os.path.join(pkg_dir, "__init__.py")):
                continue

            module_name = f"app.skills.{entry}"
            try:
                mod = importlib.import_module(module_name)
            except Exception:
                logger.warning("Failed to import skill package %s", module_name, exc_info=True)
                continue

            skill = getattr(mod, "skill", None)
            if skill is None:
                continue
            if not hasattr(skill, "name") or not hasattr(skill, "tool_schemas"):
                logger.warning("Skill in %s missing 'name' or 'tool_schemas', skipping", module_name)
                continue

            self._skills[skill.name] = skill
            for schema in skill.tool_schemas:
                fn_name = schema["function"]["name"]
                self._tool_to_skill[fn_name] = skill
                dn = schema.get("display_name")
                if dn:
                    self._display_names[fn_name] = dn

        if self._skills:
            logger.info("Discovered skills: %s", list(self._skills.keys()))

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def startup(self, **kwargs: Any) -> None:
        """Initialise all skills in parallel.

        Calls ``on_init(**kwargs)`` on each skill that defines it.
        """
        if not self._skills:
            return
        coros = []
        for s in self._skills.values():
            on_init = getattr(s, "on_init", None)
            if on_init is not None:
                coros.append(on_init(**kwargs))
        if coros:
            await asyncio.gather(*coros)
        logger.info("All skills initialised: %s", list(self._skills.keys()))

    # ------------------------------------------------------------------
    # Tool schemas & names
    # ------------------------------------------------------------------

    def get_all_tool_schemas(self) -> List[Dict[str, Any]]:
        """Return combined tool schemas from all registered skills.

        Strips ``display_name`` from each schema since it is not part of
        the LLM tool interface.
        """
        schemas: List[Dict[str, Any]] = []
        for skill in self._skills.values():
            for s in skill.tool_schemas:
                clean = {k: v for k, v in s.items() if k != "display_name"}
                schemas.append(clean)
        return schemas

    def get_all_tool_names(self) -> Set[str]:
        """Return the union of all tool names across skills."""
        return set(self._tool_to_skill.keys())

    @property
    def display_names(self) -> Dict[str, str]:
        """Display names extracted from skill tool schemas."""
        return dict(self._display_names)

    # ------------------------------------------------------------------
    # Guide prompts
    # ------------------------------------------------------------------

    def get_all_guide_prompts(self) -> List[str]:
        """Return guide prompts from all skills, each wrapped in XML tags.

        Each skill's plain-markdown SKILL.md body is wrapped as::

            <tool_guide name="skill_name">
            ...markdown body...
            </tool_guide>
        """
        prompts: List[str] = []
        for skill in self._skills.values():
            body = _load_guide_prompt(skill)
            if body:
                prompts.append(f'<tool_guide name="{skill.name}">\n{body}\n</tool_guide>')
        return prompts

    # ------------------------------------------------------------------
    # Filtered schemas & prompts (client-tool-aware)
    # ------------------------------------------------------------------

    @staticmethod
    def _is_skill_active(skill: Any, client_tool_names: Set[str]) -> bool:
        """Determine whether a skill should be active given available client tools.

        - If the skill declares no ``client_tools`` → always active.
        - If it declares ``client_tools`` → active when at least one is
          present in *client_tool_names*.
        """
        meta = _load_skill_meta(skill)
        if not meta.client_tools:
            return True
        return bool(set(meta.client_tools) & client_tool_names)

    def _resolve_with_deps(self, active_skills: List[Any]) -> List[Any]:
        """Expand active skill list to include ``depends_on`` skills.

        Recursively walks each active skill's dependency chain and returns
        the union of active + dependency skills (duplicates removed, insertion
        order preserved).  Circular references are safe — the ``visited`` set
        prevents infinite recursion.
        """
        result_names: set[str] = set()
        result: list[Any] = []

        def _add(skill: Any) -> None:
            if skill.name in result_names:
                return
            result_names.add(skill.name)
            result.append(skill)
            meta = _load_skill_meta(skill)
            for dep_name in meta.depends_on:
                dep = self._skills.get(dep_name)
                if dep is not None:
                    _add(dep)

        for s in active_skills:
            _add(s)
        return result

    def get_active_tool_schemas(self, client_tool_names: Set[str]) -> List[Dict[str, Any]]:
        """Return tool schemas only for skills whose client_tools are satisfied.

        Also includes tool schemas from dependency skills (``depends_on``).
        Strips ``display_name`` from each schema since it is not part of
        the LLM tool interface.
        """
        active = [s for s in self._skills.values() if self._is_skill_active(s, client_tool_names)]
        resolved = self._resolve_with_deps(active)
        schemas: List[Dict[str, Any]] = []
        for skill in resolved:
            for s in skill.tool_schemas:
                clean = {k: v for k, v in s.items() if k != "display_name"}
                schemas.append(clean)
        return schemas

    def get_active_guide_prompts(self, client_tool_names: Set[str]) -> List[str]:
        """Return guide prompts only for skills whose client_tools are satisfied.

        Also includes guide prompts from dependency skills (``depends_on``).
        """
        active = [s for s in self._skills.values() if self._is_skill_active(s, client_tool_names)]
        resolved = self._resolve_with_deps(active)
        prompts: List[str] = []
        for skill in resolved:
            body = _load_guide_prompt(skill)
            if body:
                prompts.append(f'<tool_guide name="{skill.name}">\n{body}\n</tool_guide>')
        return prompts

    # ------------------------------------------------------------------
    # Tool dispatch
    # ------------------------------------------------------------------

    def get_skill_for_tool(self, tool_name: str) -> Optional[Any]:
        """Look up the skill that owns *tool_name*."""
        return self._tool_to_skill.get(tool_name)

    async def execute_tool(self, name: str, arguments: Dict[str, Any], session_id: str) -> str:
        """Dispatch a tool call to the owning skill."""
        skill = self._tool_to_skill.get(name)
        if skill is None:
            raise KeyError(f"No skill registered for tool: {name}")
        return await skill.execute(name, arguments, session_id)

    # ------------------------------------------------------------------
    # Session state
    # ------------------------------------------------------------------

    def get_state_prompts(self, session_id: str) -> List[str]:
        """Collect per-turn state prompts from all skills."""
        prompts: List[str] = []
        for skill in self._skills.values():
            fn = getattr(skill, "get_state_prompt", None)
            if fn is not None:
                p = fn(session_id)
                if p:
                    prompts.append(p)
        return prompts

    def clear_session(self, session_id: str) -> None:
        """Notify all skills to drop state for an evicted session."""
        for skill in self._skills.values():
            fn = getattr(skill, "clear_session", None)
            if fn is not None:
                fn(session_id)

    def get_skill(self, name: str) -> Optional[Any]:
        """Retrieve a skill by its ``name`` attribute."""
        return self._skills.get(name)

    # ------------------------------------------------------------------
    # Generic lifecycle hooks (router should NOT reference specific skills)
    # ------------------------------------------------------------------

    def should_force_text_only(self, session_id: str) -> bool:
        """Check if any skill wants to force a text-only LLM response.

        When True, the agent loop should call the LLM without tools so it
        can only return text.  Skills return True when all work is done and
        a final summary is expected (e.g. plan fully completed).
        """
        for skill in self._skills.values():
            fn = getattr(skill, "is_all_complete", None)
            if fn is not None and fn(session_id):
                return True
        return False

    def has_unfinished_work(self, session_id: str) -> bool:
        """Check if any skill has unfinished work for the session."""
        for skill in self._skills.values():
            fn = getattr(skill, "has_unfinished_steps", None)
            if fn is not None and fn(session_id):
                return True
        return False

    def build_retry_guidance(self, session_id: str, abandoned_text: str) -> Optional[str]:
        """Collect retry guidance from skills with unfinished work."""
        for skill in self._skills.values():
            fn = getattr(skill, "build_retry_guidance", None)
            if fn is not None:
                guidance = fn(session_id, abandoned_text)
                if guidance:
                    return guidance
        return None

    async def finalize_abandoned(self, session_id: str) -> None:
        """Tell all skills to finalize/fail any abandoned work."""
        for skill in self._skills.values():
            fn = getattr(skill, "finalize_abandoned_steps", None)
            if fn is not None:
                await fn(session_id)

    def get_live_state(self, session_id: str) -> Optional[Dict[str, Any]]:
        """Collect live state from skills for streaming events (e.g. TODO progress).

        Returns the first non-None state dict from any skill that implements
        ``get_state()``.  The router emits this as an SSE event without
        knowing which skill produced it.
        """
        for skill in self._skills.values():
            fn = getattr(skill, "get_state", None)
            if fn is None:
                continue
            state = fn(session_id)
            if state is None:
                continue
            # Duck-type: expect .task and .steps attributes
            if hasattr(state, "task") and hasattr(state, "steps"):
                return {
                    "task": state.task,
                    "steps": [
                        {"description": s.description, "status": s.status, "result": s.result}
                        for s in state.steps
                    ],
                }
        return None
