# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Internal endpoints for real-time message persistence from the agent.

These endpoints are called by PersistController (fire-and-forget) during
the agent loop to persist messages as they are generated, rather than
waiting until the response is complete.

All endpoints are idempotent: duplicate calls with the same
(response_id, seq) are silently ignored via the unique constraint.
"""

import logging
import uuid

from django.db import IntegrityError
from django.utils import timezone
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response as DRFResponse

from chat_messages.models import Message, Response, Session

logger = logging.getLogger(__name__)


@api_view(["POST"])
@permission_classes([AllowAny])
@throttle_classes([])
def save_message(request):
    """Idempotent message save.

    Body: {
        session_id, response_id, seq, type, role, content,
        status?, metadata?, model?
    }
    """
    data = request.data
    response_id = data.get("response_id")
    seq = data.get("seq")
    session_id = data.get("session_id", "")
    msg_type = data.get("type", "message")
    role = data.get("role", "assistant")
    content = data.get("content", "")
    msg_status = data.get("status", "completed")
    metadata = data.get("metadata", {})
    model = data.get("model", "")

    if not response_id:
        return DRFResponse(
            {"error": "response_id is required"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    # Ensure response object exists
    try:
        response_obj = Response.objects.get(id=response_id)
    except Response.DoesNotExist:
        return DRFResponse(
            {"error": f"Response {response_id} not found"},
            status=status.HTTP_404_NOT_FOUND,
        )

    # Normalize content to Open Responses format
    if isinstance(content, str):
        if role == "assistant":
            content_parts = [{"type": "output_text", "text": content}]
        else:
            content_parts = [{"type": "input_text", "text": content}]
    else:
        content_parts = content

    try:
        Message.objects.create(
            id=f"msg_{uuid.uuid4().hex}",
            type=msg_type,
            role=role,
            status=msg_status,
            content=content_parts,
            response=response_obj,
            session_id=session_id,
            seq=seq,
            metadata=metadata,
            model=model,
        )
    except IntegrityError:
        # Duplicate (response_id, seq) — idempotent, silently ignore
        logger.debug("Duplicate message save ignored: response=%s seq=%s", response_id, seq)

    return DRFResponse({"ok": True}, status=status.HTTP_201_CREATED)


@api_view(["PATCH"])
@permission_classes([AllowAny])
@throttle_classes([])
def complete_response(request, response_id):
    """Update Response status and usage.

    Body: { status, input_tokens?, output_tokens?, model? }
    """
    data = request.data

    try:
        response_obj = Response.objects.get(id=response_id)
    except Response.DoesNotExist:
        return DRFResponse(
            {"error": f"Response {response_id} not found"},
            status=status.HTTP_404_NOT_FOUND,
        )

    new_status = data.get("status")
    if new_status:
        response_obj.status = new_status

    input_tokens = data.get("input_tokens")
    output_tokens = data.get("output_tokens")
    if input_tokens is not None:
        response_obj.input_tokens = input_tokens
    if output_tokens is not None:
        response_obj.output_tokens = output_tokens
    # Recompute total from both fields (handles partial updates correctly)
    if input_tokens is not None or output_tokens is not None:
        response_obj.total_tokens = (response_obj.input_tokens or 0) + (response_obj.output_tokens or 0)

    model = data.get("model")
    if model:
        response_obj.model = model

    if new_status in ("completed", "failed", "incomplete"):
        response_obj.completed_at = timezone.now()

    response_obj.save()

    return DRFResponse({"ok": True})


@api_view(["POST"])
@permission_classes([AllowAny])
@throttle_classes([])
def save_tool_history(request):
    """Bulk save tool history items (function_call + function_call_output).

    Body: {
        session_id, response_id,
        items: [{ type, role?, content, call_id?, name?, arguments? }]
    }
    """
    data = request.data
    response_id = data.get("response_id")
    session_id = data.get("session_id", "")
    items = data.get("items", [])

    if not response_id:
        return DRFResponse(
            {"error": "response_id is required"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    try:
        response_obj = Response.objects.get(id=response_id)
    except Response.DoesNotExist:
        return DRFResponse(
            {"error": f"Response {response_id} not found"},
            status=status.HTTP_404_NOT_FOUND,
        )

    created_count = 0
    for item in items:
        item_type = item.get("type", "function_call")
        role = item.get("role", "tool")

        # Build content based on item type
        if item_type == "function_call":
            content = [{
                "type": "function_call",
                "name": item.get("name", ""),
                "call_id": item.get("call_id", ""),
                "arguments": item.get("arguments", ""),
            }]
        elif item_type == "function_call_output":
            content = [{
                "type": "function_call_output",
                "call_id": item.get("call_id", ""),
                "output": item.get("output", item.get("content", "")),
            }]
        else:
            content = item.get("content", [])
            if isinstance(content, str):
                content = [{"type": "input_text", "text": content}]

        Message.objects.create(
            id=f"msg_{uuid.uuid4().hex}",
            type=item_type,
            role=role,
            status="completed",
            content=content,
            response=response_obj,
            session_id=session_id,
        )
        created_count += 1

    return DRFResponse({"ok": True, "created": created_count}, status=status.HTTP_201_CREATED)
