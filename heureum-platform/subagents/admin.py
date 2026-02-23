from django.contrib import admin

from .models import SubagentMessage, SubagentRun


class SubagentMessageInline(admin.TabularInline):
    model = SubagentMessage
    extra = 0
    readonly_fields = ("seq", "role", "tool_call_id", "tool_name", "created_at")


@admin.register(SubagentRun)
class SubagentRunAdmin(admin.ModelAdmin):
    list_display = (
        "child_session_id",
        "parent_session_id",
        "status",
        "created_at",
    )
    list_filter = ("status",)
    search_fields = ("child_session_id", "parent_session_id", "root_session_id")
    inlines = [SubagentMessageInline]
