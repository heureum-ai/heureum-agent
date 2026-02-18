# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for LLM-as-judge evaluation module."""

import json
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.schemas.open_responses import FunctionToolCall, FunctionToolResult, ItemStatus
from app.services.agent_service import (
    JudgeResult,
    _parse_judge_response,
    build_tool_context,
    judge_response,
)


def _make_tool_call(name: str, call_id: str, arguments: str = "{}") -> FunctionToolCall:
    return FunctionToolCall(
        id=f"fc_{call_id}",
        call_id=call_id,
        name=name,
        arguments=arguments,
        status=ItemStatus.COMPLETED,
    )


def _make_tool_result(call_id: str, output: str) -> FunctionToolResult:
    return FunctionToolResult(
        id=f"out_{call_id}",
        call_id=call_id,
        output=output,
    )


class TestBuildToolContext:
    def test_empty_items(self):
        result = build_tool_context([])
        assert result == "(no tools used)"

    def test_successful_tool(self):
        items = [
            _make_tool_call("web_search", "c1", '{"query": "ai developer"}'),
            _make_tool_result("c1", "Found 10 results"),
        ]
        result = build_tool_context(items)
        assert "web_search" in result
        assert "ok" in result

    def test_failed_tool(self):
        items = [
            _make_tool_call("web_fetch", "c1", '{"url": "https://example.com"}'),
            _make_tool_result("c1", "Error executing tool 'web_fetch': 404 not found"),
        ]
        result = build_tool_context(items)
        assert "web_fetch" in result
        assert "FAILED" in result

    def test_mixed_tools(self):
        items = [
            _make_tool_call("web_search", "c1", '{"query": "test"}'),
            _make_tool_result("c1", "Results found"),
            _make_tool_call("web_fetch", "c2", '{"url": "https://bad.com"}'),
            _make_tool_result("c2", "Error executing tool 'web_fetch': 404"),
        ]
        result = build_tool_context(items)
        lines = result.strip().split("\n")
        assert len(lines) == 3  # header + 2 tools
        assert "ok" in lines[1]
        assert "FAILED" in lines[2]

    def test_limit(self):
        items = []
        for i in range(15):
            items.append(_make_tool_call("tool", f"c{i}"))
            items.append(_make_tool_result(f"c{i}", "ok"))
        result = build_tool_context(items, limit=5)
        lines = [l for l in result.strip().split("\n") if l.startswith(("1.", "2.", "3.", "4.", "5.", "6."))]
        assert len(lines) == 5

    def test_long_args_truncated(self):
        long_args = json.dumps({"query": "x" * 200})
        items = [
            _make_tool_call("search", "c1", long_args),
            _make_tool_result("c1", "ok"),
        ]
        result = build_tool_context(items)
        assert "..." in result

    def test_empty_result_detected_as_failure(self):
        items = [
            _make_tool_call("read_file", "c1"),
            _make_tool_result("c1", "[EMPTY_RESULT] read_file returned no output. Consider retrying with different parameters."),
        ]
        result = build_tool_context(items)
        assert "FAILED" in result


class TestParseJudgeResponse:
    def test_pass_response(self):
        mock = MagicMock(content='{"pass": true, "guidance": null}')
        result = _parse_judge_response(mock)
        assert result.passed is True
        assert result.guidance is None

    def test_fail_response(self):
        mock = MagicMock(content='{"pass": false, "guidance": "Try using a different search query"}')
        result = _parse_judge_response(mock)
        assert result.passed is False
        assert result.guidance == "Try using a different search query"

    def test_invalid_json_defaults_to_pass(self):
        mock = MagicMock(content="This is not JSON")
        result = _parse_judge_response(mock)
        assert result.passed is True

    def test_empty_content_defaults_to_pass(self):
        mock = MagicMock(content="")
        result = _parse_judge_response(mock)
        assert result.passed is True

    def test_null_string_guidance(self):
        mock = MagicMock(content='{"pass": true, "guidance": "null"}')
        result = _parse_judge_response(mock)
        assert result.passed is True
        assert result.guidance is None

    def test_missing_pass_key_defaults_to_pass(self):
        mock = MagicMock(content='{"guidance": "something"}')
        result = _parse_judge_response(mock)
        assert result.passed is True


class TestJudgeResponse:
    @pytest.mark.asyncio
    async def test_pass(self):
        llm = AsyncMock()
        llm.ainvoke.return_value = MagicMock(content='{"pass": true, "guidance": null}')

        result = await judge_response(llm, "search for AI news", "Here are the results...", "Tools used:\n1. web_search -> ok")
        assert result.passed is True

    @pytest.mark.asyncio
    async def test_fail(self):
        llm = AsyncMock()
        llm.ainvoke.return_value = MagicMock(
            content='{"pass": false, "guidance": "The tool returned a 404 error. Try searching with different terms."}'
        )

        result = await judge_response(
            llm,
            "fetch https://example.com",
            "Sorry, I couldn't fetch the page.",
            "Tools used:\n1. web_fetch -> FAILED: 404",
        )
        assert result.passed is False
        assert "404" in (result.guidance or "")

    @pytest.mark.asyncio
    async def test_llm_error_defaults_to_pass(self):
        llm = AsyncMock()
        llm.ainvoke.side_effect = Exception("LLM unavailable")

        result = await judge_response(llm, "hello", "Hi!", "(no tools used)")
        assert result.passed is True

    @pytest.mark.asyncio
    async def test_prompt_contains_user_query(self):
        llm = AsyncMock()
        llm.ainvoke.return_value = MagicMock(content='{"pass": true, "guidance": null}')

        await judge_response(llm, "my specific query", "response", "context")

        call_args = llm.ainvoke.call_args[0][0]
        human_msg = call_args[1]
        assert "my specific query" in human_msg.content
