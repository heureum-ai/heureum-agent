# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for the HTTP endpoints in app.routers.agent."""

import json
from unittest.mock import AsyncMock, MagicMock

import app.routers.agent as exp_module
import app.services.agent_loop as agent_loop_pkg
import pytest
from app.config import ApprovalChoice
from app.main import app
from app.models import LLMResult, LLMResultType, ToolCallInfo
from app.schemas.open_responses import Usage
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage
from app.services.mcps import MCPClientController
from app.services.mcps.approval import ApprovalState
from app.services.messages import MessageController
from httpx import ASGITransport, AsyncClient

# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------

BASE_URL = "http://test"
ENDPOINT = "/api/v1/agent/responses"


@pytest.fixture(autouse=True)
def _patch_module(monkeypatch):
    """Patch controller instance attributes so no real LLM / MCP calls are made."""
    ctrl = agent_loop_pkg._default

    # Skip MCP initialization
    monkeypatch.setattr(ctrl, "_initialized", True)

    # Mock agent_service
    mock_svc = AsyncMock()
    mock_svc.get_history = MagicMock(return_value=[])
    mc = MessageController()
    mock_svc.message_controller = mc
    # Expose facade shortcuts so router code works with the mock
    mock_svc.responses = mc.response_message_controller
    mock_svc.history = mc.history_message_controller
    mock_svc._normalize = mc.message_normalize_controller
    mock_svc.extract_lc_text = mc.message_normalize_controller.extract_lc_text
    mock_svc._sessions = mc.session_state_controller.sessions
    monkeypatch.setattr(ctrl, "agent_service", mock_svc)
    monkeypatch.setattr(ctrl.tool_exec, "agent_service", mock_svc)
    monkeypatch.setattr(exp_module, "agent_service", mock_svc)

    # Mock tool_controller (no-op: no chain rules registered)
    from app.services.tools import ToolController

    mock_tool_controller = ToolController()
    monkeypatch.setattr(ctrl, "tool_controller", mock_tool_controller)
    monkeypatch.setattr(ctrl.tool_exec, "tool_controller", mock_tool_controller)

    # Mock mcp_client — use real MCPClientController logic for approval methods
    mock_mcp = AsyncMock()
    mock_mcp.is_server_tool = MagicMock(return_value=False)
    mock_mcp.display_names = {}
    _real = MCPClientController.__new__(MCPClientController)
    _real._approval = ApprovalState(
        approval_required_tools={"web_search", "web_fetch"},
        display_names={"web_search": "Web Search", "web_fetch": "Web Fetch"},
    )
    mock_mcp._approval_required_tools = _real._approval.approval_required_tools
    mock_mcp._approval = _real._approval
    mock_mcp.classify_tool_calls = _real.classify_tool_calls
    mock_mcp.needs_approval = _real.needs_approval
    mock_mcp.handle_approval_response = _real.handle_approval_response
    mock_mcp.request_approval = _real.request_approval
    mock_mcp.clear_session_state = _real.clear_session_state
    mock_mcp.has_pending_approval = _real.has_pending_approval
    monkeypatch.setattr(ctrl, "mcp_client", mock_mcp)
    monkeypatch.setattr(ctrl.tool_exec, "mcp_client", mock_mcp)
    monkeypatch.setattr(exp_module, "mcp_client", mock_mcp)

    # Disable router classification in tests — patch classify_request
    # to always return None (no agent config applied, preserving legacy behavior)
    from app.agents.registry import AgentRegistry
    mock_registry = MagicMock(spec=AgentRegistry)
    mock_registry.get_router_catalog.return_value = ""
    mock_registry.get_agent.return_value = None
    mock_registry.list_agents.return_value = []
    monkeypatch.setattr(ctrl, "agent_registry", mock_registry)

    import app.services.agent_loop.runner as runner_mod

    async def _noop_classify(*args, **kwargs):
        return None

    monkeypatch.setattr(runner_mod, "classify_request", _noop_classify)


@pytest.fixture
def mock_svc():
    """Return the currently patched agent_service singleton."""
    return agent_loop_pkg._default.agent_service


@pytest.fixture
def mock_mcp():
    """Return the currently patched mcp_client singleton."""
    return agent_loop_pkg._default.mcp_client


