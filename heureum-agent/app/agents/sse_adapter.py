# Copyright (c) 2026 Heureum AI. All rights reserved.

"""SSE adapter — converts LangGraph astream_events() to heureum SSE format."""

from __future__ import annotations

import json
import logging
import time
import uuid
from typing import Any, AsyncIterator, Dict, Optional, Set

from langchain_core.messages import AIMessage, AIMessageChunk
from langgraph.errors import GraphInterrupt, GraphRecursionError
from langgraph.types import Interrupt

from app.schemas.open_responses import (
    AssistantMessageItem,
    ErrorObject,
    ErrorType,
    FunctionToolCall,
    FunctionToolResult,
    ItemStatus,
    OutputTextContent,
    ResponseObject,
    ResponseStatus,
    Usage,
)

logger = logging.getLogger(__name__)

# Built-in deepagents tool display names
_BUILTIN_DISPLAY_NAMES: Dict[str, str] = {
    "write_todos": "Write Todos",
    "ls": "List Files",
    "read_file": "Read File",
    "write_file": "Write File",
    "edit_file": "Edit File",
    "glob": "Glob",
    "grep": "Grep",
    "execute": "Execute",
    "task": "Task (Sub-agent)",
}


def _sse(event: dict[str, Any]) -> str:
    """Format dict as SSE data line."""
    return f"data: {json.dumps(event)}\n\n"


def _sse_done() -> str:
    return "data: [DONE]\n\n"


def _get_display_name(tool_name: str, display_names: dict[str, str] | None) -> str:
    """Resolve a tool's display name."""
    if display_names and tool_name in display_names:
        return display_names[tool_name]
    return _BUILTIN_DISPLAY_NAMES.get(tool_name, tool_name.replace("_", " ").title())


def _build_empty_response(
    response_id: str,
    session_id: str,
    model: str,
    created_at: int,
    status: ResponseStatus,
    text: str = "",
    tool_history: list | None = None,
    error: ErrorObject | None = None,
) -> ResponseObject:
    """Build a minimal ResponseObject for SSE completion events."""
    output: list = []
    if text:
        output.append(
            AssistantMessageItem(
                content=[OutputTextContent(text=text)],
                status=ItemStatus.COMPLETED,
            )
        )
    if tool_history:
        output.extend(tool_history)

    return ResponseObject(
        id=response_id,
        created_at=created_at,
        completed_at=int(time.time()),
        model=model,
        status=status,
        output=output,
        usage=Usage.zero(),
        error=error,
        metadata={"session_id": session_id},
    )


