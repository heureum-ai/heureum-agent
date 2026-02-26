# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Centralized message registry — single source of truth for all agent loop messages."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Callable, Dict, TYPE_CHECKING

if TYPE_CHECKING:
    from app.services.middleware.runner import MiddlewareRunner

from app.services.middleware.types import (
    Domain,
    MessageInjectEvent,
    MiddlewareContext,
)


@dataclass
class MessageTemplate:
    """Single message definition."""

    key: str
    domain: Domain
    default: str
    builder: Callable[..., str] | None = None


class MessageRegistry:
    """Central message registry. Single source of truth for all hardcoded messages."""

    def __init__(self, middleware_runner: MiddlewareRunner | None = None) -> None:
        self._runner = middleware_runner
        self._templates: Dict[str, MessageTemplate] = {}
        self._register_defaults()

    @property
    def middleware_runner(self) -> MiddlewareRunner | None:
        return self._runner

    @middleware_runner.setter
    def middleware_runner(self, runner: MiddlewareRunner | None) -> None:
        self._runner = runner

    def register(self, template: MessageTemplate) -> None:
        """Register or override a message template."""
        self._templates[template.key] = template

    def get_default(self, key: str, **params: Any) -> str:
        """Return the default message without middleware (synchronous)."""
        template = self._templates.get(key)
        if not template:
            return params.get("fallback", "")
        if template.builder:
            return template.builder(**params)
        return template.default.format(**params) if params else template.default

    async def resolve(
        self,
        key: str,
        session_id: str = "",
        **params: Any,
    ) -> tuple[str, bool]:
        """Resolve a message through the middleware chain.

        Returns:
            (content, blocked) — the resolved text and whether middleware blocked it.
        """
        template = self._templates.get(key)
        if not template:
            content = params.get("fallback", "")
            domain = Domain.MESSAGE
        else:
            if template.builder:
                content = template.builder(**params)
            else:
                content = template.default.format(**params) if params else template.default
            domain = template.domain

        if not self._runner:
            return content, False

        middleware_context = MiddlewareContext(session_id=session_id, extras=params)
        event = MessageInjectEvent(
            domain=domain,
            method="resolve",
            context=middleware_context,
            key=key,
            content=content,
            params=params,
        )
        before = await self._runner.run_before(event)
        if before.blocked:
            return content, True

        result = before.modified_args.get("content", content) if before.modified_args else content
        event.final_content = result
        await self._runner.run_after(event)
        return result, False

    # -- default message registration ----------------------------------------

    def _register_defaults(self) -> None:
        MESSAGE = Domain.MESSAGE
        SUBAGENT = Domain.SUBAGENT

        # -- loop iteration messages --
        self._register_template(MESSAGE, "loop.plan_retry", "{guidance}")
        self._register_template(MESSAGE, "loop.plan_retry_fallback", "Continue the plan.")
        self._register_template(
            MESSAGE,
            "loop.subagent_synthesis",
            "All sub-agents have completed. Their results have been appended "
            "to the conversation. Please synthesize the results and provide "
            "a comprehensive response to the user.",
        )
        self._register_template(
            MESSAGE,
            "loop.judge_retry",
            "The user's original request: {user_query}\n\n"
            "Your previous response was rejected: {text}\n\n"
            "Feedback: {guidance}\n\n"
            "Please try again with alternative approaches.",
        )
        self._register_template(
            MESSAGE,
            "loop.judge_default_guidance",
            "The previous response was inadequate.",
        )
        self._register_template(
            MESSAGE,
            "loop.max_iterations",
            "Reached maximum iterations ({max_iterations}).",
        )

        # -- tool error messages --
        self._register_template(
            MESSAGE,
            "tool.error_unavailable",
            "Error: Tool '{name}' is no longer available.",
        )
        self._register_template(
            MESSAGE,
            "tool.error_empty",
            "[EMPTY_RESULT] {name} returned no output. "
            "Consider retrying with different parameters.",
        )
        self._register_template(
            MESSAGE,
            "tool.error_exec",
            "Error executing tool '{name}': {error}",
        )
        self._register_template(MESSAGE, "tool.error_blocked", "Error: Tool blocked: {reason}")
        self._register_template(
            MESSAGE,
            "tool.error_skill_blocked",
            "Error: Skill blocked: {reason}",
        )
        self._register_template(
            MESSAGE,
            "tool.error_mcp_blocked",
            "Error: MCP tool blocked: {reason}",
        )
        self._register_template(
            MESSAGE,
            "tool.error_unsupported",
            "Error: Tool '{name}' is not available. "
            "Use only the tools provided in the system prompt.",
        )
        self._register_template(
            MESSAGE,
            "tool.error_denied",
            "Permission denied by user for tool: {name}",
        )
        self._register_template(
            MESSAGE,
            "tool.error_subagent_busy",
            "Error: Cannot use '{name}' while sub-agents are running. "
            "Use sessions_spawn_status to monitor progress, "
            "then synthesize results when all sub-agents complete.",
        )

        # -- subagent messages --
        self._register_template(
            SUBAGENT,
            "subagent.synthesis",
            "All sub-tasks completed. Synthesize the results into a concise summary.",
        )
        self._register_template(SUBAGENT, "subagent.retry_fallback", "Continue.")
        self._register_template(
            SUBAGENT,
            "subagent.completion",
            "[Sub-agent completed] Task: {task}\nResult: {summary}",
        )
        self._register_template(SUBAGENT, "subagent.timeout", "Sub-agent task timed out.")
        self._register_template(SUBAGENT, "subagent.failure", "Sub-agent task failed: {error}")
        self._register_template(
            SUBAGENT,
            "subagent.max_iterations",
            "Sub-agent reached maximum iterations.",
        )

    def _register_template(
        self,
        domain: Domain,
        key: str,
        default: str,
        builder: Callable[..., str] | None = None,
    ) -> None:
        self._templates[key] = MessageTemplate(
            key=key, domain=domain, default=default, builder=builder
        )
