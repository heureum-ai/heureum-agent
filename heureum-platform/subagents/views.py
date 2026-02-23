import logging

from django.db import IntegrityError
from rest_framework import status
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.permissions import AllowAny
from rest_framework.request import Request
from rest_framework.response import Response

from .models import SubagentMessage, SubagentRun
from .serializers import (
    SubagentMessageCreateSerializer,
    SubagentMessageReadSerializer,
    SubagentRunCompleteSerializer,
    SubagentRunCreateSerializer,
    SubagentRunReadSerializer,
)

logger = logging.getLogger(__name__)


@api_view(["POST"])
@permission_classes([AllowAny])
@throttle_classes([])
def create_run(request: Request) -> Response:
    """POST /api/v1/subagents/internal/runs/ — create a sub-agent run."""
    serializer = SubagentRunCreateSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    data = serializer.validated_data

    try:
        SubagentRun.objects.create(**data)
        return Response({"ok": True, "created": True}, status=status.HTTP_201_CREATED)
    except IntegrityError:
        # Idempotent: already exists
        return Response({"ok": True, "created": False}, status=status.HTTP_200_OK)


@api_view(["POST"])
@permission_classes([AllowAny])
@throttle_classes([])
def create_message(request: Request, child_session_id: str) -> Response:
    """POST /api/v1/subagents/internal/runs/{child_session_id}/messages/"""
    try:
        run = SubagentRun.objects.get(child_session_id=child_session_id)
    except SubagentRun.DoesNotExist:
        return Response(
            {"ok": False, "error": "Run not found"},
            status=status.HTTP_404_NOT_FOUND,
        )

    serializer = SubagentMessageCreateSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    data = serializer.validated_data

    try:
        SubagentMessage.objects.create(run=run, **data)
        return Response({"ok": True, "created": True}, status=status.HTTP_201_CREATED)
    except IntegrityError:
        # Idempotent: (run, seq) already exists
        return Response({"ok": True, "created": False}, status=status.HTTP_200_OK)


@api_view(["PATCH"])
@permission_classes([AllowAny])
@throttle_classes([])
def complete_run(request: Request, child_session_id: str) -> Response:
    """PATCH /api/v1/subagents/internal/runs/{child_session_id}/complete/"""
    try:
        run = SubagentRun.objects.get(child_session_id=child_session_id)
    except SubagentRun.DoesNotExist:
        return Response(
            {"ok": False, "error": "Run not found"},
            status=status.HTTP_404_NOT_FOUND,
        )

    serializer = SubagentRunCompleteSerializer(data=request.data)
    serializer.is_valid(raise_exception=True)
    data = serializer.validated_data

    run.status = data["status"]
    run.result_summary = data.get("result_summary", "")
    run.completed_at = data["completed_at"]
    run.save(update_fields=["status", "result_summary", "completed_at"])

    return Response({"ok": True}, status=status.HTTP_200_OK)


# --- Read endpoints (Step 9) ---


@api_view(["GET"])
@permission_classes([AllowAny])
def list_runs(request: Request) -> Response:
    """GET /api/v1/subagents/runs/?session_id=..."""
    session_id = request.query_params.get("session_id")
    if not session_id:
        return Response(
            {"error": "session_id query parameter is required"},
            status=status.HTTP_400_BAD_REQUEST,
        )

    qs = SubagentRun.objects.filter(
        root_session_id=session_id,
    ) | SubagentRun.objects.filter(
        parent_session_id=session_id,
    )
    serializer = SubagentRunReadSerializer(qs.distinct(), many=True)
    return Response({"runs": serializer.data})


@api_view(["GET"])
@permission_classes([AllowAny])
def list_messages(request: Request, child_session_id: str) -> Response:
    """GET /api/v1/subagents/runs/{child_session_id}/messages/"""
    try:
        run = SubagentRun.objects.get(child_session_id=child_session_id)
    except SubagentRun.DoesNotExist:
        return Response(
            {"error": "Run not found"}, status=status.HTTP_404_NOT_FOUND
        )

    serializer = SubagentMessageReadSerializer(run.messages.all(), many=True)
    return Response({"messages": serializer.data})
