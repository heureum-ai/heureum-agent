# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Web domain tools: fetch, search."""

from mcp.server.fastmcp import FastMCP

# from src.tools.web.fetch import register_web_fetch
from src.tools.web.search import register_web_search
from src.tools.web.tavily import register_tavily_search
from src.config import settings


def register_web_tools(mcp: FastMCP) -> None:
    """Register all web-domain tools with the MCP server.

    Args:
        mcp (FastMCP): The MCP server instance to register tools with.
    """
    register_tavily_search(mcp)
    # register_web_search(mcp)
    # register_web_fetch(mcp)
