# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for MCP client (app/services/providers/mcp.py)."""

import sys
from unittest.mock import AsyncMock, MagicMock, patch

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mock_tool(name="test_tool", description="A test tool", input_schema=None, meta=None):
    tool = MagicMock()
    tool.name = name
    tool.description = description
    tool.inputSchema = input_schema or {"type": "object", "properties": {}}
    tool.meta = meta  # None by default — matches real MCP tools without meta
    return tool


def _mock_call_result(text="result text"):
    result = MagicMock()
    content_item = MagicMock()
    content_item.text = text
    result.content = [content_item]
    return result


def _make_session(tools=None, call_result=None):
    """Return an AsyncMock that quacks like a ClientSession."""
    session = AsyncMock()
    response = MagicMock()
    response.tools = tools if tools is not None else [_mock_tool()]
    session.list_tools.return_value = response
    session.call_tool.return_value = call_result or _mock_call_result()
    return session


def _setup_connection(client, url, server_name="test"):
    """Set up a mock connection with server_name for diagnostics."""
    conn = MagicMock()
    conn.server_name = server_name
    conn.session = _make_session()
    client._connections[url] = conn


# ---------------------------------------------------------------------------
# Import the module under test with mocked MCP dependencies
# ---------------------------------------------------------------------------

# Ensure the real `mcp` package is never imported.
_fake_mcp = MagicMock()
_fake_mcp.ClientSession = MagicMock
_fake_mcp.client.streamable_http.streamablehttp_client = MagicMock()

sys.modules.setdefault("mcp", _fake_mcp)
sys.modules.setdefault("mcp.client", _fake_mcp.client)
sys.modules.setdefault("mcp.client.streamable_http", _fake_mcp.client.streamable_http)

from app.config import ApprovalChoice  # noqa: E402
from app.config import settings  # noqa: E402
from app.models import Message, ToolCallInfo  # noqa: E402
from app.schemas.open_responses import MessageRole  # noqa: E402
from app.services.providers.mcp import (  # noqa: E402
    MCPClient,
    _ServerConnection,
)

# ---------------------------------------------------------------------------
# 1. TestMCPClientInit
# ---------------------------------------------------------------------------


class TestMCPClientInit:
    def test_default_server_urls(self):
        with patch("app.services.providers.mcp.settings") as mock_settings:
            mock_settings.get_mcp_server_urls.return_value = [
                "http://localhost:3001",
                "http://localhost:3002",
            ]
            client = MCPClient()
            assert client._server_urls == [
                "http://localhost:3001",
                "http://localhost:3002",
            ]

    def test_custom_server_urls(self):
        urls = ["http://a:8000", "http://b:9000"]
        client = MCPClient(server_urls=urls)
        assert client._server_urls == urls


# ---------------------------------------------------------------------------
# 2. TestDiscoverTools
# ---------------------------------------------------------------------------


