# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Per-session in-memory storage shared across agents within a session.

Sub-agents call store_finding() to persist research results.
The main agent calls get_findings() to retrieve them for synthesis.

This decouples inter-agent communication: sub-agents write to storage
and are then discarded; the main agent reads from storage rather than
accumulating raw sub-agent messages directly in its context.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field

logger = logging.getLogger(__name__)

# session_id → {topic: content}
_store: dict[str, dict[str, str]] = {}


def write_finding(session_id: str, topic: str, content: str) -> None:
    """Write a research finding to the session store."""
    _store.setdefault(session_id, {})[topic] = content
    logger.debug("session_storage[%s]: wrote topic=%r (%d chars)", session_id, topic, len(content))


def read_findings(session_id: str) -> dict[str, str]:
    """Return all stored findings for a session (shallow copy)."""
    return dict(_store.get(session_id, {}))


def clear_session(session_id: str) -> None:
    """Remove all stored findings for a session."""
    _store.pop(session_id, None)


# ---------------------------------------------------------------------------
# LangChain tools (session-bound via closure)
# ---------------------------------------------------------------------------


class _StoreFindingInput(BaseModel):
    topic: str = Field(description="Short label for this finding, e.g. 'korea_history' or 'japan_economy'")
    content: str = Field(description="The research result or summary to store")


def make_storage_tools(session_id: str) -> list[StructuredTool]:
    """Return session-bound store_finding / get_findings tools.

    Both the main agent and its sub-agents receive these tools so that:
    - Sub-agents call store_finding() to persist results into the shared store.
    - The main agent calls get_findings() to read all results when synthesizing.
    """

    def _store_finding(topic: str, content: str) -> str:
        write_finding(session_id, topic, content)
        return f"Stored: {topic}"

    def _get_findings() -> str:
        findings = read_findings(session_id)
        if not findings:
            return "No findings stored yet."
        return json.dumps(findings, ensure_ascii=False, indent=2)

    return [
        StructuredTool.from_function(
            func=_store_finding,
            name="store_finding",
            description=(
                "Save research results to the shared session store. "
                "Call this after completing your research sub-task to make results "
                "available to the orchestrating agent. "
                "Args: topic (short key), content (full findings)."
            ),
            args_schema=_StoreFindingInput,
        ),
        StructuredTool.from_function(
            func=_get_findings,
            name="get_findings",
            description=(
                "Retrieve all research findings stored by sub-agents for this session. "
                "Call this before synthesizing to get the full set of results."
            ),
            args_schema=None,  # no args needed
        ),
    ]
