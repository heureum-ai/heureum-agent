# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for pure helper functions in app.services.agent_loop."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import app.services.agent_loop as agent_loop_pkg
import pytest
from app.config import settings
from app.models import ToolCallInfo
from app.services.agent_loop import (
    AgentLoopRunner,
    LoopContext,
)
from app.services.messages import MessageController
from app.schemas.open_responses import (
    AssistantMessageItem,
    ErrorObject,
    ErrorType,
    FunctionToolCall,
    FunctionToolResult,
    InputTextContent,
    ItemReferenceItem,
    ItemStatus,
    OutputTextContent,
    ReasoningItem,
    ResponseRequest,
    ResponseStatus,
    Usage,
    UserMessageItem,
)

FAKE_UUID_HEX = "a" * 32


message_controller = MessageController()
_parse_input = message_controller.response_message_controller.parse_input_messages
_text_output = message_controller.response_message_controller.text_output
_tool_call_output = message_controller.response_message_controller.tool_call_output
_build_response = message_controller.response_message_controller.build_response


def _extract_session_id(req: ResponseRequest) -> str:
    return message_controller.response_message_controller.extract_session_id(req.metadata)


@pytest.fixture(autouse=False)
def mock_uuid():
    fake = MagicMock()
    fake.hex = FAKE_UUID_HEX
    with patch("app.services.messages.responses.uuid.uuid4", return_value=fake) as m1:
        yield (m1,)


@pytest.fixture(autouse=False)
def mock_time():
    with patch("app.services.messages.responses.time.time", return_value=1700000000.0) as m1:
        yield (m1,)


# ---------------------------------------------------------------------------
# TestParseInput
# ---------------------------------------------------------------------------


class TestParseInput:
    def test_string_input(self):
        req = ResponseRequest(input="hello")
        result = _parse_input(req)
        assert len(result) == 1
        assert result[0].type == "human"
        assert result[0].content == "hello"

    def test_user_message_item(self):
        item = UserMessageItem(
            content=[InputTextContent(text="hi"), InputTextContent(text="there")],
        )
        req = ResponseRequest(input=[item])
        result = _parse_input(req)
        assert len(result) == 1
        assert result[0].type == "human"
        assert result[0].content == "hi\nthere"

    def test_function_tool_result(self):
        item = FunctionToolResult(call_id="call_1", output="result_text")
        req = ResponseRequest(input=[item])
        result = _parse_input(req)
        assert len(result) == 1
        assert result[0].type == "tool"
        assert result[0].content == "result_text"
        assert result[0].tool_call_id == "call_1"

    def test_function_tool_call_skipped(self):
        item = FunctionToolCall(
            name="some_tool", arguments="{}", call_id="c1", display_name="Some Tool"
        )
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
            FunctionToolCall(name="tool_a", arguments="{}", call_id="c1", display_name="Tool A"),
            FunctionToolResult(call_id="c1", output="answer"),
            ReasoningItem(content="hmm"),
            ItemReferenceItem(item_id="ref_1"),
            AssistantMessageItem(content="reply"),
        ]
        req = ResponseRequest(input=items)
        result = _parse_input(req)
        assert len(result) == 3
        assert result[0].type == "human"
        assert result[0].content == "question"
        assert result[1].type == "tool"
        assert result[1].content == "answer"
        assert result[1].tool_call_id == "c1"
        assert result[2].type == "ai"
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
        tc = _tool_call_output("my_tool", {"key": "val"}, "call_99", display_name="My Tool")
        assert tc.name == "my_tool"
        assert tc.call_id == "call_99"
        assert tc.display_name == "My Tool"

    def test_dict_arguments_serialized(self):
        tc = _tool_call_output("t", {"a": 1, "b": [2]}, "c", display_name="T")
        parsed = json.loads(tc.arguments)
        assert parsed == {"a": 1, "b": [2]}

    def test_string_arguments_passthrough(self):
        tc = _tool_call_output("t", '{"raw": true}', "c", display_name="T")
        assert tc.arguments == '{"raw": true}'

    def test_id_prefix(self, mock_uuid):
        tc = _tool_call_output("t", {}, "c", display_name="T")
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
        ctrl = agent_loop_pkg._default

        async def _fake_safe(tc: ToolCallInfo, session_id: str = "") -> tuple[ToolCallInfo, str]:
            delays = {"start_a": 0.01, "start_b": 0.02, "start_c": 0.03}
            await asyncio.sleep(delays.get(tc.name, 0))
            return tc, '{"ok": true}'

        def _fake_build(tc: ToolCallInfo, *_args, **_kwargs):
            if tc.name.startswith("start_"):
                suffix = tc.name[-1]
                return [ToolCallInfo(name=f"follow_{suffix}", args={}, id=f"fu_{tc.id}")]
            return []

        monkeypatch.setattr(ctrl.tool_exec, "safe_execute_tool", _fake_safe)
        monkeypatch.setattr(ctrl.tool_exec.tool_controller, "build_per_result", _fake_build)

        roots = [
            ToolCallInfo(name="start_a", args={}, id="a"),
            ToolCallInfo(name="start_b", args={}, id="b"),
            ToolCallInfo(name="start_c", args={}, id="c"),
        ]
        display_names = {
            "start_a": "Start A",
            "start_b": "Start B",
            "start_c": "Start C",
            "follow_a": "Follow A",
            "follow_b": "Follow B",
            "follow_c": "Follow C",
        }
        results, _ = await ctrl.tool_exec.execute_tool_calls_pipelined(
            roots,
            all_output_items=[],
            display_names=display_names,
            session_id="s1",
            max_depth=1,
        )

        names = [m.name for m in results]
        assert "follow_a" in names
        assert "follow_b" in names
        assert "follow_c" in names


