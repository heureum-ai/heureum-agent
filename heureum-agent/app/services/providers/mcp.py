# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
MCP Client for connecting to MCP servers.

Discovers tools dynamically from configured MCP server URLs.
Uses streamable-http transport for FastMCP 2025-03-26 servers.
"""

import json
import logging
import re
import time
import uuid
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set, Tuple

from app.config import ApprovalChoice, settings
from app.services.prompts.base import NO_OUTPUT
from app.services.providers.tool import ChainRule, ChainStep, ToolChainRegistry
from app.models import Message, ToolCallInfo
from app.schemas.open_responses import MessageRole
from mcp import ClientSession
from mcp.client.streamable_http import streamablehttp_client

logger = logging.getLogger(__name__)


def _gen_call_id() -> str:
    """Generate a unique tool call ID."""
    return f"call_{uuid.uuid4().hex[:16]}"


@dataclass
class _ServerConnection:
    """Holds a persistent streamable-http connection and MCP session."""

    url: str
    _exit_stack: AsyncExitStack = field(default_factory=AsyncExitStack)
    session: Optional[ClientSession] = None
    server_name: str = ""

    async def connect(self) -> ClientSession:
        """Establish streamable-http connection and initialize MCP session.

        Returns:
            ClientSession: The initialized MCP client session.
        """
        read, write, _ = await self._exit_stack.enter_async_context(
            streamablehttp_client(f"{self.url}/mcp")
        )
        session = await self._exit_stack.enter_async_context(ClientSession(read, write))
        init_result = await session.initialize()
        self.session = session
        # Capture server name from MCP protocol for tool namespacing.
        server_info = getattr(init_result, "serverInfo", None) or getattr(
            init_result, "server_info", None
        )
        if server_info:
            self.server_name = getattr(server_info, "name", "") or ""
        return session

    async def close(self) -> None:
        """Close the connection and clean up resources."""
        self.session = None
        await self._exit_stack.aclose()
        self._exit_stack = AsyncExitStack()


class MCPClient:
    """Async MCP client that connects to MCP servers via SSE.

    Supports multiple MCP server URLs. Tools are discovered dynamically
    from each server. Persistent SSE connections are maintained and reused.

    Usage:
        async with MCPClient() as client:
            tools = await client.discover_tools()
            result = await client.call_tool("web_fetch", {"url": "https://example.com"})
    """

    def __init__(
        self,
        server_urls: Optional[List[str]] = None,
        chain_registry: Optional[ToolChainRegistry] = None,
    ) -> None:
        """Initialize the MCP client.

        Args:
            server_urls (Optional[List[str]]): List of MCP server base URLs.
                Defaults to ``settings.get_mcp_server_urls()`` if not provided.
            chain_registry (Optional[ToolChainRegistry]): Shared registry for
                tool chain rules. MCP chain metadata is registered here during
                discovery. If None, chain rules from MCP metadata are ignored.
        """
        self._server_urls = server_urls or settings.get_mcp_server_urls()
        self._connections: Dict[str, _ServerConnection] = {}
        self._server_tool_names: Set[str] = set()
        self._tool_to_server: Dict[str, str] = {}  # namespaced_name -> server_url
        self._original_names: Dict[str, str] = {}  # namespaced_name -> original_name
        self._available_tools: List[Dict[str, Any]] = []
        self._cache_timestamp: float = 0
        self._chain_registry = chain_registry
        self._approval_required_tools: Set[str] = set()  # from MCP meta
        self._display_names: Dict[str, str] = {}
        self._pending_tool_calls: Dict[str, Dict[str, Any]] = {}
        self._auto_approved_tools: Dict[str, Set[str]] = {}

    async def _get_session(self, server_url: str) -> ClientSession:
        """Get or create a persistent session for a server URL.

        Args:
            server_url (str): The MCP server base URL.

        Returns:
            ClientSession: An active MCP session for the server.
        """
        conn = self._connections.get(server_url)
        if conn and conn.session:
            return conn.session

        if conn:
            await conn.close()

        conn = _ServerConnection(url=server_url)
        self._connections[server_url] = conn
        await conn.connect()
        logger.info("Established persistent SSE connection to %s", server_url)
        return conn.session

    async def _disconnect_server(self, server_url: str) -> None:
        """Close and remove connection for a server.

        Args:
            server_url (str): The MCP server base URL to disconnect.
        """
        conn = self._connections.pop(server_url, None)
        if conn:
            try:
                await conn.close()
            except Exception:
                pass

    @staticmethod
    def _sanitize_server_name(name: str) -> str:
        """Sanitize an MCP server name for use as a tool namespace.

        Replaces non-alphanumeric characters with underscores and strips
        leading/trailing underscores.

        Args:
            name (str): Raw server name from MCP ``initialize()``.

        Returns:
            str: Sanitized name safe for ``[a-zA-Z0-9_]`` tool name patterns.
        """
        return re.sub(r"[^a-zA-Z0-9]", "_", name).strip("_") or "unknown"

    def _namespace_tool(self, server_url: str, tool_name: str) -> str:
        """Generate a namespaced tool name: ``mcp_{server}_{tool}``.

        Uses the server name captured from MCP ``initialize()`` during
        connection setup.

        Args:
            server_url (str): The MCP server base URL.
            tool_name (str): The original tool name from the MCP server.

        Returns:
            str: Namespaced tool name, e.g. ``mcp_filesystem_read``.
        """
        conn = self._connections.get(server_url)
        raw = conn.server_name if conn else ""
        ns = self._sanitize_server_name(raw) if raw else "unknown"
        return f"mcp_{ns}__{tool_name}"

    async def discover_tools(self) -> List[Dict[str, Any]]:
        """Discover tools from all configured MCP servers.

        Tool names are namespaced as ``mcp_{server}_{tool}`` to prevent
        collisions with client-provided tools that share the same name
        (e.g. both client and MCP server providing ``read``).

        Returns cached results if available and not expired.

        Returns:
            List[Dict[str, Any]]: List of OpenAI-compatible tool schema dicts,
                each containing a ``function`` key with ``name``,
                ``description``, and ``parameters``.
        """
        now = time.monotonic()
        if self._available_tools and (now - self._cache_timestamp) < settings.TOOL_CACHE_TTL:
            return self._available_tools

        self._available_tools.clear()
        self._server_tool_names.clear()
        self._tool_to_server.clear()
        self._original_names.clear()
        if self._chain_registry:
            self._chain_registry.clear()
        self._approval_required_tools.clear()
        self._display_names.clear()

        # Collect chain metadata for post-discovery registration so that
        # cross-server chain targets can be resolved to namespaced names.
        _pending_chains: List[Tuple[str, list]] = []

        for url in self._server_urls:
            try:
                session = await self._get_session(url)
                response = await session.list_tools()

                for tool in response.tools:
                    namespaced = self._namespace_tool(url, tool.name)

                    self._available_tools.append(
                        {
                            "type": "function",
                            "function": {
                                "name": namespaced,
                                "description": tool.description or "",
                                "parameters": tool.inputSchema,
                            },
                        }
                    )
                    self._server_tool_names.add(namespaced)
                    self._tool_to_server[namespaced] = url
                    self._original_names[namespaced] = tool.name

                    # Collect metadata
                    meta = getattr(tool, "meta", None) or {}
                    chain = meta.get("chain")
                    if isinstance(chain, list) and chain and self._chain_registry:
                        _pending_chains.append((namespaced, chain))
                    if meta.get("requires_approval"):
                        self._approval_required_tools.add(namespaced)
                    display_name = meta.get("display_name")
                    if display_name:
                        self._display_names[namespaced] = display_name

                logger.info(
                    "Discovered %d tools from MCP server %s: %s",
                    len(response.tools),
                    url,
                    [t.name for t in response.tools],
                )

            except Exception as e:
                logger.warning("MCP server unavailable at %s: %s", url, e)
                await self._disconnect_server(url)

        # Register chain rules with namespaced target names.
        if self._chain_registry and _pending_chains:
            orig_to_ns = {v: k for k, v in self._original_names.items()}
            for source_ns, raw_steps in _pending_chains:
                steps = [
                    ChainStep(
                        target=orig_to_ns.get(entry["target"], entry["target"]),
                        extract=entry["extract"],
                        arg_mapping=entry.get("arg_mapping", {}),
                    )
                    for entry in raw_steps
                ]
                self._chain_registry.register(ChainRule(source=source_ns, steps=steps))
            logger.info("Chain rules registered: %s", list(self._chain_registry.rules.keys()))

        if self._approval_required_tools:
            logger.info("Approval-required tools: %s", self._approval_required_tools)

        self._cache_timestamp = now
        return self._available_tools

    async def call_tool(self, name: str, arguments: Dict[str, Any], session_id: str = "", cwd: str = "") -> str:
        """Call a tool on its MCP server and return the result as text.

        ``name`` is the **namespaced** tool name (e.g. ``mcp_filesystem_read``).
        The original MCP tool name is resolved internally before dispatching
        to the server.

        Args:
            name: Namespaced tool name.
            arguments: Tool arguments.
            session_id: Optional session ID. When provided, it is forwarded
                to the MCP server via ``_meta`` so server-side tools can
                scope operations to the session (e.g. save to platform DB).
            cwd: Optional working directory from the user's session.

        On failure, returns an error message that guides the LLM to retry.
        """
        server_url = self._tool_to_server.get(name)
        if not server_url:
            return f"Error: tool '{name}' not found on any MCP server"

        original_name = self._original_names.get(name, name)

        meta = None
        if session_id:
            meta = {"session_id": session_id, "platform_api_url": settings.PLATFORM_API_URL}
            if cwd:
                meta["cwd"] = cwd

        try:
            session = await self._get_session(server_url)
            result = await session.call_tool(original_name, arguments, meta=meta)
            return self._extract_text(result)
        except Exception as e:
            logger.warning("Tool call failed (%s on %s): %s", name, server_url, e)
            await self._disconnect_server(server_url)
            return (
                f"Error calling {name}: {e}. "
                "The tool call failed — you may retry with the same or modified arguments."
            )

    @staticmethod
    def _extract_text(result: Any) -> str:
        """Extract text parts from a CallToolResult.

        Args:
            result (Any): The MCP ``CallToolResult`` containing content
                items.

        Returns:
            str: Concatenated text from all text content parts, or
                ``"(no output)"`` if none found.
        """
        parts = []
        for content in result.content:
            if hasattr(content, "text"):
                parts.append(content.text)
        return "\n".join(parts) if parts else NO_OUTPUT

    def is_server_tool(self, tool_name: str) -> bool:
        """Check if a tool is provided by an MCP server.

        Args:
            tool_name (str): The tool name to look up.

        Returns:
            bool: True if the tool was discovered from an MCP server.
        """
        return tool_name in self._server_tool_names

    def invalidate_cache(self) -> None:
        """Force re-discovery on next call."""
        self._cache_timestamp = 0

    async def close(self) -> None:
        """Close all persistent connections."""
        for url in list(self._connections):
            await self._disconnect_server(url)

    @property
    def server_tool_names(self) -> Set[str]:
        """Set of tool names discovered from MCP servers."""
        return self._server_tool_names

    @property
    def display_names(self) -> Dict[str, str]:
        """Display names extracted from MCP tool metadata."""
        return dict(self._display_names)

    # ------------------------------------------------------------------
    # Tool approval
    # ------------------------------------------------------------------

    def needs_approval(self, tool_name: str, session_id: str) -> bool:
        """Check if a tool still requires approval for this session."""
        pending = self._approval_required_tools - self._auto_approved_tools.get(session_id, set())
        return tool_name in pending

    def classify_tool_calls(
        self, tool_calls: List[ToolCallInfo], session_id: str,
        client_tool_names: Set[str] | None = None,
    ) -> Tuple[List[ToolCallInfo], List[ToolCallInfo]]:
        """2-way classification: (client_calls, server_calls).

        Args:
            tool_calls: All tool calls from the LLM response.
            session_id: Active session identifier.
            client_tool_names: Names of client-side tools (from request).
                Falls back to empty set if not provided.
        """
        names = client_tool_names or set()
        client_calls = [tc for tc in tool_calls if tc.name in names]
        server_calls = [tc for tc in tool_calls if tc.name not in names]
        return client_calls, server_calls

    def request_approval(
        self,
        server_calls: List[ToolCallInfo],
        session_id: str,
        usage: Any,
        input_messages: List[Message],
        assistant_lc_message: Any = None,
        remaining_chained: Optional[List[ToolCallInfo]] = None,
    ) -> Dict[str, Any]:
        """Store pending state and return tool_approval payload.

        Returns:
            {"approval_call_id": str, "question": dict, "display_name": str}
        """
        approval_call_id = _gen_call_id()
        approval_only = [tc for tc in server_calls if self.needs_approval(tc.name, session_id)]
        self._pending_tool_calls[session_id] = {
            "approval_call_id": approval_call_id,
            "tool_calls": server_calls,
            "usage": usage,
            "input_messages": input_messages,
            "assistant_lc_message": assistant_lc_message,
            "remaining_chained": remaining_chained or [],
        }
        # Use the first tool's display_name for the approval UI
        first_tool = approval_only[0] if approval_only else server_calls[0]
        display_name = self._display_names.get(first_tool.name, first_tool.name)
        return {
            "approval_call_id": approval_call_id,
            "question": self._format_approval_question(approval_only),
            "display_name": display_name,
        }

    def handle_approval_response(
        self, session_id: str, messages: List[Message]
    ) -> Optional[Dict[str, Any]]:
        """Restore pending state and parse the approval answer.

        Returns:
            {
                "decision": ApprovalChoice.decision (e.g. "allow_once"),
                "tool_calls": List[ToolCallInfo],
                "filtered_messages": List[Message],
                "usage": Usage|None,
                "input_messages": List[Message],
                "assistant_lc_message": BaseMessage|None,
            } or None if no pending state or no answer found.
        """
        pending = self._pending_tool_calls.pop(session_id, None)
        if not pending:
            return None

        answer = self._extract_approval_answer(messages, pending["approval_call_id"])
        if answer is None:
            # No answer found — restore pending
            self._pending_tool_calls[session_id] = pending
            return None

        filtered = [
            m for m in messages
            if not (m.role == MessageRole.TOOL and m.tool_call_id == pending["approval_call_id"])
        ]

        choice = ApprovalChoice(answer) if answer in ApprovalChoice._value2member_map_ else ApprovalChoice.DENY
        decision = choice.decision

        if choice is ApprovalChoice.ALWAYS_ALLOW:
            auto_set = self._auto_approved_tools.setdefault(session_id, set())
            for tc in pending["tool_calls"]:
                if tc.name in self._approval_required_tools:
                    auto_set.add(tc.name)

        return {
            "decision": decision,
            "tool_calls": pending["tool_calls"],
            "filtered_messages": filtered,
            "usage": pending["usage"],
            "input_messages": pending["input_messages"],
            "assistant_lc_message": pending.get("assistant_lc_message"),
            "remaining_chained": pending.get("remaining_chained", []),
        }

    def clear_session_state(self, session_id: str) -> None:
        """Clean up approval state for a session."""
        self._pending_tool_calls.pop(session_id, None)
        self._auto_approved_tools.pop(session_id, None)

    # ------------------------------------------------------------------
    # Private helpers for approval
    # ------------------------------------------------------------------

    @staticmethod
    def _format_approval_question(tool_calls: List[ToolCallInfo]) -> dict:
        """Build tool_approval arguments describing the tools awaiting approval."""
        if len(tool_calls) == 1:
            tc = tool_calls[0]
            question = f"Allow {tc.name}({json.dumps(tc.args, ensure_ascii=False)})?"
        else:
            lines = [
                f"  - {tc.name}({json.dumps(tc.args, ensure_ascii=False)})"
                for tc in tool_calls
            ]
            question = "Allow the following tool executions?\n" + "\n".join(lines)
        tool_name = tool_calls[0].name if tool_calls else "unknown"
        return {"question": question, "choices": ApprovalChoice.options(), "tool_name": tool_name}

    @staticmethod
    def _extract_approval_answer(
        messages: List[Message], approval_call_id: str
    ) -> Optional[str]:
        """Find the approval answer in incoming messages by matching call_id.

        # TODO: "User chose: " / "User input: " prefix stripping is
        #   hardcoded to match the client format (heureum-frontend api.ts,
        #   heureum-client api.ts). Decouple by having clients send the raw
        #   value directly instead of wrapping it with a display prefix.
        """
        for msg in messages:
            if msg.role == MessageRole.TOOL and msg.tool_call_id == approval_call_id:
                content = msg.content or ""
                if content.startswith("User chose: "):
                    return content[len("User chose: "):]
                if content.startswith("User input: "):
                    return content[len("User input: "):]
                return content
        return None

    async def __aenter__(self) -> "MCPClient":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()
