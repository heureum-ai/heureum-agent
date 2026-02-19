# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
TODO service — manages per-session execution plans.

The agent creates a TODO plan for multi-step tasks, then executes each
step while updating progress.  State is kept in-memory and persisted
as TODO.md in session files via the Platform API.
"""

import logging
import re
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any, Dict, List, Optional

import httpx

from app.config import settings

logger = logging.getLogger(__name__)


WORKFLOW_SIGNAL_PREFIX = "@@WORKFLOW_SIGNAL@@"


@dataclass
class TodoStep:
    """A single step in a TODO plan."""

    description: str
    status: str = "pending"  # pending | in_progress | completed | failed
    result: Optional[str] = None
    step_name: Optional[str] = None        # unique ID for dependency tracking
    depends_on: Optional[List[str]] = None  # step_name values this step depends on
    assigned_agent: Optional[str] = None    # agent role_type


@dataclass
class SessionTodo:
    """A TODO plan for a session."""

    task: str
    steps: List[TodoStep]
    filename: str = "TODO.md"
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)
    is_workflow: bool = False


class TodoService:
    """Manages TODO plans per session with markdown persistence."""

    def __init__(self) -> None:
        self._session_todos: Dict[str, SessionTodo] = {}
        self._session_history: Dict[str, List[SessionTodo]] = {}

    async def execute(
        self, name: str, arguments: Dict[str, Any], session_id: str
    ) -> str:
        """Dispatch manage_todo tool calls by action."""
        action = arguments.get("action", "")

        if action == "create":
            return await self.create(
                session_id,
                arguments.get("task", ""),
                arguments.get("steps", []),
            )
        elif action == "update_step":
            return await self.update_step(
                session_id,
                arguments.get("step_index", 0),
                arguments.get("status", "completed"),
                arguments.get("result"),
            )
        elif action == "add_steps":
            return await self.add_steps(
                session_id,
                arguments.get("steps", []),
                arguments.get("after_index"),
            )
        else:
            return f"Unknown action: {action}"

    @staticmethod
    def _make_todo_filename(task: str) -> str:
        """Generate a unique TODO filename from the task description."""
        slug = re.sub(r"[^a-z0-9]+", "-", task.lower()).strip("-")[:40]
        ts = datetime.now(timezone.utc).strftime("%H%M%S")
        return f"TODO-{slug}-{ts}.md"

    async def create(
        self, session_id: str, task: str, steps: List[str]
    ) -> str:
        """Create a new TODO plan for the session.

        When ``ENABLE_WORKFLOW`` is True, returns a signal that triggers the
        orchestration pipeline (role extraction -> planning -> parallel
        execution -> synthesis).  The pipeline will call
        ``_create_orchestrated()`` to build the enhanced TODO with agent
        assignments and dependencies.

        When ``ENABLE_WORKFLOW`` is False, creates a plain sequential TODO
        that the LLM steps through manually.
        """
        if not task:
            return "Error: task description is required"
        if not steps:
            return "Error: at least one step is required"

        if settings.ENABLE_WORKFLOW:
            return f"{WORKFLOW_SIGNAL_PREFIX}{task}"

        # Legacy sequential mode
        existing = self._session_todos.get(session_id)
        if existing:
            self._session_history.setdefault(session_id, []).append(existing)

        filename = self._make_todo_filename(task)
        todo = SessionTodo(
            task=task,
            steps=[TodoStep(description=s) for s in steps],
            filename=filename,
        )
        self._session_todos[session_id] = todo
        await self._write_todo_file(session_id, todo)
        return self._format_state(todo)

    async def update_step(
        self,
        session_id: str,
        step_index: int,
        status: str,
        result: Optional[str] = None,
    ) -> str:
        """Update a step's status and optional result."""
        todo = self._session_todos.get(session_id)
        if not todo:
            return "Error: no TODO plan exists for this session"
        if step_index < 0 or step_index >= len(todo.steps):
            return f"Error: step_index {step_index} out of range (0-{len(todo.steps) - 1})"

        step = todo.steps[step_index]
        step.status = status
        if result is not None:
            step.result = result
        todo.updated_at = time.time()

        await self._write_todo_file(session_id, todo)
        return self._format_state(todo)

    async def add_steps(
        self,
        session_id: str,
        steps: List[str],
        after_index: Optional[int] = None,
    ) -> str:
        """Add new steps to an existing TODO plan."""
        todo = self._session_todos.get(session_id)
        if not todo:
            return "Error: no TODO plan exists for this session"
        if not steps:
            return "Error: at least one step is required"

        new_steps = [TodoStep(description=s) for s in steps]
        if after_index is not None and 0 <= after_index < len(todo.steps):
            insert_at = after_index + 1
            todo.steps[insert_at:insert_at] = new_steps
        else:
            todo.steps.extend(new_steps)

        todo.updated_at = time.time()
        await self._write_todo_file(session_id, todo)
        return self._format_state(todo)

    async def _create_orchestrated(
        self,
        session_id: str,
        task: str,
        workflow_steps,
    ) -> str:
        """Create an orchestrated TODO from WorkflowStep objects.

        Called internally by WorkflowRunner after the planner has produced
        enhanced steps with agent assignments and dependencies.  Replaces
        any existing TODO for the session.

        Args:
            session_id: The session ID.
            task: Overall task description.
            workflow_steps: List of WorkflowStep pydantic objects.

        Returns:
            Formatted state string.
        """
        existing = self._session_todos.get(session_id)
        if existing:
            self._session_history.setdefault(session_id, []).append(existing)

        filename = self._make_todo_filename(task)
        steps = [
            TodoStep(
                description=f"[{s.assigned_agent}] {s.task}",
                step_name=s.step_name,
                depends_on=list(s.depends_on) if s.depends_on else None,
                assigned_agent=s.assigned_agent,
            )
            for s in workflow_steps
        ]
        todo = SessionTodo(
            task=task,
            steps=steps,
            filename=filename,
            is_workflow=True,
        )
        self._session_todos[session_id] = todo
        await self._write_todo_file(session_id, todo)
        return self._format_state(todo)

    def get_state(self, session_id: str) -> Optional[SessionTodo]:
        """Return the current TODO state for a session."""
        return self._session_todos.get(session_id)

    def get_failed_step(self, session_id: str) -> Optional[TodoStep]:
        """Return the first failed step, or None."""
        todo = self._session_todos.get(session_id)
        if not todo:
            return None
        for step in todo.steps:
            if step.status == "failed":
                return step
        return None

    def get_state_prompt(self, session_id: str) -> Optional[str]:
        """Return compact TODO state for system prompt injection."""
        parts: List[str] = []

        # Include history from previous attempts
        history = self._session_history.get(session_id, [])
        if history:
            hlines = ["<previous_attempts>"]
            for h in history:
                hlines.append(f"Task: {h.task}")
                for i, step in enumerate(h.steps):
                    result_part = f" — {step.result}" if step.result else ""
                    hlines.append(f"  {i}. [{step.status}] {step.description}{result_part}")
                hlines.append("")
            hlines.append(
                "Use these past results to inform your approach. "
                "Avoid repeating strategies that failed before."
            )
            hlines.append("</previous_attempts>")
            parts.append("\n".join(hlines))

        todo = self._session_todos.get(session_id)
        if not todo:
            return parts[0] if parts else None

        lines = ["<current_todo>", f"Task: {todo.task}", "Steps:"]
        first_pending = None
        in_progress_idx = None
        failed_idx = None
        for i, step in enumerate(todo.steps):
            result_part = f" — {step.result}" if step.result else ""
            agent_part = f" @{step.assigned_agent}" if step.assigned_agent else ""
            lines.append(f"  {i}. [{step.status}] {step.description}{agent_part}{result_part}")
            if step.status == "in_progress":
                in_progress_idx = i
            elif step.status == "failed" and failed_idx is None:
                failed_idx = i
            elif step.status == "pending" and first_pending is None:
                first_pending = i

        # Orchestrated mode — the pipeline manages execution automatically
        if todo.is_workflow:
            lines.append(
                "\nThis plan is being executed automatically with parallel orchestration. "
                "Do NOT manually update steps."
            )
        elif failed_idx is not None:
            step = todo.steps[failed_idx]
            lines.append(
                f"\nSTOP: Step {failed_idx} has failed. "
                "Do NOT continue with remaining steps. "
                "Inform the user about the failure and what went wrong. "
                "If the user asks to retry, create a new plan with a different approach."
            )
        elif in_progress_idx is not None:
            step = todo.steps[in_progress_idx]
            lines.append(
                f"\nACTION REQUIRED: Step {in_progress_idx} is in_progress. "
                f"Execute it now, then call manage_todo(action=\"update_step\", "
                f"step_index={in_progress_idx}, status=\"completed\", result=\"...\")."
            )
        elif first_pending is not None:
            lines.append(
                f"\nACTION REQUIRED: Call manage_todo(action=\"update_step\", "
                f"step_index={first_pending}, status=\"in_progress\") to start the next step."
            )
        else:
            completed = sum(1 for s in todo.steps if s.status == "completed")
            if completed == len(todo.steps):
                lines.append("\nAll steps completed. Provide a final summary to the user.")

        lines.append("</current_todo>")
        parts.append("\n".join(lines))
        return "\n\n".join(parts)

    def clear_session(self, session_id: str) -> None:
        """Remove TODO state for an evicted session."""
        self._session_todos.pop(session_id, None)
        self._session_history.pop(session_id, None)

    @staticmethod
    def render_markdown(todo: SessionTodo) -> str:
        """Render a TODO plan as markdown for TODO.md."""
        title = "# TODO"
        lines = [title, "", f"**Task**: {todo.task}", "", "## Steps"]

        completed = 0
        in_progress = False
        for step in todo.steps:
            # Build agent badge and dependency info for workflow steps
            suffix = ""
            if step.assigned_agent:
                suffix += f" `@{step.assigned_agent}`"
            if step.depends_on:
                suffix += f" (depends: {', '.join(step.depends_on)})"

            if step.status == "completed":
                completed += 1
                lines.append(f"- [x] ~~{step.description}~~{suffix}")
                if step.result:
                    lines.append(f"  > {step.result}")
            elif step.status == "in_progress":
                in_progress = True
                lines.append(f"- [ ] **{step.description}**{suffix} <- in progress")
            elif step.status == "failed":
                lines.append(f"- [ ] ~~{step.description}~~{suffix} X")
                if step.result:
                    lines.append(f"  > {step.result}")
            else:
                lines.append(f"- [ ] {step.description}{suffix}")

        total = len(todo.steps)
        if completed == total:
            status = "Completed"
        elif in_progress:
            status = "In Progress"
        else:
            status = "Pending"

        lines.extend(["", "---", f"Progress: {completed}/{total} completed | Status: {status}"])
        return "\n".join(lines)

    async def _write_todo_file(self, session_id: str, todo: SessionTodo) -> None:
        """Write TODO plan file to session files via Platform API."""
        content = self.render_markdown(todo)
        url = f"{settings.MCP_SERVER_URL}/api/v1/sessions/{session_id}/files/write/"

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(url, json={
                    "path": todo.filename,
                    "content": content,
                    "created_by": "agent",
                })
                if resp.status_code not in (200, 201):
                    logger.warning("Failed to write %s: %s", todo.filename, resp.text)
        except Exception as e:
            logger.warning("Failed to write %s: %s", todo.filename, e)

    @staticmethod
    def _format_state(todo: SessionTodo) -> str:
        """Format TODO state as a compact string for LLM tool result."""
        lines = [f"TODO Plan: {todo.task}", ""]
        for i, step in enumerate(todo.steps):
            icon = {"pending": "○", "in_progress": "⟳", "completed": "✓", "failed": "✗"}.get(
                step.status, "○"
            )
            result_part = f" — {step.result}" if step.result else ""
            lines.append(f"  {icon} {i}. {step.description}{result_part}")

        completed = sum(1 for s in todo.steps if s.status == "completed")
        lines.append(f"\nProgress: {completed}/{len(todo.steps)} completed")
        return "\n".join(lines)