async def langgraph_to_sse(
    event_stream: AsyncIterator[dict[str, Any]],
    session_id: str,
    model: str,
    created_at: int,
    display_names: dict[str, str] | None = None,
) -> AsyncIterator[str]:
    """Convert LangGraph astream_events() stream to heureum SSE format.

    Yields SSE-formatted strings (data: {...}\\n\\n).

    Handles:
    - Text streaming → response.output_text.delta / .done
    - Tool calls → response.function_call.done
    - Tool results → response.tool_result.done
    - Graph interrupts (client tools) → response.incomplete
    - Completion → response.completed
    - Errors → response.failed
    """
    response_id = f"resp_{uuid.uuid4().hex}"

    # Emit created event
    yield _sse({
        "type": "response.created",
        "response": {
            "id": response_id,
            "status": "in_progress",
            "model": model,
            "created_at": created_at,
            "metadata": {"session_id": session_id},
        },
    })

    accumulated_text = ""
    tool_history: list = []
    emitted_call_ids: Set[str] = set()

    # run_id → call_id mapping: built from on_tool_start to correlate with on_tool_end
    # when ToolMessage.tool_call_id is absent (e.g. built-in deepagents tools returning str/None).
    _run_to_call: dict[str, str] = {}
    # Pending call_ids keyed by tool name (FIFO queue), populated from on_chat_model_end.
    _pending_by_name: dict[str, list[str]] = {}

    try:
        async for event in event_stream:
            kind = event.get("event", "")

            # --- Streaming text chunks from LLM ---
            if kind == "on_chat_model_stream":
                chunk = event.get("data", {}).get("chunk")
                if chunk is None:
                    continue

                # Extract text content from chunk
                content = chunk.content if hasattr(chunk, "content") else ""
                if isinstance(content, str) and content:
                    accumulated_text += content
                    yield _sse({
                        "type": "response.output_text.delta",
                        "delta": content,
                    })
                elif isinstance(content, list):
                    for part in content:
                        if isinstance(part, dict) and part.get("type") == "text":
                            text = part.get("text", "")
                            if text:
                                accumulated_text += text
                                yield _sse({
                                    "type": "response.output_text.delta",
                                    "delta": text,
                                })

            # --- LLM call completed: emit tool calls ---
            elif kind == "on_chat_model_end":
                output_msg = event.get("data", {}).get("output")
                if not isinstance(output_msg, AIMessage):
                    continue

                tool_calls = getattr(output_msg, "tool_calls", []) or []
                for tc in tool_calls:
                    call_id = tc.get("id", f"call_{uuid.uuid4().hex[:8]}")
                    if call_id in emitted_call_ids:
                        continue
                    emitted_call_ids.add(call_id)

                    name = tc.get("name", "")
                    args = tc.get("args", {})
                    args_str = json.dumps(args) if isinstance(args, dict) else str(args)
                    disp_name = _get_display_name(name, display_names)

                    # Track pending call_id by tool name for run_id mapping fallback.
                    if name:
                        _pending_by_name.setdefault(name, []).append(call_id)

                    fc_item = FunctionToolCall(
                        call_id=call_id,
                        name=name,
                        arguments=args_str,
                        status=ItemStatus.COMPLETED,
                        display_name=disp_name,
                    )
                    tool_history.append(fc_item)

                    yield _sse({
                        "type": "response.function_call.done",
                        "item": {
                            "call_id": call_id,
                            "name": name,
                            "arguments": args_str,
                            "display_name": disp_name,
                        },
                    })

            # --- Tool execution started: build run_id → call_id mapping ---
            elif kind == "on_tool_start":
                run_id = event.get("run_id", "")
                tool_name = event.get("name", "")
                if run_id and tool_name and _pending_by_name.get(tool_name):
                    _run_to_call[run_id] = _pending_by_name[tool_name].pop(0)

            # --- Tool execution completed ---
            elif kind == "on_tool_end":
                tool_msg = event.get("data", {}).get("output")
                run_id = event.get("run_id", "")
                call_id = None
                output_str = ""

                if hasattr(tool_msg, "tool_call_id") and tool_msg.tool_call_id:
                    # Standard ToolMessage — tool_call_id directly matches LLM call id.
                    call_id = tool_msg.tool_call_id
                    content = tool_msg.content
                    output_str = content if isinstance(content, str) else json.dumps(content)
                else:
                    # Fallback: look up call_id from on_tool_start mapping.
                    call_id = _run_to_call.get(run_id)
                    if isinstance(tool_msg, str):
                        output_str = tool_msg
                    elif isinstance(tool_msg, (AIMessage, AIMessageChunk)):
                        # Sub-agent returned an AIMessage (e.g. task tool result).
                        content = tool_msg.content
                        if isinstance(content, str):
                            output_str = content
                        elif isinstance(content, list):
                            parts = [
                                p.get("text", "") if isinstance(p, dict) else str(p)
                                for p in content
                                if (isinstance(p, dict) and p.get("type") == "text") or isinstance(p, str)
                            ]
                            output_str = "\n".join(filter(None, parts))
                    elif isinstance(tool_msg, dict):
                        output_str = json.dumps(tool_msg, ensure_ascii=False)
                    elif isinstance(tool_msg, list):
                        output_str = json.dumps(tool_msg, ensure_ascii=False)
                    elif tool_msg is None:
                        output_str = "(completed)"

                # Clean up run_id mapping regardless of outcome.
                _run_to_call.pop(run_id, None)

                if call_id:
                    is_error = output_str.startswith("Error") or "error" in output_str.lower()[:20]
                    status_str = "failed" if is_error else "completed"

                    fr_item = FunctionToolResult(
                        call_id=call_id,
                        output=output_str,
                        status=ItemStatus.COMPLETED,
                    )
                    tool_history.append(fr_item)

                    yield _sse({
                        "type": "response.tool_result.done",
                        "call_id": call_id,
                        "output": output_str,
                        "status": status_str,
                    })

        # Stream finished — emit output_text.done + completed
        if accumulated_text:
            yield _sse({
                "type": "response.output_text.done",
                "text": accumulated_text,
            })

        response_obj = _build_empty_response(
            response_id=response_id,
            session_id=session_id,
            model=model,
            created_at=created_at,
            status=ResponseStatus.COMPLETED,
            text=accumulated_text,
            tool_history=tool_history,
        )
        yield _sse({
            "type": "response.completed",
            "response": response_obj.model_dump(mode="json"),
        })

    except GraphRecursionError:
        # Main agent hit its recursion limit.
        # Emit whatever text was accumulated so far as a completed response.
        logger.warning("Main agent hit recursion limit for session %s — emitting partial result", session_id)

        summary = accumulated_text.strip() if accumulated_text else (
            "최대 반복 횟수에 도달하여 작업을 마무리합니다. "
            "지금까지 수집된 정보를 바탕으로 결과를 정리했습니다."
        )

        if accumulated_text:
            yield _sse({"type": "response.output_text.done", "text": accumulated_text})

        response_obj = _build_empty_response(
            response_id=response_id,
            session_id=session_id,
            model=model,
            created_at=created_at,
            status=ResponseStatus.COMPLETED,
            text=summary,
            tool_history=tool_history,
        )
        yield _sse({"type": "response.completed", "response": response_obj.model_dump(mode="json")})

    except GraphInterrupt as gi:
        # Graph was interrupted (client tool call or approval needed).
        # gi.args[0] is a tuple of Interrupt objects.
        # GraphInterrupt is defined in langgraph.errors and inherits from
        # GraphBubbleUp. The interrupt values are stored in gi.args[0].
        raw_interrupts = gi.args[0] if gi.args else ()
        if not isinstance(raw_interrupts, (list, tuple)):
            raw_interrupts = (raw_interrupts,)

        # Build pending call list from interrupt values
        pending_calls: list[dict] = []
        for intr in raw_interrupts:
            value = intr.value if isinstance(intr, Interrupt) else intr
            if isinstance(value, dict) and value.get("type") == "client_tool_call":
                pending_calls.append({
                    "call_id": f"call_{uuid.uuid4().hex[:8]}",
                    "tool_name": value.get("tool_name", ""),
                    "display_name": value.get("display_name", ""),
                    "args": value.get("args", {}),
                })

        logger.info(
            "Graph interrupted for session %s: %d pending client tool calls",
            session_id,
            len(pending_calls),
        )

        response_obj = _build_empty_response(
            response_id=response_id,
            session_id=session_id,
            model=model,
            created_at=created_at,
            status=ResponseStatus.INCOMPLETE,
            text=accumulated_text,
            tool_history=tool_history,
        )
        # Attach pending calls to metadata
        resp_dict = response_obj.model_dump(mode="json")
        resp_dict["metadata"] = resp_dict.get("metadata") or {}
        resp_dict["metadata"]["pending_tool_calls"] = pending_calls

        yield _sse({
            "type": "response.incomplete",
            "response": resp_dict,
        })

    except Exception as exc:
        logger.exception("LangGraph streaming error for session %s", session_id)
        response_obj = _build_empty_response(
            response_id=response_id,
            session_id=session_id,
            model=model,
            created_at=created_at,
            status=ResponseStatus.FAILED,
            error=ErrorObject(
                type=ErrorType.SERVER_ERROR,
                message=str(exc),
            ),
        )
        yield _sse({
            "type": "response.failed",
            "response": response_obj.model_dump(mode="json"),
        })

    yield _sse_done()
