# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for sessions_spawn skill service."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.skills.plan_task.service import (
    SubagentRunRecord,
    get_registry,
    _session_depth,
)
from app.skills.plan_task.service import SessionsSpawnSkill


@pytest.fixture(autouse=True)
def _clean_state():
    """Clean up module-level state between tests."""
    yield
    _session_depth.clear()
    get_registry()._runs.clear()


@pytest.fixture
def skill():
    return SessionsSpawnSkill()


# ---------------------------------------------------------------------------
# has_unfinished_steps
# ---------------------------------------------------------------------------


class TestHasUnfinishedSteps:
    def test_no_subagents(self, skill):
        assert skill.has_unfinished_steps("s1") is False

    def test_with_running_subagent(self, skill):
        registry = get_registry()
        registry.register(
            SubagentRunRecord(child_session_id="c1", parent_session_id="s1", task="task")
        )
        assert skill.has_unfinished_steps("s1") is True

    def test_with_completed_subagent(self, skill):
        registry = get_registry()
        r = SubagentRunRecord(child_session_id="c1", parent_session_id="s1", task="task")
        r.status = "completed"
        registry.register(r)
        assert skill.has_unfinished_steps("s1") is False

    def test_exception_returns_false(self, skill):
        with patch(
            "app.skills.plan_task.service._registry",
            new_callable=lambda: MagicMock(count_active=MagicMock(side_effect=RuntimeError)),
        ):
            assert skill.has_unfinished_steps("s1") is False


# ---------------------------------------------------------------------------
# build_retry_guidance
# ---------------------------------------------------------------------------


class TestBuildRetryGuidance:
    def test_with_active_subagents(self, skill):
        registry = get_registry()
        r = SubagentRunRecord(child_session_id="c1", parent_session_id="s1", task="do something")
        r.current_iteration = 3
        registry.register(r)

        guidance = skill.build_retry_guidance("s1", "abandoned")
        assert "still running" in guidance.lower()
        assert "do something" in guidance

    def test_with_completed_subagents(self, skill):
        registry = get_registry()
        r = SubagentRunRecord(child_session_id="c1", parent_session_id="s1", task="task1")
        r.status = "completed"
        r.result_summary = "Found the answer"
        registry.register(r)

        # Need at least one active for has_unfinished_steps, add one
        r2 = SubagentRunRecord(child_session_id="c2", parent_session_id="s1", task="task2")
        registry.register(r2)

        guidance = skill.build_retry_guidance("s1", "abandoned")
        assert "completed" in guidance.lower()
        assert "Found the answer" in guidance

    def test_with_failed_subagent(self, skill):
        registry = get_registry()
        r = SubagentRunRecord(child_session_id="c1", parent_session_id="s1", task="task1")
        r.status = "failed"
        r.result_summary = "Something broke"
        registry.register(r)

        # Active one too
        r2 = SubagentRunRecord(child_session_id="c2", parent_session_id="s1", task="task2")
        registry.register(r2)

        guidance = skill.build_retry_guidance("s1", "")
        assert "failed" in guidance.lower()
        assert "Something broke" in guidance

    def test_exception_returns_fallback(self, skill):
        with patch(
            "app.skills.plan_task.service._registry",
            new_callable=lambda: MagicMock(list_by_parent=MagicMock(side_effect=RuntimeError)),
        ):
            guidance = skill.build_retry_guidance("s1", "")
        assert "still running" in guidance.lower()


# ---------------------------------------------------------------------------
# await_pending
# ---------------------------------------------------------------------------


class TestAwaitPending:
    @pytest.mark.asyncio
    async def test_delegates_to_await_active_subagents(self, skill):
        with patch("app.skills.plan_task.service.await_active_subagents", new=AsyncMock()) as mock:
            await skill.await_pending("s1", timeout=10.0)
        mock.assert_called_once_with("s1", timeout=10.0)

    @pytest.mark.asyncio
    async def test_exception_is_caught(self, skill):
        with patch(
            "app.skills.plan_task.service.await_active_subagents",
            new=AsyncMock(side_effect=RuntimeError("fail")),
        ):
            # Should not raise
            await skill.await_pending("s1")


# ---------------------------------------------------------------------------
# execute – routing
# ---------------------------------------------------------------------------


class TestExecuteRouting:
    @pytest.mark.asyncio
    async def test_routes_to_spawn(self, skill):
        with patch.object(skill, "_spawn", new=AsyncMock(return_value='{"status":"ok"}')) as mock:
            result = await skill.execute("sessions_spawn", {"task": "do"}, "s1")
        mock.assert_called_once_with({"task": "do"}, "s1")
        assert result == '{"status":"ok"}'

    @pytest.mark.asyncio
    async def test_routes_to_status(self, skill):
        with patch.object(skill, "_status", new=AsyncMock(return_value='{"children":[]}')) as mock:
            await skill.execute("sessions_spawn_status", {}, "s1")
        mock.assert_called_once_with({}, "s1")

    @pytest.mark.asyncio
    async def test_unknown_tool(self, skill):
        result = await skill.execute("unknown_tool", {}, "s1")
        data = json.loads(result)
        assert "error" in data
        assert "Unknown tool" in data["error"]


