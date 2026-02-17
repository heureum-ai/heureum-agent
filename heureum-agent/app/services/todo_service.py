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
from typing import Any, Callable, Coroutine, Dict, List, Optional

logger = logging.getLogger(__name__)

MANAGE_TODO_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "manage_todo",
        "description": (
            "Create or update a TODO execution plan for the current task. "
            "Use this for multi-step tasks to plan before executing."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "action": {
                    "type": "string",
                    "enum": ["create", "update_step", "add_steps"],
                    "description": "Action to perform",
                },
                "task": {
                    "type": "string",
                    "description": "Overall task description (required for 'create')",
                },
                "steps": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Step descriptions (required for 'create' and 'add_steps')",
                },
                "step_index": {
                    "type": "integer",
                    "description": "Index of step to update (required for 'update_step')",
                },
                "status": {
                    "type": "string",
                    "enum": ["in_progress", "completed", "failed"],
                    "description": "New status for the step (required for 'update_step')",
                },
                "result": {
                    "type": "string",
                    "description": "Brief result description for completed/failed steps",
                },
                "after_index": {
                    "type": "integer",
                    "description": "Insert new steps after this index (for 'add_steps', defaults to end)",
                },
            },
            "required": ["action"],
        },
    },
}


@dataclass
class TodoStep:
    """A single step in a TODO plan."""

    description: str
    status: str = "pending"  # pending | in_progress | completed | failed
    result: Optional[str] = None


@dataclass
class SessionTodo:
    """A TODO plan for a session."""

    task: str
    steps: List[TodoStep]
    filename: str = "TODO.md"
    created_at: float = field(default_factory=time.time)
    updated_at: float = field(default_factory=time.time)


# Type alias for the async write callback:
#   (tool_name: str, arguments: dict) -> str
WriteToolFn = Callable[[str, Dict[str, Any]], Coroutine[Any, Any, str]]


class TodoService:
    """Manages TODO plans per session with markdown persistence."""

    def __init__(self) -> None:
        self._session_todos: Dict[str, SessionTodo] = {}
        self._session_history: Dict[str, List[SessionTodo]] = {}
        self._write_tool_fn: Optional[WriteToolFn] = None

    def set_write_tool_fn(self, fn: WriteToolFn) -> None:
        """Inject the MCP tool caller used to persist TODO files.

        Args:
            fn: Async callable matching ``mcp_client.call_tool(name, args)``.
        """
        self._write_tool_fn = fn

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
        """Create a new TODO plan for the session."""
        if not task:
            return "Error: task description is required"
        if not steps:
            return "Error: at least one step is required"

        # Archive existing TODO as history before creating new one
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
            lines.append(f"  {i}. [{step.status}] {step.description}{result_part}")
            if step.status == "in_progress":
                in_progress_idx = i
            elif step.status == "failed" and failed_idx is None:
                failed_idx = i
            elif step.status == "pending" and first_pending is None:
                first_pending = i

        # Add explicit directive for next action
        if failed_idx is not None:
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
        lines = ["# TODO", "", f"**Task**: {todo.task}", "", "## Steps"]

        completed = 0
        in_progress = False
        for step in todo.steps:
            if step.status == "completed":
                completed += 1
                lines.append(f"- [x] ~~{step.description}~~ ✓")
                if step.result:
                    lines.append(f"  > {step.result}")
            elif step.status == "in_progress":
                in_progress = True
                lines.append(f"- [ ] **{step.description}** ← in progress")
            elif step.status == "failed":
                lines.append(f"- [ ] ~~{step.description}~~ ✗")
                if step.result:
                    lines.append(f"  > {step.result}")
            else:
                lines.append(f"- [ ] {step.description}")

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
        """Write TODO plan file via MCP filesystem write tool."""
        if not self._write_tool_fn:
            logger.warning("No write tool configured; skipping TODO file write for %s", todo.filename)
            return

        content = self.render_markdown(todo)
        try:
            await self._write_tool_fn("write", {"path": todo.filename, "content": content})
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
