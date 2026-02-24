from rest_framework import serializers

from .models import SubagentMessage, SubagentRun


class SubagentRunCreateSerializer(serializers.Serializer):
    child_session_id = serializers.CharField(max_length=64)
    root_session_id = serializers.CharField(max_length=64)
    parent_session_id = serializers.CharField(max_length=64)
    task = serializers.CharField()
    system_prompt = serializers.CharField(required=False, default="")
    started_at = serializers.FloatField()
    metadata = serializers.JSONField(required=False, default=dict)


class SubagentMessageCreateSerializer(serializers.Serializer):
    seq = serializers.IntegerField(min_value=0)
    role = serializers.CharField(max_length=20)
    content = serializers.CharField(allow_blank=True, allow_null=True, default="")
    tool_call_id = serializers.CharField(required=False, default="", allow_blank=True)
    tool_name = serializers.CharField(required=False, default="", allow_blank=True)
    metadata = serializers.JSONField(required=False, default=dict)


class SubagentRunCompleteSerializer(serializers.Serializer):
    status = serializers.ChoiceField(choices=["completed", "timeout", "failed"])
    result_summary = serializers.CharField(required=False, default="")
    completed_at = serializers.FloatField()
    input_tokens = serializers.IntegerField(required=False, default=0)
    output_tokens = serializers.IntegerField(required=False, default=0)
    total_tokens = serializers.IntegerField(required=False, default=0)
    cached_tokens = serializers.IntegerField(required=False, default=0)


class SubagentRunReadSerializer(serializers.ModelSerializer):
    class Meta:
        model = SubagentRun
        fields = [
            "child_session_id",
            "root_session_id",
            "parent_session_id",
            "task",
            "status",
            "result_summary",
            "started_at",
            "completed_at",
            "input_tokens",
            "output_tokens",
            "total_tokens",
            "cached_tokens",
            "metadata",
            "created_at",
        ]


class SubagentMessageReadSerializer(serializers.ModelSerializer):
    class Meta:
        model = SubagentMessage
        fields = [
            "seq",
            "role",
            "content",
            "tool_call_id",
            "tool_name",
            "metadata",
            "created_at",
        ]
