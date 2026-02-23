# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for EvaluateSkill (LLM-as-judge evaluation)."""

import json
from unittest.mock import AsyncMock, MagicMock

import pytest
from app.schemas.open_responses import FunctionToolCall, FunctionToolResult, ItemStatus
from app.skills.evaluate_task.service import EvaluateSkill


def _make_tool_call(name: str, call_id: str, arguments: str = "{}") -> FunctionToolCall:
    return FunctionToolCall(
        id=f"fc_{call_id}",
        call_id=call_id,
        name=name,
        arguments=arguments,
        status=ItemStatus.COMPLETED,
        display_name=name,
    )


def _make_tool_result(call_id: str, output: str) -> FunctionToolResult:
    return FunctionToolResult(
        id=f"out_{call_id}",
        call_id=call_id,
        output=output,
    )


class TestBuildToolContext:
    def test_empty_items(self):
        result = EvaluateSkill._build_tool_context([])
        assert result == "(no tools used)"

    def test_successful_tool(self):
        items = [
            _make_tool_call("web_search", "c1", '{"query": "ai developer"}'),
            _make_tool_result("c1", "Found 10 results"),
        ]
        result = EvaluateSkill._build_tool_context(items)
        assert "web_search" in result
        assert "ok" in result

    def test_failed_tool(self):
        items = [
            _make_tool_call("web_fetch", "c1", '{"url": "https://example.com"}'),
            _make_tool_result("c1", "Error executing tool 'web_fetch': 404 not found"),
        ]
        result = EvaluateSkill._build_tool_context(items)
        assert "web_fetch" in result
        assert "FAILED" in result

    def test_mixed_tools(self):
        items = [
            _make_tool_call("web_search", "c1", '{"query": "test"}'),
            _make_tool_result("c1", "Results found"),
            _make_tool_call("web_fetch", "c2", '{"url": "https://bad.com"}'),
            _make_tool_result("c2", "Error executing tool 'web_fetch': 404"),
        ]
        result = EvaluateSkill._build_tool_context(items)
        lines = result.strip().split("\n")
        assert len(lines) == 3  # header + 2 tools
        assert "ok" in lines[1]
        assert "FAILED" in lines[2]

    def test_limit(self):
        items = []
        for i in range(15):
            items.append(_make_tool_call("tool", f"c{i}"))
            items.append(_make_tool_result(f"c{i}", "ok"))
        result = EvaluateSkill._build_tool_context(items, limit=5)
        lines = [
            line
            for line in result.strip().split("\n")
            if line.startswith(("1.", "2.", "3.", "4.", "5.", "6."))
        ]
        assert len(lines) == 5

    def test_long_args_truncated(self):
        long_args = json.dumps({"query": "x" * 200})
        items = [
            _make_tool_call("search", "c1", long_args),
            _make_tool_result("c1", "ok"),
        ]
        result = EvaluateSkill._build_tool_context(items)
        assert "..." in result

    def test_empty_result_detected_as_failure(self):
        items = [
            _make_tool_call("read_file", "c1"),
            _make_tool_result(
                "c1",
                "[EMPTY_RESULT] read_file returned no output. Consider retrying with different parameters.",
            ),
        ]
        result = EvaluateSkill._build_tool_context(items)
        assert "FAILED" in result


class TestEvaluateResponse:
    @pytest.mark.asyncio
    async def test_pass_via_tool_call(self):
        llm = MagicMock()
        resp = MagicMock()
        resp.tool_calls = [{"args": {"passed": True}}]
        llm.bind_tools.return_value.ainvoke = AsyncMock(return_value=resp)

        skill = EvaluateSkill()
        result = await skill.evaluate_response(
            "search for AI news",
            "Here are the results...",
            [],
            llm,
        )
        assert result.passed is True

    @pytest.mark.asyncio
    async def test_fail_via_tool_call(self):
        llm = MagicMock()
        resp = MagicMock()
        resp.tool_calls = [{"args": {"passed": False, "guidance": "Try different query"}}]
        llm.bind_tools.return_value.ainvoke = AsyncMock(return_value=resp)

        skill = EvaluateSkill()
        result = await skill.evaluate_response(
            "fetch page",
            "Sorry, couldn't fetch.",
            [],
            llm,
        )
        assert result.passed is False
        assert "different query" in (result.guidance or "")

    @pytest.mark.asyncio
    async def test_llm_error_defaults_to_pass(self):
        llm = MagicMock()
        llm.bind_tools.return_value.ainvoke = AsyncMock(side_effect=Exception("LLM down"))

        skill = EvaluateSkill()
        result = await skill.evaluate_response("hello", "Hi!", [], llm)
        assert result.passed is True

    @pytest.mark.asyncio
    async def test_no_tool_calls_defaults_to_pass(self):
        llm = MagicMock()
        resp = MagicMock()
        resp.tool_calls = []
        llm.bind_tools.return_value.ainvoke = AsyncMock(return_value=resp)

        skill = EvaluateSkill()
        result = await skill.evaluate_response("query", "response", [], llm)
        assert result.passed is True