# ---------------------------------------------------------------------------
# _spawn
# ---------------------------------------------------------------------------


class TestSpawn:
    @pytest.mark.asyncio
    async def test_success(self, skill):
        skill.set_dependencies(create_subagent_task_fn=MagicMock())
        with patch("app.skills.plan_task.service.spawn_subagent", new=AsyncMock()) as mock:
            mock.return_value = MagicMock(
                status="accepted",
                child_session_id="subagent_abc",
                message="Spawned",
            )
            result = await skill._spawn({"task": "hello", "cleanup": "keep"}, "s1")

        data = json.loads(result)
        assert data["status"] == "accepted"
        assert data["child_session_id"] == "subagent_abc"

    @pytest.mark.asyncio
    async def test_spawn_exception(self, skill):
        skill.set_dependencies(create_subagent_task_fn=MagicMock())
        with patch(
            "app.skills.plan_task.service.spawn_subagent",
            new=AsyncMock(side_effect=RuntimeError("boom")),
        ):
            result = await skill._spawn({"task": "hello"}, "s1")

        data = json.loads(result)
        assert "error" in data
        assert "boom" in data["error"]


# ---------------------------------------------------------------------------
# _status
# ---------------------------------------------------------------------------


class TestStatus:
    @pytest.mark.asyncio
    async def test_specific_child_found(self, skill):
        registry = get_registry()
        r = SubagentRunRecord(child_session_id="c1", parent_session_id="s1", task="task1")
        r.status = "completed"
        r.result_summary = "Done"
        registry.register(r)

        result = await skill._status({"child_session_id": "c1"}, "s1")
        data = json.loads(result)
        assert data["child_session_id"] == "c1"
        assert data["status"] == "completed"
        assert data["result_summary"] == "Done"

    @pytest.mark.asyncio
    async def test_specific_child_not_found(self, skill):
        result = await skill._status({"child_session_id": "nonexistent"}, "s1")
        data = json.loads(result)
        assert "error" in data
        assert "not found" in data["error"]

    @pytest.mark.asyncio
    async def test_child_wrong_parent_returns_not_found(self, skill):
        """Prevents accessing another session's sub-agents."""
        registry = get_registry()
        r = SubagentRunRecord(child_session_id="c1", parent_session_id="other", task="task1")
        registry.register(r)

        result = await skill._status({"child_session_id": "c1"}, "s1")
        data = json.loads(result)
        assert "error" in data
        assert "not found" in data["error"]

    @pytest.mark.asyncio
    async def test_list_all_children(self, skill):
        registry = get_registry()
        registry.register(
            SubagentRunRecord(child_session_id="c1", parent_session_id="s1", task="task1")
        )
        registry.register(
            SubagentRunRecord(child_session_id="c2", parent_session_id="s1", task="task2")
        )

        result = await skill._status({}, "s1")
        data = json.loads(result)
        assert len(data["children"]) == 2

    @pytest.mark.asyncio
    async def test_no_children(self, skill):
        result = await skill._status({}, "s1")
        data = json.loads(result)
        assert data["children"] == []

    @pytest.mark.asyncio
    async def test_status_exception(self, skill):
        with patch(
            "app.skills.plan_task.service._registry",
            new_callable=lambda: MagicMock(get=MagicMock(side_effect=RuntimeError("fail"))),
        ):
            result = await skill._status({"child_session_id": "c1"}, "s1")
        data = json.loads(result)
        assert "error" in data


# ---------------------------------------------------------------------------
# _record_to_dict
# ---------------------------------------------------------------------------


class TestRecordToDict:
    def test_basic_fields(self):
        r = SubagentRunRecord(child_session_id="c1", parent_session_id="s1", task="task1")
        result = SessionsSpawnSkill._record_to_dict(r)
        assert result["child_session_id"] == "c1"
        assert result["task"] == "task1"
        assert result["status"] == "running"
        assert "elapsed_seconds" in result

    def test_with_summary(self):
        r = SubagentRunRecord(child_session_id="c1", parent_session_id="s1", task="task1")
        r.result_summary = "Done perfectly"
        result = SessionsSpawnSkill._record_to_dict(r)
        assert result["result_summary"] == "Done perfectly"

    def test_without_summary(self):
        r = SubagentRunRecord(child_session_id="c1", parent_session_id="s1", task="task1")
        result = SessionsSpawnSkill._record_to_dict(r)
        assert "result_summary" not in result

    def test_summary_truncation(self):
        r = SubagentRunRecord(child_session_id="c1", parent_session_id="s1", task="task1")
        r.result_summary = "x" * 3000
        result = SessionsSpawnSkill._record_to_dict(r)
        assert len(result["result_summary"]) == 500
