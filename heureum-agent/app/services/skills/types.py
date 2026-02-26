# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Skill-domain types."""

from dataclasses import dataclass
from typing import List


@dataclass(frozen=True)
class SkillMeta:
    """Parsed metadata and body from a SKILL.md file."""

    name: str
    description: str
    body: str
    tools: List[str]
    depends_on: List[str]
    subagent_access: str = "always"  # "always" | "orchestrator" | "never"
    catalog: bool = True  # Whether to show in <available_skills> catalog
