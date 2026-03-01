# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Agent router — FastAPI endpoint layer for the v2 DeepAgents-based agentic loop.

All loop logic lives in ``app.agents.v2_handler``.  This module only defines
HTTP endpoints.
"""

import logging
import time

from app.agents.constants import SSE_HEADERS
from app.agents.registry import AgentRegistry
from app.agents.v2_handler import V2ResponseHandler, clear_v2_session
from app.agents.approval_middleware import clear_session_approval_state
from app.config import settings
from app.schemas.open_responses import (
    ErrorObject,
    ErrorType,
    ResponseObject,
    ResponseRequest,
    ResponseStatus,
    Usage,
)
from app.services.agent_service import agent_service
from app.services.mcps.controller import MCPClientController
from fastapi import APIRouter
from fastapi.responses import StreamingResponse

logger = logging.getLogger(__name__)

router = APIRouter()

# ---------------------------------------------------------------------------
# Module-level singletons
# ---------------------------------------------------------------------------

_mcp_client = MCPClientController()
_agent_registry = AgentRegistry()

_v2_handler = V2ResponseHandler(
    agent_registry=_agent_registry,
    agent_service=agent_service,
    mcp_client=_mcp_client,
)


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------


@router.post("/tools/execute")
async def execute_tool_endpoint(request: dict) -> dict:
    """Execute a single MCP server tool and return the result.

    Called by the client to execute tools that run on the server side.
    """
    name = request.get("name", "")
    arguments = request.get("arguments", {})
    session_id = request.get("session_id", "")

    try:
        result = await _mcp_client.call_tool(name, arguments, session_id=session_id)
        return {"output": result or "", "success": True}
    except NotImplementedError:
        return {"output": f"Error: unknown server tool '{name}'", "success": False}
    except Exception as e:
        logger.warning("Tool execution failed (%s): %s", name, e)
        return {"output": f"Error executing tool '{name}': {e}", "success": False}


@router.post("/responses", response_model=ResponseObject)
async def create_response(request: ResponseRequest):
    """Open Responses endpoint — DeepAgents + LangGraph based agentic loop."""
    created_at = int(time.time())
    session_id = agent_service.responses.extract_session_id(request.metadata)
    model = settings.AGENT_MODEL

    if request.stream:
        return StreamingResponse(
            _v2_handler.handle_streaming(request, session_id, created_at, model),
            media_type="text/event-stream",
            headers=SSE_HEADERS,
        )

    try:
        return await _v2_handler.handle_sync(request, session_id, created_at, model)
    except Exception as e:
        logger.exception("Agent loop error for session %s", session_id)
        return agent_service.responses.build_response(
            [],
            ResponseStatus.FAILED,
            session_id,
            created_at,
            model,
            error=ErrorObject(type=ErrorType.SERVER_ERROR, message=str(e)),
        )


@router.post("/sessions/cleanup")
async def cleanup_sessions() -> dict:
    """Cleanup expired/overflow sessions from in-memory state."""
    expired_count, overflow_evicted_count = agent_service.cleanup_stale_sessions()
    return {
        "expired_count": expired_count,
        "overflow_evicted_count": overflow_evicted_count,
    }


@router.get("/sessions/{session_id}/history")
async def session_history(session_id: str) -> dict:
    """Return app-level message history for a session."""
    history = agent_service.get_history(session_id)
    return {
        "session_id": session_id,
        "message_count": len(history),
        "history": [agent_service._normalize.serialize_lc_message(msg) for msg in history],
    }


@router.delete("/sessions/{session_id}")
async def delete_session(session_id: str) -> dict:
    """Delete a session from in-memory agent state."""
    removed = agent_service.remove_session(session_id)
    _mcp_client.clear_session_state(session_id)
    clear_v2_session(session_id)
    clear_session_approval_state(session_id)
    return {"session_id": session_id, "removed": removed}


@router.get("/subagent/status/{session_id}")
async def subagent_status(session_id: str) -> dict:
    """Return sub-agent run status for the given parent session.

    V2 DeepAgents manages sub-agents internally; returns empty list.
    """
    return {"children": []}


@router.post("/title")
async def generate_title(request: dict) -> dict:
    """Generate a short title for a conversation based on its messages."""
    messages = request.get("messages", [])
    if not messages:
        return {"title": "New Chat"}

    conversation = "\n".join(
        f"{m['role'].capitalize()}: {m['text']}" for m in messages if m.get("text")
    )

    try:
        title = await agent_service.generate_title(conversation)
        return {"title": title}
    except Exception as e:
        logger.warning("Title generation failed: %s", e)
        first = next((m["text"] for m in messages if m.get("role") == "user"), "New Chat")
        title = first[:60] + ("..." if len(first) > 60 else "")
        return {"title": title}