@pytest.fixture
async def client():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url=BASE_URL) as c:
        yield c


def _text_payload(text: str = "Hello", *, session_id: str | None = None, **kwargs) -> dict:
    """Build a minimal request body with no tools (text-only path)."""
    body: dict = {"input": text, **kwargs}
    if session_id:
        body["metadata"] = {"session_id": session_id}
    return body


def _tool_payload(
    text: str = "Do something",
    tools: list | None = None,
    *,
    session_id: str | None = None,
    **kwargs,
) -> dict:
    """Build a request body that includes tool definitions."""
    if tools is None:
        tools = [
            {
                "type": "function",
                "function": {
                    "name": "ask_question",
                    "description": "Ask the user a question",
                    "parameters": {"type": "object", "properties": {}},
                },
                "display_name": "Ask Question",
            }
        ]
    body: dict = {"input": text, "tools": tools, **kwargs}
    if session_id:
        body["metadata"] = {"session_id": session_id}
    return body


# ---------------------------------------------------------------------------
# TestCreateResponseText
# ---------------------------------------------------------------------------


class TestCreateResponseText:
    """Tests for the simple text response path (no tools)."""

    async def test_text_response_no_tools(self, client, mock_svc):
        """A simple text request returns status=completed and the expected text."""
        # Server-only tools are always present, so process_messages_with_tools is called
        mock_svc.process_messages_with_tools.return_value = LLMResult(
            type=LLMResultType.TEXT,
            text="Hello!",
            session_id="test_session",
            usage=Usage.zero(),
        )
        resp = await client.post(ENDPOINT, json=_text_payload("Hi"))
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "completed"
        assert any(
            item.get("type") == "message"
            and any(c["text"] == "Hello!" for c in item.get("content", []))
            for item in data["output"]
        )

    async def test_empty_input_returns_error(self, client):
        """An empty input list returns status=failed with an error object."""
        resp = await client.post(ENDPOINT, json={"input": []})
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "failed"
        assert data["error"] is not None
        assert data["error"]["type"] == "invalid_request_error"

    async def test_session_id_in_metadata(self, client, mock_svc):
        """The response metadata includes the session_id."""
        mock_svc.process_messages_with_tools.return_value = LLMResult(
            type=LLMResultType.TEXT,
            text="OK",
            session_id="my_session",
            usage=Usage.zero(),
        )
        resp = await client.post(
            ENDPOINT,
            json=_text_payload("Hello", session_id="my_session"),
        )
        data = resp.json()
        assert data["metadata"]["session_id"] == "my_session"


# ---------------------------------------------------------------------------
# TestCreateResponseToolCall
# ---------------------------------------------------------------------------


