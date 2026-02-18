# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Filesystem server standalone entry point."""

from src.config import settings
from src.servers import create_server

mcp = create_server("filesystem")

if __name__ == "__main__":
    cfg = settings.SERVERS["filesystem"]
    mcp.run(transport=cfg.transport)
