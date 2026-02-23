# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tool-domain shared data types."""

import uuid
from dataclasses import dataclass, field
from typing import Dict, List


def gen_tool_call_id() -> str:
    """Generate a tool-call identifier."""
    return f"call_{uuid.uuid4().hex[:16]}"


@dataclass(frozen=True)
class ChainStep:
    """A single step in a chain sequence."""

    target: str
    extract: str
    arg_mapping: Dict[str, str]


@dataclass(frozen=True)
class ChainRule:
    """A multi-step chain starting from a source tool."""

    source: str
    steps: List[ChainStep] = field(default_factory=list)