class TestDiscoverTools:
    async def test_returns_tool_list(self):
        client = MCPClient(server_urls=["http://srv"])
        session = _make_session(
            tools=[
                _mock_tool("mcp_test__alpha", "First", {"type": "object"}),
                _mock_tool("mcp_test__beta", "Second", {"type": "string"}),
            ]
        )
        client._get_session = AsyncMock(return_value=session)
        _setup_connection(client, "http://srv", "test")

        tools = await client.discover_tools()

        assert len(tools) == 2
        assert tools[0] == {
            "type": "function",
            "function": {
                "name": "mcp_test__alpha",
                "description": "First",
                "parameters": {"type": "object"},
            },
        }
        assert tools[1]["function"]["name"] == "mcp_test__beta"

    async def test_cache_hit(self):
        client = MCPClient(server_urls=["http://srv"])
        session = _make_session()
        client._get_session = AsyncMock(return_value=session)
        _setup_connection(client, "http://srv")

        await client.discover_tools()
        await client.discover_tools()

        # list_tools should only be called once (cache hit on second call)
        assert session.list_tools.await_count == 1

    async def test_cache_expired(self):
        client = MCPClient(server_urls=["http://srv"])
        session = _make_session()
        client._get_session = AsyncMock(return_value=session)
        _setup_connection(client, "http://srv")

        await client.discover_tools()

        # Expire the cache
        client._cache_timestamp -= settings.TOOL_CACHE_TTL + 1

        await client.discover_tools()

        assert session.list_tools.await_count == 2

    async def test_server_failure_graceful(self):
        client = MCPClient(server_urls=["http://srv"])
        client._get_session = AsyncMock(side_effect=ConnectionError("down"))
        client._disconnect_server = AsyncMock()

        tools = await client.discover_tools()

        assert tools == []
        client._disconnect_server.assert_awaited_once_with("http://srv")

    async def test_populates_server_tool_names(self):
        client = MCPClient(server_urls=["http://srv"])
        session = _make_session(tools=[_mock_tool("mcp_web__fetch"), _mock_tool("mcp_web__search")])
        client._get_session = AsyncMock(return_value=session)
        _setup_connection(client, "http://srv", "web")

        await client.discover_tools()

        assert client._server_tool_names == {"mcp_web__fetch", "mcp_web__search"}
        assert client._tool_to_server["mcp_web__fetch"] == "http://srv"
        assert client._tool_to_server["mcp_web__search"] == "http://srv"

    async def test_collects_requires_approval_from_meta(self):
        """Tools with meta.requires_approval are added to _approval_required_tools."""
        client = MCPClient(server_urls=["http://srv"])
        session = _make_session(
            tools=[
                _mock_tool("mcp_web__search", meta={"requires_approval": True}),
                _mock_tool("mcp_web__fetch", meta={"requires_approval": True}),
                _mock_tool("mcp_web__calculator"),  # no meta
            ]
        )
        client._get_session = AsyncMock(return_value=session)
        _setup_connection(client, "http://srv", "web")

        await client.discover_tools()

        assert client._approval_required_tools == {"mcp_web__search", "mcp_web__fetch"}

    async def test_no_approval_without_meta(self):
        """Tools without meta or with requires_approval=False are not approval-required."""
        client = MCPClient(server_urls=["http://srv"])
        session = _make_session(
            tools=[
                _mock_tool("tool_a"),
                _mock_tool("tool_b", meta={"requires_approval": False}),
                _mock_tool("tool_c", meta={"chain": []}),
            ]
        )
        client._get_session = AsyncMock(return_value=session)
        _setup_connection(client, "http://srv")

        await client.discover_tools()

        assert client._approval_required_tools == set()

    async def test_multiple_servers(self):
        session_a = _make_session(tools=[_mock_tool("mcp_srv_a__tool_a")])
        session_b = _make_session(tools=[_mock_tool("mcp_srv_b__tool_b")])

        client = MCPClient(server_urls=["http://a", "http://b"])

        async def fake_get_session(url):
            return session_a if url == "http://a" else session_b

        client._get_session = AsyncMock(side_effect=fake_get_session)
        _setup_connection(client, "http://a", "srv_a")
        _setup_connection(client, "http://b", "srv_b")

        tools = await client.discover_tools()

        assert len(tools) == 2
        names = {t["function"]["name"] for t in tools}
        assert names == {"mcp_srv_a__tool_a", "mcp_srv_b__tool_b"}
        assert client._tool_to_server["mcp_srv_a__tool_a"] == "http://a"
        assert client._tool_to_server["mcp_srv_b__tool_b"] == "http://b"


# ---------------------------------------------------------------------------
# 3. TestGetSession
# ---------------------------------------------------------------------------


class TestGetSession:
    async def test_session_creation(self):
        """_get_session creates a new connection when none exists."""
        client = MCPClient(server_urls=["http://srv"])

        mock_session = _make_session()
        mock_conn = MagicMock(spec=_ServerConnection)
        mock_conn.session = mock_session
        mock_conn.connect = AsyncMock(return_value=mock_session)

        with patch("app.services.providers.mcp._ServerConnection", return_value=mock_conn):
            session = await client._get_session("http://srv")

        assert session is mock_session
        mock_conn.connect.assert_awaited_once()
        assert client._connections["http://srv"] is mock_conn

    async def test_session_reuse(self):
        """_get_session returns the existing session if already connected."""
        client = MCPClient(server_urls=["http://srv"])

        mock_session = _make_session()
        mock_conn = MagicMock(spec=_ServerConnection)
        mock_conn.session = mock_session
        mock_conn.connect = AsyncMock()

        client._connections["http://srv"] = mock_conn

        session = await client._get_session("http://srv")

        assert session is mock_session
        mock_conn.connect.assert_not_awaited()

    async def test_reconnection_after_session_lost(self):
        """_get_session reconnects when connection exists but session is None."""
        client = MCPClient(server_urls=["http://srv"])

        old_conn = MagicMock(spec=_ServerConnection)
        old_conn.session = None  # session was lost
        old_conn.close = AsyncMock()
        client._connections["http://srv"] = old_conn

        new_session = _make_session()
        new_conn = MagicMock(spec=_ServerConnection)
        new_conn.session = new_session
        new_conn.connect = AsyncMock(return_value=new_session)

        with patch("app.services.providers.mcp._ServerConnection", return_value=new_conn):
            session = await client._get_session("http://srv")

        old_conn.close.assert_awaited_once()
        new_conn.connect.assert_awaited_once()
        assert session is new_session


