# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Prompt-domain controller — system prompt build + tool schema resolution."""

from typing import Any, List, Optional, Tuple

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
        self.skills_prompt: Optional[str] = None

    def prepare_prompt_and_tools(
        self,
        instructions: Optional[str] = None,
        client_tool_prompts: Optional[List[str]] = None,
        client_tool_schemas: Optional[List[dict]] = None,
        state_prompts: Optional[List[str]] = None,
        skills_prompt: Optional[str] = None,
    ) -> Tuple[str, list]:
        """Build system prompt and resolve tool schemas together.

        Args:
            instructions: Extra instructions to append in ``<instructions>``.
            client_tool_prompts: Guide texts from clients.
            client_tool_schemas: Client-provided OpenAI-format tool schemas.
            state_prompts: Per-turn runtime state prompts from skills.
            skills_prompt: Pre-built ``<available_skills>`` block.

        Returns:
            (system_prompt, tool_schemas_for_bind_tools).
        """
        effective_skills_prompt = skills_prompt or self.skills_prompt

        server_tool_prompts = (
            self.skill_provider.get_all_guide_prompts() if self.skill_provider else []
        )
        server_tool_schemas = (
            self.skill_provider.get_all_tool_schemas() if self.skill_provider else []
        )

        prompt = build_system_prompt(
            server_tool_prompts=server_tool_prompts,
            client_tool_prompts=client_tool_prompts,
            instructions=instructions,
            state_prompts=state_prompts,
            skills_prompt=effective_skills_prompt,
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
        # MCP-discovered tools
        for t in self.mcp_tool_controller.get_tool_schemas():
            name = t.get("function", {}).get("name")
            if name and name not in seen_names:
                seen_names.add(name)
                tools.append(t)

        tools = self._normalize_tool_schemas(tools)

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
