# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for the centralized MessageRegistry."""

import pytest

from app.services.middleware import (
    BeforeResult,
    Domain,
    MessageInjectEvent,
    MessageRegistry,
    MessageTemplate,
    Middleware,
    MiddlewareRunner,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class ModifyContentMiddleware(Middleware):
    """Middleware that modifies content via modified_args."""

    def __init__(self, replacement: str):
        self._replacement = replacement

    async def before(self, event):
        if isinstance(event, MessageInjectEvent):
            return BeforeResult(modified_args={"content": self._replacement})
        return BeforeResult()


class BlockingMiddleware(Middleware):
    """Middleware that blocks MessageInjectEvents."""

    async def before(self, event):
        if isinstance(event, MessageInjectEvent):
            return BeforeResult(blocked=True, reason="blocked by test")
        return BeforeResult()


class ObserverMiddleware(Middleware):
    """Middleware that records after-events."""

    def __init__(self):
        self.after_events: list[MessageInjectEvent] = []

    async def after(self, event):
        if isinstance(event, MessageInjectEvent):
            self.after_events.append(event)


# ---------------------------------------------------------------------------
# Tests: no middleware (synchronous defaults)
# ---------------------------------------------------------------------------


class TestGetDefault:
    def test_registered_key(self):
        reg = MessageRegistry()
        result = reg.get_default("loop.plan_retry_fallback")
        assert result == "Continue the plan."

    def test_template_formatting(self):
        reg = MessageRegistry()
        result = reg.get_default("tool.error_unavailable", name="my_tool")
        assert result == "Error: Tool 'my_tool' is no longer available."

    def test_unknown_key_returns_empty(self):
        reg = MessageRegistry()
        result = reg.get_default("nonexistent.key")
        assert result == ""

    def test_unknown_key_with_fallback(self):
        reg = MessageRegistry()
        result = reg.get_default("nonexistent.key", fallback="default text")
        assert result == "default text"

    def test_subagent_domain_message(self):
        reg = MessageRegistry()
        result = reg.get_default("subagent.synthesis")
        assert "Synthesize" in result


# ---------------------------------------------------------------------------
# Tests: resolve without middleware
# ---------------------------------------------------------------------------


class TestResolveNoMiddleware:
    @pytest.mark.asyncio
    async def test_resolve_basic(self):
        reg = MessageRegistry()
        content, blocked = await reg.resolve("loop.plan_retry_fallback")
        assert content == "Continue the plan."
        assert blocked is False

    @pytest.mark.asyncio
    async def test_resolve_with_params(self):
        reg = MessageRegistry()
        content, blocked = await reg.resolve(
            "loop.judge_retry",
            user_query="hello",
            text="bad response",
            guidance="try harder",
        )
        assert "hello" in content
        assert "bad response" in content
        assert "try harder" in content
        assert blocked is False

    @pytest.mark.asyncio
    async def test_resolve_unknown_key(self):
        reg = MessageRegistry()
        content, blocked = await reg.resolve("unknown.key", fallback="fallback_text")
        assert content == "fallback_text"
        assert blocked is False


# ---------------------------------------------------------------------------
# Tests: resolve with middleware
# ---------------------------------------------------------------------------


class TestResolveWithMiddleware:
    @pytest.mark.asyncio
    async def test_middleware_modifies_content(self):
        runner = MiddlewareRunner()
        runner.register(ModifyContentMiddleware("overridden"), domains=[Domain.MESSAGE])
        reg = MessageRegistry(middleware_runner=runner)

        content, blocked = await reg.resolve("loop.plan_retry_fallback")
        assert content == "overridden"
        assert blocked is False

    @pytest.mark.asyncio
    async def test_middleware_blocks(self):
        runner = MiddlewareRunner()
        runner.register(BlockingMiddleware(), domains=[Domain.MESSAGE])
        reg = MessageRegistry(middleware_runner=runner)

        content, blocked = await reg.resolve("loop.plan_retry_fallback")
        assert blocked is True
        # When blocked, content is the original default
        assert content == "Continue the plan."

    @pytest.mark.asyncio
    async def test_middleware_after_receives_final_content(self):
        runner = MiddlewareRunner()
        observer = ObserverMiddleware()
        runner.register(ModifyContentMiddleware("modified_text"), domains=[Domain.MESSAGE])
        runner.register(observer, domains=[Domain.MESSAGE])
        reg = MessageRegistry(middleware_runner=runner)

        await reg.resolve("loop.plan_retry_fallback")
        assert len(observer.after_events) == 1
        assert observer.after_events[0].final_content == "modified_text"

    @pytest.mark.asyncio
    async def test_domain_filtering_message(self):
        """Middleware registered for SUBAGENT domain should not intercept MESSAGE domain."""
        runner = MiddlewareRunner()
        runner.register(BlockingMiddleware(), domains=[Domain.SUBAGENT])
        reg = MessageRegistry(middleware_runner=runner)

        content, blocked = await reg.resolve("loop.plan_retry_fallback")
        assert blocked is False
        assert content == "Continue the plan."

    @pytest.mark.asyncio
    async def test_domain_filtering_subagent(self):
        """Middleware registered for SUBAGENT domain should intercept SUBAGENT messages."""
        runner = MiddlewareRunner()
        runner.register(BlockingMiddleware(), domains=[Domain.SUBAGENT])
        reg = MessageRegistry(middleware_runner=runner)

        content, blocked = await reg.resolve("subagent.synthesis")
        assert blocked is True


# ---------------------------------------------------------------------------
# Tests: custom registration
# ---------------------------------------------------------------------------


class TestCustomRegistration:
    def test_override_default(self):
        reg = MessageRegistry()
        reg.register(
            MessageTemplate(
                key="loop.plan_retry_fallback",
                domain=Domain.MESSAGE,
                default="Custom fallback.",
            )
        )
        assert reg.get_default("loop.plan_retry_fallback") == "Custom fallback."

    def test_register_new_key(self):
        reg = MessageRegistry()
        reg.register(
            MessageTemplate(
                key="custom.greeting",
                domain=Domain.MESSAGE,
                default="Hello, {name}!",
            )
        )
        assert reg.get_default("custom.greeting", name="World") == "Hello, World!"

    def test_builder_callback(self):
        def build_msg(**kwargs):
            return f"Built: {kwargs.get('x', 0) + kwargs.get('y', 0)}"

        reg = MessageRegistry()
        reg.register(
            MessageTemplate(
                key="custom.builder",
                domain=Domain.MESSAGE,
                default="",
                builder=build_msg,
            )
        )
        assert reg.get_default("custom.builder", x=3, y=4) == "Built: 7"

    @pytest.mark.asyncio
    async def test_resolve_custom_with_middleware(self):
        runner = MiddlewareRunner()
        runner.register(ModifyContentMiddleware("intercepted"), domains=[Domain.MESSAGE])
        reg = MessageRegistry(middleware_runner=runner)
        reg.register(
            MessageTemplate(
                key="custom.msg",
                domain=Domain.MESSAGE,
                default="original",
            )
        )
        content, blocked = await reg.resolve("custom.msg")
        assert content == "intercepted"


# ---------------------------------------------------------------------------
# Tests: middleware_runner property
# ---------------------------------------------------------------------------


class TestMiddlewareRunnerProperty:
    @pytest.mark.asyncio
    async def test_set_runner_after_init(self):
        reg = MessageRegistry()  # no runner initially

        content, blocked = await reg.resolve("loop.plan_retry_fallback")
        assert blocked is False
        assert content == "Continue the plan."

        runner = MiddlewareRunner()
        runner.register(BlockingMiddleware(), domains=[Domain.MESSAGE])
        reg.middleware_runner = runner

        content, blocked = await reg.resolve("loop.plan_retry_fallback")
        assert blocked is True


# ---------------------------------------------------------------------------
# Tests: MessageInjectEvent structure
# ---------------------------------------------------------------------------


class TestMessageInjectEvent:
    def test_event_defaults(self):
        from app.services.middleware.types import MiddlewareContext

        event = MessageInjectEvent(
            context=MiddlewareContext(),
            key="test.key",
            content="hello",
            params={"a": 1},
        )
        assert event.domain == Domain.MESSAGE
        assert event.method == "resolve"
        assert event.key == "test.key"
        assert event.content == "hello"
        assert event.params == {"a": 1}
        assert event.final_content is None

    def test_event_custom_domain(self):
        from app.services.middleware.types import MiddlewareContext

        event = MessageInjectEvent(
            domain=Domain.SUBAGENT,
            context=MiddlewareContext(),
            key="subagent.test",
        )
        assert event.domain == Domain.SUBAGENT


# ---------------------------------------------------------------------------
# Tests: all default keys exist
# ---------------------------------------------------------------------------


class TestDefaultKeys:
    EXPECTED_KEYS = [
        "loop.plan_retry",
        "loop.plan_retry_fallback",
        "loop.subagent_synthesis",
        "loop.judge_retry",
        "loop.judge_default_guidance",
        "loop.max_iterations",
        "tool.error_unavailable",
        "tool.error_empty",
        "tool.error_exec",
        "tool.error_blocked",
        "tool.error_skill_blocked",
        "tool.error_mcp_blocked",
        "tool.error_unsupported",
        "tool.error_denied",
        "subagent.synthesis",
        "subagent.retry_fallback",
        "subagent.completion",
        "subagent.timeout",
        "subagent.failure",
        "subagent.max_iterations",
    ]

    def test_all_keys_registered(self):
        reg = MessageRegistry()
        for key in self.EXPECTED_KEYS:
            assert key in reg._templates, f"Missing default key: {key}"
