# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for pure helper functions in app.routers.agent."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import patch, MagicMock
from uuid import UUID

import pytest
from app.config import settings
from app.models import Message, ToolCallInfo
import app.routers.agent as agent_module
from app.routers.agent import (
    _AgentLoopRunner,
    _build_response,
    _extract_session_id,
    _execute_tool_calls_pipelined,
    _LoopContext,
    _parse_input,
    _text_output,
    _tool_call_output,
)
from app.schemas.open_responses import (
    AssistantMessageItem,
    ErrorObject,
    ErrorType,
    FunctionToolCall,
    FunctionToolResult,
    InputTextContent,
    ItemReferenceItem,
    ItemStatus,
    MessageRole,
    OutputTextContent,
    ReasoningItem,
    ResponseRequest,
    ResponseStatus,
    Usage,
    UserMessageItem,
)

FAKE_UUID_HEX = "a" * 32


@pytest.fixture(autouse=False)
def mock_uuid():
    fake = MagicMock()
    fake.hex = FAKE_UUID_HEX
    with patch("app.routers.agent.uuid.uuid4", return_value=fake) as m:
        yield m


@pytest.fixture(autouse=False)
def mock_time():
    with patch("app.routers.agent.time.time", return_value=1700000000.0) as m:
        yield m


# ---------------------------------------------------------------------------
# TestParseInput
# ---------------------------------------------------------------------------


class TestParseInput:
    def test_string_input(self):
        req = ResponseRequest(input="hello")
        result = _parse_input(req)
        assert len(result) == 1
        assert result[0].role == MessageRole.USER
        assert result[0].content == "hello"

    def test_user_message_item(self):
        item = UserMessageItem(
            content=[InputTextContent(text="hi"), InputTextContent(text="there")],
        )
        req = ResponseRequest(input=[item])
        result = _parse_input(req)
        assert len(result) == 1
        assert result[0].role == MessageRole.USER
        assert result[0].content == "hi\nthere"

    def test_function_tool_result(self):
        item = FunctionToolResult(call_id="call_1", output="result_text")
        req = ResponseRequest(input=[item])
        result = _parse_input(req)
        assert len(result) == 1
        assert result[0].role == MessageRole.TOOL
        assert result[0].content == "result_text"
        assert result[0].tool_call_id == "call_1"

    def test_function_tool_call_skipped(self):
        item = FunctionToolCall(name="some_tool", arguments="{}", call_id="c1")
        req = ResponseRequest(input=[item])
        result = _parse_input(req)
        assert result == []

    def test_reasoning_item_skipped(self):
        item = ReasoningItem(content="thinking...")
        req = ResponseRequest(input=[item])
        result = _parse_input(req)
        assert result == []

    def test_item_reference_skipped(self):
        item = ItemReferenceItem(item_id="ref_123")
        req = ResponseRequest(input=[item])
        result = _parse_input(req)
        assert result == []

    def test_empty_list_input(self):
        req = ResponseRequest(input=[])
        result = _parse_input(req)
        assert result == []

    def test_mixed_input(self):
        items = [
            UserMessageItem(content="question"),
            FunctionToolCall(name="tool_a", arguments="{}", call_id="c1"),
            FunctionToolResult(call_id="c1", output="answer"),
            ReasoningItem(content="hmm"),
            ItemReferenceItem(item_id="ref_1"),
            AssistantMessageItem(content="reply"),
        ]
        req = ResponseRequest(input=items)
        result = _parse_input(req)
        assert len(result) == 3
        assert result[0].role == MessageRole.USER
        assert result[0].content == "question"
        assert result[1].role == MessageRole.TOOL
        assert result[1].content == "answer"
        assert result[1].tool_call_id == "c1"
        assert result[2].role == MessageRole.ASSISTANT
        assert result[2].content == "reply"


# ---------------------------------------------------------------------------
# TestExtractSessionId
# ---------------------------------------------------------------------------


