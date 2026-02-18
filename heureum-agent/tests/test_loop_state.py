# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for _LoopStateBuilder and _ToolCallRecord in agent.py."""

import pytest
from app.routers.agent import _LoopStateBuilder, _ToolCallRecord
from app.schemas.open_responses import (
    FunctionToolCall,
    FunctionToolResult,
    InputTokenDetails,
    ItemStatus,
    OutputTokenDetails,
    Usage,
)


def _make_usage(input_tokens: int = 1000, output_tokens: int = 500) -> Usage:
    return Usage(
        input_tokens=input_tokens,
        output_tokens=output_tokens,
        total_tokens=input_tokens + output_tokens,
        input_tokens_details=InputTokenDetails(),
        output_tokens_details=OutputTokenDetails(),
    )


def _make_tool_call(name: str, call_id: str) -> FunctionToolCall:
    return FunctionToolCall(
        id=f"fc_{call_id}",
        call_id=call_id,
        name=name,
        arguments="{}",
        status=ItemStatus.COMPLETED,
    )


def _make_tool_result(call_id: str, output: str) -> FunctionToolResult:
    return FunctionToolResult(
        id=f"out_{call_id}",
        call_id=call_id,
        output=output,
    )


class TestExtractRecentTools:
    def test_empty_items(self):
        records = _LoopStateBuilder._extract_recent_tools([])
        assert records == []

    def test_successful_tools(self):
        items = [
            _make_tool_call("web_search", "c1"),
            _make_tool_result("c1", "search results here"),
            _make_tool_call("file_read", "c2"),
            _make_tool_result("c2", "file content here"),
        ]
        records = _LoopStateBuilder._extract_recent_tools(items)
        assert len(records) == 2
        assert records[0].name == "web_search"
        assert records[0].succeeded is True
        assert records[1].name == "file_read"
        assert records[1].succeeded is True

    def test_failed_tool(self):
        items = [
            _make_tool_call("web_fetch", "c1"),
            _make_tool_result("c1", "Error executing tool 'web_fetch': connection timeout"),
        ]
        records = _LoopStateBuilder._extract_recent_tools(items)
        assert len(records) == 1
        assert records[0].name == "web_fetch"
        assert records[0].succeeded is False

    def test_empty_result_detected(self):
        items = [
            _make_tool_call("grep", "c1"),
            _make_tool_result("c1", "[EMPTY_RESULT] grep returned no output. Consider retrying with different parameters."),
        ]
        records = _LoopStateBuilder._extract_recent_tools(items)
        assert records[0].succeeded is False

    def test_error_prefix_detected(self):
        items = [
            _make_tool_call("tool_x", "c1"),
            _make_tool_result("c1", "Error: something went wrong"),
        ]
        records = _LoopStateBuilder._extract_recent_tools(items)
        assert records[0].succeeded is False

    def test_limit_respects_last_n(self):
        items = []
        for i in range(10):
            cid = f"c{i}"
            items.append(_make_tool_call(f"tool_{i}", cid))
            items.append(_make_tool_result(cid, f"result {i}"))

        records = _LoopStateBuilder._extract_recent_tools(items, limit=3)
        assert len(records) == 3
        assert records[0].name == "tool_7"
        assert records[2].name == "tool_9"

    def test_mixed_success_and_failure(self):
        items = [
            _make_tool_call("search", "c1"),
            _make_tool_result("c1", "good result"),
            _make_tool_call("fetch", "c2"),
            _make_tool_result("c2", "Error executing tool 'fetch': 404"),
            _make_tool_call("read", "c3"),
            _make_tool_result("c3", "file content"),
        ]
        records = _LoopStateBuilder._extract_recent_tools(items)
        assert records[0].succeeded is True
        assert records[1].succeeded is False
        assert records[2].succeeded is True


class TestLoopStateBuilderBuild:
    def test_basic_output(self):
        result = _LoopStateBuilder.build(
            iteration=3,
            max_iterations=50,
            tool_call_count=5,
            output_items=[],
            total_usage=_make_usage(10000, 3000),
        )
        assert "<loop_progress>" in result
        assert "</loop_progress>" in result
        assert "iteration: 3/50" in result
        assert "tools_called: 5" in result
        assert "tokens_used: in=10000 out=3000" in result
        # No warning for 47 remaining
        assert "warning" not in result
        # No note for 5 tool calls
        assert "note" not in result

    def test_low_remaining_iterations_warning(self):
        result = _LoopStateBuilder.build(
            iteration=46,
            max_iterations=50,
            tool_call_count=10,
            output_items=[],
            total_usage=_make_usage(),
        )
        assert "warning: only 4 iteration(s) remaining" in result

    def test_exactly_5_remaining_shows_warning(self):
        result = _LoopStateBuilder.build(
            iteration=45,
            max_iterations=50,
            tool_call_count=0,
            output_items=[],
            total_usage=_make_usage(),
        )
        assert "warning: only 5 iteration(s) remaining" in result

    def test_6_remaining_no_warning(self):
        result = _LoopStateBuilder.build(
            iteration=44,
            max_iterations=50,
            tool_call_count=0,
            output_items=[],
            total_usage=_make_usage(),
        )
        assert "warning" not in result

    def test_high_tool_count_note(self):
        result = _LoopStateBuilder.build(
            iteration=10,
            max_iterations=50,
            tool_call_count=25,
            output_items=[],
            total_usage=_make_usage(),
        )
        assert "note: high tool call count" in result

    def test_20_tool_calls_no_note(self):
        result = _LoopStateBuilder.build(
            iteration=10,
            max_iterations=50,
            tool_call_count=20,
            output_items=[],
            total_usage=_make_usage(),
        )
        assert "note" not in result

    def test_recent_tools_included(self):
        items = [
            _make_tool_call("web_search", "c1"),
            _make_tool_result("c1", "results"),
            _make_tool_call("web_fetch", "c2"),
            _make_tool_result("c2", "Error executing tool 'web_fetch': timeout"),
        ]
        result = _LoopStateBuilder.build(
            iteration=5,
            max_iterations=50,
            tool_call_count=2,
            output_items=items,
            total_usage=_make_usage(),
        )
        assert "recent_tools:" in result
        assert "web_search: ok" in result
        assert "web_fetch: FAILED" in result

    def test_no_recent_tools_section_when_empty(self):
        result = _LoopStateBuilder.build(
            iteration=1,
            max_iterations=50,
            tool_call_count=0,
            output_items=[],
            total_usage=_make_usage(),
        )
        assert "recent_tools:" not in result

    def test_both_warning_and_note(self):
        result = _LoopStateBuilder.build(
            iteration=48,
            max_iterations=50,
            tool_call_count=30,
            output_items=[],
            total_usage=_make_usage(),
        )
        assert "warning:" in result
        assert "note:" in result

    def test_first_iteration(self):
        result = _LoopStateBuilder.build(
            iteration=1,
            max_iterations=50,
            tool_call_count=0,
            output_items=[],
            total_usage=_make_usage(0, 0),
        )
        assert "iteration: 1/50" in result
        assert "tools_called: 0" in result
        assert "tokens_used: in=0 out=0" in result
