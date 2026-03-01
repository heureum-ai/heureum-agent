# Copyright (c) 2026 Heureum AI. All rights reserved.

"""V2 endpoint handler — DeepAgents-based agentic loop for /v2/responses."""

from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from pathlib import Path
from typing import Any, AsyncIterator, Dict, List, Optional

from langchain_core.messages import BaseMessage, HumanMessage, ToolMessage
from langgraph.types import Command

from app.agents.deepagent_factory import build_agent
from app.agents.mcp_bridge import mcp_tools_to_langchain
from app.agents.client_tool_bridge import client_tools_to_langchain
from app.agents.sse_adapter import langgraph_to_sse
from app.agents.registry import AgentRegistry
from app.agents.router import classify_request
from app.config import settings
from app.schemas.open_responses import (
    ErrorObject,
    ErrorType,
    FunctionToolCall,
    FunctionToolResult,
    ResponseObject,
    ResponseRequest,
    ResponseStatus,
    SkillsSnapshot,
    Usage,
)
from app.services.mcps.controller import MCPClientController
from app.services.agent_service import AgentService

logger = logging.getLogger(__name__)

# Per-session: stores last used agent_name so continuations reuse it
_session_agent_name: dict[str, str] = {}

# Per-session: tracks pending client tool calls (for interrupt/resume)
# Maps session_id → list of {call_id, tool_name, args}
_session_pending_calls: dict[str, list[dict[str, Any]]] = {}


def _extract_tool_results(request: ResponseRequest) -> list[dict[str, Any]]:
    """Extract FunctionToolResult items from request.input."""
    if isinstance(request.input, str):
        return []
    results = []
    for item in request.input:
        if isinstance(item, FunctionToolResult):
            results.append({
                "call_id": item.call_id,
                "output": item.output,
            })
    return results


def _extract_function_calls(request: ResponseRequest) -> list[FunctionToolCall]:
    """Extract FunctionToolCall echo items from request.input."""
    if isinstance(request.input, str):
        return []
    return [item for item in request.input if isinstance(item, FunctionToolCall)]


def _is_continuation(request: ResponseRequest, session_id: str) -> bool:
    """Detect if this request is a tool-result continuation (should resume graph)."""
    tool_results = _extract_tool_results(request)
    return bool(tool_results) and session_id in _session_pending_calls


def _parse_new_user_messages(request: ResponseRequest) -> list[BaseMessage]:
    """Extract only new user-facing messages (exclude tool results and tool calls)."""
    if isinstance(request.input, str):
        return [HumanMessage(content=request.input)]

    messages: list[BaseMessage] = []
    for item in request.input:
        if isinstance(item, FunctionToolResult):
            continue  # tool results handled separately
        if isinstance(item, FunctionToolCall):
            continue  # echo items
        if hasattr(item, "role") and hasattr(item, "content"):
            content = item.content
            if isinstance(content, list):
                text = "\n".join(
                    part.text for part in content if hasattr(part, "text") and part.text
                )
            else:
                text = str(content) if content else ""
            if text:
                from langchain_core.messages import AIMessage, SystemMessage
                role = getattr(item.role, "value", str(item.role))
                if role == "assistant":
                    messages.append(AIMessage(content=text))
                elif role in ("system", "developer"):
                    messages.append(SystemMessage(content=text))
                else:
                    messages.append(HumanMessage(content=text))
    return messages


