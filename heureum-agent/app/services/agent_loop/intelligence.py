# Copyright (c) 2026 Heureum AI. All rights reserved.

"""LoopIntelligenceController — enhances the agentic loop with loop-awareness.

Three intercept domains via a single middleware:
  TOOL   after  -> track tool failures + refresh loop detection state
  PROMPT before -> inject <loop_warning> and <tool_failure_summary> into state_prompts
  MESSAGE before -> escalate retry guidance based on retry count
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Dict

from app.services.agent_loop.context import is_tool_error
from app.services.middleware.types import (
    BeforeResult,
    MessageInjectEvent,
    Middleware,
    MiddlewareEvent,
    PromptBuildEvent,
    ToolCallEvent,
)
from app.services.tools.loop_detection import (
    LoopSeverity,
    detect_tool_call_loop,
)

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Pattern name abstraction — keep internal identifiers out of LLM prompts
# ---------------------------------------------------------------------------

_PATTERN_DESCRIPTIONS: Dict[str, str] = {
    "ping_pong": "alternating between the same two tools with no progress",
    "no_progress": "repeating actions that produce identical results",
    "poll_loop": "polling tool stuck producing identical results",
    "circuit_breaker": "maximum repetition limit reached",
}


def _describe_pattern(pattern: str) -> str:
    return _PATTERN_DESCRIPTIONS.get(pattern, "repetitive tool call pattern detected")


# ---------------------------------------------------------------------------
# Per-session mutable state
# ---------------------------------------------------------------------------


@dataclass
class _SessionIntelligence:
    tool_failure_counts: Dict[str, int] = field(default_factory=dict)
    total_tool_failures: int = 0
    retry_count: int = 0
    display_names: Dict[str, str] = field(default_factory=dict)
    last_loop_severity: LoopSeverity = LoopSeverity.OK
    last_loop_message: str = ""
    last_loop_pattern: str = ""


# ---------------------------------------------------------------------------
# Controller — owns per-session state, creates middleware
# ---------------------------------------------------------------------------


class LoopIntelligenceController:
    """Session-scoped intelligence state for the agentic loop."""

    def __init__(self) -> None:
        self._sessions: Dict[str, _SessionIntelligence] = {}

    def get_session(self, session_id: str) -> _SessionIntelligence:
        if session_id not in self._sessions:
            self._sessions[session_id] = _SessionIntelligence()
        return self._sessions[session_id]

    def clear_session(self, session_id: str) -> None:
        self._sessions.pop(session_id, None)

    def create_middleware(self) -> LoopIntelligenceMiddleware:
        return LoopIntelligenceMiddleware(self)


# ---------------------------------------------------------------------------
# Middleware — single class, three intercept points
# ---------------------------------------------------------------------------


class LoopIntelligenceMiddleware(Middleware):
    """Intercepts TOOL/PROMPT/MESSAGE domains to provide loop intelligence."""

    def __init__(self, controller: LoopIntelligenceController) -> None:
        self._controller = controller

    # -- TOOL after: failure tracking + loop state refresh -------------------

    async def after(self, event: MiddlewareEvent) -> None:
        if not isinstance(event, ToolCallEvent):
            return

        session = self._controller.get_session(event.context.session_id)
        tool_name = event.tool_name

        if event.error or is_tool_error(event.result or ""):
            session.tool_failure_counts[tool_name] = (
                session.tool_failure_counts.get(tool_name, 0) + 1
            )
            session.total_tool_failures += 1
        else:
            # Success resets that tool's consecutive failure count
            session.tool_failure_counts.pop(tool_name, None)

        # Refresh loop detection state (pure function, reads SessionLoopState)
        detection = detect_tool_call_loop(event.context.session_id)
        session.last_loop_severity = detection.severity
        session.last_loop_message = detection.message
        session.last_loop_pattern = detection.pattern

    # -- PROMPT before + MESSAGE before -------------------------------------

    async def before(self, event: MiddlewareEvent) -> BeforeResult:
        if isinstance(event, PromptBuildEvent):
            return self._handle_prompt(event)

        if isinstance(event, MessageInjectEvent):
            return self._handle_message(event)

        return BeforeResult()

    # -- PROMPT handler: inject warnings ------------------------------------

    def _handle_prompt(self, event: PromptBuildEvent) -> BeforeResult:
        session = self._controller.get_session(event.context.session_id)

        # Refresh display_names from extras (runner passes them each iteration)
        extras_display = event.context.extras.get("display_names")
        if extras_display:
            session.display_names.update(extras_display)

        injections: list[str] = []

        # Loop warning — abstract pattern description, no internal identifiers
        if session.last_loop_severity in (
            LoopSeverity.WARNING,
            LoopSeverity.CRITICAL,
            LoopSeverity.CIRCUIT_BREAKER,
        ):
            if session.last_loop_severity in (
                LoopSeverity.CRITICAL,
                LoopSeverity.CIRCUIT_BREAKER,
            ):
                severity_label = "high"
            else:
                severity_label = "moderate"
            pattern_desc = _describe_pattern(session.last_loop_pattern)
            injections.append(
                f'<loop_warning severity="{severity_label}">\n'
                f"  detected: {pattern_desc}\n"
                f"  action: You are repeating the same actions. "
                f"Try a different approach or tool.\n"
                f"</loop_warning>"
            )

        # Tool failure summary — use display names
        if session.tool_failure_counts:
            lines = ["<tool_failure_summary>"]
            for internal_name, count in session.tool_failure_counts.items():
                display = session.display_names.get(internal_name, internal_name)
                lines.append(f"  {display}: {count} consecutive failure(s)")
            lines.append(
                "  suggestion: Avoid repeatedly calling failing tools. "
                "Try alternative tools or different parameters."
            )
            lines.append("</tool_failure_summary>")
            injections.append("\n".join(lines))

        if not injections:
            return BeforeResult()

        state_prompts = list(event.state_prompts or [])
        state_prompts.extend(injections)
        return BeforeResult(modified_args={"state_prompts": state_prompts})

    # -- MESSAGE handler: adaptive retry escalation -------------------------

    def _handle_message(self, event: MessageInjectEvent) -> BeforeResult:
        if event.key != "loop.plan_retry":
            return BeforeResult()

        session = self._controller.get_session(event.context.session_id)
        session.retry_count += 1

        if session.retry_count >= 3:
            escalated = (
                f"{event.content}\n\n"
                f"FINAL ATTEMPT (retry #{session.retry_count}). "
                f"Previous approaches have all failed. "
                f"You MUST use a completely different strategy."
            )
            if session.tool_failure_counts:
                failing_display = ", ".join(
                    session.display_names.get(n, n) for n in session.tool_failure_counts
                )
                escalated += f"\nAvoid these tools: {failing_display}"
            return BeforeResult(modified_args={"content": escalated})

        if session.retry_count >= 2:
            augmented = event.content
            if session.tool_failure_counts:
                failing_display = ", ".join(
                    f"{session.display_names.get(n, n)} ({c}x)"
                    for n, c in session.tool_failure_counts.items()
                )
                augmented += (
                    f"\n\nNote: These tools have been failing: {failing_display}. "
                    f"Consider using different tools or parameters."
                )
            return BeforeResult(modified_args={"content": augmented})

        return BeforeResult()
