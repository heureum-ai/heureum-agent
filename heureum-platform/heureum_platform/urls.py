# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
URL configuration for heureum_platform project.
"""

from chat_messages.internal_views import (
    complete_response as internal_complete_response,
    get_skill_body as internal_get_skill_body,
    lookup_skill_schemas as internal_lookup_skill_schemas,
    lookup_tool_schemas as internal_lookup_tool_schemas,
    register_skill_schemas as internal_register_skill_schemas,
    register_tool_schemas as internal_register_tool_schemas,
    save_message as internal_save_message,
    save_tool_history as internal_save_tool_history,
)
from chat_messages.views import (
    MessageViewSet,
    QuestionViewSet,
    SessionViewSet,
    SuggestedQuestionViewSet,
    ToolPermissionViewSet,
)
from django.contrib import admin
from django.urls import include, path
from proxy.views import proxy_subagent_status, proxy_to_agent
from rest_framework.routers import DefaultRouter

router = DefaultRouter()
router.register(r"messages", MessageViewSet, basename="message")
router.register(r"permissions", ToolPermissionViewSet, basename="permission")
router.register(r"sessions", SessionViewSet, basename="session")
router.register(r"questions", QuestionViewSet, basename="question")
router.register(r"suggested-questions", SuggestedQuestionViewSet, basename="suggested_question")

urlpatterns = [
    path("admin/", admin.site.urls),
    path("api/v1/", include(router.urls)),
    # Open Responses endpoint
    path("v1/responses", proxy_to_agent, name="responses"),
    # Legacy endpoint (for backward compatibility)
    path("api/v1/proxy/", proxy_to_agent, name="proxy"),
    path(
        "api/v1/subagent/status/<str:session_id>/",
        proxy_subagent_status,
        name="subagent_status",
    ),
    # Authentication
    path("accounts/", include("allauth.urls")),
    path("_allauth/", include("allauth.headless.urls")),
    path("api/v1/auth/", include("accounts.urls")),
    # Notifications
    path("api/v1/notifications/", include("notifications.urls")),
    # Session files (nested under sessions)
    path("api/v1/sessions/", include("session_files.urls")),
    # Periodic tasks
    path("api/v1/periodic-tasks/", include("periodic_tasks.urls")),
    # Subagent persist
    path("api/v1/subagents/", include("subagents.urls")),
    # Internal message persist (agent → platform, real-time)
    path("api/v1/messages/internal/save/", internal_save_message, name="internal_save_message"),
    path(
        "api/v1/messages/internal/response/<str:response_id>/complete/",
        internal_complete_response,
        name="internal_complete_response",
    ),
    path("api/v1/messages/internal/tool-history/", internal_save_tool_history, name="internal_save_tool_history"),
    # Tool & Skill Schema Registry (agent → platform)
    path("api/v1/messages/internal/tools/register/", internal_register_tool_schemas, name="internal_register_tool_schemas"),
    path("api/v1/messages/internal/tools/lookup/", internal_lookup_tool_schemas, name="internal_lookup_tool_schemas"),
    path("api/v1/messages/internal/skills/register/", internal_register_skill_schemas, name="internal_register_skill_schemas"),
    path("api/v1/messages/internal/skills/lookup/", internal_lookup_skill_schemas, name="internal_lookup_skill_schemas"),
    path("api/v1/messages/internal/skills/<str:skill_name>/", internal_get_skill_body, name="internal_get_skill_body"),
]