class TestCreateResponseToolCall:
    """Tests for the agentic loop with tool calling."""

    async def test_client_tool_call_returns_incomplete(self, client, mock_svc):
        """A client tool (ask_question) yields status=incomplete with a function_call output."""
        mock_svc.process_messages_with_tools.return_value = LLMResult(
            type=LLMResultType.TOOL_CALL,
            tool_calls=[
                ToolCallInfo(name="ask_question", args={"question": "What?"}, id="call_1"),
            ],
            session_id="test_session",
            usage=Usage.zero(),
        )
        resp = await client.post(ENDPOINT, json=_tool_payload("Ask me"))
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "incomplete"
        fc_items = [o for o in data["output"] if o.get("type") == "function_call"]
        assert len(fc_items) == 1
        assert fc_items[0]["name"] == "ask_question"

    async def test_server_tool_execution(self, client, mock_svc, mock_mcp):
        """A server (MCP) tool is executed via mcp_client and the final text is returned."""
        # MCP tools are NOT in request.tools — they are discovered server-side
        mock_mcp.server_tool_names = ["calculator"]
        mock_mcp.display_names = {"calculator": "Calculator"}
        # First call: LLM wants to invoke a server tool
        # Second call: LLM produces the final text answer
        mock_svc.process_messages_with_tools.side_effect = [
            LLMResult(
                type=LLMResultType.TOOL_CALL,
                tool_calls=[
                    ToolCallInfo(name="calculator", args={"expr": "1+1"}, id="call_srv"),
                ],
                session_id="test_session",
                usage=Usage.zero(),
            ),
            LLMResult(
                type=LLMResultType.TEXT,
                text="The answer is 2",
                session_id="test_session",
                usage=Usage.zero(),
            ),
        ]
        mock_mcp.is_server_tool.return_value = True
        mock_mcp.call_tool.return_value = "2"

        resp = await client.post(ENDPOINT, json=_tool_payload("calculate", tools=[]))
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "completed"
        # Output contains only the final text message
        types = [o["type"] for o in data["output"]]
        assert types == ["message"]
        # Server-executed tool calls are in metadata.tool_history
        tool_history = data["metadata"]["tool_history"]
        history_types = [h["type"] for h in tool_history]
        assert "function_call" in history_types
        assert "function_call_output" in history_types

    async def test_tool_call_with_result_in_output(self, client, mock_svc, mock_mcp):
        """Server tool call + result pairs appear as adjacent output items."""
        # MCP tools are NOT in request.tools
        mock_mcp.server_tool_names = ["calculator"]
        mock_mcp.display_names = {"calculator": "Calculator"}
        mock_svc.process_messages_with_tools.side_effect = [
            LLMResult(
                type=LLMResultType.TOOL_CALL,
                tool_calls=[
                    ToolCallInfo(name="calculator", args={}, id="call_42"),
                ],
                session_id="s1",
                usage=Usage.zero(),
            ),
            LLMResult(
                type=LLMResultType.TEXT,
                text="Done",
                session_id="s1",
                usage=Usage.zero(),
            ),
        ]
        mock_mcp.is_server_tool.return_value = True
        mock_mcp.call_tool.return_value = "result text"

        resp = await client.post(ENDPOINT, json=_tool_payload("go", tools=[]))
        data = resp.json()
        # Server tool history is in metadata, not output
        tool_history = data["metadata"]["tool_history"]
        fc_idx = next(i for i, h in enumerate(tool_history) if h["type"] == "function_call")
        assert tool_history[fc_idx + 1]["type"] == "function_call_output"
        assert tool_history[fc_idx + 1]["output"] == "result text"


# ---------------------------------------------------------------------------
# TestErrorHandling
# ---------------------------------------------------------------------------


class TestErrorHandling:
    """Tests for error paths in the endpoint."""

    async def test_not_implemented_tool(self, client, mock_svc, mock_mcp):
        """Unknown server tools are surfaced as tool-call continuation context."""
        # unknown_tool is NOT a client tool (not in request.tools) — classified as server call
        mock_svc.process_messages_with_tools.return_value = LLMResult(
            type=LLMResultType.TOOL_CALL,
            tool_calls=[
                ToolCallInfo(name="unknown_tool", args={}, id="call_x"),
            ],
            session_id="s1",
            usage=Usage.zero(),
        )
        # is_server_tool returns False, so classified as unsupported
        mock_mcp.is_server_tool.return_value = False

        resp = await client.post(ENDPOINT, json=_tool_payload("run it", tools=[]))
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "incomplete"

    async def test_server_error(self, client, mock_svc):
        """A general exception returns status=failed, error type=server_error."""
        mock_svc.process_messages_with_tools.side_effect = RuntimeError("kaboom")

        resp = await client.post(ENDPOINT, json=_text_payload("Hi"))
        assert resp.status_code == 200
        data = resp.json()
        assert data["status"] == "failed"
        assert data["error"]["type"] == "server_error"
        assert "kaboom" in data["error"]["message"]

    async def test_validation_error(self, client):
        """An invalid request body returns HTTP 422."""
        resp = await client.post(ENDPOINT, json={"bad_field": "nope"})
        assert resp.status_code == 422


# ---------------------------------------------------------------------------
# TestResponseStructure
# ---------------------------------------------------------------------------


