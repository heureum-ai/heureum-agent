# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Agent definition data types."""

from dataclasses import dataclass, field
from typing import List


@dataclass(frozen=True)
class AgentDefinition:
    """Immutable definition of a specialized agent.

    Each agent is defined by an AGENT.md file with YAML frontmatter.
    The router uses ``description`` and ``trigger`` to classify requests.
    The loop uses the remaining fields to configure tool access and behavior.
    """

    name: str
    description: str
    trigger: str
    identity_prompt: str
    skills: List[str] = field(default_factory=list)
    mcp_tools: bool = False
    client_tools: bool = True
    max_iterations: int = 3
