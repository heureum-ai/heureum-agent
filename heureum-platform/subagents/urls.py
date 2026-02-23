from django.urls import path

from . import views

urlpatterns = [
    # Internal write endpoints (agent → platform)
    path("internal/runs/", views.create_run, name="subagent-create-run"),
    path(
        "internal/runs/<str:child_session_id>/messages/",
        views.create_message,
        name="subagent-create-message",
    ),
    path(
        "internal/runs/<str:child_session_id>/complete/",
        views.complete_run,
        name="subagent-complete-run",
    ),
    # Read endpoints (Phase D)
    path("runs/", views.list_runs, name="subagent-list-runs"),
    path(
        "runs/<str:child_session_id>/messages/",
        views.list_messages,
        name="subagent-list-messages",
    ),
]
