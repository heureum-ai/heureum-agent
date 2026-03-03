# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Agent router — thin FastAPI endpoint layer.

All loop logic lives in ``app.services.agent_loop``.  This module only defines
HTTP endpoints that import and call into the loop engine.
"""

import asyncio
import json
import logging
import time

from app.config import settings
from app.schemas.open_responses import (
    ErrorObject,
    ErrorType,
    ResponseObject,
    ResponseRequest,
    ResponseStatus,
    SkillsSnapshot,
    Usage,
)
from app.services.agent_service import AgentService
from app.services.agent_loop import (
    AgentLoopRunner,
    LoopContext,
    SSE_HEADERS,
    _default as _agent_loop_ctrl,
    _get_subagent_context,
    agent_service,
    cleanup_stale_locks,
    ensure_initialized,
    execute_tool,
    handle_approval_continuation,
    mcp_client,
    persist_controller,
    remove_session_lock,
    resolve_tools,
    skill_controller,
    tool_controller,
)
from app.services.client_relay import relay
from app.services.tools import clear_session_loop_state
from app.skills.plan_task.service import get_registry as get_subagent_registry
from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from langchain_core.messages import AIMessage, ToolMessage
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter()


async def _register_client_skills(snapshot, pc) -> None:
    """Register client-provided skills (with body) to Platform DB.

    Uses the same ``register_skill_schemas`` path as server skills so that
    all skill bodies are available in the DB for ``fetch_skill_body``.
    """
    items = snapshot.skills if hasattr(snapshot, "skills") else []
    to_register = []
    for item in items:
        body = getattr(item, "body", None)
        if not body:
            continue
        name = getattr(item, "name", None)
        if not name:
            continue
        to_register.append(
            {
                "skill_name": name,
                "description": getattr(item, "description", "") or "",
                "tools": getattr(item, "tools", []) or [],
                "depends_on": [],
                "subagent_access": "always",
                "source": "client",
                "body": body,
            }
        )
    if to_register:
        try:
            await pc.register_skill_schemas(to_register)
        except Exception:
            logger.debug("Client skill registration failed", exc_info=True)


@router.post("/tools/execute")
async def execute_tool_endpoint(request: dict) -> dict:
    """Execute a single server tool and return the result.

    Called by the client to execute tools that run on the server side
    (MCP, session files, agent tools, etc.).
    """
    await ensure_initialized()
    name = request.get("name", "")
    arguments = request.get("arguments", {})
    session_id = request.get("session_id", "")

    try:
        result = await execute_tool(name, arguments, session_id=session_id)
        return {"output": result, "success": True}
    except NotImplementedError:
        return {"output": f"Error: unknown server tool '{name}'", "success": False}
    except Exception as e:
        logger.warning("Tool execution failed (%s): %s", name, e)
        return {"output": f"Error executing tool '{name}': {e}", "success": False}


@router.post("/responses", response_model=ResponseObject)
async def create_response(request: ResponseRequest) -> ResponseObject:
    """Open Responses endpoint with server-side agentic loop."""
    await ensure_initialized()
    cleanup_stale_locks()

    created_at = int(time.time())
    session_id = agent_service.responses.extract_session_id(request.metadata)
    model = settings.AGENT_MODEL
    messages = agent_service.responses.parse_input_messages(request)

    if not messages:
        return agent_service.responses.build_response(
            [],
            ResponseStatus.FAILED,
            session_id,
            created_at,
            model,
            error=ErrorObject(type=ErrorType.INVALID_REQUEST, message="No input messages"),
        )

    (
        tool_names,
        client_tool_schemas,
        client_tool_names,
        client_tool_prompts,
        display_names,
        tool_meta_sets,
    ) = await resolve_tools(request, session_id=session_id, persist_controller=persist_controller)

    # Register client-provided skills (with body) to Platform DB,
    # using the same path as server skills so all skill bodies are in DB.
    if request.skills_snapshot and persist_controller:
        await _register_client_skills(request.skills_snapshot, persist_controller)

    # Store tool metadata in ToolController for per-session access
    tool_controller.set_tool_meta(session_id, tool_meta_sets)

    # Handle pending approval BEFORE prepare_messages_for_session, because
    # the approval answer arrives as a tool-role message that
    # prepare_messages_for_session would consume (replace_tool_result)
    # and discard before the approval handler can see it.
    raw_messages = messages
    approval_early: ResponseObject | None = None
    approval_usage = Usage.zero()
    approval_tc_count = 0
    approval_output_items: list = []
    _defer_approval_to_stream = False

    if mcp_client.has_pending_approval(session_id):
        if request.stream:
            # Streaming: defer approval handling to the streaming code so
            # that chain follow-up tools (web_fetch, grep) are emitted as
            # SSE events.  Running it here would add items to output_items
            # before the streaming code measures items_before, causing the
            # chain SSE events to be silently dropped.
            _defer_approval_to_stream = True
        else:
            (
                approval_early,
                approval_remaining,
                approval_tc_count,
                approval_usage,
            ) = await handle_approval_continuation(
                session_id,
                raw_messages,
                approval_output_items,
                created_at,
                model or "default",
                Usage.zero(),
                0,
                display_names,
            )
            if approval_early:
                return approval_early
            # Strip consumed tool messages only when approval was actually
            # matched (allow or deny).  handle_approval_continuation returns
            # [] when matched, original messages when not matched (e.g.
            # stale call_id).  Stripping unmatched messages would leave an
            # empty context → Gemini "contents are required" error.
            if not approval_remaining:
                pending_call_ids = set()
                for m in raw_messages:
                    if isinstance(m, ToolMessage):
                        pending_call_ids.add(m.tool_call_id)
                messages = [
                    m for m in messages if getattr(m, "tool_call_id", None) not in pending_call_ids
                ]

    if not _defer_approval_to_stream:
        history = agent_service.get_history(session_id)
        replace_tool_result = None
        if isinstance(agent_service, AgentService):

            def replace_tool_result(**kwargs):
                return agent_service.replace_tool_result(
                    session_id=session_id,
                    **kwargs,
                )

        messages = agent_service.history.prepare_messages_for_session(
            request=request,
            messages=messages,
            history=history,
            replace_tool_result=replace_tool_result,
        )
        if (
            not history
            and messages
            and len(
                [m for m in messages if isinstance(m, AIMessage) and getattr(m, "tool_calls", None)]
            )
            > 0
        ):
            echo = next(
                (
                    m
                    for m in messages
                    if isinstance(m, AIMessage) and getattr(m, "tool_calls", None)
                ),
                None,
            )
            if echo:
                logger.info(
                    "Recovered %d tool call echo(es) for session %s",
                    len(getattr(echo, "tool_calls", None) or []),
                    session_id,
                )

    # Count tool results in input to carry over context from INCOMPLETE requests.
    # When the frontend sends back tool results (e.g. ask_question answer),
    # tool_call_count must be > 0 so the judge evaluates the follow-up response.
    input_tool_count = approval_tc_count + sum(
        1 for m in raw_messages if isinstance(m, ToolMessage)
    )

    # Extract skills_prompt from client skills snapshot (if provided)
    skills_prompt = SkillsSnapshot.extract_prompt(request.skills_snapshot)

    # Propagate skills_prompt and client tool info to subagent context so child
    # agents inherit them.  Per-request mutation on a global singleton — safe
    # under asyncio's cooperative scheduling model (single-threaded).
    try:
        sa_ctx = _get_subagent_context()
        sa_ctx.skills_prompt = skills_prompt
        sa_ctx.client_tool_schemas = client_tool_schemas
        sa_ctx.client_tool_names = client_tool_names
    except RuntimeError:
        pass

    # Extract response_id from proxy metadata for real-time persist
    response_id = request.metadata.get("response_id") if request.metadata else None

    ctx = LoopContext(
        request=request,
        created_at=created_at,
        session_id=session_id,
        model=model,
        messages=messages,
        tool_names=tool_names,
        client_tool_schemas=client_tool_schemas,
        client_tool_names=client_tool_names,
        client_tool_prompts=client_tool_prompts,
        display_names=display_names,
        skills_prompt=skills_prompt,
        total_usage=approval_usage,
        tool_call_count=input_tool_count,
        output_items=approval_output_items,
        response_id=response_id,
        ctrl=_agent_loop_ctrl,
    )

    if request.stream:
        runner = AgentLoopRunner(ctx)
        return StreamingResponse(
            runner.stream(),
            media_type="text/event-stream",
            headers=SSE_HEADERS,
        )

    try:
        return await AgentLoopRunner(ctx).run()
    except NotImplementedError as e:
        logger.error("Tool not implemented: %s", e)
        if persist_controller and response_id:
            asyncio.create_task(persist_controller.complete_response(response_id, "failed"))
        return agent_service.responses.build_response(
            [],
            ResponseStatus.FAILED,
            ctx.session_id,
            ctx.created_at,
            ctx.model,
            error=ErrorObject(
                type=ErrorType.SERVER_ERROR,
                code="tool_not_implemented",
                message=str(e),
            ),
            tool_call_count=ctx.tool_call_count,
            tool_history=ctx.output_items or None,
        )
    except Exception as e:
        logger.exception("Agent loop error")
        if persist_controller and response_id:
            asyncio.create_task(persist_controller.complete_response(response_id, "failed"))
        return agent_service.responses.build_response(
            [],
            ResponseStatus.FAILED,
            ctx.session_id,
            ctx.created_at,
            ctx.model,
            error=ErrorObject(type=ErrorType.SERVER_ERROR, message=str(e)),
            tool_call_count=ctx.tool_call_count,
            tool_history=ctx.output_items or None,
        )


@router.post("/sessions/cleanup")
async def cleanup_sessions() -> dict:
    """Cleanup expired/overflow sessions from in-memory state."""
    expired_count, overflow_evicted_count = agent_service.cleanup_stale_sessions()
    cleanup_stale_locks()
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
    remove_session_lock(session_id)
    mcp_client.clear_session_state(session_id)
    tool_controller.clear_session(session_id)
    skill_controller.clear_session(session_id)
    clear_session_loop_state(session_id)
    relay.clear_session(session_id)
    return {"session_id": session_id, "removed": removed}


@router.get("/subagent/status/{session_id}")
async def subagent_status(session_id: str) -> dict:
    """Return sub-agent run status for the given parent session."""
    now = time.time()
    records = get_subagent_registry().list_by_parent(session_id)
    return {
        "children": [
            {
                "child_session_id": r.child_session_id,
                "task": r.task[:200],
                "status": r.status,
                "elapsed_seconds": round(now - r.started_at, 1),
                "result_summary": r.result_summary[:500] if r.result_summary else None,
                "current_iteration": r.current_iteration,
                "progress": [
                    {
                        "tool_name": s.tool_name,
                        "detail": s.detail[:100],
                        "status": s.status,
                        "display_name": s.display_name,
                    }
                    for s in list(r.progress_log)
                ],
            }
            for r in records
        ]
    }


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
        # Fallback to first user message
        first = next((m["text"] for m in messages if m.get("role") == "user"), "New Chat")
        title = first[:60] + ("..." if len(first) > 60 else "")
        return {"title": title}


# ---------------------------------------------------------------------------
# Sub-agent client tool relay
# ---------------------------------------------------------------------------


class RelayResultBody(BaseModel):
    call_id: str
    output: str


@router.get("/relay/{session_id}")
async def relay_stream(session_id: str) -> StreamingResponse:
    """SSE stream that Electron subscribes to for sub-agent client tool requests.

    Yields one SSE event per pending tool call:
      data: {"call_id": "...", "tool": "bash", "args": {...}}

    The stream ends when ``relay.clear_session()`` is called (sentinel ``None``).
    """
    queue = relay.get_or_create_queue(session_id)

    async def _gen():
        in_flight = None
        try:
            while True:
                in_flight = None
                call = await queue.get()
                if call is None:
                    # Sentinel — session cleaned up, close the stream
                    break
                in_flight = call
                yield (
                    f"data: {json.dumps({'call_id': call.call_id, 'tool': call.tool_name, 'args': call.args})}\n\n"
                )
                in_flight = None  # Successfully delivered
        finally:
            if in_flight is not None:
                # Connection dropped while call was in-flight — re-queue for next subscriber
                queue.put_nowait(in_flight)

    return StreamingResponse(_gen(), media_type="text/event-stream", headers=SSE_HEADERS)


@router.post("/relay/result")
async def relay_result(body: RelayResultBody) -> dict:
    """Receive tool execution result from Electron and unblock the waiting sub-agent."""
    ok = relay.submit_result(body.call_id, body.output)
    return {"ok": ok}
