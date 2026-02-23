# Copyright (c) 2026 Heureum AI. All rights reserved.

"""MCP connection primitives."""

from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from typing import Optional

import httpx
from mcp import ClientSession
from mcp.client.streamable_http import streamable_http_client


@dataclass
class ServerConnection:
    """Holds a persistent streamable-http connection and MCP session."""

    url: str
    _exit_stack: AsyncExitStack = field(default_factory=AsyncExitStack)
    session: Optional[ClientSession] = None
    server_name: str = ""

    async def connect(self) -> ClientSession:
        """Establish streamable-http connection and initialize MCP session."""
        http_client = httpx.AsyncClient(timeout=httpx.Timeout(30.0, connect=10.0))
        read, write, _ = await self._exit_stack.enter_async_context(
            streamable_http_client(f"{self.url}/mcp", http_client=http_client)
        )
        session = await self._exit_stack.enter_async_context(ClientSession(read, write))
        init_result = await session.initialize()
        self.session = session
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
