# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Periodic task service — manages registration and control of scheduled tasks.

The agent calls manage_periodic_task to register recurring tasks after
a successful dry run.  State is persisted via the Platform API.
"""

import logging
from typing import Any, Dict

import httpx

from app.config import settings

logger = logging.getLogger(__name__)

MANAGE_PERIODIC_TASK_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "manage_periodic_task",
        "description": (
            "Register, list, or manage periodic (scheduled) tasks. "
            "Use this after successfully completing a dry run of a repeating task "
            "to register it as a periodic task that runs automatically on schedule."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["register", "list", "cancel", "pause", "resume"],
                    "description": "Action to perform on periodic tasks",
                },
                "title": {
                    "type": "string",
                    "description": "Short title for the periodic task (required for 'register')",
                },
                "description": {
                    "type": "string",
                    "description": "Longer description of what the task does (for 'register')",
                },
                "recipe": {
                    "type": "object",
                    "description": (
                        "Execution recipe JSON learned from the dry run (required for 'register'). "
                        "Must include: objective, instructions (array), tools_required (array), "
                        "output_spec (object with file_pattern and summary_template), "
                        "dry_run_result (object with success boolean and sample_output_path)"
                    ),
                },
                "schedule": {
                    "type": "object",
                    "description": (
                        "Schedule specification (required for 'register'). "
                        'Example: {"type": "cron", "cron": {"minute": 0, "hour": 9, '
                        '"day_of_month": "*", "month": "*", "day_of_week": "*"}}'
                    ),
                },
                "timezone": {
                    "type": "string",
                    "description": "IANA timezone for the schedule (default: Asia/Seoul)",
                },
                "task_id": {
                    "type": "string",
                    "description": "ID of the periodic task (required for 'cancel', 'pause', 'resume')",
                },
                "notify_on_success": {
                    "type": "boolean",
                    "description": (
                        "Whether to send a system notification when the task completes successfully. "
                        "Set to false if the task already sends its own notification via notify_user. "
                        "Default: true. Only used with 'register' action."
                    ),
                },
            },
            "required": ["action"],
        },
    },
}


class PeriodicTaskService:
    """Manages periodic tasks via Platform API."""

    async def execute(
        self, name: str, arguments: Dict[str, Any], session_id: str
    ) -> str:
        """Dispatch manage_periodic_task tool calls by action."""
        action = arguments.get("action", "")

        if action == "register":
            return await self._register(session_id, arguments)
        elif action == "list":
            return await self._list(session_id)
        elif action == "cancel":
            return await self._update_status(arguments.get("task_id", ""), "completed")
        elif action == "pause":
            return await self._update_status(arguments.get("task_id", ""), "paused")
        elif action == "resume":
            return await self._resume(arguments.get("task_id", ""))
        else:
            return f"Unknown action: {action}"

    async def _register(self, session_id: str, args: Dict[str, Any]) -> str:
        """Register a new periodic task via Platform API."""
        title = args.get("title", "")
        if not title:
            return "Error: title is required"

        recipe = args.get("recipe")
        if not recipe:
            return "Error: recipe is required"

        schedule = args.get("schedule")
        if not schedule:
            return "Error: schedule is required"

        payload = {
            "session_id": session_id,
            "title": title,
            "description": args.get("description", ""),
            "recipe": recipe,
            "schedule": schedule,
            "timezone_name": args.get("timezone", "Asia/Seoul"),
            "notify_on_success": args.get("notify_on_success", True),
        }

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    f"{settings.MCP_SERVER_URL}/api/v1/periodic-tasks/internal/create/",
                    json=payload,
                )
                if resp.status_code in (200, 201):
                    data = resp.json()
                    import json
                    return json.dumps({
                        "success": True,
                        "task": {
                            "id": data["id"],
                            "title": data["title"],
                            "description": data.get("description", ""),
                            "schedule_display": _format_schedule(data.get("schedule", {})),
                            "timezone_name": data.get("timezone_name", "Asia/Seoul"),
                            "next_run_at": data.get("next_run_at"),
                            "status": data["status"],
                            "notify_on_success": data.get("notify_on_success", True),
                        },
                    })
                return f"Error registering periodic task: {resp.text}"
        except Exception as e:
            logger.warning("Failed to register periodic task: %s", e)
            return f"Error registering periodic task: {e}"

    async def _list(self, session_id: str) -> str:
        """List periodic tasks for the current session."""
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(
                    f"{settings.MCP_SERVER_URL}/api/v1/periodic-tasks/internal/list/",
                    params={"session_id": session_id},
                )
                if resp.status_code == 200:
                    tasks = resp.json()
                    import json
                    return json.dumps({
                        "success": True,
                        "tasks": [
                            {
                                "id": t["id"],
                                "title": t["title"],
                                "status": t["status"],
                                "schedule_display": _format_schedule(t.get("schedule", {})),
                                "next_run_at": t.get("next_run_at"),
                                "total_runs": t["total_runs"],
                                "total_successes": t["total_successes"],
                                "total_failures": t["total_failures"],
                            }
                            for t in tasks
                        ],
                    })
                return f"Error listing periodic tasks: {resp.text}"
        except Exception as e:
            logger.warning("Failed to list periodic tasks: %s", e)
            return f"Error listing periodic tasks: {e}"

    async def _update_status(self, task_id: str, status: str) -> str:
        """Update a periodic task's status."""
        if not task_id:
            return "Error: task_id is required"

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.patch(
                    f"{settings.MCP_SERVER_URL}/api/v1/periodic-tasks/internal/{task_id}/update/",
                    json={"status": status},
                )
                if resp.status_code == 200:
                    data = resp.json()
                    return f"Periodic task {task_id} updated to status: {data['status']}"
                return f"Error updating task: {resp.text}"
        except Exception as e:
            logger.warning("Failed to update periodic task: %s", e)
            return f"Error updating task: {e}"

    async def _resume(self, task_id: str) -> str:
        """Resume a paused periodic task."""
        if not task_id:
            return "Error: task_id is required"

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(
                    f"{settings.MCP_SERVER_URL}/api/v1/periodic-tasks/internal/{task_id}/resume/",
                )
                if resp.status_code == 200:
                    data = resp.json()
                    return (
                        f"Periodic task {task_id} resumed.\n"
                        f"  Next run: {data.get('next_run_at', 'N/A')}"
                    )
                return f"Error resuming task: {resp.text}"
        except Exception as e:
            logger.warning("Failed to resume periodic task: %s", e)
            return f"Error resuming task: {e}"


def _format_schedule(schedule: dict) -> str:
    """Format a schedule dict into human-readable text."""
    if not schedule:
        return "N/A"

    stype = schedule.get("type", "cron")
    if stype == "cron":
        c = schedule.get("cron", {})
        hour = c.get("hour", "*")
        minute = c.get("minute", 0)
        dow = c.get("day_of_week", "*")

        time_str = f"{hour}:{str(minute).zfill(2)}" if hour != "*" else f"every hour at :{str(minute).zfill(2)}"

        if dow == "*":
            return f"Every day at {time_str}"
        elif dow == "1-5":
            return f"Weekdays at {time_str}"
        else:
            return f"Day {dow} at {time_str}"

    elif stype == "interval":
        i = schedule.get("interval", {})
        return f"Every {i.get('every', 1)} {i.get('unit', 'hours')}"

    return str(schedule)
