# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for the subagent-busy guard in _handle_tool_call_iteration.

When sub-agents are running (has_unfinished_work == True) and the LLM
emits a MAIN_AGENT_TOOLS client call (e.g. ask_question), the guard
must block it, inject an error result, and continue the loop instead
of returning INCOMPLETE to the frontend.
"""

import json
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import app.services.agent_loop as agent_loop_pkg
import pytest
from app.models import ToolCallInfo
from app.services.agent_loop import AgentLoopRunner, LoopContext
from app.schemas.open_responses import ResponseStatus, Usage


async def _async_noop(*_a, **_k):
    pass


def _make_tool_call_info(name: str, args: dict | str = "", call_id: str = "call_1"):
    return ToolCallInfo(name=name, args=args, id=call_id)


def _make_result(tool_calls, text="", usage_dict=None):
    """Fake LLMResult-like object for _handle_tool_call_iteration."""
    usage = SimpleNamespace(**(usage_dict or {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}))
    usage.model_dump = lambda: usage_dict or {"input_tokens": 0, "output_tokens": 0, "total_tokens": 0}
    return SimpleNamespace(
        tool_calls=tool_calls,
        text=text,
        usage=usage,
        assistant_lc_message=None,
    )


def _make_ctx(client_tool_names=None, **overrides):
    defaults = dict(
        request=SimpleNamespace(instructions=None),
        created_at=0,
        session_id="test_session",
        model="test-model",
        messages=[],
        tool_names=["mcp_web__search"],
        client_tool_names=client_tool_names or {"ask_question"},
        display_names={"ask_question": "Question", "mcp_web__search": "Web Search"},
        total_usage=Usage.zero(),
        ctrl=agent_loop_pkg._default,
    )
    defaults.update(overrides)
    return LoopContext(**defaults)


def _patch_runner(monkeypatch, runner, has_unfinished=True):
    """Apply common patches for the guard test."""
    ctrl = agent_loop_pkg._default

    monkeypatch.setattr(
        ctrl.skill_controller, "has_unfinished_work",
        lambda _sid: has_unfinished,
    )
    monkeypatch.setattr(
        ctrl.agent_service, "append_tool_interaction", AsyncMock(),
    )
    monkeypatch.setattr(
        runner._tool_execution, "extract_display_names",
        lambda tc, dn: None,
    )
    monkeypatch.setattr(
        runner._tool_execution, "execute_tool_calls_pipelined",
        AsyncMock(return_value=([], [])),
    )
    monkeypatch.setattr(
        runner._tool_execution, "_snapshot_tools_for",
        lambda _sid: None,
    )


class TestSubagentBusyGuard:
    """Guard blocks MAIN_AGENT_TOOLS client calls while sub-agents run."""

    @pytest.mark.asyncio
    async def test_ask_question_blocked_returns_none(self, monkeypatch):
        """ask_question should be blocked and return None (continue loop)."""
        ctx = _make_ctx()
        runner = AgentLoopRunner(ctx)
        _patch_runner(monkeypatch, runner, has_unfinished=True)

        tc = _make_tool_call_info("ask_question", {"question": "Continue waiting?"}, "call_aq")
        result = _make_result([tc])

        response = await runner._handle_tool_call_iteration(result, iteration=3)

        # Should return None (continue loop), NOT a ResponseObject
        assert response is None

    @pytest.mark.asyncio
    async def test_ask_question_allowed_when_no_subagents(self, monkeypatch):
        """ask_question should pass through when no sub-agents are running."""
        ctx = _make_ctx()
        runner = AgentLoopRunner(ctx)
        _patch_runner(monkeypatch, runner, has_unfinished=False)

        tc = _make_tool_call_info("ask_question", {"question": "What topic?"}, "call_aq")
        result = _make_result([tc])

        response = await runner._handle_tool_call_iteration(result, iteration=1)

        # Should return a ResponseObject with INCOMPLETE status
        assert response is not None
        assert response.status == ResponseStatus.INCOMPLETE

    @pytest.mark.asyncio
    async def test_error_message_injected_into_history(self, monkeypatch):
        """Blocked call should inject error result via message registry."""
        ctx = _make_ctx()
        runner = AgentLoopRunner(ctx)
        _patch_runner(monkeypatch, runner, has_unfinished=True)

        tc = _make_tool_call_info("ask_question", {"question": "Wait?"}, "call_aq")
        result = _make_result([tc])

        await runner._handle_tool_call_iteration(result, iteration=3)

        # append_tool_interaction should have been called with error results
        mock_append = agent_loop_pkg._default.agent_service.append_tool_interaction
        assert mock_append.called
        args = mock_append.call_args
        # The error results (4th positional arg) should contain the error message
        error_results = args[0][3] if len(args[0]) > 3 else args[1].get("results", [])
        assert len(error_results) > 0
        error_content = error_results[0].content
        assert "sub-agents are running" in error_content.lower() or "Cannot use" in error_content

    @pytest.mark.asyncio
    async def test_output_items_tracked(self, monkeypatch):
        """Blocked call should add to output_items via append_tool_output_items."""
        ctx = _make_ctx()
        runner = AgentLoopRunner(ctx)
        _patch_runner(monkeypatch, runner, has_unfinished=True)

        tc = _make_tool_call_info("ask_question", {"question": "Wait?"}, "call_aq")
        result = _make_result([tc])

        items_before = len(ctx.output_items)
        await runner._handle_tool_call_iteration(result, iteration=3)

        # output_items should have grown (tool call + result)
        assert len(ctx.output_items) > items_before

    @pytest.mark.asyncio
    async def test_non_ask_client_tool_passes_through(self, monkeypatch):
        """A client tool NOT in MAIN_AGENT_TOOLS should not be blocked."""
        ctx = _make_ctx(client_tool_names={"ask_question", "custom_display"})
        ctx.display_names["custom_display"] = "Custom Display"
        runner = AgentLoopRunner(ctx)
        _patch_runner(monkeypatch, runner, has_unfinished=True)

        tc = _make_tool_call_info("custom_display", {}, "call_cd")
        result = _make_result([tc])

        response = await runner._handle_tool_call_iteration(result, iteration=3)

        # custom_display is not in MAIN_AGENT_TOOLS, so it should return INCOMPLETE
        assert response is not None
        assert response.status == ResponseStatus.INCOMPLETE

    @pytest.mark.asyncio
    async def test_mixed_calls_only_blocks_main_agent_tools(self, monkeypatch):
        """When both ask_question and custom_display are called, only ask_question is blocked."""
        ctx = _make_ctx(client_tool_names={"ask_question", "custom_display"})
        ctx.display_names["custom_display"] = "Custom Display"
        runner = AgentLoopRunner(ctx)
        _patch_runner(monkeypatch, runner, has_unfinished=True)

        tc_ask = _make_tool_call_info("ask_question", {"question": "Wait?"}, "call_aq")
        tc_custom = _make_tool_call_info("custom_display", {}, "call_cd")
        result = _make_result([tc_ask, tc_custom])

        response = await runner._handle_tool_call_iteration(result, iteration=3)

        # Should return INCOMPLETE for the remaining custom_display call
        assert response is not None
        assert response.status == ResponseStatus.INCOMPLETE
        # The output should contain custom_display but not ask_question
        output_names = [item.name for item in response.output if hasattr(item, "name")]
        assert "custom_display" in output_names
        assert "ask_question" not in output_names