class TestStreamRetries:
    @pytest.mark.asyncio
    async def test_unfinished_work_does_not_emit_duplicate_delta(self, monkeypatch):
        """Partial text should be streamed once per iteration."""
        ctrl = agent_loop_pkg._default

        class _FakeAccum:
            def __init__(self):
                self.content = "PARTIAL"
                self.tool_calls = []
                self.usage_metadata = {}

        async def _fake_stream(*_args, **_kwargs):
            yield ("delta", "PARTIAL")
            yield ("done", _FakeAccum())

        monkeypatch.setattr(ctrl.skill_controller, "has_unfinished_work", lambda _sid: True)
        monkeypatch.setattr(
            ctrl.skill_controller,
            "build_retry_guidance",
            lambda _sid, _t: "Continue",
        )
        monkeypatch.setattr(ctrl.agent_service, "append_to_history", lambda *a, **k: None)
        monkeypatch.setattr(settings, "MAX_AGENT_ITERATIONS", 1)

        ctx = LoopContext(
            request=SimpleNamespace(instructions=None),
            created_at=0,
            session_id="s1",
            model="test-model",
            messages=[],
            tool_names=["dummy_tool"],
            total_usage=Usage.zero(),
            ctrl=ctrl,
        )
        runner = AgentLoopRunner(ctx)
        monkeypatch.setattr(runner, "_stream_llm_and_accumulate", _fake_stream)

        events = []
        async for event in runner._stream_tool_iterations():
            events.append(event)

        deltas = [e for e in events if "response.output_text.delta" in e]
        assert len(deltas) == 1


# ---------------------------------------------------------------------------
# TestToolCallNarrationFiltering
# ---------------------------------------------------------------------------


async def _async_noop(*_a, **_k):
    pass


def _parse_sse_events(raw_events):
    """Parse SSE 'data: {...}' strings into dicts."""
    parsed = []
    for raw in raw_events:
        if raw.startswith("data: "):
            payload = raw[len("data: ") :].rstrip("\n")
            if payload == "[DONE]":
                continue
            parsed.append(json.loads(payload))
    return parsed


