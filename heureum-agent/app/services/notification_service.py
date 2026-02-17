# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Notification service — sends notifications to users via Platform API.

The agent calls notify_user to push notifications to the user's devices.
Used by periodic tasks in headless mode to report results.
"""

import logging
from typing import Any, Dict

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

NOTIFY_USER_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "notify_user",
        "description": (
            "Send a push notification to the user. Use this to deliver results, "
            "alerts, or updates directly to the user's devices. "
            "Periodic tasks MUST call this at the end to report their results."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "title": {
                    "type": "string",
                    "description": "Notification title (short, descriptive)",
                },
                "body": {
                    "type": "string",
                    "description": "Notification body with the detailed message or results",
                },
            },
            "required": ["title", "body"],
        },
    },
}


class NotificationService:
    """Sends notifications via Platform API internal endpoint."""

    async def execute(
        self, name: str, arguments: Dict[str, Any], session_id: str
    ) -> str:
        """Send a notification to the user associated with the session."""
        title = arguments.get("title", "")
        body = arguments.get("body", "")

        if not title:
            return "Error: title is required"
        if not body:
            return "Error: body is required"

        payload = {
            "session_id": session_id,
            "title": title,
            "body": body,
        }

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    f"{settings.PLATFORM_API_URL}/api/v1/notifications/internal/send/",
                    json=payload,
                )
                if resp.status_code in (200, 201):
                    return f"Notification sent: {title}"
                return f"Error sending notification: {resp.text}"
        except Exception as e:
            logger.warning("Failed to send notification: %s", e)
            return f"Error sending notification: {e}"