# ---------------------------------------------------------------------------
# 4. TestCallTool (was 3)
# ---------------------------------------------------------------------------


class TestCallTool:
    async def test_normal_call(self):
        """call_tool dispatches with the tool name as-is."""
        client = MCPClient(server_urls=["http://srv"])
        session = _make_session(call_result=_mock_call_result("hello world"))
        client._get_session = AsyncMock(return_value=session)
        client._tool_to_server["mcp_filesystem__read"] = "http://srv"

        result = await client.call_tool("mcp_filesystem__read", {"path": "/tmp"})

        assert result == "hello world"
        session.call_tool.assert_awaited_once_with(
            "mcp_filesystem__read", {"path": "/tmp"}, meta=None
        )

    async def test_tool_not_found(self):
        client = MCPClient(server_urls=["http://srv"])

        result = await client.call_tool("nonexistent", {})

        assert "not found" in result
        assert "nonexistent" in result

    async def test_failure_returns_retry_hint(self):
        """On failure, returns error with retry guidance for the LLM."""
        client = MCPClient(server_urls=["http://srv"])
        client._tool_to_server["flaky"] = "http://srv"

        fail_session = AsyncMock()
        fail_session.call_tool.side_effect = ConnectionError("connection lost")

        client._get_session = AsyncMock(return_value=fail_session)
        client._disconnect_server = AsyncMock()

        result = await client.call_tool("flaky", {})

        assert "Error calling flaky:" in result
        assert "connection lost" in result
        assert "retry" in result.lower()
        client._disconnect_server.assert_called_once()

    async def test_extract_text_multiple_parts(self):
        result = MagicMock()
        c1 = MagicMock()
        c1.text = "part one"
        c2 = MagicMock()
        c2.text = "part two"
        result.content = [c1, c2]

        assert MCPClient._extract_text(result) == "part one\npart two"

    async def test_extract_text_no_text(self):
        result = MagicMock()
        content_item = MagicMock(spec=[])  # no .text attribute
        result.content = [content_item]

        assert MCPClient._extract_text(result) == "(no output)"


# ---------------------------------------------------------------------------
# 4. TestIsServerTool
# ---------------------------------------------------------------------------


class TestIsServerTool:
    async def test_known_tool(self):
        client = MCPClient(server_urls=["http://srv"])
        session = _make_session(tools=[_mock_tool("mcp_web__fetch")])
        client._get_session = AsyncMock(return_value=session)
        _setup_connection(client, "http://srv", "web")
        await client.discover_tools()

        assert client.is_server_tool("mcp_web__fetch") is True
        assert client.is_server_tool("fetch") is False

    async def test_unknown_tool(self):
        client = MCPClient(server_urls=["http://srv"])
        session = _make_session(tools=[_mock_tool("mcp_web__fetch")])
        client._get_session = AsyncMock(return_value=session)
        _setup_connection(client, "http://srv", "web")
        await client.discover_tools()

        assert client.is_server_tool("unknown_tool") is False

    async def test_before_discovery(self):
        client = MCPClient(server_urls=["http://srv"])

        assert client.is_server_tool("mcp_web__fetch") is False


# ---------------------------------------------------------------------------
# 5. TestInvalidateCache
# ---------------------------------------------------------------------------


