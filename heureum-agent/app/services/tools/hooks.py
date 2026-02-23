# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tool hooks — before/after middleware and built-in hook implementations."""

import abc
import logging
import time
from dataclasses import dataclass
from typing import Any, Dict, List, Optional

from app.services.tools.loop_detection import (
    LoopSeverity,
    ToolLoopDetectionConfig,
    detect_tool_call_loop,
    record_tool_call,
    record_tool_outcome,
    should_emit_warning,
)

logger = logging.getLogger(__name__)


_ALWAYS_MUTATING_TOOLS = frozenset(
    {
        "write",
        "edit",
        "create",
        "delete",
        "remove",
        "rename",
        "file_write",
        "file_delete",
        "file_rename",
        "file_move",
        "bash",
        "shell",
        "terminal",
    }
)

_READ_ONLY_TOOLS = frozenset(
    {
        "read",
        "search",
        "grep",
        "glob",
        "find",
        "ls",
        "list",
        "file_read",
        "file_search",
        "file_list",
        "web_search",
        "web_fetch",
    }
)

_MUTATING_ACTIONS = frozenset(
    {
        "create",
        "update",
        "delete",
        "write",
        "edit",
        "send",
        "post",
        "put",
        "patch",
        "execute",
        "run",
    }
)


@dataclass
class BeforeHookResult:
    """Result from a before-hook execution."""

    blocked: bool = False
    reason: str = ""
    adjusted_params: Optional[Dict[str, Any]] = None


class ToolHook(abc.ABC):
    """Abstract base class for tool hooks."""

    @abc.abstractmethod
    async def before_tool_call(
        self,
        tool_name: str,
        params: Dict[str, Any],
        context: Dict[str, Any],
    ) -> BeforeHookResult:
        """Called before tool execution."""

    @abc.abstractmethod
    async def after_tool_call(
        self,
        tool_name: str,
        params: Dict[str, Any],
        result: Optional[str],
        error: Optional[str],
        context: Dict[str, Any],
    ) -> None:
        """Called after tool execution."""


class ToolHookRunner:
    """Manages hook registration and execution."""

    def __init__(
        self,
        *,
        register_defaults: bool = True,
        loop_detection_config: Optional[ToolLoopDetectionConfig] = None,
    ) -> None:
        self._hooks: List[ToolHook] = []
        if register_defaults:
            self._hooks.append(LoopDetectionHook(config=loop_detection_config))
            self._hooks.append(MutationTrackingHook())
            self._hooks.append(TimingHook())

    def register(self, hook: ToolHook) -> None:
        self._hooks.append(hook)

    async def run_before(
        self,
        tool_name: str,
        params: Dict[str, Any],
        context: Dict[str, Any],
    ) -> BeforeHookResult:
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


def is_mutating_tool_call(
    tool_name: str,
    params: Optional[Dict[str, Any]] = None,
    *,
    dynamic_mutating: frozenset = frozenset(),
    dynamic_read_only: frozenset = frozenset(),
) -> bool:
    """Classify a tool call as mutating or read-only.

    Checks client-provided dynamic sets first, then falls back to
    built-in static sets.
    """
    name_lower = tool_name.lower()

    # Dynamic sets from client tool_meta take precedence
    if name_lower in dynamic_mutating:
        return True
    if name_lower in dynamic_read_only:
        return False

    # Static fallbacks for non-client tools
    if name_lower in _ALWAYS_MUTATING_TOOLS:
        return True
    if name_lower in _READ_ONLY_TOOLS:
        return False

    if params:
        action = str(params.get("action", "")).lower()
        if action in _MUTATING_ACTIONS:
            return True

    return True


def build_action_fingerprint(
    tool_name: str,
    params: Optional[Dict[str, Any]] = None,
    *,
    dynamic_mutating: frozenset = frozenset(),
    dynamic_read_only: frozenset = frozenset(),
) -> Optional[str]:
    """Build a fingerprint for a mutating action, or None for read-only."""
    if not is_mutating_tool_call(
        tool_name,
        params,
        dynamic_mutating=dynamic_mutating,
        dynamic_read_only=dynamic_read_only,
    ):
        return None

    parts = [tool_name]
    if params:
        for key in ("path", "file", "file_path", "url", "name"):
            if key in params:
                parts.append(f"{key}={params[key]}")
    return "|".join(parts)


def is_same_mutation(fp1: Optional[str], fp2: Optional[str]) -> bool:
    """Check if two fingerprints represent the same mutation."""
    if fp1 is None or fp2 is None:
        return False
    return fp1 == fp2


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

        record = record_tool_call(session_id, tool_name, params, config=self._config)
        context["_loop_record"] = record

        dynamic_poll = context.get("_dynamic_poll", frozenset())
        detection = detect_tool_call_loop(
            session_id,
            config=self._config,
            dynamic_poll_tools=dynamic_poll,
        )

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

        record = context.get("_loop_record")
        if record is not None:
            outcome = error if error else (result or "")
            record_tool_outcome(record, outcome)


class MutationTrackingHook(ToolHook):
    """Hook that logs mutating tool calls."""

    async def before_tool_call(
        self,
        tool_name: str,
        params: Dict[str, Any],
        context: Dict[str, Any],
    ) -> BeforeHookResult:
        dynamic_mutating = context.get("_dynamic_mutating", frozenset())
        dynamic_read_only = context.get("_dynamic_read_only", frozenset())
        fp = build_action_fingerprint(
            tool_name,
            params,
            dynamic_mutating=dynamic_mutating,
            dynamic_read_only=dynamic_read_only,
        )
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
        return


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
