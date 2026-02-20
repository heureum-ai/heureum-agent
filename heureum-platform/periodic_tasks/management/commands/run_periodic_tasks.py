# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Management command to execute due periodic tasks.

Run every minute via cron or: while true; do python manage.py run_periodic_tasks; sleep 60; done
"""

import json
import logging
import time
from datetime import datetime

import httpx
from django.conf import settings
from django.core.management.base import BaseCommand
from django.utils import timezone

from chat_messages.models import Message, Response as ResponseModel, Session
from notifications.services import notify_user
from periodic_tasks.models import PeriodicTask, PeriodicTaskRun
from periodic_tasks.utils import compute_next_run
from proxy.views import _persist_output

logger = logging.getLogger(__name__)


def _build_execution_prompt(recipe: dict) -> str:
    """Build the synthetic user message from the execution recipe."""
    now_str = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    instructions = recipe.get("instructions", [])
    steps = "\n".join(f"  {i + 1}. {step}" for i, step in enumerate(instructions))
    output_spec = recipe.get("output_spec", {})
    notification_spec = output_spec.get("notification", {})

    parts = [
        f"You are executing a scheduled periodic task.",
        f"Current date and time: {now_str}",
        f"Original user request: {recipe.get('original_request', 'N/A')}",
        f"Task objective: {recipe.get('objective', '')}",
        f"",
        f"Instructions — follow each step in order:",
        steps,
    ]

    if output_spec.get("file_pattern"):
        parts.append(f"\nFile output pattern: {output_spec['file_pattern']}")
    if notification_spec:
        parts.append(f"\nNotification title template: {notification_spec.get('title_template', 'N/A')}")
        parts.append(f"Notification body template: {notification_spec.get('body_template', 'N/A')}")

    parts.append(
        f"\nIMPORTANT: You MUST call notify_user at the end to send the results "
        f"to the user. Execute all instructions now."
    )

    return "\n".join(parts)


HEADLESS_INSTRUCTIONS = (
    "You are running a scheduled periodic task in headless mode. "
    "There is no user present — do NOT use ask_question. "
    "Execute the task according to the instructions in the user message. "
    "Available tools: web_search, web_fetch, write_file, read_file, notify_user. "
    "You MUST call notify_user at the end to send results to the user. "
    "If you encounter an error, try to recover. If recovery fails, "
    "call notify_user to inform the user what went wrong."
)


class Command(BaseCommand):
    help = "Execute due periodic tasks by calling the agent service."

    def handle(self, *args, **options):
        now = timezone.now()
        due_tasks = PeriodicTask.objects.filter(
            status="active",
            next_run_at__lte=now,
        ).select_related("user")

        if not due_tasks.exists():
            self.stdout.write("No due tasks.")
            return

        for task in due_tasks:
            self.stdout.write(f"Executing task: {task.title} ({task.id})")
            self._execute_task(task)

    def _execute_task(self, task: PeriodicTask):
        """Execute a single periodic task with retry logic."""
        run = PeriodicTaskRun.objects.create(task=task, attempt=1)

        for attempt in range(1, task.max_retries + 1):
            run.attempt = attempt
            run.save(update_fields=["attempt"])

            try:
                result = self._call_agent(task)
                status = result.get("status", "completed")
                if status in ("failed", "incomplete"):
                    raise RuntimeError(
                        result.get("error", f"Agent returned status '{status}'")
                    )
                self._handle_success(task, run, result)
                return
            except Exception as e:
                logger.warning(
                    "Task %s attempt %d/%d failed: %s",
                    task.id, attempt, task.max_retries, e,
                )
                if attempt < task.max_retries:
                    delay = 60 * (2 ** (attempt - 1))
                    self.stdout.write(f"  Retry in {delay}s...")
                    time.sleep(delay)
                else:
                    self._handle_failure(task, run, str(e))

    def _call_agent(self, task: PeriodicTask) -> dict:
        """Call the agent service with the recipe as a headless request."""
        recipe = task.recipe
        prompt = _build_execution_prompt(recipe)

        request_body = {
            "input": prompt,
            "instructions": HEADLESS_INSTRUCTIONS,
            "stream": False,
            "metadata": {"session_id": task.session_id},
        }

        agent_url = f"{settings.AGENT_SERVICE_URL}/v1/responses"

        with httpx.Client(timeout=300.0) as client:
            resp = client.post(agent_url, json=request_body)
            resp.raise_for_status()
            result = resp.json()

        # Persist execution log to the session so users can see it
        self._persist_to_session(task, prompt, result)

        return result

    def _persist_to_session(self, task: PeriodicTask, prompt: str, result: dict):
        """Persist headless execution messages to the session for visibility."""
        session_id = task.session_id
        task_meta = {
            "periodic_task_id": task.id,
            "periodic_task_title": task.title,
            "is_periodic_run": True,
        }

        response_obj = ResponseModel.objects.create(
            session_id=session_id,
            model=result.get("model", "default"),
            status="in_progress",
            metadata=task_meta,
        )

        # Store the execution prompt as a user message
        Message.objects.create(
            session_id=session_id,
            response=response_obj,
            role="user",
            content=[{"type": "input_text", "text": prompt}],
            status="completed",
            metadata=task_meta,
        )

        # Persist agent output (assistant messages, tool calls, tool results)
        _persist_output(result, session_id, response_obj)

        # Update session timestamp so it appears as recently active
        Session.objects.filter(session_id=session_id).update(updated_at=timezone.now())

    def _handle_success(self, task: PeriodicTask, run: PeriodicTaskRun, result: dict):
        """Update run and task records on successful execution."""
        # Extract output text from response
        output_text = ""
        for item in result.get("output", []):
            if item.get("type") == "message":
                for part in item.get("content", []):
                    if part.get("type") == "output_text":
                        output_text += part.get("text", "")

        usage = result.get("usage", {})
        metadata = result.get("metadata", {})

        run.status = "completed"
        run.output_summary = output_text[:2000]
        run.completed_at = timezone.now()
        run.input_tokens = usage.get("input_tokens", 0)
        run.output_tokens = usage.get("output_tokens", 0)
        run.total_tokens = usage.get("total_tokens", 0)
        run.iterations = metadata.get("iterations", 0)
        run.tool_calls_count = metadata.get("tool_call_count", 0)
        run.save()

        # Update task stats
        task.total_runs += 1
        task.total_successes += 1
        task.consecutive_failures = 0
        task.last_run_at = timezone.now()
        task.next_run_at = compute_next_run(task.schedule, task.timezone_name)
        task.save()

        self.stdout.write(self.style.SUCCESS(f"  Task {task.id} completed."))

        # Notify user (skip if task already sends its own notification)
        if task.notify_on_success:
            notify_user(
                task.user,
                f"Task completed: {task.title}",
                output_text[:200] if output_text else "Task completed successfully.",
                data={
                    "type": "periodic_task_completed",
                    "task_id": task.id,
                    "run_id": run.id,
                    "session_id": task.session_id,
                },
            )

    def _handle_failure(self, task: PeriodicTask, run: PeriodicTaskRun, error: str):
        """Update run and task records on final failure."""
        run.status = "failed"
        run.error_message = error[:2000]
        run.completed_at = timezone.now()
        run.save()

        task.total_runs += 1
        task.total_failures += 1
        task.consecutive_failures += 1
        task.last_run_at = timezone.now()

        if task.consecutive_failures >= task.max_retries:
            task.status = "failed"
            task.next_run_at = None
        else:
            task.next_run_at = compute_next_run(task.schedule, task.timezone_name)

        task.save()

        self.stdout.write(self.style.ERROR(f"  Task {task.id} failed: {error[:100]}"))

        # Notify user
        notify_user(
            task.user,
            f"Task failed: {task.title}",
            f"Failed after {task.max_retries} attempts: {error[:200]}",
            data={
                "type": "periodic_task_failed",
                "task_id": task.id,
                "run_id": run.id,
                "session_id": task.session_id,
            },
        )
