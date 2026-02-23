# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for the universal middleware system."""

import pytest

from app.services.middleware import (
    BeforeResult,
    CompactionEvent,
    Domain,
    MCPCallEvent,
    MCPDiscoverEvent,
    Middleware,
    MiddlewareBlocked,
    MiddlewareContext,
    MiddlewareEvent,
    MiddlewareRunner,
    PromptBuildEvent,
    SkillExecuteEvent,
    ToolCallEvent,
)


# ---------------------------------------------------------------------------
# Concrete middleware implementations for testing
# ---------------------------------------------------------------------------


class PassthroughMiddleware(Middleware):
    """Middleware that does nothing (pass-through)."""

    def __init__(self, name: str = "PassthroughMiddleware"):
        self._name = name
        self.before_calls: list[MiddlewareEvent] = []
        self.after_calls: list[MiddlewareEvent] = []

    @property
    def name(self) -> str:
        return self._name

    async def before(self, event):
        self.before_calls.append(event)
        return BeforeResult()

    async def after(self, event):
        self.after_calls.append(event)


class BlockingMiddleware(Middleware):
    """Middleware that blocks all events."""

    def __init__(self, reason: str = "blocked by policy"):
        self._reason = reason

    async def before(self, event):
        return BeforeResult(blocked=True, reason=self._reason)


class ArgModifyingMiddleware(Middleware):
    """Middleware that modifies args."""

    def __init__(self, modifications: dict):
        self._modifications = modifications

    async def before(self, event):
        return BeforeResult(modified_args=self._modifications)


class FailingMiddleware(Middleware):
    """Middleware that raises exceptions."""

    async def before(self, event):
        raise RuntimeError("before failed")

    async def after(self, event):
        raise RuntimeError("after failed")


class OrderTrackingMiddleware(Middleware):
    """Tracks call order via a shared list."""

    def __init__(self, name: str, order_log: list):
        self._name = name
        self._log = order_log

    @property
    def name(self) -> str:
        return self._name

    async def before(self, event):
        self._log.append(f"before:{self._name}")
        return BeforeResult()

    async def after(self, event):
        self._log.append(f"after:{self._name}")


# ---------------------------------------------------------------------------
# MiddlewareRunner tests
# ---------------------------------------------------------------------------