class TestInvalidateCache:
    async def test_resets_timestamp(self):
        client = MCPClient(server_urls=["http://srv"])
        session = _make_session()
        client._get_session = AsyncMock(return_value=session)
        _setup_connection(client, "http://srv")

        await client.discover_tools()
        assert client._cache_timestamp > 0

        client.invalidate_cache()

        assert client._cache_timestamp == 0

    async def test_invalidate_triggers_rediscovery(self):
        client = MCPClient(server_urls=["http://srv"])
        session = _make_session()
        client._get_session = AsyncMock(return_value=session)
        _setup_connection(client, "http://srv")

        await client.discover_tools()
        client.invalidate_cache()
        await client.discover_tools()

        assert session.list_tools.await_count == 2


# ---------------------------------------------------------------------------
# 6. TestClose
# ---------------------------------------------------------------------------


class TestClose:
    async def test_closes_all_connections(self):
        client = MCPClient(server_urls=["http://a", "http://b"])
        client._disconnect_server = AsyncMock()
        client._connections = {"http://a": MagicMock(), "http://b": MagicMock()}

        await client.close()

        assert client._disconnect_server.await_count == 2
        client._disconnect_server.assert_any_await("http://a")
        client._disconnect_server.assert_any_await("http://b")

    async def test_double_close_safe(self):
        client = MCPClient(server_urls=["http://srv"])
        client._disconnect_server = AsyncMock()
        client._connections = {"http://srv": MagicMock()}

        await client.close()
        await client.close()  # second close should not raise


# ---------------------------------------------------------------------------
# 7. TestAsyncContextManager
# ---------------------------------------------------------------------------


class TestAsyncContextManager:
    async def test_aenter_returns_self(self):
        client = MCPClient(server_urls=["http://srv"])

        result = await client.__aenter__()

        assert result is client

    async def test_aexit_calls_close(self):
        client = MCPClient(server_urls=["http://srv"])
        client.close = AsyncMock()

        await client.__aexit__(None, None, None)

        client.close.assert_awaited_once()

    async def test_context_manager_protocol(self):
        client = MCPClient(server_urls=["http://srv"])
        client.close = AsyncMock()

        async with client as ctx:
            assert ctx is client

        client.close.assert_awaited_once()


# ---------------------------------------------------------------------------
# 8. TestServerToolNamesProperty
# ---------------------------------------------------------------------------


class TestServerToolNamesProperty:
    async def test_returns_set(self):
        client = MCPClient(server_urls=["http://srv"])
        session = _make_session(tools=[_mock_tool("mcp_test__a"), _mock_tool("mcp_test__b")])
        client._get_session = AsyncMock(return_value=session)
        _setup_connection(client, "http://srv", "test")
        await client.discover_tools()

        assert client.server_tool_names == {"mcp_test__a", "mcp_test__b"}


# ---------------------------------------------------------------------------
# 9. TestClassifyToolCalls
# ---------------------------------------------------------------------------


class TestClassifyToolCalls:
    def test_2way_classification(self):
        """Correctly splits tool calls into client and server."""
        client = MCPClient(server_urls=["http://srv"])
        client._approval_required_tools = {"web_search", "web_fetch"}
        tool_calls = [
            ToolCallInfo(name="ask_question", args={}, id="c1"),
            ToolCallInfo(name="web_search", args={"query": "q"}, id="c2"),
            ToolCallInfo(name="calculator", args={}, id="c3"),
        ]

        client_calls, server_calls = client.classify_tool_calls(
            tool_calls,
            "s1",
            client_tool_names={"ask_question"},
        )

        assert [tc.name for tc in client_calls] == ["ask_question"]
        assert [tc.name for tc in server_calls] == ["web_search", "calculator"]

    def test_needs_approval(self):
        """needs_approval checks approval state per session."""
        client = MCPClient(server_urls=["http://srv"])
        client._approval_required_tools = {"web_search", "web_fetch"}

        assert client.needs_approval("web_search", "s1") is True
        assert client.needs_approval("calculator", "s1") is False

        # Auto-approved tools skip approval
        client._auto_approved_tools["s1"] = {"web_search"}
        assert client.needs_approval("web_search", "s1") is False


# ---------------------------------------------------------------------------
# 10. TestRequestApproval
# ---------------------------------------------------------------------------


