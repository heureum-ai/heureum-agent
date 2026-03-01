# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for persist hook invocations in the agent loop (AgentLoopRunner).

Verifies that _persist_message and _persist_complete are called at the
correct points in both streaming and non-streaming paths.
"""

import asyncio
from unittest.mock import AsyncMock, MagicMock

import app.routers.agent as agent_mod
import app.services.agent_loop as agent_loop_pkg
import pytest
from app.models import LLMResult, LLMResultType, ToolCallInfo
from app.schemas.open_responses import (
    Usage,
)
from app.services.mcps import MCPClientController
from app.services.mcps.approval import ApprovalState
from app.services.messages import MessageController
from httpx import ASGITransport, AsyncClient
from app.main import app


BASE_URL = "http://test"
ENDPOINT = "/api/v1/agent/responses"


@pytest.fixture(autouse=True)
def _patch_module(monkeypatch):
    """Patch controller instance attributes."""
    ctrl = agent_loop_pkg._default

    monkeypatch.setattr(ctrl, "_initialized", True)

    mock_svc = AsyncMock()
    mock_svc.get_history = MagicMock(return_value=[])
    mc = MessageController()
    mock_svc.message_controller = mc
    mock_svc.responses = mc.response_message_controller
    mock_svc.history = mc.history_message_controller
    mock_svc._normalize = mc.message_normalize_controller
    mock_svc.extract_lc_text = mc.message_normalize_controller.extract_lc_text
    mock_svc._sessions = mc.session_state_controller.sessions
    monkeypatch.setattr(ctrl, "agent_service", mock_svc)
    monkeypatch.setattr(ctrl.tool_exec, "agent_service", mock_svc)
    monkeypatch.setattr(agent_mod, "agent_service", mock_svc)

    from app.services.tools import ToolController

    tc = ToolController()
    monkeypatch.setattr(ctrl, "tool_controller", tc)
    monkeypatch.setattr(ctrl.tool_exec, "tool_controller", tc)

    mock_mcp = AsyncMock()
    mock_mcp.is_server_tool = MagicMock(return_value=False)
    mock_mcp.display_names = {}
    _real = MCPClientController.__new__(MCPClientController)
    _real._approval = ApprovalState(
        approval_required_tools={"web_search"},
        display_names={"web_search": "Web Search"},
    )
    mock_mcp._approval = _real._approval
    mock_mcp.classify_tool_calls = _real.classify_tool_calls
    mock_mcp.needs_approval = _real.needs_approval
    mock_mcp.handle_approval_response = _real.handle_approval_response
    mock_mcp.request_approval = _real.request_approval
    mock_mcp.clear_session_state = _real.clear_session_state
    mock_mcp.has_pending_approval = _real.has_pending_approval
    mock_mcp.server_tool_names = {"_dummy_server_tool"}
    monkeypatch.setattr(ctrl, "mcp_client", mock_mcp)
    monkeypatch.setattr(ctrl.tool_exec, "mcp_client", mock_mcp)
    monkeypatch.setattr(agent_mod, "mcp_client", mock_mcp)

    # Mock persist_controller
    mock_pc = AsyncMock()
    mock_pc.save_message = AsyncMock()
    mock_pc.complete_response = AsyncMock()
    monkeypatch.setattr(ctrl, "persist_controller", mock_pc)
    monkeypatch.setattr(agent_mod, "persist_controller", mock_pc)

    # Ensure skill_controller methods exist
    mock_skill = MagicMock()
    mock_skill.get_all_tool_names = MagicMock(return_value=set())
    mock_skill.display_names = {}
    mock_skill.get_state_prompts = MagicMock(return_value=[])
    mock_skill.clear_completed_plans = MagicMock()
    mock_skill.has_unfinished_work = MagicMock(return_value=False)
    mock_skill.should_force_text_only = MagicMock(return_value=False)
    mock_skill.get_live_state = MagicMock(return_value=None)
    monkeypatch.setattr(ctrl, "skill_controller", mock_skill)
    monkeypatch.setattr(ctrl.tool_exec, "skill_controller", mock_skill)


@pytest.fixture
def mock_svc():
    return agent_loop_pkg._default.agent_service


@pytest.fixture
def mock_pc():
    return agent_loop_pkg._default.persist_controller


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE_URL) as c:
        yield c


# ---------------------------------------------------------------------------
# Non-streaming persist hooks
# ---------------------------------------------------------------------------


class TestNonStreamingPersistHooks:
    """Verify persist hooks fire in the non-streaming path."""

    async def test_text_only_persists_message_and_complete(self, client, mock_svc, mock_pc):
        """_run_text_only should persist message + complete."""
        mock_svc.process_messages_with_tools.return_value = LLMResult(
            type=LLMResultType.TEXT,
            text="Hello!",
            session_id="test_session",
            usage=Usage.zero(),
        )
        resp = await client.post(
            ENDPOINT,
            json={
                "input": "Hi",
                "metadata": {"session_id": "s1", "response_id": "99"},
            },
        )
        assert resp.json()["status"] == "completed"

        # Allow fire-and-forget tasks to run
        await asyncio.sleep(0.05)

        # Verify persist_controller.save_message was called
        assert mock_pc.save_message.call_count >= 1
        save_call = mock_pc.save_message.call_args
        assert save_call.kwargs.get("msg_type") == "message" or (
            save_call.args and save_call.args[3] == "message"
        )

        # Verify persist_controller.complete_response was called
        assert mock_pc.complete_response.call_count >= 1

    async def test_tool_iteration_persists_function_calls(self, client, mock_svc, mock_pc):
        """Tool calls should persist function_call and function_call_output."""
        mock_mcp = agent_loop_pkg._default.mcp_client
        mock_mcp.server_tool_names = ["calculator"]
        mock_mcp.display_names = {"calculator": "Calculator"}
        mock_mcp.is_server_tool.return_value = True
        mock_mcp.call_tool.return_value = "42"

        mock_svc.process_messages_with_tools.side_effect = [
            LLMResult(
                type=LLMResultType.TOOL_CALL,
                tool_calls=[
                    ToolCallInfo(name="calculator", args={"expr": "1+1"}, id="call_1"),
                ],
                session_id="s1",
                usage=Usage.zero(),
            ),
            LLMResult(
                type=LLMResultType.TEXT,
                text="The answer is 42",
                session_id="s1",
                usage=Usage.zero(),
            ),
        ]

        resp = await client.post(
            ENDPOINT,
            json={
                "input": "calculate",
                "tools": [],
                "metadata": {"session_id": "s1", "response_id": "100"},
            },
        )
        assert resp.json()["status"] == "completed"

        await asyncio.sleep(0.05)

        # Should have: function_call, function_call_output, message, complete
        save_calls = mock_pc.save_message.call_args_list
        msg_types = []
        for c in save_calls:
            msg_type = c.kwargs.get("msg_type")
            if msg_type is None and len(c.args) > 3:
                msg_type = c.args[3]
            msg_types.append(msg_type)

        assert "function_call" in msg_types
        assert "function_call_output" in msg_types
        assert "message" in msg_types
        assert mock_pc.complete_response.call_count >= 1

    async def test_approval_persists_incomplete(self, client, mock_svc, mock_pc):
        """Approval request should persist complete('incomplete')."""
        mock_mcp = agent_loop_pkg._default.mcp_client
        mock_mcp.server_tool_names = ["web_search"]
        mock_mcp.display_names = {"web_search": "Web Search"}

        mock_svc.process_messages_with_tools.return_value = LLMResult(
            type=LLMResultType.TOOL_CALL,
            tool_calls=[
                ToolCallInfo(name="web_search", args={"q": "test"}, id="call_ws"),
            ],
            session_id="s1",
            usage=Usage.zero(),
        )

        resp = await client.post(
            ENDPOINT,
            json={
                "input": "search",
                "tools": [],
                "metadata": {"session_id": "s1", "response_id": "101"},
            },
        )
        assert resp.json()["status"] == "incomplete"

        await asyncio.sleep(0.05)

        # Should have persisted complete with "incomplete" status
        assert mock_pc.complete_response.call_count >= 1
        complete_call = mock_pc.complete_response.call_args
        status_arg = complete_call.kwargs.get("status") or (
            complete_call.args[1] if len(complete_call.args) > 1 else None
        )
        assert status_arg == "incomplete"

    async def test_unsupported_tool_persists_error(self, client, mock_svc, mock_pc):
        """Unsupported tool errors should be persisted."""
        mock_mcp = agent_loop_pkg._default.mcp_client
        mock_mcp.is_server_tool.return_value = False

        mock_svc.process_messages_with_tools.return_value = LLMResult(
            type=LLMResultType.TOOL_CALL,
            tool_calls=[
                ToolCallInfo(name="nonexistent_tool", args={}, id="call_x"),
            ],
            session_id="s1",
            usage=Usage.zero(),
        )

        await client.post(
            ENDPOINT,
            json={
                "input": "run it",
                "tools": [],
                "metadata": {"session_id": "s1", "response_id": "102"},
            },
        )

        await asyncio.sleep(0.05)

        # Should have persisted function_call_output with error
        save_calls = mock_pc.save_message.call_args_list
        has_error_persist = any(
            (
                c.kwargs.get("msg_type") == "function_call_output"
                or (len(c.args) > 3 and c.args[3] == "function_call_output")
            )
            for c in save_calls
        )
        assert has_error_persist


# ---------------------------------------------------------------------------
# Streaming persist hooks
# ---------------------------------------------------------------------------


class TestStreamingPersistHooks:
    """Verify persist hooks fire in the streaming path."""

    async def test_stream_text_only_persists(self, client, mock_svc, mock_pc):
        """Streaming text-only should persist message + complete."""
        mock_svc.stream_messages_with_tools = _make_stream_generator("Hello stream!")
        # extract_usage must return a proper Usage object
        mock_svc.extract_usage = MagicMock(return_value=Usage.zero())

        resp = await client.post(
            ENDPOINT,
            json={
                "input": "Hi",
                "stream": True,
                "metadata": {"session_id": "s1", "response_id": "200"},
            },
        )
        assert resp.status_code == 200

        # Consume the stream
        _ = resp.text

        await asyncio.sleep(0.1)

        assert mock_pc.save_message.call_count >= 1
        assert mock_pc.complete_response.call_count >= 1

    async def test_stream_max_iterations_persists_incomplete(
        self, client, mock_svc, mock_pc, monkeypatch
    ):
        """Streaming max iterations should persist complete('incomplete')."""
        from app.config import settings

        monkeypatch.setattr(settings, "MAX_AGENT_ITERATIONS", 1)

        mock_mcp = agent_loop_pkg._default.mcp_client
        mock_mcp.server_tool_names = ["calculator"]
        mock_mcp.display_names = {"calculator": "Calculator"}
        mock_mcp.is_server_tool.return_value = True
        mock_mcp.call_tool.return_value = "42"

        # extract_usage must return a proper Usage object
        mock_svc.extract_usage = MagicMock(return_value=Usage.zero())

        # Stream always returns tool calls → will hit max iterations
        mock_svc.stream_messages_with_tools = _make_tool_stream_generator(
            tool_calls=[{"name": "calculator", "args": {"x": 1}, "id": "c1"}]
        )

        resp = await client.post(
            ENDPOINT,
            json={
                "input": "go",
                "tools": [],
                "stream": True,
                "metadata": {"session_id": "s1", "response_id": "201"},
            },
        )
        _ = resp.text

        await asyncio.sleep(0.1)

        # Verify incomplete persist
        complete_calls = mock_pc.complete_response.call_args_list
        has_incomplete = any(
            (
                c.kwargs.get("status") == "incomplete"
                or (len(c.args) > 1 and c.args[1] == "incomplete")
            )
            for c in complete_calls
        )
        assert has_incomplete


# ---------------------------------------------------------------------------
# No persist when no response_id
# ---------------------------------------------------------------------------


class TestNoPersistWithoutResponseId:
    """When response_id is not set, no persist calls should be made."""

    async def test_no_persist_without_response_id(self, client, mock_svc, mock_pc):
        mock_svc.process_messages_with_tools.return_value = LLMResult(
            type=LLMResultType.TEXT,
            text="Hello!",
            session_id="s1",
            usage=Usage.zero(),
        )
        resp = await client.post(
            ENDPOINT,
            json={"input": "Hi", "metadata": {"session_id": "s1"}},
        )
        assert resp.json()["status"] == "completed"

        await asyncio.sleep(0.05)

        # No persist calls should be made (no response_id in metadata)
        assert mock_pc.save_message.call_count == 0
        assert mock_pc.complete_response.call_count == 0


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_stream_generator(text: str):
    """Create a mock stream generator that yields chunks then a final message."""

    async def _gen(**kwargs):
        chunk = MagicMock()
        chunk.content = text
        chunk.tool_calls = None
        chunk.usage_metadata = {
            "input_tokens": 10,
            "output_tokens": 5,
            "total_tokens": 15,
            "input_token_details": {"cache_read": 0},
            "output_token_details": {"reasoning": 0},
        }
        # Make chunk + chunk = chunk (for accumulation)
        chunk.__add__ = MagicMock(return_value=chunk)
        yield chunk

    return _gen


def _make_tool_stream_generator(tool_calls: list):
    """Create a mock stream generator that yields a tool-call chunk."""

    async def _gen(**kwargs):
        chunk = MagicMock()
        chunk.content = ""
        chunk.tool_calls = tool_calls
        chunk.usage_metadata = {
            "input_tokens": 10,
            "output_tokens": 5,
            "total_tokens": 15,
            "input_token_details": {"cache_read": 0},
            "output_token_details": {"reasoning": 0},
        }
        chunk.__add__ = MagicMock(return_value=chunk)
        yield chunk

    return _gen
