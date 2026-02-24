# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Skill metadata loading and SKILL.md parsing."""

import importlib
import os
from typing import Any

from app.services.skills.types import SkillMeta


def parse_skill_md(path: str) -> SkillMeta:
    """Parse a SKILL.md file into SkillMeta."""
    with open(path, encoding="utf-8") as file:
        text = file.read()

    name = ""
    description = ""
    body = text
    tools: list[str] = []
    depends_on: list[str] = []
    subagent_access: str = "always"

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
            elif key == "tools":
                tools = [tool.strip() for tool in value.split(",") if tool.strip()]
            elif key == "depends_on":
                depends_on = [tool.strip() for tool in value.split(",") if tool.strip()]
            elif key == "subagent_access":
                subagent_access = value.lower()

    return SkillMeta(
        name=name,
        description=description,
        body=body,
        tools=tools,
        depends_on=depends_on,
        subagent_access=subagent_access,
    )


def load_skill_meta(skill: Any) -> SkillMeta:
    """Load and cache SkillMeta from SKILL.md for a skill instance."""
    cached = getattr(skill, "_skill_meta_cache", None)
    if cached is not None:
        return cached

    module = importlib.import_module(skill.__class__.__module__)
    skill_dir = os.path.dirname(os.path.abspath(module.__file__))  # type: ignore[arg-type]
    markdown_path = os.path.join(skill_dir, "SKILL.md")

    if os.path.isfile(markdown_path):
        meta = parse_skill_md(markdown_path)
    else:
        meta = SkillMeta(
            name=skill.name,
            description="",
            body="",
            tools=[],
            depends_on=[],
        )

    skill._skill_meta_cache = meta
    return meta


def load_guide_prompt(skill: Any) -> str:
    """Load SKILL.md body for a skill instance."""
    return load_skill_meta(skill).body
