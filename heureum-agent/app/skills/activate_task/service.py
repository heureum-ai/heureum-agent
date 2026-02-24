# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Activate skill — progressive tool loading for LLM-based skill activation."""

import json
import logging
from typing import Any, Dict

logger = logging.getLogger(__name__)

ACTIVATE_SKILL_SCHEMA = {
    "type": "function",
    "display_name": "ActivateSkill",
    "function": {
        "name": "activate_skill",
        "description": (
            "Activate skills to use their tools. Call this before using "
            "a skill's tools. Review the <available_skills> section in "
            "your prompt to see which skills can be activated."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "skill_names": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": (
                        "Names of skills to activate (from available_skills list)"
                    ),
                },
            },
            "required": ["skill_names"],
        },
    },
}


class ActivateSkill:
    """Server skill that activates client skills on demand."""

    name = "activate_task"
    tool_schemas = [ACTIVATE_SKILL_SCHEMA]

    def __init__(self) -> None:
        self._skill_controller: Any = None

    async def on_init(self, skill_controller: Any = None, **kwargs: Any) -> None:
        self._skill_controller = skill_controller

    async def execute(self, name: str, arguments: Dict[str, Any], session_id: str) -> str:
        skill_names = arguments.get("skill_names", [])
        if not skill_names:
            return json.dumps({"error": "skill_names required"})

        if self._skill_controller is None:
            return json.dumps({"error": "skill controller not available"})

        activated = self._skill_controller.activate_skills(session_id, skill_names)
        return json.dumps({
            "activated": activated,
            "message": f"Activated {len(activated)} skill(s). Their tools are now available.",
        })
