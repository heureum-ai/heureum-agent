# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for PersistController — payload structure, truncation, error handling."""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest
from app.services.messages.persist import PersistController


@pytest.fixture
async def pc():
    """Create a PersistController with a mocked httpx client."""
    controller = PersistController("http://platform:8000")
    # Replace the real client with a mock
    mock_client = AsyncMock(spec=httpx.AsyncClient)
    mock_client.post = AsyncMock(return_value=MagicMock(status_code=201))
    mock_client.patch = AsyncMock(return_value=MagicMock(status_code=200))
    controller._client = mock_client
    yield controller
    await controller.close()


# ---------------------------------------------------------------------------
# save_message
# ---------------------------------------------------------------------------


class TestSaveMessage:
    """Tests for save_message payload structure and edge cases."""

    async def test_save_message_sends_correct_payload(self, pc):
        await pc.save_message(
            session_id="sess_1",
            response_id=42,
            seq=0,
            msg_type="message",
            role="assistant",
            content="Hello world",
        )
        pc._client.post.assert_called_once()
        call_kwargs = pc._client.post.call_args
        payload = (
            call_kwargs.kwargs["json"] if "json" in call_kwargs.kwargs else call_kwargs[1]["json"]
        )
        assert payload["session_id"] == "sess_1"
        assert payload["response_id"] == 42
        assert payload["seq"] == 0
        assert payload["type"] == "message"
        assert payload["role"] == "assistant"
        assert payload["content"] == "Hello world"

    async def test_save_message_with_metadata(self, pc):
        await pc.save_message(
            session_id="sess_1",
            response_id=42,
            seq=1,
            msg_type="function_call_output",
            role="tool",
            content="error text",
            metadata={"tool_call_id": "call_1", "tool_name": "web_search"},
        )
        payload = (
            pc._client.post.call_args.kwargs.get("json") or pc._client.post.call_args[1]["json"]
        )
        assert payload["metadata"]["tool_call_id"] == "call_1"
        assert payload["metadata"]["tool_name"] == "web_search"

    async def test_save_message_skips_without_response_id(self, pc):
        await pc.save_message(
            session_id="sess_1",
            response_id=None,
            seq=0,
            msg_type="message",
            role="assistant",
            content="Hello",
        )
        pc._client.post.assert_not_called()

    async def test_save_message_skips_zero_response_id(self, pc):
        await pc.save_message(
            session_id="sess_1",
            response_id=0,
            seq=0,
            msg_type="message",
            role="assistant",
            content="Hello",
        )
        pc._client.post.assert_not_called()

    async def test_save_message_truncates_long_content(self, pc):
        long_text = "x" * 60_000
        await pc.save_message(
            session_id="sess_1",
            response_id=1,
            seq=0,
            msg_type="message",
            role="assistant",
            content=long_text,
        )
        payload = (
            pc._client.post.call_args.kwargs.get("json") or pc._client.post.call_args[1]["json"]
        )
        assert len(payload["content"]) == pc.CONTENT_MAX

    async def test_save_message_non_string_content_not_truncated(self, pc):
        """Non-string content (e.g. list/dict) should pass through unchanged."""
        content = [{"type": "output_text", "text": "hello"}]
        await pc.save_message(
            session_id="sess_1",
            response_id=1,
            seq=0,
            msg_type="message",
            role="assistant",
            content=content,
        )
        payload = (
            pc._client.post.call_args.kwargs.get("json") or pc._client.post.call_args[1]["json"]
        )
        assert payload["content"] == content

    async def test_save_message_swallows_network_error(self, pc):
        """Network errors should be silently logged, not raised."""
        pc._client.post.side_effect = httpx.ConnectError("connection refused")
        # Should not raise
        await pc.save_message(
            session_id="sess_1",
            response_id=1,
            seq=0,
            msg_type="message",
            role="assistant",
            content="Hello",
        )


# ---------------------------------------------------------------------------
# complete_response
# ---------------------------------------------------------------------------


class TestCompleteResponse:
    """Tests for complete_response payload and edge cases."""

    async def test_complete_response_sends_status(self, pc):
        await pc.complete_response(response_id=42, status="completed")
        pc._client.patch.assert_called_once()
        payload = (
            pc._client.patch.call_args.kwargs.get("json") or pc._client.patch.call_args[1]["json"]
        )
        assert payload["status"] == "completed"

    async def test_complete_response_with_usage_and_model(self, pc):
        await pc.complete_response(
            response_id=42,
            status="completed",
            usage={"input_tokens": 100, "output_tokens": 50},
            model="gpt-4o",
        )
        payload = (
            pc._client.patch.call_args.kwargs.get("json") or pc._client.patch.call_args[1]["json"]
        )
        assert payload["input_tokens"] == 100
        assert payload["output_tokens"] == 50
        assert payload["model"] == "gpt-4o"

    async def test_complete_response_skips_without_response_id(self, pc):
        await pc.complete_response(response_id=None, status="completed")
        pc._client.patch.assert_not_called()

    async def test_complete_response_swallows_error(self, pc):
        pc._client.patch.side_effect = httpx.ConnectError("timeout")
        await pc.complete_response(response_id=1, status="failed")


