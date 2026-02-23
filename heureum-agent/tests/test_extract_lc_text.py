# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for MessageNormalizeController.extract_lc_text / _text_from_block."""

import pytest

from app.services.messages.normalize import MessageNormalizeController, _text_from_block

ctrl = MessageNormalizeController()


# ---------------------------------------------------------------------------
# extract_lc_text — top-level dispatch
# ---------------------------------------------------------------------------


class TestExtractLcTextString:
    def test_plain_string(self):
        assert ctrl.extract_lc_text("hello world") == "hello world"

    def test_empty_string(self):
        assert ctrl.extract_lc_text("") == ""


class TestExtractLcTextList:
    def test_string_items(self):
        assert ctrl.extract_lc_text(["a", "b"]) == "a b"

    def test_text_blocks(self):
        content = [
            {"type": "text", "text": "hello"},
            {"type": "text", "text": "world"},
        ]
        assert ctrl.extract_lc_text(content) == "hello world"

    def test_mixed_string_and_text_block(self):
        content = ["hello", {"type": "text", "text": "world"}]
        assert ctrl.extract_lc_text(content) == "hello world"

    def test_empty_list(self):
        assert ctrl.extract_lc_text([]) == ""

    def test_text_block_with_none_value(self):
        """text 값이 None이면 빈 문자열로 변환."""
        content = [{"type": "text", "text": None}]
        assert ctrl.extract_lc_text(content) == ""

    def test_skips_empty_text_blocks(self):
        """빈 문자열 text block은 falsy라서 parts에 포함 안 됨."""
        content = [
            {"type": "text", "text": ""},
            {"type": "text", "text": "hello"},
        ]
        assert ctrl.extract_lc_text(content) == "hello"

    def test_thinking_stripped_from_text(self):
        """extract_lc_text strips thinking blocks, returns only text."""
        content = [
            {"type": "thinking", "thinking": "hmm"},
            {"type": "text", "text": "answer"},
        ]
        assert ctrl.extract_lc_text(content) == "answer"


class TestExtractLcTextFallback:
    def test_int_fallback(self):
        assert ctrl.extract_lc_text(42) == "42"

    def test_none_fallback(self):
        assert ctrl.extract_lc_text(None) == "None"


# ---------------------------------------------------------------------------
# _text_from_block — per-block parsing
# ---------------------------------------------------------------------------


class TestTextFromBlockText:
    """{"type": "text", "text": "..."} 표준 텍스트 블록."""

    def test_basic(self):
        assert _text_from_block({"type": "text", "text": "hello"}) == "hello"

    def test_multiline(self):
        text = "line1\nline2\nline3"
        assert _text_from_block({"type": "text", "text": text}) == text

    def test_none_text_returns_empty(self):
        assert _text_from_block({"type": "text", "text": None}) == ""

    def test_text_without_type_key(self):
        """type 키 없이 text만 있어도 동작."""
        assert _text_from_block({"text": "works"}) == "works"


class TestTextFromBlockNonText:
    """Non-text blocks with a type key return None."""

    def test_thinking_block(self):
        assert _text_from_block({"type": "thinking", "thinking": "let me think..."}) is None

    def test_executable_code(self):
        block = {
            "type": "executable_code",
            "executable_code": "print('hello')",
            "language": "PYTHON",
            "id": "abc123",
        }
        assert _text_from_block(block) is None

    def test_code_execution_result(self):
        block = {
            "type": "code_execution_result",
            "code_execution_result": "hello\n",
            "outcome": 1,
            "tool_call_id": "",
        }
        assert _text_from_block(block) is None

    def test_image_block(self):
        block = {
            "type": "image_url",
            "image_url": {"url": "data:image/png;base64,abc"},
        }
        assert _text_from_block(block) is None

    def test_reasoning_block(self):
        assert _text_from_block({"type": "reasoning", "content": "I should consider..."}) is None


class TestTextFromBlockRefusal:
    """{"type": "refusal", "refusal": "..."} OpenAI refusal block."""

    def test_basic(self):
        assert (
            _text_from_block({"type": "refusal", "refusal": "I cannot do that"})
            == "I cannot do that"
        )

    def test_none_refusal(self):
        assert _text_from_block({"type": "refusal", "refusal": None}) == ""


class TestTextFromBlockFunctionResponse:
    """Gemini function_response echo."""

    def test_basic(self):
        block = {
            "function_response": {
                "name": "mcp_filesystem__bash",
                "response": {"output": "file contents here"},
            }
        }
        assert _text_from_block(block) == "file contents here"

    def test_multiline_output(self):
        text = "line1\nline2\nline3"
        block = {
            "function_response": {
                "name": "web_search",
                "response": {"output": text},
            }
        }
        assert _text_from_block(block) == text

    def test_none_output(self):
        block = {
            "function_response": {
                "name": "some_tool",
                "response": {"output": None},
            }
        }
        assert _text_from_block(block) == ""

    def test_missing_output_key_raises(self):
        block = {
            "function_response": {
                "name": "some_tool",
                "response": {},
            }
        }
        with pytest.raises(KeyError):
            _text_from_block(block)

    def test_missing_response_key_raises(self):
        block = {
            "function_response": {
                "name": "some_tool",
            }
        }
        with pytest.raises(KeyError):
            _text_from_block(block)


class TestTextFromBlockUnknown:
    """알 수 없는 블록 타입은 ValueError."""

    def test_empty_dict_raises(self):
        with pytest.raises(ValueError, match="Unknown content block type"):
            _text_from_block({})

    def test_random_dict_raises(self):
        with pytest.raises(ValueError, match="Unknown content block type"):
            _text_from_block({"foo": "bar"})


# ---------------------------------------------------------------------------
# extract_lc_text — function_response가 포함된 실제 시나리오
# ---------------------------------------------------------------------------


class TestExtractLcTextFunctionResponseScenarios:
    """Gemini 응답에 function_response echo가 섞여 들어오는 실제 케이스."""

    def test_function_response_only(self):
        content = [
            {
                "function_response": {
                    "name": "mcp_filesystem__bash",
                    "response": {"output": "file contents"},
                }
            }
        ]
        assert ctrl.extract_lc_text(content) == "file contents"

    def test_text_then_function_response(self):
        content = [
            {"type": "text", "text": "Here is the result:"},
            {
                "function_response": {
                    "name": "web_fetch",
                    "response": {"output": "page content"},
                }
            },
        ]
        assert ctrl.extract_lc_text(content) == "Here is the result: page content"

    def test_function_response_then_text(self):
        content = [
            {
                "function_response": {
                    "name": "mcp_filesystem__bash",
                    "response": {"output": "raw data"},
                }
            },
            {"type": "text", "text": "Based on the data, here is my answer."},
        ]
        assert ctrl.extract_lc_text(content) == "raw data Based on the data, here is my answer."

    def test_thinking_then_text(self):
        content = [
            {"type": "thinking", "thinking": "let me analyze"},
            {"type": "text", "text": "answer"},
        ]
        assert ctrl.extract_lc_text(content) == "answer"