class TestRequestApproval:
    def test_stores_pending_and_returns_question(self):
        """request_approval saves pending state and returns question payload."""
        client = MCPClient(server_urls=["http://srv"])
        client._approval_required_tools = {"web_search"}
        server_calls = [
            ToolCallInfo(name="web_search", args={"query": "q"}, id="c1"),
            ToolCallInfo(name="calculator", args={}, id="c2"),
        ]

        info = client.request_approval(server_calls, "s1", None, [])

        assert "approval_call_id" in info
        assert "question" in info
        assert "web_search" in info["question"]["question"]
        choice_labels = [c["label"] for c in info["question"]["choices"]]
        assert ApprovalChoice.ALLOW_ONCE.value in choice_labels
        # Pending state was stored
        assert "s1" in client._pending_tool_calls
        pending = client._pending_tool_calls["s1"]
        assert len(pending["tool_calls"]) == 2  # all server calls


# ---------------------------------------------------------------------------
# 11. TestHandleApprovalResponse
# ---------------------------------------------------------------------------


class TestHandleApprovalResponse:
    def test_allow_once(self):
        """'Allow Once' returns allow_once decision and does not auto-approve."""
        client = MCPClient(server_urls=["http://srv"])
        client._pending_tool_calls["s1"] = {
            "approval_call_id": "ask_1",
            "tool_calls": [ToolCallInfo(name="web_search", args={"query": "q"}, id="c1")],
            "usage": None,
            "input_messages": [],
        }
        messages = [
            Message(
                role=MessageRole.TOOL,
                content=ApprovalChoice.ALLOW_ONCE,
                tool_call_id="ask_1",
            )
        ]

        result = client.handle_approval_response("s1", messages)

        assert result is not None
        assert result["decision"] == "allow_once"
        assert len(result["tool_calls"]) == 1
        assert "s1" not in client._auto_approved_tools
        assert "s1" not in client._pending_tool_calls

    def test_always_allow(self):
        """'Always Allow' returns always_allow decision and adds to auto_approved."""
        client = MCPClient(server_urls=["http://srv"])
        client._approval_required_tools = {"web_search", "web_fetch"}
        client._pending_tool_calls["s1"] = {
            "approval_call_id": "ask_2",
            "tool_calls": [ToolCallInfo(name="web_search", args={"query": "q"}, id="c1")],
            "usage": None,
            "input_messages": [],
        }
        messages = [
            Message(
                role=MessageRole.TOOL,
                content=ApprovalChoice.ALWAYS_ALLOW,
                tool_call_id="ask_2",
            )
        ]

        result = client.handle_approval_response("s1", messages)

        assert result["decision"] == "always_allow"
        assert "web_search" in client._auto_approved_tools["s1"]

    def test_deny(self):
        """'Deny' returns deny decision."""
        client = MCPClient(server_urls=["http://srv"])
        client._pending_tool_calls["s1"] = {
            "approval_call_id": "ask_3",
            "tool_calls": [ToolCallInfo(name="web_search", args={"query": "q"}, id="c1")],
            "usage": None,
            "input_messages": [],
        }
        messages = [
            Message(role=MessageRole.TOOL, content=ApprovalChoice.DENY, tool_call_id="ask_3")
        ]

        result = client.handle_approval_response("s1", messages)

        assert result["decision"] == "deny"

    def test_no_pending(self):
        """Returns None when no pending state exists."""
        client = MCPClient(server_urls=["http://srv"])
        messages = [
            Message(
                role=MessageRole.TOOL,
                content=ApprovalChoice.ALLOW_ONCE,
                tool_call_id="ask_1",
            )
        ]

        result = client.handle_approval_response("s1", messages)

        assert result is None

    def test_no_answer_restores_pending(self):
        """When no matching answer is found, pending state is restored."""
        client = MCPClient(server_urls=["http://srv"])
        client._pending_tool_calls["s1"] = {
            "approval_call_id": "ask_1",
            "tool_calls": [ToolCallInfo(name="web_search", args={}, id="c1")],
            "usage": None,
            "input_messages": [],
        }
        messages = [Message(role=MessageRole.USER, content="hello")]

        result = client.handle_approval_response("s1", messages)

        assert result is None
        assert "s1" in client._pending_tool_calls

    def test_filtered_messages(self):
        """Approval answer message is removed from filtered_messages."""
        client = MCPClient(server_urls=["http://srv"])
        client._pending_tool_calls["s1"] = {
            "approval_call_id": "ask_1",
            "tool_calls": [ToolCallInfo(name="web_search", args={}, id="c1")],
            "usage": None,
            "input_messages": [],
        }
        messages = [
            Message(role=MessageRole.USER, content="hello"),
            Message(
                role=MessageRole.TOOL,
                content=ApprovalChoice.ALLOW_ONCE,
                tool_call_id="ask_1",
            ),
        ]

        result = client.handle_approval_response("s1", messages)

        assert len(result["filtered_messages"]) == 1
        assert result["filtered_messages"][0].content == "hello"