# ---------------------------------------------------------------------------
# save_tool_history
# ---------------------------------------------------------------------------


class TestSaveToolHistory:
    """Tests for save_tool_history."""

    async def test_save_tool_history_sends_items(self, pc):
        items = [
            {"type": "function_call", "name": "web_search", "call_id": "c1"},
            {"type": "function_call_output", "call_id": "c1", "output": "result"},
        ]
        await pc.save_tool_history(
            session_id="sess_1",
            response_id=42,
            items=items,
        )
        payload = (
            pc._client.post.call_args.kwargs.get("json") or pc._client.post.call_args[1]["json"]
        )
        assert payload["session_id"] == "sess_1"
        assert payload["response_id"] == 42
        assert len(payload["items"]) == 2

    async def test_save_tool_history_skips_empty_items(self, pc):
        await pc.save_tool_history(session_id="s", response_id=1, items=[])
        pc._client.post.assert_not_called()

    async def test_save_tool_history_skips_no_response_id(self, pc):
        await pc.save_tool_history(session_id="s", response_id=None, items=[{"x": 1}])
        pc._client.post.assert_not_called()


# ---------------------------------------------------------------------------
# Subagent persist methods
# ---------------------------------------------------------------------------


class TestSubagentPersist:
    """Tests for subagent_run_start, subagent_message, subagent_run_complete."""

    @pytest.fixture
    def record(self):
        rec = MagicMock()
        rec.child_session_id = "child_1"
        rec.parent_session_id = "parent_1"
        rec.task = "summarize document"
        rec.started_at = 1700000000.0
        return rec

    async def test_subagent_run_start(self, pc, record):
        await pc.subagent_run_start(record, root_session_id="root_1")
        await asyncio.sleep(0)
        pc._client.post.assert_called_once()
        payload = (
            pc._client.post.call_args.kwargs.get("json") or pc._client.post.call_args[1]["json"]
        )
        assert payload["child_session_id"] == "child_1"
        assert payload["root_session_id"] == "root_1"

    async def test_subagent_message(self, pc, record):
        await pc.subagent_message(record, seq=0, role="assistant", content="Done!")
        await asyncio.sleep(0)
        pc._client.post.assert_called_once()
        payload = (
            pc._client.post.call_args.kwargs.get("json") or pc._client.post.call_args[1]["json"]
        )
        assert payload["seq"] == 0
        assert payload["role"] == "assistant"
        assert payload["content"] == "Done!"

    async def test_subagent_run_complete(self, pc, record):
        await pc.subagent_run_complete(record, status="completed", result_summary="All done")
        await asyncio.sleep(0)
        pc._client.patch.assert_called_once()
        payload = (
            pc._client.patch.call_args.kwargs.get("json") or pc._client.patch.call_args[1]["json"]
        )
        assert payload["status"] == "completed"

    async def test_subagent_truncates_long_content(self, pc, record):
        long_text = "a" * 60_000
        await pc.subagent_message(record, seq=0, role="assistant", content=long_text)
        await asyncio.sleep(0)
        payload = (
            pc._client.post.call_args.kwargs.get("json") or pc._client.post.call_args[1]["json"]
        )
        assert len(payload["content"]) == pc.CONTENT_MAX


# ---------------------------------------------------------------------------
# Truncation
# ---------------------------------------------------------------------------


class TestTruncation:
    """Tests for the _truncate helper."""

    def test_short_string_unchanged(self, pc):
        assert pc._truncate("hello") == "hello"

    def test_long_string_truncated(self, pc):
        long = "x" * 60_000
        result = pc._truncate(long)
        assert len(result) == pc.CONTENT_MAX

    def test_exact_limit_unchanged(self, pc):
        exact = "y" * pc.CONTENT_MAX
        assert pc._truncate(exact) == exact


# ---------------------------------------------------------------------------
# close
# ---------------------------------------------------------------------------


class TestClose:
    """Test that close() delegates to the httpx client."""

    async def test_close_calls_aclose(self, pc):
        await pc.close()
        pc._client.aclose.assert_called_once()