class TestExtractSessionId:
    def test_from_metadata(self):
        req = ResponseRequest(input="x", metadata={"session_id": "s1"})
        assert _extract_session_id(req) == "s1"

    def test_no_metadata(self, mock_uuid):
        req = ResponseRequest(input="x", metadata=None)
        sid = _extract_session_id(req)
        assert sid == f"session_{FAKE_UUID_HEX[:16]}"

    def test_empty_metadata(self, mock_uuid):
        req = ResponseRequest(input="x", metadata={})
        sid = _extract_session_id(req)
        assert sid == f"session_{FAKE_UUID_HEX[:16]}"

    def test_empty_session_id(self, mock_uuid):
        req = ResponseRequest(input="x", metadata={"session_id": ""})
        sid = _extract_session_id(req)
        assert sid == f"session_{FAKE_UUID_HEX[:16]}"


# ---------------------------------------------------------------------------
# TestTextOutput
# ---------------------------------------------------------------------------


class TestTextOutput:
    def test_text_content(self):
        item = _text_output("hello world")
        assert len(item.content) == 1
        assert isinstance(item.content[0], OutputTextContent)
        assert item.content[0].text == "hello world"

    def test_id_prefix(self, mock_uuid):
        item = _text_output("test")
        assert item.id == f"msg_{FAKE_UUID_HEX}"

    def test_default_status(self):
        item = _text_output("test")
        assert item.status == ItemStatus.COMPLETED

    def test_custom_status(self):
        item = _text_output("test", status=ItemStatus.INCOMPLETE)
        assert item.status == ItemStatus.INCOMPLETE


# ---------------------------------------------------------------------------
# TestToolCallOutput
# ---------------------------------------------------------------------------


class TestToolCallOutput:
    def test_name_and_call_id(self):
        tc = _tool_call_output("my_tool", {"key": "val"}, "call_99")
        assert tc.name == "my_tool"
        assert tc.call_id == "call_99"

    def test_dict_arguments_serialized(self):
        tc = _tool_call_output("t", {"a": 1, "b": [2]}, "c")
        parsed = json.loads(tc.arguments)
        assert parsed == {"a": 1, "b": [2]}

    def test_string_arguments_passthrough(self):
        tc = _tool_call_output("t", '{"raw": true}', "c")
        assert tc.arguments == '{"raw": true}'

    def test_id_prefix(self, mock_uuid):
        tc = _tool_call_output("t", {}, "c")
        assert tc.id == f"fc_{FAKE_UUID_HEX}"


# ---------------------------------------------------------------------------
# TestBuildResponse
# ---------------------------------------------------------------------------


class TestBuildResponse:
    def test_basic_fields(self, mock_uuid, mock_time):
        resp = _build_response(
            output_items=[],
            status=ResponseStatus.COMPLETED,
            session_id="sess_1",
            created_at=1000,
            model="test-model",
        )
        assert resp.id == f"resp_{FAKE_UUID_HEX}"
        assert resp.model == "test-model"
        assert resp.status == ResponseStatus.COMPLETED
        assert resp.metadata["session_id"] == "sess_1"
        assert resp.created_at == 1000

    def test_default_usage_is_zero(self):
        resp = _build_response(
            output_items=[],
            status=ResponseStatus.COMPLETED,
            session_id="s",
            created_at=0,
            model="m",
        )
        assert resp.usage.input_tokens == 0
        assert resp.usage.output_tokens == 0
        assert resp.usage.total_tokens == 0

    def test_custom_usage(self):
        custom = Usage(
            input_tokens=10,
            output_tokens=20,
            total_tokens=30,
            input_tokens_details={"cached_tokens": 5},
            output_tokens_details={"reasoning_tokens": 3},
        )
        resp = _build_response(
            output_items=[],
            status=ResponseStatus.COMPLETED,
            session_id="s",
            created_at=0,
            model="m",
            usage=custom,
        )
        assert resp.usage.input_tokens == 10
        assert resp.usage.output_tokens == 20
        assert resp.usage.total_tokens == 30

    def test_error_field(self):
        err = ErrorObject(type=ErrorType.SERVER_ERROR, message="boom")
        resp = _build_response(
            output_items=[],
            status=ResponseStatus.FAILED,
            session_id="s",
            created_at=0,
            model="m",
            error=err,
        )
        assert resp.error is not None
        assert resp.error.type == ErrorType.SERVER_ERROR
        assert resp.error.message == "boom"

    def test_extra_metadata(self):
        resp = _build_response(
            output_items=[],
            status=ResponseStatus.COMPLETED,
            session_id="s",
            created_at=0,
            model="m",
            iterations=5,
            tool_call_count=3,
        )
        assert resp.metadata["iterations"] == 5
        assert resp.metadata["tool_call_count"] == 3
        assert resp.metadata["session_id"] == "s"

    def test_completed_at_set(self, mock_time):
        resp = _build_response(
            output_items=[],
            status=ResponseStatus.COMPLETED,
            session_id="s",
            created_at=0,
            model="m",
        )
        assert resp.completed_at == 1700000000


