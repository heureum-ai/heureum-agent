# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Tool hooks — before/after middleware for tool execution.

Provides:
  - ToolHook ABC with before_tool_call / after_tool_call
  - ToolHookRunner for hook registration and execution
  - Built-in hooks: LoopDetectionHook, MutationTrackingHook, TimingHook
  - Mutation classification helpers
"""

import abc
import logging
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from app.services.loop_detection import (
    LoopSeverity,
    ToolLoopDetectionConfig,
    detect_tool_call_loop,
    record_tool_call,
    record_tool_outcome,
    should_emit_warning,
)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------


@dataclass
class BeforeHookResult:
    """Result from a before-hook execution."""

    blocked: bool = False
    reason: str = ""
    adjusted_params: Optional[Dict[str, Any]] = None


# ---------------------------------------------------------------------------
# Hook ABC
# ---------------------------------------------------------------------------


class ToolHook(abc.ABC):
    """Abstract base class for tool hooks."""

    @abc.abstractmethod
    async def before_tool_call(
        self,
        tool_name: str,
        params: Dict[str, Any],
        context: Dict[str, Any],
    ) -> BeforeHookResult:
        """Called before tool execution.

        Args:
            tool_name: Name of the tool about to be called.
            params: Tool call arguments.
            context: Additional context (session_id, tool_call_id, etc.).

        Returns:
            BeforeHookResult with blocking/adjustment info.
        """

    @abc.abstractmethod
    async def after_tool_call(
        self,
        tool_name: str,
        params: Dict[str, Any],
        result: Optional[str],
        error: Optional[str],
        context: Dict[str, Any],
    ) -> None:
        """Called after tool execution (whether success or failure).

        Args:
            tool_name: Name of the tool that was called.
            params: Tool call arguments.
            result: Tool result string (None if error).
            error: Error message (None if success).
            context: Additional context.
        """


# ---------------------------------------------------------------------------
# Hook runner
# ---------------------------------------------------------------------------


class ToolHookRunner:
    """Manages hook registration and execution."""

    def __init__(self) -> None:
        self._hooks: List[ToolHook] = []

    def register(self, hook: ToolHook) -> None:
        """Register a hook."""
        self._hooks.append(hook)

    async def run_before(
        self,
        tool_name: str,
        params: Dict[str, Any],
        context: Dict[str, Any],
    ) -> BeforeHookResult:
        """Run all before-hooks. First blocker wins.

        If a hook sets adjusted_params and no blocker fires, the last
        non-None adjusted_params is used.
        """
        last_adjusted = None

        for hook in self._hooks:
            try:
                result = await hook.before_tool_call(tool_name, params, context)
                if result.blocked:
                    return result
                if result.adjusted_params is not None:
                    last_adjusted = result.adjusted_params
            except Exception:
                logger.warning(
                    "Before-hook %s failed for %s",
                    type(hook).__name__,
                    tool_name,
                    exc_info=True,
                )

        return BeforeHookResult(adjusted_params=last_adjusted)

    async def run_after(
        self,
        tool_name: str,
        params: Dict[str, Any],
        result: Optional[str],
        error: Optional[str],
        context: Dict[str, Any],
    ) -> None:
        """Run all after-hooks. Errors are logged but don't propagate."""
        for hook in self._hooks:
            try:
                await hook.after_tool_call(tool_name, params, result, error, context)
            except Exception:
                logger.warning(
                    "After-hook %s failed for %s",
                    type(hook).__name__,
                    tool_name,
                    exc_info=True,
                )


# ---------------------------------------------------------------------------
# Mutation classification
# ---------------------------------------------------------------------------

_ALWAYS_MUTATING_TOOLS = frozenset({
    "write", "edit", "create", "delete", "remove", "rename",
    "file_write", "file_delete", "file_rename", "file_move",
    "browser_click", "browser_type", "browser_submit",
    "bash", "shell", "terminal",
})

_READ_ONLY_TOOLS = frozenset({
    "read", "search", "grep", "glob", "find", "ls", "list",
    "file_read", "file_search", "file_list",
    "browser_navigate", "browser_get_content", "browser_screenshot",
    "web_search", "web_fetch",
})

_MUTATING_ACTIONS = frozenset({
    "create", "update", "delete", "write", "edit", "send",
    "post", "put", "patch", "execute", "run",
})


