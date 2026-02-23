# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Server factory and registry."""

from mcp.server.fastmcp import FastMCP
from src.config import settings


def create_server(server_key: str) -> FastMCP:
    """Create a FastMCP instance and register domain tools for the given key.

    Args:
        server_key (str): Key identifying the server configuration in settings,
            e.g. "web".

    Returns:
        FastMCP: A configured FastMCP server instance with domain tools registered.

    Raises:
        ValueError: If the server_key does not match any known server.
    """
    cfg = settings.SERVERS[server_key]
    mcp = FastMCP(cfg.name, host=cfg.host, port=cfg.port)

    match server_key:
        case "web":
            from src.tools.web import register_web_tools

            register_web_tools(mcp)
        case _:
            raise ValueError(f"Unknown server: {server_key}")

    return mcp
