# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Prompt-domain controller — system prompt build + tool schema resolution."""

from typing import Any, List, Optional, Set, Tuple

from app.services.prompts.base import build_system_prompt


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

        Returns:
            (system_prompt, tool_schemas_for_bind_tools).
        """
        effective_skills_prompt = skills_prompt

        # OpenClaw-style snapshot mode: avoid injecting full SKILL.md bodies
        # when <available_skills> is already present.
        use_server_guides = not bool(effective_skills_prompt)

        server_tool_prompts = (
            (
                self.skill_provider.get_all_guide_prompts(
                    skills_snapshot=skills_snapshot,
                )
                if self.skill_provider and use_server_guides
                else []
            )
        )
        server_tool_schemas = (
            (
                self.skill_provider.get_all_tool_schemas(
                    skills_snapshot=skills_snapshot,
                )
                if self.skill_provider
                else []
            )
        )

        prompt = build_system_prompt(
            server_tool_prompts=server_tool_prompts,
            client_tool_prompts=client_tool_prompts,
            instructions=instructions,
            state_prompts=state_prompts,
            skills_prompt=effective_skills_prompt,
            is_subagent=is_subagent,
        )

        tools: list = []
        seen_names: set = set()
        # Client tools take priority (they carry client-specific metadata).
        for t in client_tool_schemas or []:
            name = t.get("function", {}).get("name")
            if name and name not in seen_names:
                seen_names.add(name)
                tools.append(t)
        # Server skill tools
        for t in server_tool_schemas:
            name = t.get("function", {}).get("name")
            if name and name not in seen_names:
                seen_names.add(name)
                tools.append(t)
        # MCP-discovered tools — apply active skill filter
        for t in self.mcp_tool_controller.get_tool_schemas():
            name = t.get("function", {}).get("name")
            if name and name not in seen_names:
                if active_tool_names is not None and name not in active_tool_names:
                    continue
                seen_names.add(name)
                tools.append(t)

        tools = self._normalize_tool_schemas(tools)
        if not is_subagent:
            tools = self._inject_display_name_param(tools)

        return prompt, tools

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
