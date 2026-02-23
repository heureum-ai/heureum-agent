# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Unit tests for app.schemas.open_responses Pydantic models."""

import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.schemas.open_responses import (
    AssistantMessageItem,
    DeveloperMessageItem,
    ErrorObject,
    ErrorType,
    FunctionDefinition,
    FunctionToolCall,
    FunctionToolResult,
    InputTextContent,
    InputTokenDetails,
    ItemReferenceItem,
    ItemStatus,
    MessageItem,
    MessageRole,
    OutputTextContent,
    OutputTokenDetails,
    ReasoningItem,
    ResponseObject,
    ResponseRequest,
    ResponseStatus,
    ROLE_TO_MESSAGE_CLASS,
    SystemMessageItem,
    ToolDefinition,
    Usage,
    UserMessageItem,
)

FIXTURES_DIR = Path(__file__).parent / "integration"


# ---------------------------------------------------------------------------
# Usage
# ---------------------------------------------------------------------------


class TestUsage:
    def test_zero(self):
        u = Usage.zero()
        assert u.input_tokens == 0
        assert u.output_tokens == 0
        assert u.total_tokens == 0
        assert u.input_tokens_details.cached_tokens == 0
        assert u.output_tokens_details.reasoning_tokens == 0

    def test_add(self):
        a = Usage(
            input_tokens=10,
            output_tokens=5,
            total_tokens=15,
            input_tokens_details=InputTokenDetails(cached_tokens=3),
            output_tokens_details=OutputTokenDetails(reasoning_tokens=2),
        )
        b = Usage(
            input_tokens=20,
            output_tokens=10,
            total_tokens=30,
            input_tokens_details=InputTokenDetails(cached_tokens=7),
            output_tokens_details=OutputTokenDetails(reasoning_tokens=4),
        )
        result = a.add(b)
        assert result.input_tokens == 30
        assert result.output_tokens == 15
        assert result.total_tokens == 45
        assert result.input_tokens_details.cached_tokens == 10
        assert result.output_tokens_details.reasoning_tokens == 6

    def test_token_details_defaults(self):
        details_in = InputTokenDetails()
        assert details_in.cached_tokens == 0
        details_out = OutputTokenDetails()
        assert details_out.reasoning_tokens == 0


# ---------------------------------------------------------------------------
# Content parts
# ---------------------------------------------------------------------------


class TestInputTextContent:
    def test_creation(self):
        c = InputTextContent(text="hello")
        assert c.type == "input_text"
        assert c.text == "hello"

    def test_serialization(self):
        c = InputTextContent(text="hi")
        d = c.model_dump()
        assert d == {"type": "input_text", "text": "hi"}


class TestOutputTextContent:
    def test_creation(self):
        c = OutputTextContent(text="world")
        assert c.type == "output_text"
        assert c.text == "world"

    def test_serialization(self):
        c = OutputTextContent(text="bye")
        d = c.model_dump()
        assert d == {"type": "output_text", "text": "bye", "annotations": []}


# ---------------------------------------------------------------------------
# MessageItem and subclasses
# ---------------------------------------------------------------------------


class TestMessageItem:
    def test_normalize_content_from_string(self):
        m = MessageItem(role=MessageRole.USER, content="hello")
        assert isinstance(m.content, list)
        assert len(m.content) == 1
        assert isinstance(m.content[0], InputTextContent)
        assert m.content[0].text == "hello"

    def test_normalize_content_list_passthrough(self):
        parts = [OutputTextContent(text="ok")]
        m = MessageItem(role=MessageRole.ASSISTANT, content=parts)
        assert len(m.content) == 1
        assert isinstance(m.content[0], OutputTextContent)
        assert m.content[0].text == "ok"

    def test_defaults(self):
        m = MessageItem(role=MessageRole.USER, content="x")
        assert m.type == "message"
        assert m.status == ItemStatus.COMPLETED
        assert m.id is None


class TestUserMessageItem:
    def test_role_fixed(self):
        u = UserMessageItem(content="hi")
        assert u.role == MessageRole.USER

    def test_rejects_wrong_role(self):
        with pytest.raises(ValidationError):
            UserMessageItem(role="assistant", content="hi")


class TestAssistantMessageItem:
    def test_role_fixed(self):
        a = AssistantMessageItem(content=[OutputTextContent(text="ok")])
        assert a.role == MessageRole.ASSISTANT

    def test_usage_optional(self):
        a = AssistantMessageItem(content="hi")
        assert a.usage is None


class TestSystemMessageItem:
    def test_role_fixed(self):
        s = SystemMessageItem(content="sys prompt")
        assert s.role == MessageRole.SYSTEM


class TestDeveloperMessageItem:
    def test_role_fixed(self):
        d = DeveloperMessageItem(content="dev note")
        assert d.role == MessageRole.DEVELOPER


