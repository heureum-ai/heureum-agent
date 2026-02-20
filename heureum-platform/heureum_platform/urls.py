# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
URL configuration for heureum_platform project.
"""

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
]