# ---------------------------------------------------------------------------
# TestConstants
# ---------------------------------------------------------------------------


class TestConstants:
    def test_max_agent_iterations(self):
        assert settings.MAX_AGENT_ITERATIONS == 50


class TestPipelinedChainDepth:
    @pytest.mark.asyncio
    async def test_depth_is_tracked_per_chain_hop(self, monkeypatch):
        """All sibling root calls should get first-hop follow-ups."""

        async def _fake_safe(tc: ToolCallInfo, session_id: str = "", cwd: str = "") -> tuple[ToolCallInfo, str]:
            delays = {"start_a": 0.01, "start_b": 0.02, "start_c": 0.03}
            await asyncio.sleep(delays.get(tc.name, 0))
            return tc, '{"ok": true}'

        def _fake_build(tc: ToolCallInfo, *_args, **_kwargs):
            if tc.name.startswith("start_"):
                suffix = tc.name[-1]
                return [ToolCallInfo(name=f"follow_{suffix}", args={}, id=f"fu_{tc.id}")]
            return []

        monkeypatch.setattr(agent_module, "_safe_execute_tool", _fake_safe)
        monkeypatch.setattr(agent_module.chain_registry, "build_per_result", _fake_build)

        roots = [
            ToolCallInfo(name="start_a", args={}, id="a"),
            ToolCallInfo(name="start_b", args={}, id="b"),
            ToolCallInfo(name="start_c", args={}, id="c"),
        ]
        results, _ = await _execute_tool_calls_pipelined(
            roots,
            all_output_items=[],
            session_id="s1",
            max_depth=1,
        )

        names = [m.tool_name for m in results]
        assert "follow_a" in names
        assert "follow_b" in names
        assert "follow_c" in names


class TestStreamRetries:
    @pytest.mark.asyncio
    async def test_unfinished_work_does_not_emit_duplicate_delta(self, monkeypatch):
        """Partial text should be streamed once per iteration."""

        class _FakeAccum:
            def __init__(self):
                self.content = "PARTIAL"
                self.tool_calls = []
                self.usage_metadata = {}

        async def _fake_stream(*_args, **_kwargs):
            yield ("delta", "PARTIAL")
            yield ("done", _FakeAccum())

        monkeypatch.setattr(agent_module.skill_provider, "has_unfinished_work", lambda _sid: True)
        monkeypatch.setattr(agent_module.skill_provider, "build_retry_guidance", lambda _sid, _t: "Continue")
        monkeypatch.setattr(agent_module.agent_service, "_append_to_history", lambda *a, **k: None)
        monkeypatch.setattr(agent_module.settings, "MAX_AGENT_ITERATIONS", 1)

        ctx = _LoopContext(
            request=SimpleNamespace(instructions=None),
            created_at=0,
            session_id="s1",
            model="test-model",
            messages=[],
            tool_names=["dummy_tool"],
            total_usage=Usage.zero(),
        )
        runner = _AgentLoopRunner(ctx)
        monkeypatch.setattr(runner, "_stream_llm_and_accumulate", _fake_stream)

        events = []
        async for event in runner._stream_tool_iterations():
            events.append(event)

        deltas = [e for e in events if "response.output_text.delta" in e]
        assert len(deltas) == 1