# ---------------------------------------------------------------------------
# 12. TestBuildChainedCalls — moved to tests/test_tool_chain.py
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# 13. TestApprovalLifecycle — discovery → classify → approval → auto-approve
# ---------------------------------------------------------------------------


class TestApprovalLifecycle:
    """End-to-end: requires_approval meta → classify → user response → future calls."""

    async def test_allow_once_still_requires_approval_next_time(self):
        """Allow Once executes the tool but does NOT auto-approve future calls."""
        client = MCPClient(server_urls=["http://srv"])
        session = _make_session(
            tools=[
                _mock_tool("mcp_web__search", meta={"requires_approval": True}),
                _mock_tool("mcp_web__calculator"),
            ]
        )
        client._get_session = AsyncMock(return_value=session)
        _setup_connection(client, "http://srv", "web")
        await client.discover_tools()

        ws = "mcp_web__search"

        # 1) First call: web_search classified as approval-required
        tc = [ToolCallInfo(name=ws, args={"query": "q"}, id="c1")]
        _, server_calls = client.classify_tool_calls(tc, "s1")
        assert client.needs_approval(ws, "s1") is True

        # 2) User responds "Allow Once"
        info = client.request_approval(server_calls, "s1", None, [])
        messages = [
            Message(
                role=MessageRole.TOOL,
                content=ApprovalChoice.ALLOW_ONCE,
                tool_call_id=info["approval_call_id"],
            )
        ]
        result = client.handle_approval_response("s1", messages)
        assert result["decision"] == ApprovalChoice.ALLOW_ONCE.decision

        # 3) Next call: web_search STILL requires approval
        assert client.needs_approval(ws, "s1") is True

    async def test_always_allow_skips_approval_on_next_call(self):
        """Always Allow auto-approves the tool for all future calls in the session."""
        client = MCPClient(server_urls=["http://srv"])
        session = _make_session(
            tools=[
                _mock_tool("mcp_web__search", meta={"requires_approval": True}),
                _mock_tool("mcp_web__calculator"),
            ]
        )
        client._get_session = AsyncMock(return_value=session)
        _setup_connection(client, "http://srv", "web")
        await client.discover_tools()

        ws = "mcp_web__search"

        # 1) First call: web_search classified as approval-required
        tc = [ToolCallInfo(name=ws, args={"query": "q"}, id="c1")]
        _, server_calls = client.classify_tool_calls(tc, "s1")
        assert client.needs_approval(ws, "s1") is True

        # 2) User responds "Always Allow"
        info = client.request_approval(server_calls, "s1", None, [])
        messages = [
            Message(
                role=MessageRole.TOOL,
                content=ApprovalChoice.ALWAYS_ALLOW,
                tool_call_id=info["approval_call_id"],
            )
        ]
        result = client.handle_approval_response("s1", messages)
        assert result["decision"] == ApprovalChoice.ALWAYS_ALLOW.decision
        assert ws in client._auto_approved_tools["s1"]

        # 3) Next call: web_search no longer needs approval
        assert client.needs_approval(ws, "s1") is False

    async def test_deny_does_not_auto_approve(self):
        """Deny does not add tool to auto-approved; next call still requires approval."""
        client = MCPClient(server_urls=["http://srv"])
        session = _make_session(
            tools=[
                _mock_tool("mcp_web__search", meta={"requires_approval": True}),
            ]
        )
        client._get_session = AsyncMock(return_value=session)
        _setup_connection(client, "http://srv", "web")
        await client.discover_tools()

        ws = "mcp_web__search"
        tc = [ToolCallInfo(name=ws, args={"query": "q"}, id="c1")]
        _, server_calls = client.classify_tool_calls(tc, "s1")
        info = client.request_approval(server_calls, "s1", None, [])
        messages = [
            Message(
                role=MessageRole.TOOL,
                content=ApprovalChoice.DENY,
                tool_call_id=info["approval_call_id"],
            )
        ]
        result = client.handle_approval_response("s1", messages)
        assert result["decision"] == ApprovalChoice.DENY.decision

        # Next call: still requires approval
        assert client.needs_approval(ws, "s1") is True

    async def test_tool_without_meta_never_requires_approval(self):
        """Tools without requires_approval meta always go to auto."""
        client = MCPClient(server_urls=["http://srv"])
        session = _make_session(
            tools=[
                _mock_tool("calculator"),
                _mock_tool("mcp_web__search", meta={"requires_approval": True}),
            ]
        )
        client._get_session = AsyncMock(return_value=session)
        _setup_connection(client, "http://srv", "web")
        await client.discover_tools()

        calc = "mcp_web__calculator"
        ws = "mcp_web__search"
        tc = [
            ToolCallInfo(name=calc, args={}, id="c1"),
            ToolCallInfo(name=ws, args={"query": "q"}, id="c2"),
        ]
        client_calls, server_calls = client.classify_tool_calls(tc, "s1")
        assert client_calls == []
        assert [t.name for t in server_calls] == [calc, ws]
        assert client.needs_approval(calc, "s1") is False
        assert client.needs_approval(ws, "s1") is True

    async def test_always_allow_is_per_session(self):
        """Auto-approval for session s1 does not affect session s2."""
        client = MCPClient(server_urls=["http://srv"])
        session = _make_session(
            tools=[
                _mock_tool("mcp_web__search", meta={"requires_approval": True}),
            ]
        )
        client._get_session = AsyncMock(return_value=session)
        _setup_connection(client, "http://srv", "web")
        await client.discover_tools()

        ws = "mcp_web__search"

        # Auto-approve in s1
        client._auto_approved_tools["s1"] = {ws}

        # s1: skips approval (auto-approved)
        assert client.needs_approval(ws, "s1") is False

        # s2: still requires approval
        assert client.needs_approval(ws, "s2") is True


