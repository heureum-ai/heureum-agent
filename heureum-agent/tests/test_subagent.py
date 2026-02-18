# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for sub-agent spawning."""

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.subagent import (
    ProgressStep,
    SpawnRequest,
    SubagentRegistry,
    SubagentRunRecord,
    _announce_completion,
    _clear_depth,
    _session_depth,
    _tool_detail,
    get_subagent_depth,
    spawn_subagent,
)


@pytest.fixture(autouse=True)
def _clean_state():
    """Clean up module-level state between tests."""
    yield
    _session_depth.clear()
    from app.services.subagent import _registry
    _registry._runs.clear()


# ---------------------------------------------------------------------------
# SubagentRegistry
# ---------------------------------------------------------------------------


class TestSubagentRegistry:
    def test_register_and_get(self):
        reg = SubagentRegistry()
        record = SubagentRunRecord(
            child_session_id="child1",
            parent_session_id="parent1",
            task="test task",
        )
        reg.register(record)
        assert reg.get("child1") is record
        assert reg.get("nonexistent") is None

    def test_count_active(self):
        reg = SubagentRegistry()
        reg.register(SubagentRunRecord(
            child_session_id="c1", parent_session_id="p1", task="t1"
        ))
        reg.register(SubagentRunRecord(
            child_session_id="c2", parent_session_id="p1", task="t2"
        ))
        reg.register(SubagentRunRecord(
            child_session_id="c3", parent_session_id="p2", task="t3"
        ))
        assert reg.count_active("p1") == 2
        assert reg.count_active("p2") == 1

    def test_count_active_excludes_completed(self):
        reg = SubagentRegistry()
        reg.register(SubagentRunRecord(
            child_session_id="c1", parent_session_id="p1", task="t1"
        ))
        reg.register(SubagentRunRecord(
            child_session_id="c2", parent_session_id="p1", task="t2"
        ))
        reg.mark_completed("c1", "completed", "done")
        assert reg.count_active("p1") == 1

    def test_cleanup(self):
        reg = SubagentRegistry()
        reg.register(SubagentRunRecord(
            child_session_id="c1", parent_session_id="p1", task="t1"
        ))
        reg.cleanup("c1")
        assert reg.get("c1") is None


# ---------------------------------------------------------------------------
# Depth tracking
# ---------------------------------------------------------------------------


class TestGetSubagentDepth:
    def test_root_is_zero(self):
        assert get_subagent_depth("root_session") == 0

    def test_child_increments(self):
        _session_depth["parent"] = 0
        from app.services.subagent import _set_child_depth
        _set_child_depth("child", "parent")
        assert get_subagent_depth("child") == 1

    def test_nested_depth(self):
        _session_depth["parent"] = 0
        _session_depth["child"] = 1
        from app.services.subagent import _set_child_depth
        _set_child_depth("grandchild", "child")
        assert get_subagent_depth("grandchild") == 2

    def test_clear(self):
        _session_depth["test"] = 3
        _clear_depth("test")
        assert get_subagent_depth("test") == 0


# ---------------------------------------------------------------------------
# spawn_subagent
# ---------------------------------------------------------------------------


class TestSpawnSubagent:
    @pytest.mark.asyncio
    async def test_accepted(self):
        """Normal spawn should be accepted."""
        request = SpawnRequest(
            parent_session_id="parent1",
            task="Find the answer to life",
        )
        with patch("app.services.subagent._run_subagent", new=AsyncMock()):
            result = await spawn_subagent(request)
        assert result.status == "accepted"
        assert result.child_session_id.startswith("subagent_")

    @pytest.mark.asyncio
    async def test_depth_forbidden(self):
        """Spawn should be forbidden when depth limit reached."""
        _session_depth["parent1"] = 1  # At max depth (default is 1)
        request = SpawnRequest(
            parent_session_id="parent1",
            task="Nested task",
        )
        result = await spawn_subagent(request)
        assert result.status == "forbidden"
        assert "depth" in result.message.lower()

    @pytest.mark.asyncio
    async def test_max_children_forbidden(self):
        """Spawn should be forbidden when max children reached."""
        from app.services.subagent import _registry
        # Fill up children
        for i in range(5):
            _registry.register(SubagentRunRecord(
                child_session_id=f"child_{i}",
                parent_session_id="parent2",
                task=f"task_{i}",
            ))

        request = SpawnRequest(
            parent_session_id="parent2",
            task="One more task",
        )
        result = await spawn_subagent(request)
        assert result.status == "forbidden"
        assert "children" in result.message.lower()


