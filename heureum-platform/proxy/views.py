# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Views for proxying requests to agent service using Open Responses spec."""

import json as json_mod
import uuid
from datetime import datetime
from datetime import timezone as dt_timezone
from decimal import Decimal

import httpx
from chat_messages.models import Message, ModelPricing, Question
from chat_messages.models import Response as ResponseModel
from chat_messages.models import Session
from chat_messages.serializers import ResponseRequestSerializer
from django.conf import settings
from django.core.cache import cache
from django.db.models import F
from django.http import StreamingHttpResponse
from django.utils import timezone
from rest_framework import status as http_status
from rest_framework.decorators import api_view, permission_classes
from rest_framework.permissions import IsAuthenticated
from rest_framework.request import Request
from rest_framework.response import Response

# Module-level persistent client — reuses TCP connections across requests
# instead of opening/closing a connection per request.
_agent_client = httpx.Client(
    limits=httpx.Limits(
        max_connections=100,
        max_keepalive_connections=20,
        keepalive_expiry=30,
    ),
    timeout=httpx.Timeout(60.0, connect=5.0),
)


@api_view(["POST"])
def proxy_to_agent(request: Request) -> Response:
    """
    Proxy chat requests to the agent service using Open Responses format.

    Endpoint: POST /v1/responses

    Args:
        request: HTTP request containing Open Responses request format

    Returns:
        Open Responses response format
    """
    try:
        # Validate request using Open Responses format
        serializer = ResponseRequestSerializer(data=request.data)
        if not serializer.is_valid():
            return Response(
                {
                    "type": "invalid_request",
                    "message": "Invalid request format",
                    "param": str(serializer.errors),
                },
                status=http_status.HTTP_400_BAD_REQUEST,
            )

        data = serializer.validated_data

        # Extract session_id from metadata or generate a unique one
        metadata = data.get("metadata") or {}
        session_id = metadata.get("session_id") or f"sess_{uuid.uuid4().hex}"

        # Ensure session exists and is associated with the current user
        session_defaults = {}
        if request.user.is_authenticated:
            session_defaults["user"] = request.user
        session_obj, session_created = Session.objects.get_or_create(
            session_id=session_id,
            defaults=session_defaults,
        )
        if not session_created and request.user.is_authenticated and session_obj.user is None:
            session_obj.user = request.user
            session_obj.save(update_fields=["user"])

        # Ensure the agent receives the same session_id the platform uses.
        # Without this, a new conversation (no session_id in metadata) causes
        # the platform and agent to generate different IDs, breaking internal
        # endpoints like periodic task registration that look up sessions by ID.
        if "metadata" not in data or data["metadata"] is None:
            data["metadata"] = {}
        data["metadata"]["session_id"] = session_id
        if session_obj.cwd:
            data["metadata"]["cwd"] = session_obj.cwd

        # Create a Response object
        response_obj = ResponseModel.objects.create(
            session_id=session_id,
            model=data.get("model", "default"),
            status="in_progress",
            previous_response_id=data.get("previous_response_id"),
            metadata=data.get("metadata", {}),
        )

        # Pass response_id to agent so it can persist messages in real-time
        data["metadata"]["response_id"] = response_obj.id

        # Store input messages
        input_data = data.get("input")
        input_messages = []

        if isinstance(input_data, str):
            # Simple string input - convert to user message
            input_messages = [
                {
                    "role": "user",
                    "content": [{"type": "input_text", "text": input_data}],
                }
            ]
        elif isinstance(input_data, list):
            # Already in Open Responses format
            input_messages = input_data

        # Store input items — only genuinely new ones to avoid duplication.
        # The frontend sends the full conversation as context, but only the
        # latest user message and tool round-trip items are new.
        # Detect follow-up requests: if the input contains function_call_output
        # items, the user message is just re-sent context (already persisted).
        has_tool_results = any(m.get("type") == "function_call_output" for m in input_messages)

        for msg in input_messages:
            item_type = msg.get("type", "message")
            if item_type == "function_call_output":
                Message.objects.create(
                    session_id=session_id,
                    response=response_obj,
                    type=item_type,
                    role="tool",
                    content=msg,
                    status=msg.get("status", "completed"),
                )
                # Update Question record when user answers
                if item_type == "function_call_output":
                    call_id = msg.get("call_id", "")
                    try:
                        question = Question.objects.filter(call_id=call_id).first()
                        if question:
                            output_text = msg.get("output", "")
                            if output_text.startswith("User input:"):
                                question.answer_type = "user_input"
                                question.user_answer = output_text[len("User input: ") :]
                            elif output_text.startswith("User chose:"):
                                question.answer_type = "choice"
                                question.user_answer = output_text[len("User chose: ") :]
                            else:
                                question.user_answer = output_text
                            question.save()
                    except Exception:
                        pass

        # Only store the last user message on initial requests.
        # Follow-up requests (containing function_call_output) re-send the
        # user message as context — it was already persisted on the first request.
        if not has_tool_results:
            user_msgs = [
                m
                for m in input_messages
                if m.get("type", "message") == "message" and m.get("role") == "user"
            ]
            if user_msgs:
                last_user = user_msgs[-1]
                Message.objects.create(
                    session_id=session_id,
                    response=response_obj,
                    role="user",
                    content=last_user.get("content", []),
                    status="completed",
                )

        # Streaming pass-through
        if data.get("stream"):
            return _proxy_streaming(serializer.validated_data, session_id, response_obj)

        # Forward request to agent service (non-streaming)
        agent_url = f"{settings.AGENT_SERVICE_URL}/v1/responses"
        agent_response = _agent_client.post(
            agent_url,
            json=serializer.validated_data,
        )
        agent_response.raise_for_status()
        response_data = agent_response.json()

        _persist_output(response_data, session_id, response_obj)

        # Ensure the frontend knows which session this belongs to
        if "metadata" not in response_data:
            response_data["metadata"] = {}
        response_data["metadata"]["session_id"] = session_id

        # Inject cost data into usage
        if "usage" in response_data:
            response_data["usage"]["input_cost"] = float(response_obj.input_cost)
            response_data["usage"]["output_cost"] = float(response_obj.output_cost)
            response_data["usage"]["total_cost"] = float(response_obj.total_cost)

        return Response(response_data, status=http_status.HTTP_200_OK)

    except httpx.HTTPError as e:
        # Update response status to failed
        if "response_obj" in locals():
            response_obj.status = "failed"
            response_obj.completed_at = timezone.now()
            response_obj.save()

        return Response(
            {
                "type": "server_error",
                "message": f"Agent service error: {str(e)}",
            },
            status=http_status.HTTP_502_BAD_GATEWAY,
        )
    except Exception as e:
        # Update response status to failed
        if "response_obj" in locals():
            response_obj.status = "failed"
            response_obj.completed_at = timezone.now()
            response_obj.save()

        return Response(
            {
                "type": "server_error",
                "message": f"Server error: {str(e)}",
            },
            status=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
        )