class TestToolCallNarrationFiltering:
    """Narration text must be discarded when the LLM generates text + tool_calls.

    When the model produces text alongside tool_calls (e.g.
    "mcp_web__search를 사용하여 검색하겠습니다."), that narration text
    should NOT be shown to the user.  The streaming loop must emit a
    ``response.output_text.abandoned`` event so the frontend clears
    the streamed narration.
    """

    @staticmethod
    def _text_accum(text):
        return SimpleNamespace(content=text, tool_calls=[], usage_metadata={})

    @staticmethod
    def _tool_accum(text="", tool_calls=None):
        if tool_calls is None:
            tool_calls = [{"name": "mcp_web__search", "args": {"query": "test"}, "id": "call_1"}]
        return SimpleNamespace(content=text, tool_calls=tool_calls, usage_metadata={})

    @staticmethod
    def _make_ctx(**overrides):
        defaults = dict(
            request=SimpleNamespace(instructions=None),
            created_at=0,
            session_id="s1",
            model="test-model",
            messages=[],
            tool_names=["mcp_web__search"],
            display_names={"mcp_web__search": "Web Search"},
            total_usage=Usage.zero(),
            ctrl=agent_loop_pkg._default,
        )
        defaults.update(overrides)
        return LoopContext(**defaults)

    def _apply_common_patches(self, monkeypatch):
        ctrl = agent_loop_pkg._default
        monkeypatch.setattr(
            ctrl.skill_controller,
            "has_unfinished_work",
            lambda _sid: False,
        )
        monkeypatch.setattr(
            ctrl.skill_controller,
            "should_force_text_only",
            lambda _sid: False,
        )
        monkeypatch.setattr(
            ctrl.skill_controller,
            "clear_completed_plans",
            lambda _sid: None,
        )
        monkeypatch.setattr(
            ctrl.skill_controller,
            "get_state_prompts",
            lambda _sid: [],
        )
        monkeypatch.setattr(
            ctrl.agent_service,
            "append_to_history",
            lambda *a, **k: None,
        )
        monkeypatch.setattr(
            ctrl.agent_service,
            "append_tool_interaction",
            _async_noop,
        )
        monkeypatch.setattr(settings, "ENABLE_SELF_EVALUATION", False)

    # ------------------------------------------------------------------ #
    # Case 1 (Normal): text-only → deltas + done, no abandoned            #
    # ------------------------------------------------------------------ #

    @pytest.mark.asyncio
    async def test_text_only_streams_deltas_and_done(self, monkeypatch):
        """Text-only LLM response: deltas streamed, done emitted, no abandoned."""
        self._apply_common_patches(monkeypatch)
        monkeypatch.setattr(settings, "MAX_AGENT_ITERATIONS", 1)

        accum = self._text_accum("대한민국은 동아시아에 위치한 나라입니다.")

        async def _fake_stream(*_a, **_k):
            yield ("delta", "대한민국은 ")
            yield ("delta", "동아시아에 위치한 나라입니다.")
            yield ("done", accum)

        ctx = self._make_ctx()
        runner = AgentLoopRunner(ctx)
        monkeypatch.setattr(runner, "_stream_llm_and_accumulate", _fake_stream)

        raw_events = []
        async for event in runner._stream_tool_iterations():
            raw_events.append(event)

        events = _parse_sse_events(raw_events)
        types = [e["type"] for e in events]

        deltas = [e for e in events if e["type"] == "response.output_text.delta"]
        assert len(deltas) == 2
        assert deltas[0]["delta"] == "대한민국은 "
        assert deltas[1]["delta"] == "동아시아에 위치한 나라입니다."

        assert "response.output_text.done" in types
        assert "response.completed" in types
        assert "response.output_text.abandoned" not in types

    # ------------------------------------------------------------------ #
    # Case 2 (Bug): text + tool_calls → abandoned MUST be emitted         #
    # ------------------------------------------------------------------ #

    @pytest.mark.asyncio
    async def test_tool_call_with_narration_emits_abandoned(self, monkeypatch):
        """When LLM generates narration text + tool_calls, abandoned event
        must be emitted so the frontend discards the streamed narration."""
        self._apply_common_patches(monkeypatch)
        monkeypatch.setattr(settings, "MAX_AGENT_ITERATIONS", 1)

        narration = "mcp_web__search를 사용하여 검색하겠습니다."
        accum = self._tool_accum(text=narration)

        async def _fake_stream(*_a, **_k):
            yield ("delta", narration)
            yield ("done", accum)

        ctx = self._make_ctx()
        runner = AgentLoopRunner(ctx)
        monkeypatch.setattr(runner, "_stream_llm_and_accumulate", _fake_stream)
        monkeypatch.setattr(
            runner,
            "_handle_tool_call_iteration",
            lambda *_a, **_k: _async_noop(),
        )

        raw_events = []
        async for event in runner._stream_tool_iterations():
            raw_events.append(event)

        events = _parse_sse_events(raw_events)
        types = [e["type"] for e in events]

        # Narration was progressively streamed (unavoidable)
        deltas = [e for e in events if e["type"] == "response.output_text.delta"]
        assert len(deltas) == 1

        # KEY: abandoned must be emitted to discard the narration
        abandoned = [e for e in events if e["type"] == "response.output_text.abandoned"]
        assert len(abandoned) == 1
        assert abandoned[0]["reason"] == "tool_call"

        # output_text.done should NOT appear (not a final text response)
        assert "response.output_text.done" not in types

    # ------------------------------------------------------------------ #
    # Case 3: tool_call without narration text → abandoned still safe      #
    # ------------------------------------------------------------------ #

    @pytest.mark.asyncio
    async def test_tool_call_without_narration_emits_abandoned(self, monkeypatch):
        """Tool call with empty text: no deltas, abandoned still emitted (harmless)."""
        self._apply_common_patches(monkeypatch)
        monkeypatch.setattr(settings, "MAX_AGENT_ITERATIONS", 1)

        accum = self._tool_accum(text="")

        async def _fake_stream(*_a, **_k):
            yield ("done", accum)

        ctx = self._make_ctx()
        runner = AgentLoopRunner(ctx)
        monkeypatch.setattr(runner, "_stream_llm_and_accumulate", _fake_stream)
        monkeypatch.setattr(
            runner,
            "_handle_tool_call_iteration",
            lambda *_a, **_k: _async_noop(),
        )

        raw_events = []
        async for event in runner._stream_tool_iterations():
            raw_events.append(event)

        events = _parse_sse_events(raw_events)

        deltas = [e for e in events if e["type"] == "response.output_text.delta"]
        assert len(deltas) == 0

        abandoned = [e for e in events if e["type"] == "response.output_text.abandoned"]
        assert len(abandoned) == 1
        assert abandoned[0]["reason"] == "tool_call"

    # ------------------------------------------------------------------ #
    # Case 4 (Multi-turn): iter1 narration discarded, iter2 text kept      #
    # ------------------------------------------------------------------ #

    @pytest.mark.asyncio
    async def test_multi_iter_narration_discarded_final_text_kept(self, monkeypatch):
        """Iteration 1: tool_call + narration → abandoned.
        Iteration 2: text-only → done + completed."""
        self._apply_common_patches(monkeypatch)
        monkeypatch.setattr(settings, "MAX_AGENT_ITERATIONS", 2)

        narration = "검색 도구를 사용하겠습니다."
        final_answer = "대한민국은 동아시아에 위치한 나라입니다."

        call_count = 0

        async def _fake_stream(*_a, **_k):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                yield ("delta", narration)
                yield ("done", self._tool_accum(text=narration))
            else:
                yield ("delta", final_answer)
                yield ("done", self._text_accum(final_answer))

        ctx = self._make_ctx()
        runner = AgentLoopRunner(ctx)
        monkeypatch.setattr(runner, "_stream_llm_and_accumulate", _fake_stream)
        monkeypatch.setattr(
            runner,
            "_handle_tool_call_iteration",
            lambda *_a, **_k: _async_noop(),
        )

        raw_events = []
        async for event in runner._stream_tool_iterations():
            raw_events.append(event)

        events = _parse_sse_events(raw_events)
        types = [e["type"] for e in events]

        # Iteration 1 narration → abandoned
        abandoned = [e for e in events if e["type"] == "response.output_text.abandoned"]
        assert len(abandoned) == 1
        assert abandoned[0]["reason"] == "tool_call"

        # Iteration 2 final text → done
        done_events = [e for e in events if e["type"] == "response.output_text.done"]
        assert len(done_events) == 1
        assert done_events[0]["text"] == final_answer

        assert "response.completed" in types
