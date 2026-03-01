# Copyright (c) 2026 Heureum AI. All rights reserved.

"""ToolHookBridgeMiddleware — adapts the legacy ToolHookRunner to the Middleware ABC."""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.services.middleware.types import (
    BeforeResult,
    Middleware,
    MiddlewareEvent,
    ToolCallEvent,
)

if TYPE_CHECKING:
    from app.services.tools.hooks import ToolHookRunner


class ToolHookBridgeMiddleware(Middleware):
    """Bridge adapter: routes ``ToolCallEvent`` to the existing ``ToolHookRunner``.

    Non-ToolCallEvent events are silently passed through.
    """

    def __init__(self, runner: ToolHookRunner) -> None:
        self._runner = runner

    async def before(self, event: MiddlewareEvent) -> BeforeResult:
        if not isinstance(event, ToolCallEvent):
            return BeforeResult()

        context = {
            "session_id": event.context.session_id,
            "tool_call_id": event.context.extras.get("tool_call_id", ""),
            "_dynamic_mutating": event.context.extras.get("_dynamic_mutating", frozenset()),
            "_dynamic_read_only": event.context.extras.get("_dynamic_read_only", frozenset()),
            "_dynamic_poll": event.context.extras.get("_dynamic_poll", frozenset()),
        }
        hook_result = await self._runner.run_before(event.tool_name, event.params, context)

        if hook_result.blocked:
            return BeforeResult(blocked=True, reason=hook_result.reason)

        modified = None
        if hook_result.adjusted_params is not None:
            modified = {"params": hook_result.adjusted_params}

        return BeforeResult(modified_args=modified)

    async def after(self, event: MiddlewareEvent) -> None:
        if not isinstance(event, ToolCallEvent):
            return

        context = {
            "session_id": event.context.session_id,
            "tool_call_id": event.context.extras.get("tool_call_id", ""),
            "_dynamic_mutating": event.context.extras.get("_dynamic_mutating", frozenset()),
            "_dynamic_read_only": event.context.extras.get("_dynamic_read_only", frozenset()),
            "_dynamic_poll": event.context.extras.get("_dynamic_poll", frozenset()),
        }
        await self._runner.run_after(
            event.tool_name,
            event.params,
            event.result,
            event.error,
            context,
        )