@api_view(["GET"])
@permission_classes([IsAuthenticated])
def proxy_subagent_status(request: Request, session_id: str) -> Response:
    """Proxy sub-agent status requests to the agent service."""
    # Verify session ownership
    try:
        session = Session.objects.get(session_id=session_id)
    except Session.DoesNotExist:
        return Response({"error": "Session not found"}, status=http_status.HTTP_404_NOT_FOUND)
    if session.user and session.user != request.user:
        return Response({"error": "Session not found"}, status=http_status.HTTP_404_NOT_FOUND)

    try:
        agent_url = f"{settings.AGENT_SERVICE_URL}/v1/subagent/status/{session_id}"
        agent_response = _agent_client.get(agent_url)
        try:
            payload = agent_response.json()
        except ValueError:
            payload = {"detail": agent_response.text}
        return Response(payload, status=agent_response.status_code)
    except httpx.HTTPError as e:
        return Response(
            {
                "type": "server_error",
                "message": f"Agent service error: {str(e)}",
            },
            status=http_status.HTTP_502_BAD_GATEWAY,
        )
    except Exception as e:
        return Response(
            {
                "type": "server_error",
                "message": f"Server error: {str(e)}",
            },
            status=http_status.HTTP_500_INTERNAL_SERVER_ERROR,
        )


def _calculate_cost(input_tokens, output_tokens, pricing):
    """Calculate input and output costs given token counts and pricing."""
    if not pricing:
        return Decimal(0), Decimal(0)
    input_cost = Decimal(input_tokens) * pricing.input_cost_per_mtok / Decimal(1_000_000)
    output_cost = Decimal(output_tokens) * pricing.output_cost_per_mtok / Decimal(1_000_000)
    return input_cost, output_cost