class V2ResponseHandler:
    """Handler for /v2/responses endpoint using DeepAgents + LangGraph."""

    def __init__(
        self,
        agent_registry: AgentRegistry,
        agent_service: AgentService,
        mcp_client: MCPClientController,
    ) -> None:
        self._registry = agent_registry
        self._agent_service = agent_service
        self._mcp_client = mcp_client

    async def _resolve_agent_name(
        self,
        request: ResponseRequest,
        messages: list[BaseMessage],
        session_id: str,
    ) -> str:
        """Classify request or reuse previous agent name for continuations."""
        if _is_continuation(request, session_id):
            # Reuse previous agent for continuations
            return _session_agent_name.get(session_id, "simple")

        agent_name = await classify_request(
            messages=messages,
            agent_registry=self._registry,
            agent_service=self._agent_service,
        )
        _session_agent_name[session_id] = agent_name
        return agent_name

    async def _build_tools(
        self,
        request: ResponseRequest,
        session_id: str,
        include_mcp: bool,
        include_client: bool = True,
    ):
        """Build MCP + client tool lists for DeepAgents."""
        from app.agents.session_storage import make_storage_tools

        custom_tools = []
        display_names: dict[str, str] = {}

        # Session storage tools: available to both main agent and sub-agents.
        # Sub-agents call store_finding() to persist results; main agent calls
        # get_findings() to retrieve them when synthesizing.
        storage_tools = make_storage_tools(session_id)
        custom_tools.extend(storage_tools)
        display_names["store_finding"] = "Store Finding"
        display_names["get_findings"] = "Get Findings"

        if include_mcp:
            try:
                mcp_schemas = await self._mcp_client.discover_tools()
                mcp_tools = mcp_tools_to_langchain(mcp_schemas, self._mcp_client, session_id)
                custom_tools.extend(mcp_tools)
                # Collect display names
                display_names.update(self._mcp_client.display_names)
            except Exception:
                logger.warning("MCP tool discovery failed", exc_info=True)

        if include_client and request.tools:
            client_tools = client_tools_to_langchain(request.tools)
            custom_tools.extend(client_tools)
            # Collect client tool display names
            for td in request.tools:
                display_names[td.function.name] = td.display_name or td.function.name

        return custom_tools, display_names

    async def handle_streaming(
        self,
        request: ResponseRequest,
        session_id: str,
        created_at: int,
        model: str,
    ) -> AsyncIterator[str]:
        """Run DeepAgents loop and yield SSE events.

        Yields:
            SSE-formatted strings.
        """
        # Parse user messages
        user_messages = _parse_new_user_messages(request)

        # Detect continuation (client tool results)
        tool_results = _extract_tool_results(request)
        is_cont = _is_continuation(request, session_id)

        # Classify request → agent config
        agent_name = await self._resolve_agent_name(request, user_messages, session_id)
        agent_config = self._registry.get_agent(agent_name)
        if agent_config is None:
            agent_config = self._registry.get_agent("simple")
        if agent_config is None:
            # Fallback: create a minimal dynamic agent config
            from app.agents.types import AgentDefinition
            agent_config = AgentDefinition(
                name="simple",
                description="Simple agent",
                trigger="always",
                identity_prompt="",
                skills=[],
                mcp_tools=False,
                max_iterations=10,
            )

        logger.info(
            "V2 session=%s agent=%s continuation=%s tools=%d",
            session_id,
            agent_name,
            is_cont,
            len(request.tools or []),
        )

        # Build tools
        custom_tools, display_names = await self._build_tools(
            request,
            session_id,
            include_mcp=agent_config.mcp_tools,
            include_client=agent_config.client_tools,
        )

        # filesystem agent uses LocalShellBackend anchored to home dir.
        # Other agents (complex, simple, ...) with client_tools=False still use
        # FilesystemBackend (skills only) — not LocalShellBackend.
        root_dir = str(Path.home()) if agent_config.name == "filesystem" else None

        # Build agent with checkpointer
        agent = build_agent(
            model=model,
            agent_config=agent_config,
            custom_tools=custom_tools,
            system_prompt=request.instructions,
            root_dir=root_dir,
        )

        # LangGraph config: thread_id = session_id for state persistence.
        # Set recursion_limit high enough for complex multi-step research tasks.
        # Default LangGraph limit is 25 which is too low for agents doing
        # multiple web searches, file operations, and sub-agent delegation.
        lg_config = {
            "configurable": {"thread_id": session_id},
            "recursion_limit": max(agent_config.max_iterations * 4, 100),
        }

        # Choose: resume interrupted graph OR start/continue normal turn
        if is_cont:
            # Resume after client tool execution
            pending = _session_pending_calls.pop(session_id, [])
            logger.info(
                "Resuming graph for session %s with %d tool results",
                session_id,
                len(tool_results),
            )
            # Map call_ids back to outputs
            result_map = {r["call_id"]: r["output"] for r in tool_results}
            if len(pending) == 1:
                output = result_map.get(pending[0]["call_id"], tool_results[0]["output"] if tool_results else "")
                graph_input = Command(resume={"output": output, "call_id": pending[0]["call_id"]})
            else:
                # Multiple pending → resume with all results
                resume_list = [
                    {"call_id": p["call_id"], "output": result_map.get(p["call_id"], "")}
                    for p in pending
                ]
                graph_input = Command(resume=resume_list)
        else:
            # New turn or continuation of conversation
            if not user_messages:
                # Nothing to send
                async def _empty():
                    yield "data: {\"type\": \"response.completed\"}\n\n"
                    yield "data: [DONE]\n\n"
                async for chunk in _empty():
                    yield chunk
                return
            graph_input = {"messages": user_messages}

        # Stream events through the SSE adapter
        event_stream = agent.astream_events(
            graph_input,
            config=lg_config,
            version="v2",
        )

        async for sse_chunk in langgraph_to_sse(
            event_stream=event_stream,
            session_id=session_id,
            model=model,
            created_at=created_at,
            display_names=display_names,
        ):
            # Capture pending client tool calls from incomplete response
            if '"type": "response.incomplete"' in sse_chunk:
                try:
                    data = json.loads(sse_chunk.removeprefix("data: ").rstrip())
                    pending_calls = (
                        data.get("response", {})
                        .get("metadata", {})
                        .get("pending_tool_calls", [])
                    )
                    if pending_calls:
                        _session_pending_calls[session_id] = pending_calls
                except Exception:
                    pass
            yield sse_chunk

    async def handle_sync(
        self,
        request: ResponseRequest,
        session_id: str,
        created_at: int,
        model: str,
    ) -> ResponseObject:
        """Run DeepAgents loop synchronously (collect all SSE and return final response)."""
        chunks = []
        async for chunk in self.handle_streaming(request, session_id, created_at, model):
            chunks.append(chunk)

        # Find the last response.completed / response.failed / response.incomplete event
        for chunk in reversed(chunks):
            if not chunk.startswith("data: "):
                continue
            raw = chunk.removeprefix("data: ").rstrip()
            if raw == "[DONE]":
                continue
            try:
                event = json.loads(raw)
                evt_type = event.get("type", "")
                if evt_type in ("response.completed", "response.incomplete", "response.failed"):
                    response_data = event.get("response", {})
                    return ResponseObject(**response_data)
            except Exception:
                continue

        # Fallback empty response
        return ResponseObject(
            id=f"resp_{uuid.uuid4().hex}",
            created_at=created_at,
            model=model,
            status=ResponseStatus.FAILED,
            output=[],
            usage=Usage.zero(),
            error=ErrorObject(
                type=ErrorType.SERVER_ERROR,
                message="No response generated",
            ),
            metadata={"session_id": session_id},
        )


def clear_v2_session(session_id: str) -> None:
    """Clear V2 session state (agent name, pending calls, session storage)."""
    from app.agents.session_storage import clear_session
    _session_agent_name.pop(session_id, None)
    _session_pending_calls.pop(session_id, None)
    clear_session(session_id)