# ---------------------------------------------------------------------------
# _announce_completion
# ---------------------------------------------------------------------------


class TestAnnounceCompletion:
    @pytest.mark.asyncio
    async def test_appends_to_parent(self):
        """Completion message is appended to parent session."""
        record = SubagentRunRecord(
            child_session_id="c1",
            parent_session_id="p1",
            task="test task",
        )

        mock_sessions = {"p1": []}
        mock_svc = MagicMock()
        mock_svc._lc_sessions = mock_sessions

        with patch("app.routers.agent.agent_service", mock_svc):
            await _announce_completion(record, "Task done successfully")

        assert len(mock_sessions["p1"]) == 1
        assert "Sub-agent completed" in mock_sessions["p1"][0].content
        assert "Task done successfully" in mock_sessions["p1"][0].content

    @pytest.mark.asyncio
    async def test_retries_on_failure(self):
        """Announcement retries on failure."""
        record = SubagentRunRecord(
            child_session_id="c1",
            parent_session_id="p1",
            task="test task",
        )

        call_count = 0

        class MockSessions:
            def __contains__(self, key):
                nonlocal call_count
                call_count += 1
                if call_count < 2:
                    raise RuntimeError("Lock contention")
                return True

            def __getitem__(self, key):
                return []

        mock_svc = MagicMock()
        mock_svc._lc_sessions = MockSessions()

        with patch("app.routers.agent.agent_service", mock_svc):
            with patch("asyncio.sleep", new=AsyncMock()):
                await _announce_completion(record, "done", max_retries=3)

        # Should have retried
        assert call_count >= 2

    @pytest.mark.asyncio
    async def test_parent_session_not_found(self):
        """No error when parent session doesn't exist."""
        record = SubagentRunRecord(
            child_session_id="c1",
            parent_session_id="nonexistent",
            task="test task",
        )

        mock_svc = MagicMock()
        mock_svc._lc_sessions = {}

        with patch("app.routers.agent.agent_service", mock_svc):
            # Should not raise
            await _announce_completion(record, "done")


# ---------------------------------------------------------------------------
# ProgressStep & _tool_detail
# ---------------------------------------------------------------------------


class TestProgressStep:
    def test_defaults(self):
        step = ProgressStep(tool_name="bash", detail="ls -la")
        assert step.status == "running"
        assert step.completed_at is None
        assert step.started_at > 0

    def test_status_update(self):
        step = ProgressStep(tool_name="read", detail="/tmp/file.txt")
        step.status = "completed"
        step.completed_at = 123.0
        assert step.status == "completed"
        assert step.completed_at == 123.0


class TestToolDetail:
    def test_bash_command(self):
        result = _tool_detail("bash", {"command": "echo hello world"})
        assert result == "echo hello world"

    def test_bash_long_command_truncated(self):
        long_cmd = "x" * 200
        result = _tool_detail("bash", {"command": long_cmd})
        assert len(result) == 80

    def test_query_key(self):
        result = _tool_detail("search", {"query": "python async"})
        assert result == "python async"

    def test_url_key(self):
        result = _tool_detail("fetch", {"url": "https://example.com"})
        assert result == "https://example.com"

    def test_path_key(self):
        result = _tool_detail("read", {"path": "/tmp/test.py"})
        assert result == "/tmp/test.py"

    def test_pattern_key(self):
        result = _tool_detail("grep", {"pattern": "def main"})
        assert result == "def main"

    def test_fallback_first_string_arg(self):
        result = _tool_detail("custom_tool", {"foo": 42, "bar": "some text"})
        assert result == "some text"

    def test_empty_args(self):
        result = _tool_detail("tool", {})
        assert result == ""

    def test_no_string_args(self):
        result = _tool_detail("tool", {"count": 5, "flag": True})
        assert result == ""


class TestProgressLog:
    def test_record_defaults(self):
        record = SubagentRunRecord(
            child_session_id="c1",
            parent_session_id="p1",
            task="test",
        )
        assert record.progress_log == []
        assert record.current_iteration == 0

    def test_progress_log_append(self):
        record = SubagentRunRecord(
            child_session_id="c1",
            parent_session_id="p1",
            task="test",
        )
        step = ProgressStep(tool_name="bash", detail="ls")
        record.progress_log.append(step)
        assert len(record.progress_log) == 1
        assert record.progress_log[0].tool_name == "bash"

    def test_iteration_tracking(self):
        record = SubagentRunRecord(
            child_session_id="c1",
            parent_session_id="p1",
            task="test",
        )
        record.current_iteration = 3
        assert record.current_iteration == 3