# ---------------------------------------------------------------------------
# Function tool call / result
# ---------------------------------------------------------------------------


class TestFunctionToolCall:
    def test_required_fields(self):
        tc = FunctionToolCall(name="my_tool", arguments='{"a":1}', display_name="My Tool")
        assert tc.type == "function_call"
        assert tc.name == "my_tool"
        assert tc.arguments == '{"a":1}'
        assert tc.status == ItemStatus.COMPLETED
        assert tc.display_name == "My Tool"

    def test_arguments_is_json_string(self):
        tc = FunctionToolCall(name="t", arguments='{"key":"val"}', display_name="T")
        parsed = json.loads(tc.arguments)
        assert parsed == {"key": "val"}

    def test_optional_fields(self):
        tc = FunctionToolCall(name="t", arguments="{}", display_name="T")
        assert tc.id is None
        assert tc.call_id is None
        assert tc.usage is None


class TestFunctionToolResult:
    def test_required_fields(self):
        tr = FunctionToolResult(call_id="call_abc", output="result text")
        assert tr.type == "function_call_output"
        assert tr.call_id == "call_abc"
        assert tr.output == "result text"

    def test_status_default(self):
        tr = FunctionToolResult(call_id="c1", output="ok")
        assert tr.status == ItemStatus.COMPLETED

    def test_id_optional(self):
        tr = FunctionToolResult(call_id="c1", output="ok")
        assert tr.id is None


# ---------------------------------------------------------------------------
# ReasoningItem / ItemReferenceItem
# ---------------------------------------------------------------------------


class TestReasoningItem:
    def test_all_optional(self):
        r = ReasoningItem()
        assert r.type == "reasoning"
        assert r.id is None
        assert r.status == ItemStatus.COMPLETED
        assert r.content is None
        assert r.encrypted_content is None
        assert r.summary is None

    def test_with_values(self):
        r = ReasoningItem(content="thinking...", summary="thought")
        assert r.content == "thinking..."
        assert r.summary == "thought"


class TestItemReferenceItem:
    def test_required_item_id(self):
        ref = ItemReferenceItem(item_id="item_123")
        assert ref.type == "item_reference"
        assert ref.item_id == "item_123"

    def test_missing_item_id_raises(self):
        with pytest.raises(ValidationError):
            ItemReferenceItem()


# ---------------------------------------------------------------------------
# ToolDefinition
# ---------------------------------------------------------------------------


class TestToolDefinition:
    def test_name_property(self):
        td = ToolDefinition(
            function=FunctionDefinition(name="search", description="Search the web"),
            display_name="Search",
        )
        assert td.name == "search"
        assert td.type == "function"
        assert td.display_name == "Search"

    def test_function_optional_fields(self):
        fd = FunctionDefinition(name="f")
        assert fd.description is None
        assert fd.parameters is None


# ---------------------------------------------------------------------------
# ResponseRequest
# ---------------------------------------------------------------------------


class TestResponseRequest:
    def test_defaults(self):
        req = ResponseRequest(input="hello")
        assert req.model == "default"
        assert req.stream is False
        assert req.tools is None
        assert req.previous_response_id is None
        assert req.instructions is None
        assert req.temperature is None
        assert req.max_output_tokens is None
        assert req.metadata is None

    def test_temperature_valid_range(self):
        req = ResponseRequest(input="hi", temperature=0.0)
        assert req.temperature == 0.0
        req2 = ResponseRequest(input="hi", temperature=2.0)
        assert req2.temperature == 2.0

    def test_temperature_out_of_range(self):
        with pytest.raises(ValidationError):
            ResponseRequest(input="hi", temperature=-0.1)
        with pytest.raises(ValidationError):
            ResponseRequest(input="hi", temperature=2.1)

    def test_max_output_tokens_must_be_positive(self):
        with pytest.raises(ValidationError):
            ResponseRequest(input="hi", max_output_tokens=0)
        with pytest.raises(ValidationError):
            ResponseRequest(input="hi", max_output_tokens=-1)


# ---------------------------------------------------------------------------
# ResponseObject
# ---------------------------------------------------------------------------


class TestResponseObject:
    def test_full_assembly(self):
        msg = AssistantMessageItem(
            id="msg_1",
            content=[OutputTextContent(text="hello")],
        )
        resp = ResponseObject(
            id="resp_1",
            created_at=1000,
            model="test-model",
            status=ResponseStatus.COMPLETED,
            output=[msg],
            usage=Usage.zero(),
        )
        assert resp.object == "response"
        assert resp.id == "resp_1"
        assert resp.completed_at is None
        assert resp.error is None
        assert resp.metadata is None
        assert len(resp.output) == 1

    def test_status_values(self):
        for status in ResponseStatus:
            resp = ResponseObject(
                id="r",
                created_at=0,
                model="m",
                status=status,
                output=[],
                usage=Usage.zero(),
            )
            assert resp.status == status


