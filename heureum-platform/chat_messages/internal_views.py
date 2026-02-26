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

from chat_messages.models import Message, Response, Session, SkillSchema, ToolSchema

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
    cached_tokens = data.get("cached_tokens")
    if input_tokens is not None:
        response_obj.input_tokens = input_tokens
    if output_tokens is not None:
        response_obj.output_tokens = output_tokens
    if cached_tokens is not None:
        response_obj.cached_tokens = cached_tokens
    # Recompute total from both fields (handles partial updates correctly)
    if input_tokens is not None or output_tokens is not None:
        response_obj.total_tokens = (response_obj.input_tokens or 0) + (response_obj.output_tokens or 0)

    model = data.get("model")
    if model:
        response_obj.model = model

    if new_status in ("completed", "failed", "incomplete"):
        response_obj.completed_at = timezone.now()

    response_obj.save()

    # Touch session updated_at (QuerySet.update bypasses auto_now)
    Session.objects.filter(session_id=response_obj.session_id).update(
        updated_at=timezone.now()
    )

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


# ---------------------------------------------------------------------------
# Tool / Skill Schema Registry
# ---------------------------------------------------------------------------


@api_view(["POST"])
@permission_classes([AllowAny])
@throttle_classes([])
def register_tool_schemas(request):
    """Bulk upsert tool schemas from agent.

    Body: { "tools": [{ "tool_name", "description", "parameters_schema", "source", ... }] }
    Platform sets execution_target="server" for all agent-registered tools.
    """
    items = request.data.get("tools", [])
    count = 0
    for item in items:
        name = item.get("tool_name")
        if not name:
            continue
        ToolSchema.objects.update_or_create(
            tool_name=name,
            defaults={
                "description": item.get("description", ""),
                "parameters_schema": item.get("parameters_schema", {}),
                "display_name": item.get("display_name", ""),
                "guide": item.get("guide", ""),
                "source": item.get("source", "mcp"),
                "execution_target": "server",
                "requires_approval": item.get("requires_approval", False),
            },
        )
        count += 1
    return DRFResponse({"registered": count})


@api_view(["GET"])
@permission_classes([AllowAny])
@throttle_classes([])
def lookup_tool_schemas(request):
    """Fetch tool schemas by names.

    Query: ?names=web_fetch,read
    """
    names = [n.strip() for n in request.query_params.get("names", "").split(",") if n.strip()]
    if not names:
        return DRFResponse({"tools": []})
    schemas = ToolSchema.objects.filter(tool_name__in=names)
    return DRFResponse({
        "tools": [
            {
                "tool_name": s.tool_name,
                "source": s.source,
                "execution_target": s.execution_target,
                "display_name": s.display_name,
                "guide": s.guide,
                "requires_approval": s.requires_approval,
                "schema": s.to_openai_schema(),
            }
            for s in schemas
        ]
    })


@api_view(["POST"])
@permission_classes([AllowAny])
@throttle_classes([])
def register_skill_schemas(request):
    """Bulk upsert skill schemas.

    Body: { "skills": [{ "skill_name", "description", "tools", "depends_on",
                          "subagent_access", "source", "body" }] }
    """
    items = request.data.get("skills", [])
    count = 0
    for item in items:
        name = item.get("skill_name")
        if not name:
            continue
        SkillSchema.objects.update_or_create(
            skill_name=name,
            defaults={
                "description": item.get("description", ""),
                "tools": item.get("tools", []),
                "depends_on": item.get("depends_on", []),
                "subagent_access": item.get("subagent_access", "always"),
                "source": item.get("source", "server"),
                "body": item.get("body", ""),
            },
        )
        count += 1
    return DRFResponse({"registered": count})


@api_view(["GET"])
@permission_classes([AllowAny])
@throttle_classes([])
def lookup_skill_schemas(request):
    """Fetch skill metadata (without body).

    Query: ?names=web_search_task,plan_task  (optional, omit for all)
    """
    names = request.query_params.get("names", "")
    qs = SkillSchema.objects.all()
    if names:
        name_list = [n.strip() for n in names.split(",") if n.strip()]
        qs = qs.filter(skill_name__in=name_list)
    return DRFResponse({
        "skills": [
            {
                "skill_name": s.skill_name,
                "description": s.description,
                "tools": s.tools,
                "depends_on": s.depends_on,
                "subagent_access": s.subagent_access,
                "source": s.source,
            }
            for s in qs
        ]
    })


@api_view(["GET"])
@permission_classes([AllowAny])
@throttle_classes([])
def get_skill_body(request, skill_name):
    """Fetch full skill including body (for activated skills)."""
    try:
        s = SkillSchema.objects.get(skill_name=skill_name)
    except SkillSchema.DoesNotExist:
        return DRFResponse({"error": "not found"}, status=status.HTTP_404_NOT_FOUND)
    return DRFResponse({
        "skill_name": s.skill_name,
        "description": s.description,
        "tools": s.tools,
        "depends_on": s.depends_on,
        "subagent_access": s.subagent_access,
        "source": s.source,
        "body": s.body,
    })
