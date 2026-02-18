# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for PlanSkill.get_state_prompt() action directives.

Validates that the per-turn state prompt gives the correct behavioral
directive based on step status — especially that intermediate steps
do NOT encourage verbose summaries.
"""

import pytest
from app.skills.plan_task.service import PlanSkill


@pytest.fixture
def skill():
    return PlanSkill()


SID = "test_session"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

async def _create_plan(skill: PlanSkill, steps: list[str], sid: str = SID):
    """Create a plan with given steps."""
    await skill.execute("manage_todo", {
        "action": "create", "task": "Test task", "steps": steps,
    }, sid)


async def _update_step(skill: PlanSkill, index: int, status: str, sid: str = SID, result: str | None = None):
    args = {"action": "update_step", "step_index": index, "status": status}
    if result is not None:
        args["result"] = result
    await skill.execute("manage_todo", args, sid)


# ---------------------------------------------------------------------------
# TestIntermediateDirective — core tests for verbosity control
# ---------------------------------------------------------------------------

class TestIntermediateDirective:
    """Intermediate steps must instruct the LLM to proceed immediately,
    not to summarize or provide lengthy responses."""

    @pytest.mark.asyncio
    async def test_in_progress_with_pending_steps_says_proceed(self, skill):
        """When a step is in_progress and pending steps remain,
        directive must say to proceed and keep text brief."""
        await _create_plan(skill, ["Step A", "Step B", "Step C"])
        await _update_step(skill, 0, "in_progress")

        prompt = skill.get_state_prompt(SID)
        assert prompt is not None
        assert "proceed" in prompt.lower()
        # Must limit intermediate text, not encourage full summaries
        assert "one short sentence" in prompt.lower()
        assert "final summary" not in prompt.lower()

    @pytest.mark.asyncio
    async def test_in_progress_last_step_allows_summary(self, skill):
        """When the last step is in_progress (no pending steps),
        the directive may mention providing a summary."""
        await _create_plan(skill, ["Step A", "Step B"])
        await _update_step(skill, 0, "completed", result="Done")
        await _update_step(skill, 1, "in_progress")

        prompt = skill.get_state_prompt(SID)
        assert prompt is not None
        # Last step — summary is allowed
        assert "summary" in prompt.lower()

    @pytest.mark.asyncio
    async def test_pending_step_directive_no_summary(self, skill):
        """When transitioning to the next pending step (no in_progress),
        directive should not mention summary."""
        await _create_plan(skill, ["Step A", "Step B", "Step C"])
        await _update_step(skill, 0, "in_progress")
        await _update_step(skill, 0, "completed", result="Done")
        # Now: step 0 completed, steps 1,2 pending, none in_progress

        prompt = skill.get_state_prompt(SID)
        assert prompt is not None
        assert "summary" not in prompt.lower()

    @pytest.mark.asyncio
    async def test_all_completed_says_final_summary(self, skill):
        """When all steps are completed, directive says final summary only."""
        await _create_plan(skill, ["Step A", "Step B"])
        await _update_step(skill, 0, "completed", result="Done A")
        await _update_step(skill, 1, "completed", result="Done B")

        prompt = skill.get_state_prompt(SID)
        assert prompt is not None
        assert "final summary" in prompt.lower()
        assert "do not call any more tools" in prompt.lower()

    @pytest.mark.asyncio
    async def test_in_progress_mid_plan_no_text_response(self, skill):
        """Mid-plan in_progress directive must tell LLM not to generate
        standalone text response."""
        await _create_plan(skill, ["Step A", "Step B", "Step C"])
        await _update_step(skill, 0, "completed", result="Done")
        await _update_step(skill, 1, "in_progress")
        # step 1 in_progress, step 2 pending

        prompt = skill.get_state_prompt(SID)
        assert prompt is not None
        # Should indicate to proceed, not to produce text
        assert "proceed" in prompt.lower() or "next" in prompt.lower()


# ---------------------------------------------------------------------------
# TestDirectiveStructure — structural validation
# ---------------------------------------------------------------------------

class TestDirectiveStructure:
    """Verify that get_state_prompt has correct XML structure."""

    @pytest.mark.asyncio
    async def test_contains_current_todo_tags(self, skill):
        await _create_plan(skill, ["Step A"])
        prompt = skill.get_state_prompt(SID)
        assert "<current_todo>" in prompt
        assert "</current_todo>" in prompt

    @pytest.mark.asyncio
    async def test_completed_steps_section(self, skill):
        await _create_plan(skill, ["Step A", "Step B"])
        await _update_step(skill, 0, "completed", result="Done")
        prompt = skill.get_state_prompt(SID)
        assert "<completed_steps>" in prompt
        assert "</completed_steps>" in prompt

    @pytest.mark.asyncio
    async def test_pending_steps_section(self, skill):
        await _create_plan(skill, ["Step A", "Step B"])
        prompt = skill.get_state_prompt(SID)
        assert "<pending_steps>" in prompt
        assert "</pending_steps>" in prompt

    @pytest.mark.asyncio
    async def test_failed_step_stops_execution(self, skill):
        """Failed step directive should say STOP."""
        await _create_plan(skill, ["Step A", "Step B"])
        await _update_step(skill, 0, "failed", result="Error occurred")
        prompt = skill.get_state_prompt(SID)
        assert "STOP" in prompt