class TestMiddlewareRunner:
    def test_empty_runner_before(self):
        runner = MiddlewareRunner()
        event = ToolCallEvent(context=MiddlewareContext(), tool_name="test")

        import asyncio

        result = asyncio.get_event_loop().run_until_complete(runner.run_before(event))
        assert not result.blocked
        assert result.modified_args is None

    def test_empty_runner_after(self):
        runner = MiddlewareRunner()
        event = ToolCallEvent(context=MiddlewareContext(), tool_name="test")

        import asyncio

        asyncio.get_event_loop().run_until_complete(runner.run_after(event))

    @pytest.mark.asyncio
    async def test_register_and_before_passthrough(self):
        runner = MiddlewareRunner()
        mw = PassthroughMiddleware()
        runner.register(mw)

        event = ToolCallEvent(context=MiddlewareContext(), tool_name="test")
        result = await runner.run_before(event)

        assert not result.blocked
        assert result.modified_args is None
        assert len(mw.before_calls) == 1

    @pytest.mark.asyncio
    async def test_register_and_after_passthrough(self):
        runner = MiddlewareRunner()
        mw = PassthroughMiddleware()
        runner.register(mw)

        event = ToolCallEvent(context=MiddlewareContext(), tool_name="test")
        await runner.run_after(event)

        assert len(mw.after_calls) == 1

    @pytest.mark.asyncio
    async def test_blocking_stops_chain(self):
        runner = MiddlewareRunner()
        blocker = BlockingMiddleware("test block")
        passthrough = PassthroughMiddleware()
        runner.register(blocker)
        runner.register(passthrough)

        event = ToolCallEvent(context=MiddlewareContext(), tool_name="test")
        result = await runner.run_before(event)

        assert result.blocked
        assert result.reason == "test block"
        assert len(passthrough.before_calls) == 0  # not reached

    @pytest.mark.asyncio
    async def test_modified_args_accumulation(self):
        runner = MiddlewareRunner()
        mw1 = ArgModifyingMiddleware({"key1": "val1"})
        mw2 = ArgModifyingMiddleware({"key2": "val2"})
        runner.register(mw1)
        runner.register(mw2)

        event = ToolCallEvent(context=MiddlewareContext(), tool_name="test")
        result = await runner.run_before(event)

        assert not result.blocked
        assert result.modified_args == {"key1": "val1", "key2": "val2"}

    @pytest.mark.asyncio
    async def test_modified_args_last_writer_wins(self):
        runner = MiddlewareRunner()
        mw1 = ArgModifyingMiddleware({"params": {"a": 1}})
        mw2 = ArgModifyingMiddleware({"params": {"b": 2}})
        runner.register(mw1)
        runner.register(mw2)

        event = ToolCallEvent(context=MiddlewareContext(), tool_name="test")
        result = await runner.run_before(event)

        assert result.modified_args["params"] == {"b": 2}

    @pytest.mark.asyncio
    async def test_after_runs_in_reverse_order(self):
        order_log: list = []
        runner = MiddlewareRunner()
        runner.register(OrderTrackingMiddleware("A", order_log))
        runner.register(OrderTrackingMiddleware("B", order_log))
        runner.register(OrderTrackingMiddleware("C", order_log))

        event = ToolCallEvent(context=MiddlewareContext(), tool_name="test")
        await runner.run_after(event)

        assert order_log == ["after:C", "after:B", "after:A"]

    @pytest.mark.asyncio
    async def test_before_runs_in_registration_order(self):
        order_log: list = []
        runner = MiddlewareRunner()
        runner.register(OrderTrackingMiddleware("A", order_log))
        runner.register(OrderTrackingMiddleware("B", order_log))
        runner.register(OrderTrackingMiddleware("C", order_log))

        event = ToolCallEvent(context=MiddlewareContext(), tool_name="test")
        await runner.run_before(event)

        assert order_log == ["before:A", "before:B", "before:C"]

    @pytest.mark.asyncio
    async def test_unregister(self):
        runner = MiddlewareRunner()
        mw = PassthroughMiddleware()
        runner.register(mw)
        runner.unregister(mw)

        event = ToolCallEvent(context=MiddlewareContext(), tool_name="test")
        await runner.run_before(event)

        assert len(mw.before_calls) == 0

    @pytest.mark.asyncio
    async def test_before_exception_is_caught(self):
        runner = MiddlewareRunner()
        runner.register(FailingMiddleware())
        passthrough = PassthroughMiddleware()
        runner.register(passthrough)

        event = ToolCallEvent(context=MiddlewareContext(), tool_name="test")
        result = await runner.run_before(event)

        assert not result.blocked
        assert len(passthrough.before_calls) == 1  # chain continues

    @pytest.mark.asyncio
    async def test_after_exception_is_caught(self):
        runner = MiddlewareRunner()
        runner.register(FailingMiddleware())
        passthrough = PassthroughMiddleware()
        runner.register(passthrough)

        event = ToolCallEvent(context=MiddlewareContext(), tool_name="test")
        # Should not raise
        await runner.run_after(event)
        # Passthrough still ran (it's at index 1, and after runs in reverse)
        assert len(passthrough.after_calls) == 1


# ---------------------------------------------------------------------------
# Domain filtering tests
# ---------------------------------------------------------------------------