# ---------------------------------------------------------------------------
# 15. TestClearSessionState
# ---------------------------------------------------------------------------


class TestClearSessionState:
    def test_clears_pending_and_auto(self):
        """clear_session_state removes both pending and auto-approved state."""
        client = MCPClient(server_urls=["http://srv"])
        client._pending_tool_calls["s1"] = {"approval_call_id": "x", "tool_calls": []}
        client._auto_approved_tools["s1"] = {"web_search"}

        client.clear_session_state("s1")

        assert "s1" not in client._pending_tool_calls
        assert "s1" not in client._auto_approved_tools

    def test_clear_nonexistent_session_safe(self):
        """Clearing a non-existent session does not raise."""
        client = MCPClient(server_urls=["http://srv"])
        client.clear_session_state("nonexistent")  # should not raise


# ---------------------------------------------------------------------------
# 16. TestToolNamespacing
# ---------------------------------------------------------------------------


class TestToolPassthrough:
    """Tests for source-side tool naming — names pass through unchanged."""

    async def test_discover_then_call_passthrough(self):
        """Full flow: discover → call_tool passes the name through unchanged."""
        client = MCPClient(server_urls=["http://srv"])
        session = _make_session(
            tools=[_mock_tool("mcp_filesystem__read", "Read a file")],
            call_result=_mock_call_result("file content"),
        )
        client._get_session = AsyncMock(return_value=session)
        _setup_connection(client, "http://srv", "filesystem")

        await client.discover_tools()

        assert client.is_server_tool("mcp_filesystem__read")

        result = await client.call_tool("mcp_filesystem__read", {"path": "/tmp/x"})
        assert result == "file content"
        session.call_tool.assert_awaited_once_with(
            "mcp_filesystem__read", {"path": "/tmp/x"}, meta=None
        )

    async def test_distinct_names_from_different_servers(self):
        """Two servers register tools with their own namespaced names."""
        client = MCPClient(server_urls=["http://a", "http://b"])
        session_a = _make_session(tools=[_mock_tool("mcp_filesystem__read")])
        session_b = _make_session(tools=[_mock_tool("mcp_cloud__read")])

        async def fake_get_session(url):
            return session_a if url == "http://a" else session_b

        client._get_session = AsyncMock(side_effect=fake_get_session)
        _setup_connection(client, "http://a", "filesystem")
        _setup_connection(client, "http://b", "cloud")

        tools = await client.discover_tools()

        names = {t["function"]["name"] for t in tools}
        assert names == {"mcp_filesystem__read", "mcp_cloud__read"}
