# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Serializers for Open Responses message models."""
from rest_framework import serializers
from .models import Message, Response, Session, ToolPermission, Question, SuggestedQuestion


class ContentPartSerializer(serializers.Serializer):
    """Serializer for content parts."""
    type = serializers.CharField()
    text = serializers.CharField(required=False)


class MessageItemSerializer(serializers.Serializer):
    """Serializer for Open Responses message items."""
    id = serializers.CharField(read_only=True)
    type = serializers.CharField(default="message")
    role = serializers.ChoiceField(choices=["user", "assistant", "system", "developer"])
    status = serializers.ChoiceField(
        choices=["in_progress", "incomplete", "completed", "failed"],
        default="completed"
    )
    content = serializers.ListField(child=ContentPartSerializer(), required=False, default=list)


class UsageSerializer(serializers.Serializer):
    """Serializer for token usage statistics."""
    input_tokens = serializers.IntegerField()
    output_tokens = serializers.IntegerField()
    total_tokens = serializers.IntegerField()


class ResponseObjectSerializer(serializers.Serializer):
    """Serializer for Open Responses response object."""
    id = serializers.CharField(read_only=True)
    created_at = serializers.IntegerField(read_only=True)
    completed_at = serializers.IntegerField(required=False, allow_null=True)
    model = serializers.CharField(default="default")
    status = serializers.ChoiceField(
        choices=["in_progress", "incomplete", "completed", "failed"],
        default="completed"
    )
    output = serializers.JSONField()  # Heterogeneous: messages + tool calls
    usage = UsageSerializer(required=False, allow_null=True)
    metadata = serializers.JSONField(required=False, default=dict)


class ResponseRequestSerializer(serializers.Serializer):
    """Serializer for Open Responses request."""
    model = serializers.CharField(default="default")
    input = serializers.JSONField()  # Can be string or list of items
    tools = serializers.JSONField(required=False, default=None)
    previous_response_id = serializers.CharField(required=False, allow_null=True)
    instructions = serializers.CharField(required=False, allow_null=True)
    temperature = serializers.FloatField(required=False, min_value=0, max_value=2, allow_null=True)
    max_output_tokens = serializers.IntegerField(required=False, min_value=1, allow_null=True)
    tool_choice = serializers.JSONField(required=False, allow_null=True)
    truncation = serializers.ChoiceField(
        required=False,
        allow_null=True,
        choices=["auto", "disabled"],
    )
    skills_snapshot = serializers.JSONField(required=False, allow_null=True)
    stream = serializers.BooleanField(default=False)
    metadata = serializers.JSONField(required=False, default=dict)


class MessageSerializer(serializers.ModelSerializer):
    """Serializer for Message model (legacy/admin compatibility)."""

    class Meta:
        """Meta options for MessageSerializer."""
        model = Message
        fields = [
            "id",
            "type",
            "role",
            "status",
            "content",
            "session_id",
            "metadata",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]


class ResponseSerializer(serializers.ModelSerializer):
    """Serializer for Response model."""
    output_items = MessageSerializer(many=True, read_only=True)

    class Meta:
        """Meta options for ResponseSerializer."""
        model = Response
        fields = [
            "id",
            "session_id",
            "model",
            "status",
            "created_at",
            "completed_at",
            "input_tokens",
            "output_tokens",
            "total_tokens",
            "metadata",
            "previous_response_id",
            "output_items",
        ]
        read_only_fields = ["id", "created_at"]


class SessionSerializer(serializers.ModelSerializer):
    """Serializer for Session model."""
    message_count = serializers.IntegerField(read_only=True, default=0)

    class Meta:
        model = Session
        fields = [
            "id", "session_id", "title", "cwd", "created_at", "updated_at",
            "message_count", "total_input_tokens", "total_output_tokens",
            "total_tokens", "total_cost",
        ]
        read_only_fields = ["id", "created_at", "updated_at", "message_count"]


class SessionCwdUpdateSerializer(serializers.Serializer):
    """Serializer for updating session CWD."""
    cwd = serializers.CharField(max_length=1024)


class ToolPermissionSerializer(serializers.ModelSerializer):
    """Serializer for ToolPermission model."""

    class Meta:
        model = ToolPermission
        fields = ["id", "client_id", "tool_name", "command", "allowed", "created_at", "updated_at"]
        read_only_fields = ["id", "created_at", "updated_at"]


class QuestionSerializer(serializers.ModelSerializer):
    """Serializer for Question model."""

    class Meta:
        model = Question
        fields = [
            "id",
            "session_id",
            "response",
            "call_id",
            "question_text",
            "choices",
            "allow_user_input",
            "user_answer",
            "answer_type",
            "created_at",
            "updated_at",
        ]
        read_only_fields = ["id", "created_at", "updated_at"]


class SuggestedQuestionSerializer(serializers.ModelSerializer):
    class Meta:
        model = SuggestedQuestion
        fields = ["id", "question_text", "order"]
        read_only_fields = ["id"]