class TestResponseStructure:
    """Tests for the shape and required fields of the response body."""

    async def test_response_has_required_fields(self, client, mock_svc):
        """The response JSON contains all required top-level fields."""
        mock_svc.process_messages_with_tools.return_value = LLMResult(
            type=LLMResultType.TEXT,
            text="Hi",
            session_id="s1",
            usage=Usage.zero(),
        )
        resp = await client.post(ENDPOINT, json=_text_payload("Hi"))
        data = resp.json()
        for field in (
            "id",
            "object",
            "created_at",
            "model",
            "status",
            "output",
            "usage",
        ):
            assert field in data, f"Missing field: {field}"

    async def test_response_object_literal(self, client, mock_svc):
        """The 'object' field is always the literal string 'response'."""
        mock_svc.process_messages_with_tools.return_value = LLMResult(
            type=LLMResultType.TEXT,
            text="Hi",
            session_id="s1",
            usage=Usage.zero(),
        )
        resp = await client.post(ENDPOINT, json=_text_payload("Hi"))
        data = resp.json()
        assert data["object"] == "response"

    async def test_usage_structure(self, client, mock_svc):
        """The usage object contains input_tokens, output_tokens, and total_tokens."""
        mock_svc.process_messages_with_tools.return_value = LLMResult(
            type=LLMResultType.TEXT,
            text="Hi",
            session_id="s1",
            usage=Usage.zero(),
        )
        resp = await client.post(ENDPOINT, json=_text_payload("Hi"))
        usage = resp.json()["usage"]
        assert "input_tokens" in usage
        assert "output_tokens" in usage
        assert "total_tokens" in usage


# ---------------------------------------------------------------------------
# TestToolApproval
# ---------------------------------------------------------------------------

WEB_SEARCH_TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "web_search",
            "description": "Search the web",
            "parameters": {"type": "object", "properties": {}},
        },
        "display_name": "Web Search",
    }
]