def _persist_output(response_data, session_id, response_obj, item_usages=None, todo_state=None):
    """Store output items and update response object from agent response.

    If the agent already persisted messages in real-time (messages with seq),
    this function skips creating duplicate text/tool messages and only handles
    items the agent didn't persist (function_calls, tool_history, todo_state)
    plus the response-level usage/cost update.
    """
    output_items = response_data.get("output", [])
    model_name = response_data.get("model", "")
    pricing = ModelPricing.get_for_model(model_name)

    # Check which messages the agent already persisted in real-time (per-message dedup).
    # Using per-seq check instead of all-or-nothing to handle partial persist
    # (e.g. agent crashes after persisting 2 of 5 messages).
    existing_seqs = set(
        Message.objects.filter(response=response_obj, seq__isnull=False)
        .values_list("seq", flat=True)
    )
    agent_persisted = bool(existing_seqs)

    # Build per-iteration usage lookup from streaming events
    # text_usages[i] = usage dict for the i-th assistant text message
    text_usages = []
    if item_usages:
        for iu in item_usages:
            if iu["type"] == "text":
                text_usages.append(iu["usage"])

    text_idx = 0
    for item in output_items:
        item_type = item.get("type", "message")
        if item_type == "function_call":
            Message.objects.create(
                session_id=session_id,
                response=response_obj,
                type=item_type,
                role="tool",
                content=item,
                status=item.get("status", "completed"),
                metadata={"item_id": item.get("id")},
                model=model_name,
            )
            if item.get("name") == "ask_question":
                try:
                    args = json_mod.loads(item.get("arguments", "{}"))
                    Question.objects.create(
                        session_id=session_id,
                        response=response_obj,
                        call_id=item.get("call_id", ""),
                        question_text=args.get("question", ""),
                        choices=args.get("choices", []),
                        allow_user_input=args.get("allow_user_input", False),
                    )
                except (json_mod.JSONDecodeError, Exception):
                    pass
        else:
            # Assistant text message — assign per-iteration usage
            item_usage = text_usages[text_idx] if text_idx < len(text_usages) else {}
            text_idx += 1

            # Skip if agent already persisted this specific message in real-time.
            # Use text_idx as the seq proxy: agent assigns seq sequentially,
            # and text messages correspond to text_idx in order.
            if agent_persisted and (text_idx - 1) in existing_seqs:
                continue

            msg_input = item_usage.get("input_tokens", 0)
            msg_output = item_usage.get("output_tokens", 0)
            msg_total = item_usage.get("total_tokens", 0)
            msg_input_cost, msg_output_cost = _calculate_cost(msg_input, msg_output, pricing)

            Message.objects.create(
                session_id=session_id,
                response=response_obj,
                role=item.get("role", "assistant"),
                content=item.get("content", []),
                status=item.get("status", "completed"),
                metadata={"item_id": item.get("id")},
                model=model_name,
                input_tokens=msg_input,
                output_tokens=msg_output,
                total_tokens=msg_total,
                input_cost=msg_input_cost,
                output_cost=msg_output_cost,
                total_cost=msg_input_cost + msg_output_cost,
            )

    # Persist server-side tool calls from tool_history (not in output array)
    tool_history = (response_data.get("metadata") or {}).get("tool_history", [])
    for th_item in tool_history:
        th_type = th_item.get("type", "")
        if th_type in ("function_call", "function_call_output"):
            Message.objects.create(
                session_id=session_id,
                response=response_obj,
                type=th_type,
                role="tool",
                content=th_item,
                status=th_item.get("status", "completed"),
                metadata={"item_id": th_item.get("id")},
                model=model_name,
            )

    # Persist todo state captured from response.todo.updated SSE events
    if todo_state:
        # If no text messages consumed per-item usage, attribute response-level
        # cost to the todo_state so it remains visible in the UI.
        todo_tokens = {}
        if text_idx == 0:
            usage = response_data.get("usage", {})
            todo_input = usage.get("input_tokens", 0)
            todo_output = usage.get("output_tokens", 0)
            todo_total = usage.get("total_tokens", 0)
            todo_input_cost, todo_output_cost = _calculate_cost(
                todo_input, todo_output, pricing
            )
            todo_tokens = dict(
                input_tokens=todo_input,
                output_tokens=todo_output,
                total_tokens=todo_total,
                input_cost=todo_input_cost,
                output_cost=todo_output_cost,
                total_cost=todo_input_cost + todo_output_cost,
            )
        Message.objects.create(
            session_id=session_id,
            response=response_obj,
            type="todo_state",
            role="assistant",
            content=todo_state,
            status="completed",
            **todo_tokens,
        )

    # Response-level usage and pricing
    usage = response_data.get("usage", {})
    response_obj.status = response_data.get("status", "completed")
    response_obj.model = model_name

    completed_at_ts = response_data.get("completed_at")
    if completed_at_ts:
        response_obj.completed_at = datetime.fromtimestamp(completed_at_ts, tz=dt_timezone.utc)

    response_obj.input_tokens = usage.get("input_tokens", 0)
    response_obj.output_tokens = usage.get("output_tokens", 0)
    response_obj.total_tokens = usage.get("total_tokens", 0)

    resp_input_cost, resp_output_cost = _calculate_cost(
        response_obj.input_tokens, response_obj.output_tokens, pricing
    )
    response_obj.input_cost = resp_input_cost
    response_obj.output_cost = resp_output_cost
    response_obj.total_cost = resp_input_cost + resp_output_cost
    response_obj.save()

    # Update session aggregates atomically
    Session.objects.filter(session_id=session_id).update(
        total_input_tokens=F("total_input_tokens") + response_obj.input_tokens,
        total_output_tokens=F("total_output_tokens") + response_obj.output_tokens,
        total_tokens=F("total_tokens") + response_obj.total_tokens,
        total_cost=F("total_cost") + response_obj.total_cost,
    )

    # Bust session list cache for this user
    try:
        session = Session.objects.get(session_id=session_id)
        if session.user_id:
            cache.delete(f"user_sessions:{session.user_id}")
    except Session.DoesNotExist:
        pass


