# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for ToolHookBridgeMiddleware — legacy ToolHookRunner adapter."""

import pytest
from unittest.mock import AsyncMock, MagicMock

from app.services.middleware import (
    MiddlewareContext,
    ToolHookBridgeMiddleware,
)
from app.services.middleware.types import (
    CompactionEvent,
    MCPCallEvent,
    PromptBuildEvent,
    SkillExecuteEvent,
    ToolCallEvent,
)
from app.services.tools.hooks import BeforeHookResult


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_mock_runner(
    *,
    blocked: bool = False,
    reason: str = "",
    adjusted_params: dict | None = None,
) -> MagicMock:
    """Create a mock ToolHookRunner with configurable before result."""
    runner = MagicMock()
    runner.run_before = AsyncMock(
        return_value=BeforeHookResult(
            blocked=blocked,
            reason=reason,
            adjusted_params=adjusted_params,
        )
    )
    runner.run_after = AsyncMock()
    return runner


# ---------------------------------------------------------------------------
# before() tests
# ---------------------------------------------------------------------------


class TestToolHookBridgeBefore:
    @pytest.mark.asyncio
    async def test_passthrough_on_tool_event(self):
        mock_runner = _make_mock_runner()
        bridge = ToolHookBridgeMiddleware(mock_runner)

        event = ToolCallEvent(
            context=MiddlewareContext(session_id="s1", extras={"tool_call_id": "tc1"}),
            tool_name="bash",
            params={"cmd": "ls"},
        )
        result = await bridge.before(event)

        assert not result.blocked
        assert result.modified_args is None
        call_args = mock_runner.run_before.call_args
        assert call_args[0][0] == "bash"
        assert call_args[0][1] == {"cmd": "ls"}
        ctx = call_args[0][2]
        assert ctx["session_id"] == "s1"
        assert ctx["tool_call_id"] == "tc1"

    @pytest.mark.asyncio
    async def test_blocked_result(self):
        mock_runner = _make_mock_runner(blocked=True, reason="loop detected")
        bridge = ToolHookBridgeMiddleware(mock_runner)

        event = ToolCallEvent(
            context=MiddlewareContext(session_id="s1", extras={"tool_call_id": "tc1"}),
            tool_name="bash",
            params={},
        )
        result = await bridge.before(event)

        assert result.blocked
        assert result.reason == "loop detected"

    @pytest.mark.asyncio
    async def test_adjusted_params_converted(self):
        mock_runner = _make_mock_runner(adjusted_params={"cmd": "pwd"})
        bridge = ToolHookBridgeMiddleware(mock_runner)

        event = ToolCallEvent(
            context=MiddlewareContext(session_id="s1", extras={"tool_call_id": "tc1"}),
            tool_name="bash",
            params={"cmd": "ls"},
        )
        result = await bridge.before(event)

        assert not result.blocked
        assert result.modified_args == {"params": {"cmd": "pwd"}}

    @pytest.mark.asyncio
    async def test_non_tool_event_passthrough(self):
        mock_runner = _make_mock_runner()
        bridge = ToolHookBridgeMiddleware(mock_runner)

        events = [
            CompactionEvent(context=MiddlewareContext(), message_count=10),
            PromptBuildEvent(context=MiddlewareContext()),
            SkillExecuteEvent(context=MiddlewareContext(), tool_name="plan"),
            MCPCallEvent(context=MiddlewareContext(), tool_name="mcp_web"),
        ]
        for event in events:
            result = await bridge.before(event)
            assert not result.blocked
            assert result.modified_args is None

        mock_runner.run_before.assert_not_awaited()


# ---------------------------------------------------------------------------
# after() tests
# ---------------------------------------------------------------------------


class TestToolHookBridgeAfter:
    @pytest.mark.asyncio
    async def test_after_called_for_tool_event(self):
        mock_runner = _make_mock_runner()
        bridge = ToolHookBridgeMiddleware(mock_runner)

        event = ToolCallEvent(
            context=MiddlewareContext(session_id="s1", extras={"tool_call_id": "tc1"}),
            tool_name="bash",
            params={"cmd": "ls"},
        )
        event.result = "file1.txt\nfile2.txt"
        event.error = None

        await bridge.after(event)

        call_args = mock_runner.run_after.call_args
        assert call_args[0][0] == "bash"
        assert call_args[0][1] == {"cmd": "ls"}
        assert call_args[0][2] == "file1.txt\nfile2.txt"
        assert call_args[0][3] is None
        ctx = call_args[0][4]
        assert ctx["session_id"] == "s1"
        assert ctx["tool_call_id"] == "tc1"

    @pytest.mark.asyncio
    async def test_after_passes_error(self):
        mock_runner = _make_mock_runner()
        bridge = ToolHookBridgeMiddleware(mock_runner)

        event = ToolCallEvent(
            context=MiddlewareContext(session_id="s1", extras={"tool_call_id": "tc1"}),
            tool_name="bash",
            params={"cmd": "ls"},
        )
        event.result = None
        event.error = "permission denied"

        await bridge.after(event)

        call_args = mock_runner.run_after.call_args
        assert call_args[0][0] == "bash"
        assert call_args[0][1] == {"cmd": "ls"}
        assert call_args[0][2] is None
        assert call_args[0][3] == "permission denied"
        ctx = call_args[0][4]
        assert ctx["session_id"] == "s1"
        assert ctx["tool_call_id"] == "tc1"

    @pytest.mark.asyncio
    async def test_after_skipped_for_non_tool_event(self):
        mock_runner = _make_mock_runner()
        bridge = ToolHookBridgeMiddleware(mock_runner)

        events = [
            CompactionEvent(context=MiddlewareContext(), message_count=10),
            PromptBuildEvent(context=MiddlewareContext()),
            SkillExecuteEvent(context=MiddlewareContext(), tool_name="plan"),
            MCPCallEvent(context=MiddlewareContext(), tool_name="mcp_web"),
        ]
        for event in events:
            await bridge.after(event)

        mock_runner.run_after.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_missing_tool_call_id_defaults_to_empty(self):
        mock_runner = _make_mock_runner()
        bridge = ToolHookBridgeMiddleware(mock_runner)

        event = ToolCallEvent(
            context=MiddlewareContext(session_id="s1"),  # no extras
            tool_name="read",
            params={"path": "/tmp"},
        )
        event.result = "content"

        await bridge.after(event)

        call_args = mock_runner.run_after.call_args
        context_arg = call_args[0][4]
        assert context_arg["tool_call_id"] == ""