# ---------------------------------------------------------------------------
# ErrorObject
# ---------------------------------------------------------------------------


class TestErrorObject:
    def test_error_types(self):
        for et in ErrorType:
            err = ErrorObject(type=et, message="oops")
            assert err.type == et
            assert err.message == "oops"
            assert err.code is None
            assert err.param is None

    def test_with_code_and_param(self):
        err = ErrorObject(
            type=ErrorType.INVALID_REQUEST,
            code="bad_param",
            param="temperature",
            message="out of range",
        )
        assert err.code == "bad_param"
        assert err.param == "temperature"


# ---------------------------------------------------------------------------
# ROLE_TO_MESSAGE_CLASS mapping
# ---------------------------------------------------------------------------


class TestRoleToMessageClass:
    def test_mapping_completeness(self):
        expected = {
            MessageRole.USER: UserMessageItem,
            MessageRole.ASSISTANT: AssistantMessageItem,
            MessageRole.SYSTEM: SystemMessageItem,
            MessageRole.DEVELOPER: DeveloperMessageItem,
        }
        assert ROLE_TO_MESSAGE_CLASS == expected


# ---------------------------------------------------------------------------
# Fixture round-trip: parse real integration JSON into ResponseObject
# ---------------------------------------------------------------------------


class TestFixtureRoundTrip:
    @pytest.mark.parametrize(
        "fixture_file",
        [
            "02_simple_text_response.json",
            "03_tool_call_response.json",
            "04_tool_result_continuation.json",
            "07_agentic_loop_web_search.json",
        ],
    )
    def test_parse_fixture(self, fixture_file: str):
        path = FIXTURES_DIR / fixture_file
        data = json.loads(path.read_text())
        resp = ResponseObject.model_validate(data)
        assert resp.id == data["id"]
        assert resp.model == data["model"]
        assert resp.status.value == data["status"]
        assert len(resp.output) == len(data["output"])
        assert resp.usage.input_tokens == data["usage"]["input_tokens"]

    def test_simple_text_output_content(self):
        data = json.loads((FIXTURES_DIR / "02_simple_text_response.json").read_text())
        resp = ResponseObject.model_validate(data)
        msg = resp.output[0]
        assert isinstance(msg, AssistantMessageItem)
        assert msg.content[0].text == data["output"][0]["content"][0]["text"]

    def test_tool_call_fixture_status_incomplete(self):
        data = json.loads((FIXTURES_DIR / "03_tool_call_response.json").read_text())
        resp = ResponseObject.model_validate(data)
        assert resp.status == ResponseStatus.INCOMPLETE
        tc = resp.output[0]
        assert isinstance(tc, FunctionToolCall)
        assert tc.name == "ask_question"

    def test_agentic_loop_has_mixed_output(self):
        data = json.loads((FIXTURES_DIR / "07_agentic_loop_web_search.json").read_text())
        resp = ResponseObject.model_validate(data)
        types = [item.type for item in resp.output]
        assert "function_call" in types
        assert "function_call_output" in types
        assert "message" in types


# ---------------------------------------------------------------------------
# ResponseStatus enum
# ---------------------------------------------------------------------------


class TestResponseStatus:
    def test_has_six_values(self):
        assert len(ResponseStatus) == 6

    def test_values(self):
        expected = {"queued", "in_progress", "completed", "incomplete", "failed", "cancelled"}
        assert {s.value for s in ResponseStatus} == expected


# ---------------------------------------------------------------------------
# ItemStatus enum (no FAILED / CANCELLED)
# ---------------------------------------------------------------------------


class TestItemStatus:
    def test_has_three_values(self):
        assert len(ItemStatus) == 3

    def test_values(self):
        expected = {"in_progress", "incomplete", "completed"}
        assert {s.value for s in ItemStatus} == expected

    def test_no_failed_or_cancelled(self):
        names = {s.name for s in ItemStatus}
        assert "FAILED" not in names
        assert "CANCELLED" not in names


# ---------------------------------------------------------------------------
# ResponseRequest new fields
# ---------------------------------------------------------------------------


class TestResponseRequestNewFields:
    def test_tool_choice_defaults_none(self):
        req = ResponseRequest(input="hello")
        assert req.tool_choice is None

    def test_truncation_defaults_none(self):
        req = ResponseRequest(input="hello")
        assert req.truncation is None

    def test_tool_choice_string_values(self):
        for val in ("auto", "required", "none"):
            req = ResponseRequest(input="hello", tool_choice=val)
            assert req.tool_choice == val

    def test_tool_choice_dict(self):
        tc = {"type": "function", "function": {"name": "my_tool"}}
        req = ResponseRequest(input="hello", tool_choice=tc)
        assert req.tool_choice == tc

    def test_truncation_values(self):
        for val in ("auto", "disabled"):
            req = ResponseRequest(input="hello", truncation=val)
            assert req.truncation == val