class TestToolApproval:
    """Tests for the approval-required tool flow."""

    @pytest.fixture(autouse=True)
    def _clear_approval_state(self, mock_mcp):
        """Reset mcp_client approval state between tests."""
        mock_mcp._approval.pending_tool_calls.clear()
        mock_mcp._approval.auto_approved_tools.clear()
        yield
        mock_mcp._approval.pending_tool_calls.clear()
        mock_mcp._approval.auto_approved_tools.clear()

    async def test_approval_tool_returns_tool_approval(self, client, mock_svc, mock_mcp):
        """web_search triggers a tool_approval instead of executing."""
        # web_search is an MCP server tool, not in request.tools
        mock_mcp.server_tool_names = ["web_search"]
        mock_mcp.display_names = {"web_search": "Web Search"}
        mock_svc.process_messages_with_tools.return_value = LLMResult(
            type=LLMResultType.TOOL_CALL,
            tool_calls=[
                ToolCallInfo(name="web_search", args={"query": "test"}, id="call_ws"),
            ],
            session_id="s1",
            usage=Usage.zero(),
        )

        resp = await client.post(
            ENDPOINT,
            json=_tool_payload("search", tools=[], session_id="s1"),
        )
        data = resp.json()

        assert data["status"] == "incomplete"
        fc_items = [o for o in data["output"] if o.get("type") == "function_call"]
        assert len(fc_items) == 1
        assert fc_items[0]["name"] == "tool_approval"
        args = json.loads(fc_items[0]["arguments"])
        assert "web_search" in args["question"]
        assert args["tool_name"] == "web_search"
        choice_labels = [c["label"] for c in args["choices"]]
        assert ApprovalChoice.ALLOW_ONCE.value in choice_labels
        assert ApprovalChoice.ALWAYS_ALLOW.value in choice_labels
        assert ApprovalChoice.DENY.value in choice_labels

        # Tool was NOT executed
        mock_mcp.call_tool.assert_not_called()

        # Pending state was saved
        assert "s1" in mock_mcp._approval.pending_tool_calls

    async def test_approval_allow_once_executes_tool(self, client, mock_svc, mock_mcp):
        """After 'Allow Once', the pending tool is executed and the loop continues."""
        # Seed pending state (simulates a previous ask_question return)
        mock_mcp._approval.pending_tool_calls["s1"] = {
            "approval_call_id": "ask_q_1",
            "tool_calls": [ToolCallInfo(name="web_search", args={"query": "test"}, id="call_ws")],
            "usage": Usage.zero(),
            "input_messages": [],
        }
        mock_mcp.is_server_tool.return_value = True
        mock_mcp.call_tool.return_value = "search results"

        # After approval, the loop continues — LLM produces final text
        mock_svc.process_messages_with_tools.return_value = LLMResult(
            type=LLMResultType.TEXT,
            text="Here are the results",
            session_id="s1",
            usage=Usage.zero(),
        )

        # Send approval as FunctionToolCall echo + FunctionToolResult
        resp = await client.post(
            ENDPOINT,
            json={
                "input": [
                    {
                        "type": "function_call",
                        "name": "ask_question",
                        "call_id": "ask_q_1",
                        "arguments": "{}",
                        "display_name": "Ask Question",
                    },
                    {
                        "type": "function_call_output",
                        "call_id": "ask_q_1",
                        "output": ApprovalChoice.ALLOW_ONCE,
                    },
                ],
                "tools": WEB_SEARCH_TOOLS,
                "metadata": {"session_id": "s1"},
            },
        )
        data = resp.json()

        assert data["status"] == "completed"
        mock_mcp.call_tool.assert_called_once_with("web_search", {"query": "test"}, session_id="s1")
        # Pending state was cleaned up
        assert "s1" not in mock_mcp._approval.pending_tool_calls
        # NOT auto-approved for future calls
        assert "s1" not in mock_mcp._approval.auto_approved_tools

    async def test_approval_always_allow_auto_approves_future(self, client, mock_svc, mock_mcp):
        """'Always Allow' approves and remembers the tool for future calls."""
        mock_mcp._approval.pending_tool_calls["s1"] = {
            "approval_call_id": "ask_q_2",
            "tool_calls": [ToolCallInfo(name="web_search", args={"query": "q"}, id="call_ws2")],
            "usage": Usage.zero(),
            "input_messages": [],
        }
        mock_mcp.is_server_tool.return_value = True
        mock_mcp.call_tool.return_value = "ok"
        mock_svc.process_messages_with_tools.return_value = LLMResult(
            type=LLMResultType.TEXT,
            text="done",
            session_id="s1",
            usage=Usage.zero(),
        )

        resp = await client.post(
            ENDPOINT,
            json={
                "input": [
                    {
                        "type": "function_call",
                        "name": "ask_question",
                        "call_id": "ask_q_2",
                        "arguments": "{}",
                        "display_name": "Ask Question",
                    },
                    {
                        "type": "function_call_output",
                        "call_id": "ask_q_2",
                        "output": ApprovalChoice.ALWAYS_ALLOW,
                    },
                ],
                "tools": WEB_SEARCH_TOOLS,
                "metadata": {"session_id": "s1"},
            },
        )
        assert resp.json()["status"] == "completed"
        assert "web_search" in mock_mcp._approval.auto_approved_tools.get("s1", set())

    async def test_approval_deny_sends_denial_to_llm(self, client, mock_svc, mock_mcp):
        """'Deny' injects a permission-denied tool result."""
        mock_mcp._approval.pending_tool_calls["s1"] = {
            "approval_call_id": "ask_q_3",
            "tool_calls": [ToolCallInfo(name="web_search", args={"query": "q"}, id="call_ws3")],
            "usage": Usage.zero(),
            "input_messages": [],
        }
        mock_svc.process_messages_with_tools.return_value = LLMResult(
            type=LLMResultType.TEXT,
            text="I cannot search",
            session_id="s1",
            usage=Usage.zero(),
        )

        resp = await client.post(
            ENDPOINT,
            json={
                "input": [
                    {
                        "type": "function_call",
                        "name": "ask_question",
                        "call_id": "ask_q_3",
                        "arguments": "{}",
                        "display_name": "Ask Question",
                    },
                    {
                        "type": "function_call_output",
                        "call_id": "ask_q_3",
                        "output": ApprovalChoice.DENY,
                    },
                ],
                "tools": WEB_SEARCH_TOOLS,
                "metadata": {"session_id": "s1"},
            },
        )
        data = resp.json()
        assert data["status"] == "completed"
        # Tool was NOT executed
        mock_mcp.call_tool.assert_not_called()
        # append_tool_interaction was called with denial result
        call_args = mock_svc.append_tool_interaction.call_args
        tool_results = call_args[0][3]  # 4th positional arg
        assert any("Permission denied" in r.content for r in tool_results)

    async def test_auto_approved_tool_skips_approval(self, client, mock_svc, mock_mcp):
        """A tool in _auto_approved_tools is executed without asking."""
        mock_mcp._approval.auto_approved_tools["s1"] = {"web_search"}
        mock_mcp.server_tool_names = ["web_search"]
        mock_mcp.display_names = {"web_search": "Web Search"}

        mock_svc.process_messages_with_tools.side_effect = [
            LLMResult(
                type=LLMResultType.TOOL_CALL,
                tool_calls=[
                    ToolCallInfo(name="web_search", args={"query": "q"}, id="call_auto"),
                ],
                session_id="s1",
                usage=Usage.zero(),
            ),
            LLMResult(
                type=LLMResultType.TEXT,
                text="auto result",
                session_id="s1",
                usage=Usage.zero(),
            ),
        ]
        mock_mcp.is_server_tool.return_value = True
        mock_mcp.call_tool.return_value = "results"

        resp = await client.post(
            ENDPOINT,
            json=_tool_payload("go", tools=[], session_id="s1"),
        )
        data = resp.json()

        assert data["status"] == "completed"
        mock_mcp.call_tool.assert_called_once()
        # No pending state was created
        assert "s1" not in mock_mcp._approval.pending_tool_calls


