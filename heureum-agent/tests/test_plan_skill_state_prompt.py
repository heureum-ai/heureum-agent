# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for PlanSkill.get_state_prompt() action directives and checkpoint flow.

Validates that the per-turn state prompt gives the correct behavioral
directive based on task status and phase.
"""

import json
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
        result = await skill.execute(
            "manage_todo",
            {
                "action": "create",
                "goal": "Test goal",
                "tasks": tasks,
            },
            sid,
        )
    return result


async def _checkpoint(skill: PlanSkill, phase: str, sid: str = SID, note: str = "ok"):
    """Call thinking_checkpoint."""
    with patch("app.skills.plan_task.service.spawn_subagent", _mock_spawn):
        result = await skill.execute(
            "manage_todo",
            {
                "action": "thinking_checkpoint",
                "phase": phase,
                "note": note,
            },
            sid,
        )
    return result


async def _update_task(
    skill: PlanSkill, task_id: str, status: str, sid: str = SID, result: str | None = None
):
    args = {"action": "update_task", "task_id": task_id, "status": status}
    if result is not None:
        args["result"] = result
    with patch("app.skills.plan_task.service.spawn_subagent", _mock_spawn):
        return await skill.execute("manage_todo", args, sid)


async def _add_tasks(skill: PlanSkill, tasks: list[dict], sid: str = SID):
    with patch("app.skills.plan_task.service.spawn_subagent", _mock_spawn):
        return await skill.execute(
            "manage_todo",
            {"action": "add_tasks", "tasks": tasks},
            sid,
        )


def _simple_tasks(*names: str) -> list[dict]:
    """Build simple tasks with no dependencies."""
    return [{"id": name, "description": f"Do {name}"} for name in names]


# ---------------------------------------------------------------------------
# TestPhaseTransitions
# ---------------------------------------------------------------------------


class TestPhaseTransitions:
    """Test the full phase lifecycle: awaiting → executing → ready_for_final → finalized."""

    @pytest.mark.asyncio
    async def test_create_sets_awaiting_phase(self, skill):
        """After create, phase = awaiting_pre_thinking."""
        result = await _create_plan(skill, _simple_tasks("a", "b"))
        parsed = json.loads(result)
        assert parsed["phase"] == "awaiting_pre_thinking"

        plan = skill.get_state(SID)
        assert plan.phase == "awaiting_pre_thinking"

    @pytest.mark.asyncio
    async def test_create_does_not_spawn(self, skill):
        """After create, tasks remain pending (no spawn)."""
        await _create_plan(skill, _simple_tasks("a", "b"))
        plan = skill.get_state(SID)
        for task in plan.tasks.values():
            assert task.status == "pending"
            assert task.child_session_id is None

    @pytest.mark.asyncio
    async def test_pre_checkpoint_transitions_to_executing(self, skill):
        """pre_plan checkpoint → phase = executing, tasks spawned."""
        await _create_plan(skill, _simple_tasks("a", "b"))
        result = await _checkpoint(skill, "pre_plan")
        parsed = json.loads(result)
        assert parsed["phase"] == "executing"

        plan = skill.get_state(SID)
        assert plan.phase == "executing"

    @pytest.mark.asyncio
    async def test_pre_checkpoint_spawns_tasks(self, skill):
        """pre_plan checkpoint triggers spawn for ready tasks."""
        await _create_plan(skill, _simple_tasks("a", "b"))
        _mock_spawn.reset_mock()
        await _checkpoint(skill, "pre_plan")
        assert _mock_spawn.call_count > 0

    @pytest.mark.asyncio
    async def test_all_terminal_transitions_to_ready_for_final(self, skill):
        """When all tasks complete during executing → phase = ready_for_final."""
        await _create_plan(skill, _simple_tasks("a", "b"))
        await _checkpoint(skill, "pre_plan")
        await _update_task(skill, "a", "completed", result="Done A")
        await _update_task(skill, "b", "completed", result="Done B")

        plan = skill.get_state(SID)
        assert plan.phase == "ready_for_final"

    @pytest.mark.asyncio
    async def test_post_checkpoint_transitions_to_finalized(self, skill):
        """post_plan checkpoint → phase = finalized."""
        await _create_plan(skill, _simple_tasks("a", "b"))
        await _checkpoint(skill, "pre_plan")
        await _update_task(skill, "a", "completed", result="Done A")
        await _update_task(skill, "b", "completed", result="Done B")
        result = await _checkpoint(skill, "post_plan")
        parsed = json.loads(result)
        assert parsed["phase"] == "finalized"

        plan = skill.get_state(SID)
        assert plan.phase == "finalized"


# ---------------------------------------------------------------------------
# TestCheckpointGuards
# ---------------------------------------------------------------------------


class TestCheckpointGuards:
    """Test that checkpoints reject invalid phase transitions."""

    @pytest.mark.asyncio
    async def test_pre_checkpoint_rejected_during_executing(self, skill):
        """pre_plan not valid when already executing."""
        await _create_plan(skill, _simple_tasks("a"))
        await _checkpoint(skill, "pre_plan")
        result = await _checkpoint(skill, "pre_plan")
        assert "Error" in result

    @pytest.mark.asyncio
    async def test_post_checkpoint_rejected_during_executing(self, skill):
        """post_plan not valid when still executing (not all terminal)."""
        await _create_plan(skill, _simple_tasks("a"))
        await _checkpoint(skill, "pre_plan")
        result = await _checkpoint(skill, "post_plan")
        assert "Error" in result

    @pytest.mark.asyncio
    async def test_post_checkpoint_rejected_during_awaiting(self, skill):
        """post_plan not valid during awaiting_pre_thinking."""
        await _create_plan(skill, _simple_tasks("a"))
        result = await _checkpoint(skill, "post_plan")
        assert "Error" in result

    @pytest.mark.asyncio
    async def test_unknown_phase_rejected(self, skill):
        """Unknown phase string returns error."""
        await _create_plan(skill, _simple_tasks("a"))
        result = await _checkpoint(skill, "unknown")
        assert "Error" in result

    @pytest.mark.asyncio
    async def test_checkpoint_without_plan_rejected(self, skill):
        """Checkpoint without active plan returns error."""
        result = await _checkpoint(skill, "pre_plan")
        assert "Error" in result


# ---------------------------------------------------------------------------
# TestSpawnGuard
# ---------------------------------------------------------------------------


class TestSpawnGuard:
    """Test that spawn is blocked before pre checkpoint."""

    @pytest.mark.asyncio
    async def test_spawn_blocked_during_awaiting(self, skill):
        """_spawn_ready_tasks should not spawn during awaiting_pre_thinking."""
        await _create_plan(skill, _simple_tasks("a", "b"))
        plan = skill.get_state(SID)
        # All tasks should be pending (not in_progress)
        assert all(t.status == "pending" for t in plan.tasks.values())


# ---------------------------------------------------------------------------
# TestIsAllComplete
# ---------------------------------------------------------------------------


class TestIsAllComplete:
    """Test is_all_complete requires finalized phase."""

    @pytest.mark.asyncio
    async def test_not_complete_during_executing(self, skill):
        """Even with all tasks terminal, is_all_complete = False if not finalized."""
        await _create_plan(skill, _simple_tasks("a"))
        await _checkpoint(skill, "pre_plan")
        await _update_task(skill, "a", "completed", result="Done")
        # Phase is ready_for_final, but not finalized
        assert skill.is_all_complete(SID) is False

    @pytest.mark.asyncio
    async def test_complete_after_post_checkpoint(self, skill):
        """is_all_complete = True only after post checkpoint."""
        await _create_plan(skill, _simple_tasks("a"))
        await _checkpoint(skill, "pre_plan")
        await _update_task(skill, "a", "completed", result="Done")
        await _checkpoint(skill, "post_plan")
        assert skill.is_all_complete(SID) is True


# ---------------------------------------------------------------------------
# TestHasUnfinishedSteps
# ---------------------------------------------------------------------------


class TestHasUnfinishedSteps:
    """Test has_unfinished_steps respects phase."""

    @pytest.mark.asyncio
    async def test_unfinished_during_awaiting(self, skill):
        """has_unfinished_steps = True during awaiting_pre_thinking."""
        await _create_plan(skill, _simple_tasks("a"))
        assert skill.has_unfinished_steps(SID) is True

    @pytest.mark.asyncio
    async def test_unfinished_during_ready_for_final(self, skill):
        """has_unfinished_steps = True during ready_for_final."""
        await _create_plan(skill, _simple_tasks("a"))
        await _checkpoint(skill, "pre_plan")
        await _update_task(skill, "a", "completed", result="Done")
        assert skill.has_unfinished_steps(SID) is True

    @pytest.mark.asyncio
    async def test_finished_after_finalized(self, skill):
        """has_unfinished_steps = False after finalized."""
        await _create_plan(skill, _simple_tasks("a"))
        await _checkpoint(skill, "pre_plan")
        await _update_task(skill, "a", "completed", result="Done")
        await _checkpoint(skill, "post_plan")
        assert skill.has_unfinished_steps(SID) is False


# ---------------------------------------------------------------------------
# TestFinalizeAbandoned
# ---------------------------------------------------------------------------


class TestFinalizeAbandoned:
    """Test that finalize_abandoned is rejected during checkpoint waits."""

    @pytest.mark.asyncio
    async def test_abandon_rejected_during_awaiting(self, skill):
        """finalize_abandoned_steps should not mark tasks failed during awaiting."""
        await _create_plan(skill, _simple_tasks("a"))
        await skill.finalize_abandoned_steps(SID)
        plan = skill.get_state(SID)
        # Tasks should still be pending (not failed)
        assert all(t.status == "pending" for t in plan.tasks.values())
        assert plan.phase == "awaiting_pre_thinking"

    @pytest.mark.asyncio
    async def test_abandon_rejected_during_ready_for_final(self, skill):
        """finalize_abandoned_steps should not mark tasks failed during ready_for_final."""
        await _create_plan(skill, _simple_tasks("a"))
        await _checkpoint(skill, "pre_plan")
        await _update_task(skill, "a", "completed", result="Done")
        plan = skill.get_state(SID)
        assert plan.phase == "ready_for_final"
        await skill.finalize_abandoned_steps(SID)
        assert plan.phase == "ready_for_final"


# ---------------------------------------------------------------------------
# TestBuildRetryGuidance
# ---------------------------------------------------------------------------


class TestBuildRetryGuidance:
    """Test phase-specific retry guidance."""

    @pytest.mark.asyncio
    async def test_guidance_during_awaiting(self, skill):
        """Guidance should tell agent to call pre_plan checkpoint."""
        await _create_plan(skill, _simple_tasks("a"))
        guidance = skill.build_retry_guidance(SID, "some text")
        assert "thinking_checkpoint" in guidance
        assert "pre_plan" in guidance

    @pytest.mark.asyncio
    async def test_guidance_during_ready_for_final(self, skill):
        """Guidance should tell agent to call post_plan checkpoint."""
        await _create_plan(skill, _simple_tasks("a"))
        await _checkpoint(skill, "pre_plan")
        await _update_task(skill, "a", "completed", result="Done")
        guidance = skill.build_retry_guidance(SID, "some text")
        assert "thinking_checkpoint" in guidance
        assert "post_plan" in guidance


# ---------------------------------------------------------------------------
# TestAddTasksPhaseRecalculation
# ---------------------------------------------------------------------------


class TestAddTasksPhaseRecalculation:
    """Test that add_tasks recalculates phase correctly."""

    @pytest.mark.asyncio
    async def test_add_tasks_transitions_from_ready_to_executing(self, skill):
        """Adding new tasks when ready_for_final should transition back to executing."""
        await _create_plan(skill, _simple_tasks("a"))
        await _checkpoint(skill, "pre_plan")
        await _update_task(skill, "a", "completed", result="Done")
        plan = skill.get_state(SID)
        assert plan.phase == "ready_for_final"

        await _add_tasks(skill, [{"id": "b", "description": "Do B"}])
        plan = skill.get_state(SID)
        assert plan.phase == "executing"

    @pytest.mark.asyncio
    async def test_add_tasks_no_change_during_awaiting(self, skill):
        """Adding tasks during awaiting_pre_thinking stays in awaiting."""
        await _create_plan(skill, _simple_tasks("a"))
        await _add_tasks(skill, [{"id": "b", "description": "Do B"}])
        plan = skill.get_state(SID)
        assert plan.phase == "awaiting_pre_thinking"


# ---------------------------------------------------------------------------
# TestIntermediateDirective (updated for phase)
# ---------------------------------------------------------------------------


class TestIntermediateDirective:
    """Tasks with sub-agents; directive should reflect phase."""

    @pytest.mark.asyncio
    async def test_awaiting_phase_says_review(self, skill):
        """After create, prompt should say to review and call checkpoint."""
        await _create_plan(skill, _simple_tasks("a", "b", "c"))
        prompt = skill.get_state_prompt(SID)
        assert prompt is not None
        assert "thinking_checkpoint" in prompt
        assert "pre_plan" in prompt

    @pytest.mark.asyncio
    async def test_executing_phase_says_sub_agents(self, skill):
        """After pre checkpoint, prompt should say sub-agents running."""
        await _create_plan(skill, _simple_tasks("a", "b", "c"))
        await _checkpoint(skill, "pre_plan")
        prompt = skill.get_state_prompt(SID)
        assert prompt is not None
        assert "sub-agent" in prompt.lower()

    @pytest.mark.asyncio
    async def test_ready_for_final_says_verify(self, skill):
        """When all tasks done, prompt should say to verify and call post checkpoint."""
        await _create_plan(skill, _simple_tasks("a", "b"))
        await _checkpoint(skill, "pre_plan")
        await _update_task(skill, "a", "completed", result="Done A")
        await _update_task(skill, "b", "completed", result="Done B")
        prompt = skill.get_state_prompt(SID)
        assert prompt is not None
        assert "thinking_checkpoint" in prompt
        assert "post_plan" in prompt

    @pytest.mark.asyncio
    async def test_finalized_says_summary(self, skill):
        """After post checkpoint, prompt should say provide final summary."""
        await _create_plan(skill, _simple_tasks("a"))
        await _checkpoint(skill, "pre_plan")
        await _update_task(skill, "a", "completed", result="Done")
        await _checkpoint(skill, "post_plan")
        prompt = skill.get_state_prompt(SID)
        assert prompt is not None
        assert "final summary" in prompt.lower()


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
        await _checkpoint(skill, "pre_plan")
        await _update_task(skill, "a", "completed", result="Done")
        prompt = skill.get_state_prompt(SID)
        assert "<completed_tasks>" in prompt
        assert "</completed_tasks>" in prompt

    @pytest.mark.asyncio
    async def test_failed_task_with_remaining(self, skill):
        """When a task fails but others are running, sub-agents info shown."""
        await _create_plan(skill, _simple_tasks("a", "b"))
        await _checkpoint(skill, "pre_plan")
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
