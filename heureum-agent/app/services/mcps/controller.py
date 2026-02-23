# Copyright (c) 2026 Heureum AI. All rights reserved.

"""MCP client controller for server-side tool discovery and invocation."""

import asyncio
import logging
import time
from typing import Any, Dict, List, Optional, Set, Tuple

from app.config import settings
from app.services.tools import ToolChainRegistry, gen_tool_call_id
from langchain_core.messages import BaseMessage

from app.models import ToolCallInfo
from app.services.mcps.approval import (
    ApprovalState,
    classify_tool_calls,
    clear_session_state,
    extract_approval_answer,
    format_approval_question,
    handle_approval_response,
    needs_approval,
    request_approval,
)
from app.services.mcps.connection import ServerConnection
from app.services.mcps.discovery import (
    append_discovered_tool,
    collect_discovery_metadata,
    register_pending_chains,
)
from app.services.mcps.text import extract_text_content
from app.services.prompts.base import NO_OUTPUT
from mcp import ClientSession

logger = logging.getLogger(__name__)


class MCPClientController:
    """Async MCP client that manages multi-server discovery and tool calls."""

    _ServerConnection = ServerConnection

    @staticmethod
    def _gen_call_id() -> str:
        return gen_tool_call_id()

    def __init__(
        self,
        server_urls: Optional[List[str]] = None,
        chain_registry: Optional[ToolChainRegistry] = None,
    ) -> None:
        self._server_urls = server_urls or settings.get_mcp_server_urls()
        self._connections: Dict[str, ServerConnection] = {}
        self._server_tool_names: Set[str] = set()
        self._tool_to_server: Dict[str, str] = {}
        self._available_tools: List[Dict[str, Any]] = []
        self._cache_timestamp: float = 0
        self._chain_registry = chain_registry
        self._approval = ApprovalState()

    @property
    def _approval_required_tools(self) -> Set[str]:
        return self._approval.approval_required_tools

    @property
    def _display_names(self) -> Dict[str, str]:
        return self._approval.display_names

    async def _get_session(self, server_url: str) -> ClientSession:
        connection = self._connections.get(server_url)
        if connection and connection.session:
            return connection.session

        if connection:
            await connection.close()

        last_error: BaseException | None = None
        for attempt in range(settings.MCP_CONNECT_MAX_RETRIES + 1):
            try:
                connection = self._ServerConnection(url=server_url)
                self._connections[server_url] = connection
                await connection.connect()
                logger.info("Established MCP connection to %s", server_url)
                return connection.session
            except BaseException as e:
                last_error = e
                logger.warning(
                    "MCP connection attempt %d/%d to %s failed: %s",
                    attempt + 1,
                    settings.MCP_CONNECT_MAX_RETRIES + 1,
                    server_url,
                    e,
                )
                try:
                    await connection.close()
                except Exception:
                    pass
                self._connections.pop(server_url, None)

                if attempt < settings.MCP_CONNECT_MAX_RETRIES:
                    delay = settings.MCP_CONNECT_RETRY_DELAY * (2 ** attempt)
                    await asyncio.sleep(delay)

        raise last_error

    async def _disconnect_server(self, server_url: str) -> None:
        connection = self._connections.pop(server_url, None)
        if connection:
            try:
                await connection.close()
            except Exception:
                pass

    async def discover_tools(self) -> List[Dict[str, Any]]:
        now = time.monotonic()
        if self._available_tools and (now - self._cache_timestamp) < settings.TOOL_CACHE_TTL:
            return self._available_tools

        self._available_tools.clear()
        self._server_tool_names.clear()
        self._tool_to_server.clear()
        if self._chain_registry:
            self._chain_registry.clear()
        self._approval.clear()

        pending_chains: List[Tuple[str, list]] = []

        for server_url in self._server_urls:
            try:
                session = await self._get_session(server_url)
                response = await session.list_tools()

                for tool in response.tools:
                    tool_name = append_discovered_tool(
                        tool=tool,
                        server_url=server_url,
                        available_tools=self._available_tools,
                        server_tool_names=self._server_tool_names,
                        tool_to_server=self._tool_to_server,
                    )
                    collect_discovery_metadata(
                        tool=tool,
                        tool_name=tool_name,
                        pending_chains=pending_chains,
                        approval_required_tools=self._approval.approval_required_tools,
                        display_names=self._approval.display_names,
                        has_chain_registry=self._chain_registry is not None,
                    )

                logger.info(
                    "Discovered %d tools from MCP server %s: %s",
                    len(response.tools),
                    server_url,
                    [tool.name for tool in response.tools],
                )

            except BaseException as error:
                # BaseException catches CancelledError (Python 3.9+) which
                # can leak from anyio cancel scopes inside streamablehttp_client.
                logger.warning("MCP server unavailable at %s: %s", server_url, error)
                await self._disconnect_server(server_url)

        register_pending_chains(
            chain_registry=self._chain_registry,
            pending_chains=pending_chains,
        )
        if self._approval.approval_required_tools:
            logger.info("Approval-required tools: %s", self._approval.approval_required_tools)

        self._cache_timestamp = now
        return self._available_tools

    async def call_tool(self, name: str, arguments: Dict[str, Any], session_id: str = "") -> str:
        server_url = self._tool_to_server.get(name)
        if not server_url:
            return f"Error: tool '{name}' not found on any MCP server"

        meta = None
        if session_id:
            meta = {
                "session_id": session_id,
                "platform_api_url": settings.PLATFORM_API_URL,
            }

        try:
            session = await self._get_session(server_url)
            result = await session.call_tool(name, arguments, meta=meta)
            return self._extract_text(result)
        except BaseException as error:
            logger.warning("Tool call failed (%s on %s): %s", name, server_url, error)
            await self._disconnect_server(server_url)
            return (
                f"Error calling {name}: {error}. "
                "The tool call failed — you may retry with the same or modified arguments."
            )

    @staticmethod
    def _extract_text(result: Any) -> str:
        return extract_text_content(result, NO_OUTPUT)

    def is_server_tool(self, tool_name: str) -> bool:
        return tool_name in self._server_tool_names

    def invalidate_cache(self) -> None:
        self._cache_timestamp = 0

    async def close(self) -> None:
        for server_url in list(self._connections):
            await self._disconnect_server(server_url)

    @property
    def server_tool_names(self) -> Set[str]:
        return self._server_tool_names

    @property
    def display_names(self) -> Dict[str, str]:
        return dict(self._approval.display_names)

    def needs_approval(self, tool_name: str, session_id: str) -> bool:
        return needs_approval(
            tool_name=tool_name,
            session_id=session_id,
            state=self._approval,
        )

    def classify_tool_calls(
        self,
        tool_calls: List[ToolCallInfo],
        client_tool_names: Set[str] | None = None,
    ) -> Tuple[List[ToolCallInfo], List[ToolCallInfo]]:
        return classify_tool_calls(
            tool_calls=tool_calls,
            client_tool_names=client_tool_names,
        )

    def request_approval(
        self,
        server_calls: List[ToolCallInfo],
        session_id: str,
        usage: Any,
        input_messages: List[BaseMessage],
        assistant_lc_message: Any = None,
        remaining_chained: Optional[List[ToolCallInfo]] = None,
    ) -> Dict[str, Any]:
        return request_approval(
            server_calls=server_calls,
            session_id=session_id,
            usage=usage,
            input_messages=input_messages,
            assistant_lc_message=assistant_lc_message,
            remaining_chained=remaining_chained,
            state=self._approval,
            gen_call_id=self._gen_call_id,
        )

    def handle_approval_response(
        self, session_id: str, messages: List[BaseMessage]
    ) -> Optional[Dict[str, Any]]:
        return handle_approval_response(
            session_id=session_id,
            messages=messages,
            state=self._approval,
        )

    def has_pending_approval(self, session_id: str) -> bool:
        """Check if a session has pending tool approval requests."""
        return bool(self._approval.pending_tool_calls.get(session_id))

    def clear_session_state(self, session_id: str) -> None:
        clear_session_state(
            session_id=session_id,
            state=self._approval,
        )

    @staticmethod
    def _format_approval_question(tool_calls: List[ToolCallInfo]) -> dict:
        return format_approval_question(tool_calls)

    @staticmethod
    def _extract_approval_answer(
        messages: List[BaseMessage], approval_call_id: str
    ) -> Optional[str]:
        return extract_approval_answer(messages, approval_call_id)

    async def __aenter__(self) -> "MCPClientController":
        return self

    async def __aexit__(self, *exc: Any) -> None:
        await self.close()
