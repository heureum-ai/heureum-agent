# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Skill package discovery helpers."""

import importlib
import logging
import os
from typing import Any, Dict, Tuple

logger = logging.getLogger(__name__)


def discover_skills(controller_file: str) -> Tuple[Dict[str, Any], Dict[str, Any], Dict[str, str]]:
    """Discover all skills from app/skills packages."""
    skills: Dict[str, Any] = {}
    tool_to_skill: Dict[str, Any] = {}
    display_names: Dict[str, str] = {}

    skills_dir = os.path.join(
        os.path.dirname(os.path.abspath(controller_file)),
        os.pardir,
        os.pardir,
        "skills",
    )
    skills_dir = os.path.normpath(skills_dir)

    if not os.path.isdir(skills_dir):
        return skills, tool_to_skill, display_names

    for entry in sorted(os.listdir(skills_dir)):
        if entry.startswith("_") or entry.startswith("."):
            continue
        package_dir = os.path.join(skills_dir, entry)
        if not os.path.isdir(package_dir):
            continue
        if not os.path.isfile(os.path.join(package_dir, "__init__.py")):
            continue

        module_name = f"app.skills.{entry}"
        try:
            module = importlib.import_module(module_name)
        except Exception:
            logger.warning("Failed to import skill package %s", module_name, exc_info=True)
            continue

        skill = getattr(module, "skill", None)
        if skill is None:
            continue
        if not hasattr(skill, "name") or not hasattr(skill, "tool_schemas"):
            logger.warning(
                "Skill in %s missing 'name' or 'tool_schemas', skipping",
                module_name,
            )
            continue

        skills[skill.name] = skill
        for schema in skill.tool_schemas:
            function_name = schema["function"]["name"]
            tool_to_skill[function_name] = skill
            display_name = schema.get("display_name")
            if display_name:
                display_names[function_name] = display_name

    if skills:
        logger.info("Discovered skills: %s", list(skills.keys()))

    return skills, tool_to_skill, display_names
