# Copyright (c) 2026 Heureum AI. All rights reserved.

"""MCP tool-schema controller."""

from typing import Any, Dict, List, Optional


class MCPToolController:
    """Controller for MCP tool schemas provided by clients/routers."""

    def __init__(self, tools: Optional[List[Dict[str, Any]]] = None) -> None:
        self._tools: List[Dict[str, Any]] = list(tools or [])

    def set_tools(self, tools: Optional[List[Dict[str, Any]]]) -> None:
        self._tools = list(tools or [])

    def get_tool_schemas(self) -> List[Dict[str, Any]]:
        return list(self._tools)

    def get_tool_names(self) -> set[str]:
        names: set[str] = set()
        for schema in self._tools:
            func = schema.get("function")
            if isinstance(func, dict):
                name = func.get("name")
                if isinstance(name, str) and name:
                    names.add(name)
        return names