# ---------------------------------------------------------------------------
# TestClientToolContinuation
# ---------------------------------------------------------------------------


class TestClientToolContinuation:
    """Tests for the continuation flow when client tool results come back."""

    async def test_continuation_does_not_duplicate_user_message(self, client, mock_svc, mock_mcp):
        """When client sends tool results + original messages, only tool
        results are applied to history and no duplicate messages are passed
        to the LLM."""
        # Simulate existing session history with placeholder ToolMessage
        existing_history = [
            HumanMessage(content="Open coupang"),
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "browser_new_tab",
                        "args": {"url": "https://coupang.com"},
                        "id": "call_1",
                    },
                ],
            ),
            ToolMessage(
                tool_call_id="call_1",
                content='{"url":"https://coupang.com"}',
                name="browser_new_tab",
            ),
        ]
        mock_svc.get_history = MagicMock(return_value=existing_history)

        # LLM responds with text after seeing tool results
        mock_svc.process_messages_with_tools.return_value = LLMResult(
            type=LLMResultType.TEXT,
            text="Coupang is now open!",
            session_id="s1",
            usage=Usage.zero(),
        )

        # Client sends continuation: original user message + tool call echo + tool result
        resp = await client.post(
            ENDPOINT,
            json={
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "status": "completed",
                        "content": [{"type": "input_text", "text": "Open coupang"}],
                    },
                    {
                        "type": "function_call",
                        "name": "browser_new_tab",
                        "call_id": "call_1",
                        "arguments": '{"url":"https://coupang.com"}',
                        "display_name": "New Tab",
                    },
                    {
                        "type": "function_call_output",
                        "call_id": "call_1",
                        "output": "Successfully opened https://coupang.com",
                    },
                ],
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "ask_question",
                            "description": "Ask",
                            "parameters": {"type": "object", "properties": {}},
                        },
                        "display_name": "Ask Question",
                    }
                ],
                "metadata": {"session_id": "s1"},
            },
        )
        data = resp.json()
        assert data["status"] == "completed"

        # Verify process_messages_with_tools was called with EMPTY messages
        # (not the duplicate user message)
        call_args = mock_svc.process_messages_with_tools.call_args
        messages_arg = call_args.kwargs.get("messages", call_args[0][0] if call_args[0] else None)
        assert messages_arg == [], f"Expected empty messages but got {messages_arg}"

        # Verify placeholder in history was replaced with actual result
        assert existing_history[2].content == "Successfully opened https://coupang.com"

    async def test_continuation_with_failed_tool_gets_llm_response(
        self, client, mock_svc, mock_mcp
    ):
        """When a client tool fails, the LLM should see the error and respond."""
        existing_history = [
            HumanMessage(content="Click the button"),
            AIMessage(
                content="",
                tool_calls=[
                    {"name": "browser_click", "args": {"selector": "#btn"}, "id": "call_c1"},
                ],
            ),
            ToolMessage(
                tool_call_id="call_c1",
                content='{"selector":"#btn"}',
                name="browser_click",
            ),
        ]
        mock_svc.get_history = MagicMock(return_value=existing_history)

        mock_svc.process_messages_with_tools.return_value = LLMResult(
            type=LLMResultType.TEXT,
            text="The click failed. Let me try a different approach.",
            session_id="s1",
            usage=Usage.zero(),
        )

        resp = await client.post(
            ENDPOINT,
            json={
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "status": "completed",
                        "content": [{"type": "input_text", "text": "Click the button"}],
                    },
                    {
                        "type": "function_call",
                        "name": "browser_click",
                        "call_id": "call_c1",
                        "arguments": '{"selector":"#btn"}',
                        "display_name": "Click",
                    },
                    {
                        "type": "function_call_output",
                        "call_id": "call_c1",
                        "output": "Error: Element not found",
                    },
                ],
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "ask_question",
                            "description": "Ask",
                            "parameters": {"type": "object", "properties": {}},
                        },
                        "display_name": "Ask Question",
                    }
                ],
                "metadata": {"session_id": "s1"},
            },
        )
        data = resp.json()
        assert data["status"] == "completed"

        # Verify the error was applied to history
        assert existing_history[2].content == "Error: Element not found"

        # Verify the LLM's response is in the output
        msg_items = [o for o in data["output"] if o.get("type") == "message"]
        assert len(msg_items) == 1
        assert any("failed" in c["text"] for c in msg_items[0]["content"])

    async def test_echo_recovery_orders_user_before_ai_tool(self, client, mock_svc, mock_mcp):
        """When session is lost (empty history), echo recovery must produce
        [UserMessage, AIMessage{tool_calls}, ToolMessage] — NOT
        [AIMessage, UserMessage, ToolMessage] which violates the OpenAI API."""

        # Empty session = echo recovery branch
        mock_svc.get_history = MagicMock(return_value=[])

        mock_svc.process_messages_with_tools.return_value = LLMResult(
            type=LLMResultType.TEXT,
            text="The extension seems disconnected.",
            session_id="s2",
            usage=Usage.zero(),
        )

        resp = await client.post(
            ENDPOINT,
            json={
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "status": "completed",
                        "content": [{"type": "input_text", "text": "쿠팡 열어줘"}],
                    },
                    {
                        "type": "function_call",
                        "name": "browser_navigate",
                        "call_id": "call_nav1",
                        "arguments": '{"url":"https://coupang.com"}',
                        "display_name": "Navigate",
                    },
                    {
                        "type": "function_call_output",
                        "call_id": "call_nav1",
                        "output": "Error: browser extension not connected",
                    },
                ],
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "ask_question",
                            "description": "Ask",
                            "parameters": {"type": "object", "properties": {}},
                        },
                        "display_name": "Ask Question",
                    }
                ],
                "metadata": {"session_id": "s2"},
            },
        )
        data = resp.json()
        assert data["status"] == "completed"

        # Verify correct message ordering: [User, AI{tool_calls}, Tool]
        call_args = mock_svc.process_messages_with_tools.call_args
        messages_arg = call_args.kwargs.get("messages", call_args[0][0] if call_args[0] else None)
        assert len(messages_arg) == 3
        assert messages_arg[0].type == "human"
        assert messages_arg[1].type == "ai"
        assert messages_arg[1].tool_calls is not None
        assert messages_arg[2].type == "tool"
        assert messages_arg[2].tool_call_id == "call_nav1"

    async def test_new_message_not_dropped_when_session_exists(self, client, mock_svc, mock_mcp):
        """When user sends a follow-up message (not continuation), the new
        message must reach the LLM — not be dropped as an 'echo'."""
        # Session has history from previous interaction
        existing_history = [
            HumanMessage(content="쿠팡 열어줘"),
            AIMessage(
                content="",
                tool_calls=[
                    {
                        "name": "browser_new_tab",
                        "args": {"url": "https://coupang.com"},
                        "id": "call_1",
                    },
                ],
            ),
            ToolMessage(
                tool_call_id="call_1",
                content="Error: extension not connected",
                name="browser_new_tab",
            ),
            AIMessage(content="확장 프로그램을 설치해 주세요."),
        ]
        mock_svc.get_history = MagicMock(return_value=existing_history)

        mock_svc.process_messages_with_tools.return_value = LLMResult(
            type=LLMResultType.TEXT,
            text="네, 다시 시도하겠습니다!",
            session_id="s1",
            usage=Usage.zero(),
        )

        # User sends a NEW message along with echoed history (no tool results)
        resp = await client.post(
            ENDPOINT,
            json={
                "input": [
                    {
                        "type": "message",
                        "role": "user",
                        "status": "completed",
                        "content": [{"type": "input_text", "text": "쿠팡 열어줘"}],
                    },
                    {
                        "type": "message",
                        "role": "assistant",
                        "status": "completed",
                        "content": [
                            {
                                "type": "output_text",
                                "text": "확장 프로그램을 설치해 주세요.",
                            }
                        ],
                    },
                    {
                        "type": "message",
                        "role": "user",
                        "status": "completed",
                        "content": [{"type": "input_text", "text": "연결했어"}],
                    },
                ],
                "tools": [
                    {
                        "type": "function",
                        "function": {
                            "name": "ask_question",
                            "description": "Ask",
                            "parameters": {"type": "object", "properties": {}},
                        },
                        "display_name": "Ask Question",
                    }
                ],
                "metadata": {"session_id": "s1"},
            },
        )
        data = resp.json()
        assert data["status"] == "completed"

        # The new message "연결했어" must be passed to the LLM
        call_args = mock_svc.process_messages_with_tools.call_args
        messages_arg = call_args.kwargs.get("messages", call_args[0][0] if call_args[0] else None)
        assert len(messages_arg) == 1
        assert messages_arg[0].type == "human"
        assert messages_arg[0].content == "연결했어"

    async def test_continuation_keeps_tool_path_without_forced_cutoff(
        self,
        client,
        mock_svc,
        mock_mcp,
    ):
        """Consecutive continuations should keep the tool-enabled path.

        Tool retry decisions are left to the LLM via tool error context,
        and only the overall loop iteration limit should cap the cycle.
        """
        existing_history = [
            HumanMessage(content="검색해줘"),
            AIMessage(
                content="",
                tool_calls=[
                    {"name": "browser_click", "args": {"selector": ".btn"}, "id": "call_r1"},
                ],
            ),
            ToolMessage(
                tool_call_id="call_r1",
                content='{"selector":".btn"}',
                name="browser_click",
            ),
        ]
        mock_svc.get_history = MagicMock(return_value=existing_history)

        mock_svc.process_messages_with_tools.side_effect = [
            LLMResult(
                type=LLMResultType.TEXT,
                text="Retrying...",
                session_id="s1",
                usage=Usage.zero(),
            ),
            LLMResult(
                type=LLMResultType.TEXT,
                text="Still trying...",
                session_id="s1",
                usage=Usage.zero(),
            ),
        ]

        continuation_payload = {
            "input": [
                {
                    "type": "message",
                    "role": "user",
                    "status": "completed",
                    "content": [{"type": "input_text", "text": "검색해줘"}],
                },
                {
                    "type": "function_call",
                    "name": "browser_click",
                    "call_id": "call_r1",
                    "arguments": '{"selector":".btn"}',
                    "display_name": "Click",
                },
                {
                    "type": "function_call_output",
                    "call_id": "call_r1",
                    "output": "Error: Element not found",
                },
            ],
            "tools": [
                {
                    "type": "function",
                    "function": {
                        "name": "ask_question",
                        "description": "Ask",
                        "parameters": {"type": "object", "properties": {}},
                    },
                    "display_name": "Ask Question",
                }
            ],
            "metadata": {"session_id": "s1"},
        }

        # First continuation
        await client.post(ENDPOINT, json=continuation_payload)
        mock_svc.process_messages_with_tools.assert_called()
        mock_svc.process_messages.assert_not_called()

        # Second continuation should also stay on tool-enabled path
        resp = await client.post(ENDPOINT, json=continuation_payload)
        assert mock_svc.process_messages_with_tools.call_count == 2
        mock_svc.process_messages.assert_not_called()

        data = resp.json()
        assert data["status"] == "completed"
        msg_items = [o for o in data["output"] if o.get("type") == "message"]
        assert any("Still trying" in c["text"] for c in msg_items[0]["content"])