def is_mutating_tool_call(tool_name: str, params: Optional[Dict[str, Any]] = None) -> bool:
    """Classify a tool call as mutating or read-only."""
    name_lower = tool_name.lower()

    if name_lower in _ALWAYS_MUTATING_TOOLS:
        return True
    if name_lower in _READ_ONLY_TOOLS:
        return False

    # Check for action-like params
    if params:
        action = str(params.get("action", "")).lower()
        if action in _MUTATING_ACTIONS:
            return True

    # Default: treat unknown tools as potentially mutating
    return True


def build_action_fingerprint(
    tool_name: str,
    params: Optional[Dict[str, Any]] = None,
) -> Optional[str]:
    """Build a fingerprint for a mutating action, or None for read-only."""
    if not is_mutating_tool_call(tool_name, params):
        return None

    parts = [tool_name]
    if params:
        # Include path/file/url for dedup
        for key in ("path", "file", "file_path", "url", "name"):
            if key in params:
                parts.append(f"{key}={params[key]}")
    return "|".join(parts)


def is_same_mutation(fp1: Optional[str], fp2: Optional[str]) -> bool:
    """Check if two fingerprints represent the same mutation."""
    if fp1 is None or fp2 is None:
        return False
    return fp1 == fp2


# ---------------------------------------------------------------------------
# Built-in hooks
# ---------------------------------------------------------------------------


class LoopDetectionHook(ToolHook):
    """Hook that integrates tool loop detection."""

    def __init__(self, config: Optional[ToolLoopDetectionConfig] = None) -> None:
        self._config = config

    async def before_tool_call(
        self,
        tool_name: str,
        params: Dict[str, Any],
        context: Dict[str, Any],
    ) -> BeforeHookResult:
        session_id = context.get("session_id", "")
        if not session_id:
            return BeforeHookResult()

        # Record the call
        record_tool_call(session_id, tool_name, params, config=self._config)

        # Run detection
        detection = detect_tool_call_loop(session_id, config=self._config)

        if detection.severity == LoopSeverity.CIRCUIT_BREAKER:
            return BeforeHookResult(blocked=True, reason=detection.message)

        if detection.severity in (LoopSeverity.WARNING, LoopSeverity.CRITICAL):
            if should_emit_warning(session_id, detection.streak):
                logger.warning(
                    "Loop detection [%s] session=%s: %s",
                    detection.severity.value,
                    session_id,
                    detection.message,
                )

        return BeforeHookResult()

    async def after_tool_call(
        self,
        tool_name: str,
        params: Dict[str, Any],
        result: Optional[str],
        error: Optional[str],
        context: Dict[str, Any],
    ) -> None:
        session_id = context.get("session_id", "")
        if not session_id:
            return

        from app.services.loop_detection import get_session_loop_state

        state = get_session_loop_state(session_id)
        if state.records:
            last_record = state.records[-1]
            outcome = error if error else (result or "")
            record_tool_outcome(last_record, outcome)


class MutationTrackingHook(ToolHook):
    """Hook that logs mutating tool calls."""

    async def before_tool_call(
        self,
        tool_name: str,
        params: Dict[str, Any],
        context: Dict[str, Any],
    ) -> BeforeHookResult:
        fp = build_action_fingerprint(tool_name, params)
        if fp:
            logger.info("Mutating tool call: %s (session=%s)", fp, context.get("session_id", ""))
        return BeforeHookResult()

    async def after_tool_call(
        self,
        tool_name: str,
        params: Dict[str, Any],
        result: Optional[str],
        error: Optional[str],
        context: Dict[str, Any],
    ) -> None:
        pass


class TimingHook(ToolHook):
    """Hook that measures tool execution time."""

    _start_times: Dict[str, float] = {}

    async def before_tool_call(
        self,
        tool_name: str,
        params: Dict[str, Any],
        context: Dict[str, Any],
    ) -> BeforeHookResult:
        key = context.get("tool_call_id", "")
        if key:
            self._start_times[key] = time.monotonic()
        return BeforeHookResult()

    async def after_tool_call(
        self,
        tool_name: str,
        params: Dict[str, Any],
        result: Optional[str],
        error: Optional[str],
        context: Dict[str, Any],
    ) -> None:
        key = context.get("tool_call_id", "")
        start = self._start_times.pop(key, None)
        if start is not None:
            elapsed = time.monotonic() - start
            if elapsed > 5.0:
                logger.info(
                    "Slow tool: %s took %.1fs (session=%s)",
                    tool_name,
                    elapsed,
                    context.get("session_id", ""),
                )


# ---------------------------------------------------------------------------
# Module-level singleton
# ---------------------------------------------------------------------------

hook_runner = ToolHookRunner()
hook_runner.register(LoopDetectionHook())
hook_runner.register(MutationTrackingHook())
hook_runner.register(TimingHook())
