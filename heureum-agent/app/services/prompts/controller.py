# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Prompt-domain controller — system prompt build + tool schema resolution."""

import logging
from typing import Any, List, Optional, Set, Tuple, TYPE_CHECKING

from app.services.prompts.base import SystemPromptBuilder, build_system_prompt

logger = logging.getLogger(__name__)

if TYPE_CHECKING:
    from app.agents.types import AgentDefinition

# Tools exposed to the main (orchestrator) agent only.
# Sub-agents receive the full server tool set instead.
MAIN_AGENT_TOOLS = frozenset({"activate_skill", "ask_question"})


class PromptController:
    """Encapsulates system prompt building and tool schema resolution.

    Centralizes prompt + tool-binding decisions so dynamic prompting logic
    (e.g. tool filtering, conditional guides) lives in one place.
    """

    def __init__(
        self,
        skill_provider: Any = None,
        mcp_tool_controller: Any = None,
    ) -> None:
        from app.services.mcps.tools import MCPToolController

        self.skill_provider = skill_provider
        self.mcp_tool_controller = mcp_tool_controller or MCPToolController()

    def prepare_prompt_and_tools(
        self,
        instructions: Optional[str] = None,
        client_tool_prompts: Optional[List[str]] = None,
        client_tool_schemas: Optional[List[dict]] = None,
        client_tool_names: Optional[Set[str]] = None,
        state_prompts: Optional[List[str]] = None,
        skills_prompt: Optional[str] = None,
        skills_snapshot: Any = None,
        active_tool_names: Optional[Set[str]] = None,
        is_subagent: bool = False,
        agent_config: Optional["AgentDefinition"] = None,
    ) -> Tuple[str, list]:
        """Build system prompt and resolve tool schemas together.

        Args:
            instructions: Extra instructions to append in ``<instructions>``.
            client_tool_prompts: Guide texts from clients.
            client_tool_schemas: Client-provided OpenAI-format tool schemas.
            client_tool_names: Client-side tool names available in this turn.
            state_prompts: Per-turn runtime state prompts from skills.
            skills_prompt: Pre-built ``<available_skills>`` block.
            skills_snapshot: Full skills snapshot payload.
            active_tool_names: Progressive skill activation filter set.
            is_subagent: Whether this is a sub-agent call.
            agent_config: AgentDefinition from the router. When provided,
                overrides identity prompt and tool filtering logic.

        Returns:
            (system_prompt, tool_schemas_for_bind_tools).
        """
        server_tool_schemas = (
            self.skill_provider.get_all_tool_schemas(
                skills_snapshot=skills_snapshot,
            )
            if self.skill_provider
            else []
        )

        if agent_config:
            # Ensure SKILL.md guides for the agent's skills are always
            # present, even on continuation turns where the client may
            # not resend skills_snapshot (which would otherwise skip
            # the DB guide fetch in resolve_tools).
            merged_prompts = list(client_tool_prompts or [])
            if agent_config.skills and self.skill_provider:
                existing = set(merged_prompts)
                server_guides = self.skill_provider.get_guide_prompts_for_skills(
                    set(agent_config.skills)
                )
                for guide in server_guides:
                    if guide not in existing:
                        merged_prompts.append(guide)
                logger.info(
                    "GUIDE_INJECT agent=%s skills=%s server_guides=%d merged=%d",
                    agent_config.name,
                    agent_config.skills,
                    len(server_guides),
                    len(merged_prompts),
                )
            prompt = self._build_agent_config_prompt(
                agent_config=agent_config,
                client_tool_prompts=merged_prompts or None,
                instructions=instructions,
                state_prompts=state_prompts,
                skills_prompt=skills_prompt if agent_config.skills else None,
            )
        else:
            prompt = build_system_prompt(
                client_tool_prompts=client_tool_prompts,
                instructions=instructions,
                state_prompts=state_prompts,
                skills_prompt=skills_prompt,
                is_subagent=is_subagent,
            )

        if agent_config:
            tools = self._resolve_agent_config_tools(
                agent_config=agent_config,
                client_tool_schemas=client_tool_schemas,
                server_tool_schemas=server_tool_schemas,
                active_tool_names=active_tool_names,
            )
        elif is_subagent:
            tools = self._resolve_subagent_tools(
                client_tool_schemas=client_tool_schemas,
                server_tool_schemas=server_tool_schemas,
                active_tool_names=active_tool_names,
            )
        else:
            tools = self._resolve_main_agent_tools(
                client_tool_schemas=client_tool_schemas,
                server_tool_schemas=server_tool_schemas,
            )

        tools = self._normalize_tool_schemas(tools)
        if not is_subagent:
            tools = self._inject_display_name_param(tools)

        return prompt, tools

    # ------------------------------------------------------------------
    # Prompt builders
    # ------------------------------------------------------------------

    @staticmethod
    def _build_agent_config_prompt(
        agent_config: "AgentDefinition",
        client_tool_prompts: Optional[List[str]] = None,
        instructions: Optional[str] = None,
        state_prompts: Optional[List[str]] = None,
        skills_prompt: Optional[str] = None,
    ) -> str:
        """Build system prompt using agent-specific identity from AGENT.md."""
        builder = SystemPromptBuilder(agent_identity=agent_config.identity_prompt)
        if skills_prompt:
            builder.add_skills_catalog(skills_prompt)
        if client_tool_prompts:
            for guide in client_tool_prompts:
                if guide.strip().startswith("<tool_guide"):
                    builder.add_tool_guides([guide])
                else:
                    builder.add_tool_guide("client", guide)
        if state_prompts:
            builder.add_state_prompts(state_prompts)
        if instructions:
            builder.set_instructions(instructions)
        return builder.build()

    # ------------------------------------------------------------------
    # Tool resolution strategies
    # ------------------------------------------------------------------

    def _resolve_agent_config_tools(
        self,
        agent_config: "AgentDefinition",
        client_tool_schemas: Optional[List[dict]],
        server_tool_schemas: list,
        active_tool_names: Optional[Set[str]],
    ) -> list:
        """Resolve tools based on AgentDefinition (routed agent).

        - Client and server skill tools are filtered to only those whose
          owning skill is in ``agent_config.skills``.
        - MCP tools are included only if ``agent_config.mcp_tools`` is True.
        """
        tools: list = []
        seen_names: set = set()

        # Build the allowed tool-name set from the agent's skills.
        # This filters both client and server tool schemas so the agent
        # only sees tools belonging to its declared skills.
        allowed_skills = set(agent_config.skills) if agent_config.skills else set()
        skill_tool_names: Set[str] = set()
        if allowed_skills and self.skill_provider:
            skill_tool_names = self.skill_provider.get_skill_tool_names(allowed_skills)

        # Client tools — filtered by allowed skill tools
        for t in client_tool_schemas or []:
            name = t.get("function", {}).get("name")
            if name and name not in seen_names:
                if skill_tool_names and name not in skill_tool_names:
                    continue
                seen_names.add(name)
                tools.append(t)

        # Server skill tools — only from allowed skills
        if skill_tool_names:
            for t in server_tool_schemas:
                name = t.get("function", {}).get("name")
                if name and name in skill_tool_names and name not in seen_names:
                    seen_names.add(name)
                    tools.append(t)

        # MCP tools — only if agent allows them
        # Note: active_tool_names filter is NOT applied here because it only
        # tracks client-skill tool names. MCP tool access is governed solely
        # by agent_config.mcp_tools. Applying the filter would drop all MCP
        # tools on continuation turns (where skills_snapshot is absent).
        if agent_config.mcp_tools:
            for t in self.mcp_tool_controller.get_tool_schemas():
                name = t.get("function", {}).get("name")
                if name and name not in seen_names:
                    seen_names.add(name)
                    tools.append(t)

        return tools

    def _resolve_subagent_tools(
        self,
        client_tool_schemas: Optional[List[dict]],
        server_tool_schemas: list,
        active_tool_names: Optional[Set[str]],
    ) -> list:
        """Resolve tools for sub-agent calls (full server + MCP tool set)."""
        tools: list = []
        seen_names: set = set()

        for t in client_tool_schemas or []:
            name = t.get("function", {}).get("name")
            if name and name not in seen_names:
                seen_names.add(name)
                tools.append(t)

        for t in server_tool_schemas:
            name = t.get("function", {}).get("name")
            if name and name not in seen_names:
                seen_names.add(name)
                tools.append(t)

        for t in self.mcp_tool_controller.get_tool_schemas():
            name = t.get("function", {}).get("name")
            if name and name not in seen_names:
                if active_tool_names is not None and name not in active_tool_names:
                    continue
                seen_names.add(name)
                tools.append(t)

        return tools

    @staticmethod
    def _resolve_main_agent_tools(
        client_tool_schemas: Optional[List[dict]],
        server_tool_schemas: list,
    ) -> list:
        """Resolve tools for the main orchestrator agent (activate_skill + ask_question only)."""
        tools: list = []
        seen_names: set = set()

        for t in client_tool_schemas or []:
            name = t.get("function", {}).get("name")
            if name and name not in seen_names:
                seen_names.add(name)
                tools.append(t)

        for t in server_tool_schemas:
            name = t.get("function", {}).get("name")
            if name and name in MAIN_AGENT_TOOLS and name not in seen_names:
                seen_names.add(name)
                tools.append(t)

        return tools

    # ------------------------------------------------------------------
    # Schema normalisation
    # ------------------------------------------------------------------

    # JSON Schema keyword mappings for provider compatibility.
    # OpenAI uses standard JSON Schema keywords; Gemini SDK uses its own
    # naming convention.
    #   - str value  → rename key  (e.g. "oneOf" → "anyOf")
    #   - None value → drop key    (e.g. "additionalProperties" → removed)
    _SCHEMA_KEY_MAP: dict[str, str | None] = {
        "oneOf": "anyOf",
        "additionalProperties": None,
    }

    @classmethod
    def _normalize_tool_schemas(cls, tools: list) -> list:
        """Rewrite/strip JSON Schema keywords for cross-provider compatibility.

        Applies ``_SCHEMA_KEY_MAP`` recursively to all tool schemas.
        Extend ``_SCHEMA_KEY_MAP`` to handle future provider differences.
        """
        key_map = cls._SCHEMA_KEY_MAP
        if not key_map:
            return tools

        def _rewrite(obj):
            if isinstance(obj, dict):
                result = {
                    key_map.get(k, k): _rewrite(v)
                    for k, v in obj.items()
                    if key_map.get(k, k) is not None
                }
                # Gemini requires a non-empty "items" on every array type
                is_array = result.get("type") == "array"
                has_valid_items = result.get("items") not in (None, {})
                if is_array and not has_valid_items:
                    result["items"] = {"type": "string"}
                return result
            if isinstance(obj, list):
                return [_rewrite(item) for item in obj]
            return obj

        return [_rewrite(t) for t in tools]

    @staticmethod
    def _inject_display_name_param(tools: list) -> list:
        """Add a required display_name parameter to every tool schema.

        Forces the LLM to generate a short PascalCase display name for each
        tool call, so the UI always has a human-readable label.
        """
        for t in tools:
            func = t.get("function", {})
            params = func.get("parameters")
            if not isinstance(params, dict):
                continue
            props = params.get("properties")
            if not isinstance(props, dict):
                continue
            if "display_name" in props:
                continue
            props["display_name"] = {
                "type": "string",
                "description": (
                    "A short PascalCase display label for this tool call "
                    "(e.g. 'WebSearch', 'ManageTodo', 'ReadFile'). "
                    "Derive it from the tool name and current task context."
                ),
            }
            required = params.get("required")
            if isinstance(required, list) and "display_name" not in required:
                required.append("display_name")
        return tools