def _proxy_streaming(request_data, session_id, response_obj):
    """Stream SSE events from agent to client, persisting after completion."""
    agent_url = f"{settings.AGENT_SERVICE_URL}/v1/responses"

    def _inject_usage_cost(usage_dict, pricing):
        """Add cost fields to a usage dict in-place."""
        if not usage_dict:
            return
        input_cost, output_cost = _calculate_cost(
            usage_dict.get("input_tokens", 0),
            usage_dict.get("output_tokens", 0),
            pricing,
        )
        usage_dict["input_cost"] = float(input_cost)
        usage_dict["output_cost"] = float(output_cost)
        usage_dict["total_cost"] = float(input_cost + output_cost)

    def event_stream():
        final_response_data = None
        item_usages = []  # Collect per-item usage from intermediate events
        pricing = None  # Looked up once on response.created
        last_todo_state = None  # Capture latest todo snapshot from SSE

        try:
            with _agent_client.stream(
                "POST",
                agent_url,
                json=request_data,
                timeout=300.0,
            ) as resp:
                resp.raise_for_status()
                for line in resp.iter_lines():
                    # Parse to collect usage and find the final response
                    if line.startswith("data: ") and line[6:] != "[DONE]":
                        try:
                            event = json_mod.loads(line[6:])
                            evt_type = event.get("type", "")

                            if evt_type == "response.created":
                                # Look up pricing once from the model name
                                model_name = event.get("response", {}).get("model", "")
                                pricing = ModelPricing.get_for_model(model_name)
                                yield line + "\n"

                            elif evt_type == "response.output_text.done":
                                usage = event.get("usage")
                                if usage:
                                    item_usages.append({"type": "text", "usage": usage})
                                    _inject_usage_cost(usage, pricing)
                                    yield f"data: {json_mod.dumps(event)}\n"
                                else:
                                    yield line + "\n"

                            elif evt_type == "response.function_call.done":
                                usage = event.get("usage")
                                if usage:
                                    _inject_usage_cost(usage, pricing)
                                    yield f"data: {json_mod.dumps(event)}\n"
                                else:
                                    yield line + "\n"

                            elif evt_type == "response.todo.updated":
                                last_todo_state = event.get("todo")
                                yield line + "\n"

                            elif evt_type in (
                                "response.completed",
                                "response.incomplete",
                                "response.failed",
                            ):
                                final_response_data = event.get("response", {})
                                # Inject session_id into metadata
                                if "metadata" not in final_response_data:
                                    final_response_data["metadata"] = {}
                                final_response_data["metadata"]["session_id"] = session_id

                                # Inject costs into final response usage
                                resp_usage = final_response_data.get("usage", {})
                                _inject_usage_cost(resp_usage, pricing)

                                event["response"] = final_response_data
                                yield f"data: {json_mod.dumps(event)}\n"
                            else:
                                yield line + "\n"
                        except (json_mod.JSONDecodeError, Exception):
                            yield line + "\n"
                    else:
                        yield line + "\n"
        except Exception as e:
            # Emit error event to frontend
            error_event = {
                "type": "response.failed",
                "response": {
                    "status": "failed",
                    "error": {"type": "server_error", "message": str(e)},
                    "metadata": {"session_id": session_id},
                },
            }
            yield f"data: {json_mod.dumps(error_event)}\n"
            yield "data: [DONE]\n"
            final_response_data = error_event.get("response")

        # Persist the final response after stream completes
        if final_response_data:
            try:
                _persist_output(
                    final_response_data,
                    session_id,
                    response_obj,
                    item_usages=item_usages,
                    todo_state=last_todo_state,
                )
            except Exception:
                pass

    resp = StreamingHttpResponse(
        event_stream(),
        content_type="text/event-stream",
    )
    resp["Cache-Control"] = "no-cache"
    resp["X-Accel-Buffering"] = "no"
    return resp
