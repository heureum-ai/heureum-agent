# Copyright (c) 2026 Heureum AI. All rights reserved.

"""MCP tool bridge — converts MCP tool schemas to LangChain tools for DeepAgents."""

from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any, Dict, List

from langchain_core.tools import StructuredTool
from pydantic import BaseModel, Field, create_model

if TYPE_CHECKING:
    from app.services.mcps.controller import MCPClientController

logger = logging.getLogger(__name__)


def _build_pydantic_model(name: str, parameters: dict | None) -> type[BaseModel]:
    """Build a Pydantic model from a JSON Schema parameters dict."""
    if not parameters:
        return create_model(f"{name}_Args")

    props = parameters.get("properties", {})
    required = set(parameters.get("required", []))

    fields: dict[str, Any] = {}
    for field_name, field_schema in props.items():
        field_type: type = str  # default to str
        schema_type = field_schema.get("type", "string")
        if schema_type == "integer":
            field_type = int
        elif schema_type == "number":
            field_type = float
        elif schema_type == "boolean":
            field_type = bool
        elif schema_type == "array":
            field_type = list
        elif schema_type == "object":
            field_type = dict

        description = field_schema.get("description", "")

        if field_name in required:
            fields[field_name] = (field_type, Field(..., description=description))
        else:
            fields[field_name] = (field_type | None, Field(None, description=description))

    return create_model(f"{name}_Args", **fields)


def mcp_tools_to_langchain(
    mcp_schemas: List[Dict[str, Any]],
    mcp_client: "MCPClientController",
    session_id: str = "",
) -> List[StructuredTool]:
    """Convert MCP tool schemas to LangChain StructuredTool instances.

    Args:
        mcp_schemas: List of MCP tool schema dicts (OpenAI function format).
        mcp_client: MCPClientController for dispatching tool calls.
        session_id: Session ID to pass to MCP tool calls.

    Returns:
        List of LangChain StructuredTool instances ready for DeepAgents.
    """
    tools = []
    for schema in mcp_schemas:
        func_def = schema.get("function", {})
        name = func_def.get("name", "")
        if not name:
            continue

        description = func_def.get("description", f"MCP tool: {name}")
        parameters = func_def.get("parameters")

        # Build Pydantic model for args validation
        args_model = _build_pydantic_model(name, parameters)

        # Closure over name and session_id
        def _make_async_func(tool_name: str, sid: str):
            async def call_mcp(**kwargs: Any) -> str:
                try:
                    result = await mcp_client.call_tool(tool_name, kwargs, session_id=sid)
                    return result or ""
                except Exception as exc:
                    logger.warning("MCP tool '%s' failed: %s", tool_name, exc)
                    return f"Error calling {tool_name}: {exc}"
            call_mcp.__name__ = tool_name
            return call_mcp

        async_func = _make_async_func(name, session_id)

        tool = StructuredTool(
            name=name,
            description=description,
            args_schema=args_model,
            coroutine=async_func,
        )
        tools.append(tool)
        logger.debug("Registered MCP tool: %s", name)

    logger.info("Built %d LangChain tools from MCP schemas", len(tools))
    return tools
