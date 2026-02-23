# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for PlanSkill.get_state_prompt() action directives.

Validates that the per-turn state prompt gives the correct behavioral
directive based on task status.
"""

from unittest.mock import AsyncMock, patch

import pytest
from app.skills.plan_task.service import PlanSkill, SpawnResult


@pytest.fixture
def skill():
    return PlanSkill()


SID = "test_session"

_mock_spawn = AsyncMock(
    return_value=SpawnResult(status="accepted", child_session_id="child_1", message="ok")
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _create_plan(skill: PlanSkill, tasks: list[dict], sid: str = SID):
    """Create a plan with given tasks (spawn_subagent mocked)."""
    with patch("app.skills.plan_task.service.spawn_subagent", _mock_spawn):
        await skill.execute(
            "manage_todo",
            {
                "action": "create",
                "goal": "Test goal",
                "tasks": tasks,
            },
            sid,
        )


async def _update_task(
    skill: PlanSkill, task_id: str, status: str, sid: str = SID, result: str | None = None
):
    args = {"action": "update_task", "task_id": task_id, "status": status}
    if result is not None:
        args["result"] = result
    await skill.execute("manage_todo", args, sid)


def _simple_tasks(*names: str) -> list[dict]:
    """Build simple tasks with no dependencies."""
    return [{"id": name, "description": f"Do {name}"} for name in names]


# ---------------------------------------------------------------------------
# TestIntermediateDirective
# ---------------------------------------------------------------------------


class TestIntermediateDirective:
    """Tasks are auto-spawned; directive should say sub-agents are running."""

    @pytest.mark.asyncio
    async def test_in_progress_tasks_say_sub_agents(self, skill):
        """After create, all tasks are in_progress with sub-agents."""
        await _create_plan(skill, _simple_tasks("a", "b", "c"))

        prompt = skill.get_state_prompt(SID)
        assert prompt is not None
        assert "sub-agent" in prompt.lower()
        assert "final summary" not in prompt.lower()

    @pytest.mark.asyncio
    async def test_all_completed_says_final_summary(self, skill):
        """When all tasks are completed, directive says final summary."""
        await _create_plan(skill, _simple_tasks("a", "b"))
        await _update_task(skill, "a", "completed", result="Done A")
        await _update_task(skill, "b", "completed", result="Done B")

        prompt = skill.get_state_prompt(SID)
        assert prompt is not None
        assert "final summary" in prompt.lower()

    @pytest.mark.asyncio
    async def test_pending_task_directive_no_summary(self, skill):
        """Pending/in_progress tasks should not mention final summary."""
        await _create_plan(skill, _simple_tasks("a", "b", "c"))
        await _update_task(skill, "a", "completed", result="Done")
        # tasks b,c still in_progress (auto-spawned)

        prompt = skill.get_state_prompt(SID)
        assert prompt is not None
        assert "final summary" not in prompt.lower()


# ---------------------------------------------------------------------------
# TestDirectiveStructure
# ---------------------------------------------------------------------------


class TestDirectiveStructure:
    """Verify that get_state_prompt has correct XML structure."""

    @pytest.mark.asyncio
    async def test_contains_current_plan_tags(self, skill):
        await _create_plan(skill, _simple_tasks("a"))
        prompt = skill.get_state_prompt(SID)
        assert "<current_plan>" in prompt
        assert "</current_plan>" in prompt

    @pytest.mark.asyncio
    async def test_completed_tasks_section(self, skill):
        await _create_plan(skill, _simple_tasks("a", "b"))
        await _update_task(skill, "a", "completed", result="Done")
        prompt = skill.get_state_prompt(SID)
        assert "<completed_tasks>" in prompt
        assert "</completed_tasks>" in prompt

    @pytest.mark.asyncio
    async def test_failed_task_with_remaining(self, skill):
        """When a task fails but others are running, sub-agents info shown."""
        await _create_plan(skill, _simple_tasks("a", "b"))
        await _update_task(skill, "a", "failed", result="Error occurred")
        prompt = skill.get_state_prompt(SID)
        assert "sub-agent" in prompt.lower()

    @pytest.mark.asyncio
    async def test_blocked_tasks_section(self, skill):
        """Blocked tasks should show in blocked_tasks section."""
        tasks = [
            {"id": "a", "description": "Do A"},
            {"id": "b", "description": "Do B", "depends_on": ["a"]},
        ]
        await _create_plan(skill, tasks)
        prompt = skill.get_state_prompt(SID)
        assert "<blocked_tasks>" in prompt
        assert "waiting for" in prompt.lower()
