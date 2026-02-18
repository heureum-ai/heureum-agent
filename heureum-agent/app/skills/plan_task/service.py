# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Plan skill — manages per-session execution plans (TODO).

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
    "display_name": "Todo",
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
#   (tool_name: str, arguments: dict, *, session_id: str) -> str
WriteToolFn = Callable[..., Coroutine[Any, Any, str]]


class PlanSkill:
    """Manages TODO plans per session with markdown persistence."""

    name = "plan_task"
    tool_schemas = [MANAGE_TODO_TOOL_SCHEMA]

    def __init__(self) -> None:
        self._session_todos: Dict[str, SessionTodo] = {}
        self._session_history: Dict[str, List[SessionTodo]] = {}
        self._write_tool_fn: Optional[WriteToolFn] = None

    async def on_init(self, **kwargs: Any) -> None:
        write_tool_fn = kwargs.get("write_tool_fn")
        if write_tool_fn is not None:
            self._write_tool_fn = write_tool_fn

    async def execute(
        self, name: str, arguments: Dict[str, Any], session_id: str
    ) -> str:
        action = arguments.get("action", "")
        if action == "create":
            return await self._create(
                session_id,
                arguments.get("task", ""),
                arguments.get("steps", []),
            )
        elif action == "update_step":
            return await self._update_step(
                session_id,
                arguments.get("step_index", 0),
                arguments.get("status", "completed"),
                arguments.get("result"),
            )
        elif action == "add_steps":
            return await self._add_steps(
                session_id,
                arguments.get("steps", []),
                arguments.get("after_index"),
            )
        else:
            return f"Unknown action: {action}"

    @staticmethod
    def _make_todo_filename(task: str) -> str:
        slug = re.sub(r"[^a-z0-9]+", "-", task.lower()).strip("-")[:40]
        ts = datetime.now(timezone.utc).strftime("%H%M%S")
        return f"TODO-{slug}-{ts}.md"

    async def _create(
        self, session_id: str, task: str, steps: List[str]
    ) -> str:
        if not task:
            return "Error: task description is required"
        if not steps:
            return "Error: at least one step is required"

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

    async def _update_step(
        self,
        session_id: str,
        step_index: int,
        status: str,
        result: Optional[str] = None,
    ) -> str:
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

    async def _add_steps(
        self,
        session_id: str,
        steps: List[str],
        after_index: Optional[int] = None,
    ) -> str:
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
        return self._session_todos.get(session_id)

    def get_failed_step(self, session_id: str) -> Optional[TodoStep]:
        todo = self._session_todos.get(session_id)
        if not todo:
            return None
        for step in todo.steps:
            if step.status == "failed":
                return step
        return None

    def build_retry_guidance(self, session_id: str, abandoned_text: str) -> Optional[str]:
        """Build a targeted guidance prompt when the LLM abandons the plan.

        Provides a structured breakdown of previous/current/remaining steps
        so the LLM has full context to recover and continue.
        """
        todo = self._session_todos.get(session_id)
        if not todo:
            return None

        in_progress = []
        pending = []
        completed = []
        failed = []
        for i, step in enumerate(todo.steps):
            if step.status == "in_progress":
                in_progress.append((i, step))
            elif step.status == "pending":
                pending.append((i, step))
            elif step.status == "completed":
                completed.append((i, step))
            elif step.status == "failed":
                failed.append((i, step))

        if not in_progress and not pending:
            return None

        lines = [
            "You tried to respond without finishing the plan. "
            "You MUST complete every step before giving a final answer.",
        ]

        # -- Previous steps (completed / failed) --
        if completed or failed:
            lines.append("")
            lines.append("## Previous steps")
            for idx, step in completed:
                result_part = f" → {step.result}" if step.result else ""
                lines.append(f"  ✓ Step {idx}: {step.description}{result_part}")
            for idx, step in failed:
                result_part = f" → {step.result}" if step.result else ""
                lines.append(f"  ✗ Step {idx}: {step.description}{result_part}")

        # -- Current step (in_progress) --
        if in_progress:
            idx, step = in_progress[0]
            lines.append("")
            lines.append(f"## Current step (BLOCKED)")
            lines.append(f"  ⟳ Step {idx}: {step.description}")
            lines.append("")
            lines.append("Action required — pick ONE:")
            lines.append(f"  1. Try a DIFFERENT approach to complete this step.")
            lines.append(f"  2. Mark it failed if truly impossible:")
            lines.append(f'     manage_todo(action="update_step", step_index={idx}, '
                         f'status="failed", result="<reason>")')

        # -- Remaining steps (pending) --
        if pending:
            lines.append("")
            lines.append("## Remaining steps")
            for idx, step in pending:
                lines.append(f"  ○ Step {idx}: {step.description}")
            if in_progress:
                next_idx, next_step = pending[0]
                lines.append("")
                lines.append(
                    f"After resolving the current step, continue to step {next_idx}."
                )
            else:
                next_idx, next_step = pending[0]
                lines.append("")
                lines.append(f"Start step {next_idx} now.")

        lines.append("")
        lines.append(f"Progress: {len(completed)}/{len(todo.steps)} completed.")

        return "\n".join(lines)

    def is_all_complete(self, session_id: str) -> bool:
        """True when a plan exists and every step is completed or failed."""
        todo = self._session_todos.get(session_id)
        if not todo:
            return False
        return all(s.status in ("completed", "failed") for s in todo.steps)

    def has_unfinished_steps(self, session_id: str) -> bool:
        """Check if the plan has any in_progress or pending steps."""
        todo = self._session_todos.get(session_id)
        if not todo:
            return False
        return any(s.status in ("in_progress", "pending") for s in todo.steps)

    async def finalize_abandoned_steps(self, session_id: str) -> None:
        """Auto-fail any in_progress or pending steps when the LLM returns text without updating.

        Called by the agent loop as a safety net — ensures the plan never
        stays stuck in a broken state when the LLM abandons it.
        """
        todo = self._session_todos.get(session_id)
        if not todo:
            return
        changed = False
        for step in todo.steps:
            if step.status == "in_progress":
                step.status = "failed"
                step.result = "Abandoned by agent"
                changed = True
            elif step.status == "pending":
                step.status = "failed"
                step.result = "Skipped — previous step abandoned"
                changed = True
        if changed:
            todo.updated_at = time.time()
            await self._write_todo_file(session_id, todo)

    def get_state_prompt(self, session_id: str) -> Optional[str]:
        parts: List[str] = []

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

        lines = ["<current_todo>", f"Task: {todo.task}"]

        # Classify steps by status
        completed_lines: List[str] = []
        current_lines: List[str] = []
        pending_lines: List[str] = []
        first_pending = None
        in_progress_idx = None
        failed_idx = None

        for i, step in enumerate(todo.steps):
            result_part = f" — {step.result}" if step.result else ""
            entry = f"  {i}. {step.description}{result_part}"
            if step.status == "completed":
                completed_lines.append(entry)
            elif step.status == "in_progress":
                current_lines.append(entry)
                in_progress_idx = i
            elif step.status == "failed":
                current_lines.append(f"  {i}. [FAILED] {step.description}{result_part}")
                if failed_idx is None:
                    failed_idx = i
            else:  # pending
                pending_lines.append(entry)
                if first_pending is None:
                    first_pending = i

        if completed_lines:
            lines.append("<completed_steps>")
            lines.extend(completed_lines)
            lines.append("</completed_steps>")
        if current_lines:
            lines.append("<current_step>")
            lines.extend(current_lines)
            lines.append("</current_step>")
        if pending_lines:
            lines.append("<pending_steps>")
            lines.extend(pending_lines)
            lines.append("</pending_steps>")

        # Action directive
        if failed_idx is not None:
            lines.append(
                f"\nSTOP: Step {failed_idx} has failed. "
                "Do NOT continue with remaining steps. "
                "Inform the user about the failure and what went wrong. "
                "If the user asks to retry, create a new plan with a different approach."
            )
        elif in_progress_idx is not None:
            lines.append(
                f"\nStep {in_progress_idx} is in_progress. "
                "Call manage_todo(action=\"update_step\") to set this step to "
                "\"completed\" or \"failed\" before responding with text to the user. "
                f"If the step cannot be completed, mark it as failed: "
                f"manage_todo(action=\"update_step\", step_index={in_progress_idx}, "
                f"status=\"failed\", result=\"reason\")."
            )
            if first_pending is not None:
                lines.append(
                    "Then proceed to the next pending step immediately. "
                    "Keep any intermediate text to one short sentence at most."
                )
            else:
                lines.append(
                    "Then provide a final summary of all completed work."
                )
        elif first_pending is not None:
            lines.append(
                f"\nCall manage_todo(action=\"update_step\", "
                f"step_index={first_pending}, status=\"in_progress\") to start the next step."
            )
        else:
            completed = sum(1 for s in todo.steps if s.status == "completed")
            if completed == len(todo.steps):
                lines.append(
                    "\nAll steps completed. Respond with a final summary only. "
                    "Do not call any more tools."
                )

        lines.append("</current_todo>")
        parts.append("\n".join(lines))
        return "\n\n".join(parts)

    def clear_session(self, session_id: str) -> None:
        self._session_todos.pop(session_id, None)
        self._session_history.pop(session_id, None)

    @staticmethod
    def render_markdown(todo: SessionTodo) -> str:
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
        if not self._write_tool_fn:
            logger.warning("No write tool configured; skipping TODO file write for %s", todo.filename)
            return
        content = self.render_markdown(todo)
        try:
            await self._write_tool_fn("mcp_filesystem__write", {"path": todo.filename, "content": content}, session_id=session_id)
        except Exception as e:
            logger.warning("Failed to write %s: %s", todo.filename, e)

    @staticmethod
    def _format_state(todo: SessionTodo) -> str:
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