class TestDomainFiltering:
    @pytest.mark.asyncio
    async def test_domain_scoped_middleware_matches(self):
        runner = MiddlewareRunner()
        mw = PassthroughMiddleware()
        runner.register(mw, domains=[Domain.TOOL])

        event = ToolCallEvent(context=MiddlewareContext(), tool_name="test")
        await runner.run_before(event)

        assert len(mw.before_calls) == 1

    @pytest.mark.asyncio
    async def test_domain_scoped_middleware_skips(self):
        runner = MiddlewareRunner()
        mw = PassthroughMiddleware()
        runner.register(mw, domains=[Domain.TOOL])

        event = CompactionEvent(context=MiddlewareContext(), message_count=10)
        await runner.run_before(event)

        assert len(mw.before_calls) == 0

    @pytest.mark.asyncio
    async def test_unscoped_middleware_matches_all(self):
        runner = MiddlewareRunner()
        mw = PassthroughMiddleware()
        runner.register(mw)  # no domain filter

        events = [
            ToolCallEvent(context=MiddlewareContext(), tool_name="test"),
            CompactionEvent(context=MiddlewareContext(), message_count=10),
            PromptBuildEvent(context=MiddlewareContext()),
            SkillExecuteEvent(context=MiddlewareContext(), tool_name="skill1"),
            MCPCallEvent(context=MiddlewareContext(), tool_name="mcp1"),
        ]
        for e in events:
            await runner.run_before(e)

        assert len(mw.before_calls) == 5

    @pytest.mark.asyncio
    async def test_multi_domain_scope(self):
        runner = MiddlewareRunner()
        mw = PassthroughMiddleware()
        runner.register(mw, domains=[Domain.TOOL, Domain.MCP])

        await runner.run_before(ToolCallEvent(context=MiddlewareContext(), tool_name="t"))
        await runner.run_before(MCPCallEvent(context=MiddlewareContext(), tool_name="m"))
        await runner.run_before(CompactionEvent(context=MiddlewareContext(), message_count=1))

        assert len(mw.before_calls) == 2


# ---------------------------------------------------------------------------
# Event type tests
# ---------------------------------------------------------------------------


class TestEventTypes:
    def test_tool_call_event_defaults(self):
        event = ToolCallEvent(context=MiddlewareContext(session_id="s1"), tool_name="bash")
        assert event.domain == Domain.TOOL
        assert event.method == "execute_tool"
        assert event.tool_name == "bash"
        assert event.context.session_id == "s1"
        assert event.result is None
        assert event.error is None

    def test_prompt_build_event_defaults(self):
        event = PromptBuildEvent(context=MiddlewareContext(), instructions="test")
        assert event.domain == Domain.PROMPT
        assert event.method == "prepare_prompt_and_tools"
        assert event.instructions == "test"

    def test_skill_execute_event_defaults(self):
        event = SkillExecuteEvent(context=MiddlewareContext(), tool_name="plan")
        assert event.domain == Domain.SKILL
        assert event.method == "execute_tool"

    def test_mcp_call_event_defaults(self):
        event = MCPCallEvent(context=MiddlewareContext(), tool_name="web_search")
        assert event.domain == Domain.MCP
        assert event.method == "call_tool"

    def test_mcp_discover_event_defaults(self):
        event = MCPDiscoverEvent(context=MiddlewareContext(), discovered_tools=[{"fn": "a"}])
        assert event.domain == Domain.MCP
        assert event.method == "discover_tools"
        assert event.discovered_tools == [{"fn": "a"}]

    def test_compaction_event_defaults(self):
        event = CompactionEvent(context=MiddlewareContext(), message_count=42)
        assert event.domain == Domain.COMPACTION
        assert event.method == "compact_session_history"
        assert event.message_count == 42
        assert event.compacted_count is None


# ---------------------------------------------------------------------------
# MiddlewareBlocked exception tests
# ---------------------------------------------------------------------------


class TestMiddlewareBlocked:
    def test_exception_message(self):
        exc = MiddlewareBlocked("test reason")
        assert exc.reason == "test reason"
        assert str(exc) == "test reason"

    def test_raise_and_catch(self):
        with pytest.raises(MiddlewareBlocked) as exc_info:
            raise MiddlewareBlocked("blocked")
        assert exc_info.value.reason == "blocked"


# ---------------------------------------------------------------------------
# Middleware ABC tests
# ---------------------------------------------------------------------------


class TestMiddlewareABC:
    @pytest.mark.asyncio
    async def test_default_before_returns_passthrough(self):
        class MinimalMiddleware(Middleware):
            pass

        mw = MinimalMiddleware()
        result = await mw.before(ToolCallEvent(context=MiddlewareContext(), tool_name="t"))
        assert not result.blocked
        assert result.modified_args is None

    @pytest.mark.asyncio
    async def test_default_after_is_noop(self):
        class MinimalMiddleware(Middleware):
            pass

        mw = MinimalMiddleware()
        # Should not raise
        await mw.after(ToolCallEvent(context=MiddlewareContext(), tool_name="t"))

    def test_name_property(self):
        class CustomMiddleware(Middleware):
            pass

        assert CustomMiddleware().name == "CustomMiddleware"
