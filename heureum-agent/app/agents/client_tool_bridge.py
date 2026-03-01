# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Client tool bridge — converts Electron IPC tools to LangGraph interrupt-based tools."""

from __future__ import annotations

import logging
from typing import Any, Dict, List

from langchain_core.tools import StructuredTool
from langgraph.types import interrupt
from pydantic import BaseModel, Field, create_model

from app.schemas.open_responses import ToolDefinition

logger = logging.getLogger(__name__)


def _build_args_model(tool_def: ToolDefinition) -> type[BaseModel]:
    """Build a Pydantic model from a ToolDefinition's parameter schema."""
    params = tool_def.function.parameters or {}
    props = params.get("properties", {})
    required = set(params.get("required", []))

    fields: dict[str, Any] = {}
    for field_name, field_schema in props.items():
        field_type: type = str
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

    model_name = f"{tool_def.function.name}_ClientArgs"
    return create_model(model_name, **fields)


def client_tools_to_langchain(
    tool_definitions: List[ToolDefinition],
) -> List[StructuredTool]:
    """Convert client ToolDefinition list to LangChain interrupt-based tools.

    Each tool will interrupt LangGraph execution when called, signaling
    that the client (Electron) needs to execute the tool and provide the result.

    Args:
        tool_definitions: List of ToolDefinition objects from request.tools.

    Returns:
        List of LangChain StructuredTool instances.
    """
    tools = []
    for tool_def in tool_definitions:
        name = tool_def.function.name
        description = tool_def.function.description or f"Client-side tool: {name}"
        args_model = _build_args_model(tool_def)
        display_name = tool_def.display_name or name

        def _make_interrupt_func(tool_name: str, disp_name: str):
            async def execute_client_tool(**kwargs: Any) -> str:
                """Interrupt graph execution to delegate tool call to client."""
                # interrupt() suspends the LangGraph node and returns the resume value
                # when the graph is resumed with Command(resume=...)
                result = interrupt({
                    "type": "client_tool_call",
                    "tool_name": tool_name,
                    "display_name": disp_name,
                    "args": kwargs,
                })
                # result is provided by Command(resume=result) on the next invoke
                if isinstance(result, dict):
                    return result.get("output", str(result))
                return str(result) if result is not None else ""
            execute_client_tool.__name__ = tool_name
            return execute_client_tool

        tool = StructuredTool(
            name=name,
            description=description,
            args_schema=args_model,
            coroutine=_make_interrupt_func(name, display_name),
        )
        tools.append(tool)
        logger.debug("Registered client tool (interrupt): %s", name)

    logger.info("Built %d interrupt-based client tools", len(tools))
    return tools


def get_client_tool_names(tool_definitions: List[ToolDefinition]) -> set[str]:
    """Return the set of client tool names from a list of ToolDefinitions."""
    return {td.function.name for td in tool_definitions}
