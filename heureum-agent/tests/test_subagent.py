# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for sub-agent spawning."""

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from app.models import LLMResult, LLMResultType, ToolCallInfo
from app.schemas.open_responses import InputTokenDetails, OutputTokenDetails, Usage
from app.services.skills.controller import _FilteredSkillController
from app.services.tools.controller import ToolController
from app.services.tools.hooks import ToolHookRunner
from app.skills.plan_task.service import (
    ProgressStep,
    SpawnRequest,
    SubagentRegistry,
    SubagentRunRecord,
    _clear_depth,
    _session_depth,
    await_active_subagents,
    get_registry,
    get_subagent_depth,
    spawn_subagent,
)
from app.services.skills.types import SkillMeta
from app.services.subagent import (
    SubagentContext,
    _announce_completion,
    _build_subagent_instructions,
    _resolve_child_tools,
    _tool_detail,
    set_context as set_subagent_context,
)


@pytest.fixture(autouse=True)
def _clean_state():
    """Clean up module-level state between tests."""
    yield
    _session_depth.clear()
    from app.skills.plan_task.service import _registry
    import app.services.subagent as _mod

    _registry._runs.clear()
    _mod._context = None


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
        reg.register(SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="t1"))
        reg.register(SubagentRunRecord(child_session_id="c2", parent_session_id="p1", task="t2"))
        reg.register(SubagentRunRecord(child_session_id="c3", parent_session_id="p2", task="t3"))
        assert reg.count_active("p1") == 2
        assert reg.count_active("p2") == 1

    def test_count_active_excludes_completed(self):
        reg = SubagentRegistry()
        reg.register(SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="t1"))
        reg.register(SubagentRunRecord(child_session_id="c2", parent_session_id="p1", task="t2"))
        reg.mark_completed("c1", "completed", "done")
        assert reg.count_active("p1") == 1

    def test_cleanup(self):
        reg = SubagentRegistry()
        reg.register(SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="t1"))
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
        from app.skills.plan_task.service import _set_child_depth

        _set_child_depth("child", "parent")
        assert get_subagent_depth("child") == 1

    def test_nested_depth(self):
        _session_depth["parent"] = 0
        _session_depth["child"] = 1
        from app.skills.plan_task.service import _set_child_depth

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
        mock_create_task = MagicMock(return_value=MagicMock())
        result = await spawn_subagent(request, mock_create_task)
        assert result.status == "accepted"
        assert result.child_session_id.startswith("subagent_")
        mock_create_task.assert_called_once()

    @pytest.mark.asyncio
    async def test_depth_forbidden(self):
        """Spawn should be forbidden when depth limit reached."""
        _session_depth["parent1"] = 2  # At max depth (default is 2)
        request = SpawnRequest(
            parent_session_id="parent1",
            task="Nested task",
        )
        result = await spawn_subagent(request, MagicMock())
        assert result.status == "forbidden"
        assert "depth" in result.message.lower()

    @pytest.mark.asyncio
    async def test_max_children_forbidden(self):
        """Spawn should be forbidden when max children reached."""
        from app.skills.plan_task.service import _registry

        # Fill up children
        for i in range(5):
            _registry.register(
                SubagentRunRecord(
                    child_session_id=f"child_{i}",
                    parent_session_id="parent2",
                    task=f"task_{i}",
                )
            )

        request = SpawnRequest(
            parent_session_id="parent2",
            task="One more task",
        )
        result = await spawn_subagent(request, MagicMock())
        assert result.status == "forbidden"
        assert "children" in result.message.lower()


# ---------------------------------------------------------------------------
# _announce_completion
# ---------------------------------------------------------------------------


class TestAnnounceCompletion:
    def _set_mock_context(self, mock_svc):
        """Install a SubagentContext backed by mock_svc."""
        set_subagent_context(
            SubagentContext(
                agent_service=mock_svc,
                mcp_client=MagicMock(),
                skill_controller=MagicMock(),
                tool_controller=MagicMock(),
                execute_tool=AsyncMock(),
            )
        )

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
        mock_svc._sessions = mock_sessions
        self._set_mock_context(mock_svc)

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
        mock_svc._sessions = MockSessions()
        self._set_mock_context(mock_svc)

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
        mock_svc._sessions = {}
        self._set_mock_context(mock_svc)

        # Should not raise
        await _announce_completion(record, "done")


# ---------------------------------------------------------------------------
# ProgressStep & _tool_detail
# ---------------------------------------------------------------------------


class TestProgressStep:
    def test_defaults(self):
        step = ProgressStep(tool_name="bash", display_name="Bash", detail="ls -la")
        assert step.status == "running"
        assert step.completed_at is None
        assert step.started_at > 0

    def test_status_update(self):
        step = ProgressStep(tool_name="read", display_name="Read", detail="/tmp/file.txt")
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
        step = ProgressStep(tool_name="bash", display_name="Bash", detail="ls")
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


# ---------------------------------------------------------------------------
# SubagentRegistry – list_by_parent & sweep_stale
# ---------------------------------------------------------------------------


class TestRegistryListByParent:
    def test_returns_matching_records(self):
        reg = SubagentRegistry()
        r1 = SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="t1")
        r2 = SubagentRunRecord(child_session_id="c2", parent_session_id="p1", task="t2")
        r3 = SubagentRunRecord(child_session_id="c3", parent_session_id="p2", task="t3")
        reg.register(r1)
        reg.register(r2)
        reg.register(r3)
        result = reg.list_by_parent("p1")
        assert len(result) == 2
        assert set(r.child_session_id for r in result) == {"c1", "c2"}

    def test_empty_for_unknown_parent(self):
        reg = SubagentRegistry()
        assert reg.list_by_parent("unknown") == []


class TestRegistrySweepStale:
    def test_sweep_removes_old_completed(self):
        reg = SubagentRegistry()
        r = SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="t1")
        r.status = "completed"
        r.completed_at = time.time() - 700  # older than STALE_TTL_SECONDS (600)
        reg.register(r)

        swept = reg.sweep_stale()

        assert swept == ["c1"]
        assert reg.get("c1") is None

    def test_sweep_keeps_running(self):
        reg = SubagentRegistry()
        r = SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="t1")
        r.status = "running"
        r.started_at = time.time() - 700
        reg.register(r)

        swept = reg.sweep_stale()
        assert swept == []
        assert reg.get("c1") is not None

    def test_sweep_keeps_recent_completed(self):
        reg = SubagentRegistry()
        r = SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="t1")
        r.status = "completed"
        r.completed_at = time.time() - 10  # recent
        reg.register(r)

        swept = reg.sweep_stale()
        assert swept == []
        assert reg.get("c1") is not None

    def test_sweep_returns_stale_ids_for_caller_cleanup(self):
        """sweep_stale returns IDs; cleanup is caller's responsibility."""
        reg = SubagentRegistry()
        r = SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="t1")
        r.status = "failed"
        r.completed_at = time.time() - 700
        reg.register(r)

        swept = reg.sweep_stale()

        assert swept == ["c1"]
        assert reg.get("c1") is None


# ---------------------------------------------------------------------------
# get_registry
# ---------------------------------------------------------------------------


class TestGetRegistry:
    def test_returns_singleton(self):
        r1 = get_registry()
        r2 = get_registry()
        assert r1 is r2


# ---------------------------------------------------------------------------
# _build_subagent_instructions
# ---------------------------------------------------------------------------


class TestBuildSubagentInstructions:
    def test_includes_task(self):
        result = _build_subagent_instructions("Do something", [])
        assert "Do something" in result
        assert "## Task" in result

    def test_includes_tools_when_provided(self):
        result = _build_subagent_instructions("task", ["bash", "read_file"])
        assert "bash" in result
        assert "read_file" in result
        assert "## Available Tools" in result

    def test_no_tools_section_when_empty(self):
        result = _build_subagent_instructions("task", [])
        assert "## Available Tools" not in result

    def test_includes_constraints(self):
        result = _build_subagent_instructions("task", [])
        assert "## Constraints" in result
        assert "autonomously" in result

    def test_no_spawn_constraint_by_default(self):
        result = _build_subagent_instructions("task", [])
        assert "Do NOT spawn sub-agents" in result

    def test_can_spawn_removes_constraint(self):
        result = _build_subagent_instructions("task", [], can_spawn=True)
        assert "Do NOT spawn sub-agents" not in result
        assert "## Rules" in result

    def test_can_spawn_false_keeps_constraint(self):
        result = _build_subagent_instructions("task", [], can_spawn=False)
        assert "Do NOT spawn sub-agents" in result

    def test_orchestrator_phases_included_when_can_spawn(self):
        result = _build_subagent_instructions("task", [], can_spawn=True)
        assert "## Phase 1: Planning" in result
        assert "## Phase 2: Execution" in result
        assert "manage_todo" in result

    def test_phases_excluded_for_leaf(self):
        result = _build_subagent_instructions("task", [], can_spawn=False)
        assert "## Phase 1" not in result
        assert "## Phase 2" not in result


# ---------------------------------------------------------------------------
# _FilteredSkillController
# ---------------------------------------------------------------------------


class TestFilteredSkillProvider:
    def setup_method(self):
        self.base = MagicMock()
        self.provider = _FilteredSkillController(self.base, {"tool_a", "tool_b"})

    def test_get_all_tool_schemas_filters(self):
        self.base.get_all_tool_schemas.return_value = [
            {"function": {"name": "tool_a"}},
            {"function": {"name": "tool_c"}},
        ]
        result = self.provider.get_all_tool_schemas()
        assert len(result) == 1
        assert result[0]["function"]["name"] == "tool_a"

    @pytest.mark.asyncio
    async def test_execute_tool_allowed(self):
        self.base.execute_tool = AsyncMock(return_value="ok")
        result = await self.provider.execute_tool("tool_a", {}, "s1")
        self.base.execute_tool.assert_called_once_with("tool_a", {}, "s1")
        assert result == "ok"

    @pytest.mark.asyncio
    async def test_execute_tool_blocked(self):
        with pytest.raises(KeyError, match="not allowed"):
            await self.provider.execute_tool("tool_c", {}, "s1")

    def test_get_skill_for_tool_allowed(self):
        self.base.get_skill_for_tool.return_value = "skill_a"
        assert self.provider.get_skill_for_tool("tool_a") == "skill_a"

    def test_get_skill_for_tool_blocked(self):
        assert self.provider.get_skill_for_tool("tool_c") is None

    def test_delegates_guide_prompts(self):
        self.base.get_all_guide_prompts.return_value = ["prompt"]
        assert self.provider.get_all_guide_prompts() == ["prompt"]

    def test_delegates_state_prompts(self):
        self.base.get_state_prompts.return_value = ["state"]
        assert self.provider.get_state_prompts("s1") == ["state"]

    def test_delegates_clear_session(self):
        self.provider.clear_session("s1")
        self.base.clear_session.assert_called_once_with("s1")

    @pytest.mark.asyncio
    async def test_delegates_await_pending(self):
        self.base.await_pending = AsyncMock()
        await self.provider.await_pending("s1", timeout=10.0)
        self.base.await_pending.assert_called_once_with("s1", 10.0)


# ---------------------------------------------------------------------------
# _resolve_child_tools
# ---------------------------------------------------------------------------

# Mock deny-list side effect matching real SKILL.md declarations
_DENY_NEVER = {"activate_skill", "notify_user", "manage_periodic_task"}
_DENY_ORCH = {"manage_todo", "sessions_spawn", "sessions_spawn_status"}


def _mock_deny_side_effect(depth: int, max_depth: int) -> set:
    denied = set(_DENY_NEVER)
    if depth >= max_depth:
        denied |= _DENY_ORCH
    return denied


class TestResolveChildTools:
    def _set_ctx(self, mock_svc, mock_mcp, mock_skill):
        mock_skill.get_subagent_denied_tools.side_effect = _mock_deny_side_effect
        mock_skill.get_subagent_orchestrator_tools.return_value = set(_DENY_ORCH)
        set_subagent_context(
            SubagentContext(
                agent_service=mock_svc,
                mcp_client=mock_mcp,
                skill_controller=mock_skill,
                tool_controller=MagicMock(),
                execute_tool=AsyncMock(),
            )
        )

    def test_inherits_all_tools_without_whitelist(self):
        mock_svc = MagicMock()
        mock_svc.mcp_tool_controller.get_tool_schemas.return_value = [
            {"function": {"name": "bash"}},
            {"function": {"name": "read"}},
        ]
        mock_mcp = MagicMock()
        mock_mcp._approval_required_tools = set()
        mock_skill = MagicMock()
        mock_skill.get_all_tool_schemas.return_value = []

        self._set_ctx(mock_svc, mock_mcp, mock_skill)
        request = SpawnRequest(parent_session_id="p1", task="t", tools=None)
        mcp_tools, sp, names = _resolve_child_tools(request)

        assert len(mcp_tools) == 2
        assert "bash" in names
        assert "read" in names

    def test_whitelist_filters_tools(self):
        mock_svc = MagicMock()
        mock_svc.mcp_tool_controller.get_tool_schemas.return_value = [
            {"function": {"name": "bash"}},
            {"function": {"name": "read"}},
            {"function": {"name": "write"}},
        ]
        mock_mcp = MagicMock()
        mock_mcp._approval_required_tools = set()
        mock_skill = MagicMock()
        mock_skill.get_all_tool_schemas.return_value = []

        self._set_ctx(mock_svc, mock_mcp, mock_skill)
        request = SpawnRequest(parent_session_id="p1", task="t", tools=["bash", "read"])
        mcp_tools, sp, names = _resolve_child_tools(request)

        assert len(mcp_tools) == 2
        assert "write" not in names

    def test_inherits_all_tools_including_approval_required(self):
        mock_svc = MagicMock()
        mock_svc.mcp_tool_controller.get_tool_schemas.return_value = [
            {"function": {"name": "bash"}},
            {"function": {"name": "mcp_web__search"}},
        ]
        mock_mcp = MagicMock()
        mock_mcp._approval_required_tools = {"mcp_web__search"}
        mock_skill = MagicMock()
        mock_skill.get_all_tool_schemas.return_value = []

        self._set_ctx(mock_svc, mock_mcp, mock_skill)
        request = SpawnRequest(parent_session_id="p1", task="t", tools=None)
        mcp_tools, sp, names = _resolve_child_tools(request)

        assert len(mcp_tools) == 2
        assert "mcp_web__search" in names

    def test_includes_skill_tool_names(self):
        mock_svc = MagicMock()
        mock_svc.mcp_tool_controller.get_tool_schemas.return_value = []
        mock_mcp = MagicMock()
        mock_mcp._approval_required_tools = set()
        mock_skill = MagicMock()
        mock_skill.get_all_tool_schemas.return_value = [
            {"function": {"name": "manage_todo"}},
        ]
        # The filtered controller also needs to return schemas
        filtered_mock = MagicMock()
        filtered_mock.get_all_tool_schemas.return_value = [
            {"function": {"name": "manage_todo"}},
        ]
        mock_skill.filtered.return_value = filtered_mock

        self._set_ctx(mock_svc, mock_mcp, mock_skill)
        _session_depth["p1"] = 0
        request = SpawnRequest(parent_session_id="p1", task="t", tools=None)
        mcp_tools, sp, names = _resolve_child_tools(request)

        assert "manage_todo" in names


# ---------------------------------------------------------------------------
# _run_subagent
# ---------------------------------------------------------------------------


class TestRunSubagent:
    @pytest.mark.asyncio
    async def test_success_path(self):
        from app.skills.plan_task.service import _registry
        from app.services.subagent import _run_subagent

        record = SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="test")
        _registry.register(record)
        request = SpawnRequest(parent_session_id="p1", task="test", cleanup="delete")
        mock_clear_depth = MagicMock()

        mock_usage = Usage(
            input_tokens=100, output_tokens=50, total_tokens=150,
            input_tokens_details=InputTokenDetails(),
            output_tokens_details=OutputTokenDetails(),
        )
        set_subagent_context(
            SubagentContext(
                agent_service=MagicMock(),
                mcp_client=MagicMock(),
                skill_controller=MagicMock(),
                tool_controller=MagicMock(),
                execute_tool=AsyncMock(),
            )
        )

        with (
            patch(
                "app.services.subagent._execute_subagent_task",
                new=AsyncMock(return_value=("Done", mock_usage)),
            ),
            patch("app.services.subagent._announce_completion", new=AsyncMock()) as mock_announce,
            patch("app.services.subagent.cleanup_session_state"),
        ):
            await _run_subagent(record, request, _registry, mock_clear_depth)

        r = _registry.get("c1")
        # The record gets marked completed by _run_subagent
        assert r is None or r.status == "completed"
        mock_announce.assert_called_once()
        mock_clear_depth.assert_called_once_with("c1")

    @pytest.mark.asyncio
    async def test_timeout_path(self):
        from app.skills.plan_task.service import _registry
        from app.services.subagent import _run_subagent

        record = SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="test")
        _registry.register(record)
        request = SpawnRequest(parent_session_id="p1", task="test", cleanup="keep")

        async def slow_task(*args, **kwargs):
            await asyncio.sleep(999)

        with (
            patch("app.services.subagent._execute_subagent_task", new=slow_task),
            patch("app.services.subagent._announce_completion", new=AsyncMock()) as mock_announce,
            patch("app.services.subagent.settings") as mock_settings,
        ):
            mock_settings.SUBAGENT_TIMEOUT_SECONDS = 0.01
            await _run_subagent(record, request, _registry, MagicMock())

        assert record.status == "timeout"
        mock_announce.assert_called_once()
        assert "timed out" in mock_announce.call_args[0][1].lower()

    @pytest.mark.asyncio
    async def test_error_path(self):
        from app.skills.plan_task.service import _registry
        from app.services.subagent import _run_subagent

        record = SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="test")
        _registry.register(record)
        request = SpawnRequest(parent_session_id="p1", task="test", cleanup="keep")

        async def failing_task(*args, **kwargs):
            raise ValueError("something broke")

        with (
            patch("app.services.subagent._execute_subagent_task", new=failing_task),
            patch("app.services.subagent._announce_completion", new=AsyncMock()) as mock_announce,
        ):
            await _run_subagent(record, request, _registry, MagicMock())

        assert record.status == "failed"
        mock_announce.assert_called_once()
        assert "failed" in mock_announce.call_args[0][1].lower()

    @pytest.mark.asyncio
    async def test_cancel_path(self):
        from app.skills.plan_task.service import _registry
        from app.services.subagent import _run_subagent

        record = SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="test")
        _registry.register(record)
        request = SpawnRequest(parent_session_id="p1", task="test", cleanup="keep")

        async def cancelled_task(*args, **kwargs):
            raise asyncio.CancelledError()

        with (
            patch("app.services.subagent._execute_subagent_task", new=cancelled_task),
            patch("app.services.subagent._announce_completion", new=AsyncMock()) as mock_announce,
        ):
            await _run_subagent(record, request, _registry, MagicMock())

        assert record.status == "failed"
        # CancelledError does NOT call _announce_completion
        mock_announce.assert_not_called()

    @pytest.mark.asyncio
    async def test_cleanup_keep_skips_depth_clear(self):
        from app.skills.plan_task.service import _registry
        from app.services.subagent import _run_subagent

        mock_usage = Usage(
            input_tokens=10, output_tokens=5, total_tokens=15,
            input_tokens_details=InputTokenDetails(),
            output_tokens_details=OutputTokenDetails(),
        )
        record = SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="test")
        _registry.register(record)
        request = SpawnRequest(parent_session_id="p1", task="test", cleanup="keep")
        mock_clear_depth = MagicMock()

        with (
            patch(
                "app.services.subagent._execute_subagent_task",
                new=AsyncMock(return_value=("Done", mock_usage)),
            ),
            patch("app.services.subagent._announce_completion", new=AsyncMock()),
        ):
            await _run_subagent(record, request, _registry, mock_clear_depth)

        mock_clear_depth.assert_not_called()


# ---------------------------------------------------------------------------
# _execute_subagent_task
# ---------------------------------------------------------------------------


class TestExecuteSubagentTask:
    def _make_text_result(self, text="Done"):
        return LLMResult(
            type=LLMResultType.TEXT,
            text=text,
            session_id="c1",
            usage=Usage(
                input_tokens=10,
                output_tokens=5,
                total_tokens=15,
                input_tokens_details=InputTokenDetails(),
                output_tokens_details=OutputTokenDetails(),
            ),
        )

    def _make_tool_result(self, name="bash", args=None, call_id="call_1"):
        return LLMResult(
            type=LLMResultType.TOOL_CALL,
            tool_calls=[ToolCallInfo(name=name, args=args or {}, id=call_id)],
            session_id="c1",
            usage=Usage(
                input_tokens=10,
                output_tokens=5,
                total_tokens=15,
                input_tokens_details=InputTokenDetails(),
                output_tokens_details=OutputTokenDetails(),
            ),
            assistant_lc_message=MagicMock(),
        )

    def _set_ctx(self, execute_tool=None, persist_controller=None):
        set_subagent_context(
            SubagentContext(
                agent_service=MagicMock(),
                mcp_client=MagicMock(),
                skill_controller=MagicMock(),
                tool_controller=ToolController(
                    tool_hook_runner=ToolHookRunner(register_defaults=False)
                ),
                execute_tool=execute_tool or AsyncMock(),
                persist_controller=persist_controller,
            )
        )

    @pytest.mark.asyncio
    async def test_text_response_returns_immediately(self):
        from app.services.subagent import _execute_subagent_task
        from app.skills.plan_task.service import _registry

        record = SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="hello")
        request = SpawnRequest(parent_session_id="p1", task="hello")

        mock_service = MagicMock()
        mock_service.process_messages_with_tools = AsyncMock(
            return_value=self._make_text_result("All done")
        )
        mock_service.message_controller.session_state_controller.set_session = MagicMock()
        mock_service.aclose = AsyncMock()

        self._set_ctx()
        with (
            patch("app.services.subagent._resolve_child_tools", return_value=([], None, [])),
            patch("app.services.subagent.AgentService", return_value=mock_service),
        ):
            text, usage = await _execute_subagent_task(record, request, _registry)

        assert text == "All done"
        assert usage.input_tokens == 10
        assert usage.output_tokens == 5
        assert usage.total_tokens == 15
        mock_service.aclose.assert_called_once()

    @pytest.mark.asyncio
    async def test_tool_call_then_text(self):
        from app.services.subagent import _execute_subagent_task
        from app.skills.plan_task.service import _registry

        record = SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="task")
        request = SpawnRequest(parent_session_id="p1", task="task")

        call_count = 0
        mock_service = MagicMock()

        async def process_side_effect(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return self._make_tool_result("bash", {"command": "ls"}, "c1")
            return self._make_text_result("Finished")

        mock_service.process_messages_with_tools = AsyncMock(side_effect=process_side_effect)
        mock_service.append_tool_interaction = AsyncMock()
        mock_service.message_controller.session_state_controller.set_session = MagicMock()
        mock_service.aclose = AsyncMock()

        self._set_ctx(execute_tool=AsyncMock(return_value="output"))
        with (
            patch("app.services.subagent._resolve_child_tools", return_value=([], None, [])),
            patch("app.services.subagent.AgentService", return_value=mock_service),
        ):
            text, usage = await _execute_subagent_task(record, request, _registry)

        assert text == "Finished"
        # Two iterations: tool call (10 in, 5 out) + text (10 in, 5 out)
        assert usage.input_tokens == 20
        assert usage.output_tokens == 10
        assert usage.total_tokens == 30
        assert record.current_iteration == 2
        assert len(record.progress_log) == 1
        assert record.progress_log[0].tool_name == "bash"
        assert record.progress_log[0].status == "completed"

    @pytest.mark.asyncio
    async def test_tool_execution_failure_records_error(self):
        from app.services.subagent import _execute_subagent_task
        from app.skills.plan_task.service import _registry

        record = SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="task")
        request = SpawnRequest(parent_session_id="p1", task="task")

        call_count = 0
        mock_service = MagicMock()

        async def process_side_effect(*args, **kwargs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                return self._make_tool_result("bash", {"command": "fail"}, "c1")
            return self._make_text_result("Done anyway")

        mock_service.process_messages_with_tools = AsyncMock(side_effect=process_side_effect)
        mock_service.append_tool_interaction = AsyncMock()
        mock_service.message_controller.session_state_controller.set_session = MagicMock()
        mock_service.aclose = AsyncMock()

        async def failing_execute(*args, **kwargs):
            raise RuntimeError("tool broke")

        self._set_ctx(execute_tool=failing_execute)
        with (
            patch("app.services.subagent._resolve_child_tools", return_value=([], None, [])),
            patch("app.services.subagent.AgentService", return_value=mock_service),
        ):
            text, usage = await _execute_subagent_task(record, request, _registry)

        assert text == "Done anyway"
        assert usage.input_tokens == 20  # two iterations
        assert record.progress_log[0].status == "failed"

    @pytest.mark.asyncio
    async def test_max_iterations_returns_message(self):
        from app.services.subagent import _execute_subagent_task
        from app.skills.plan_task.service import _registry

        record = SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="task")
        request = SpawnRequest(parent_session_id="p1", task="task")

        mock_service = MagicMock()
        # Always return tool calls, never text
        mock_service.process_messages_with_tools = AsyncMock(
            return_value=self._make_tool_result("bash", {}, "c1")
        )
        mock_service.append_tool_interaction = AsyncMock()
        mock_service.message_controller.session_state_controller.set_session = MagicMock()
        mock_service.aclose = AsyncMock()

        self._set_ctx(execute_tool=AsyncMock(return_value=""))
        with (
            patch("app.services.subagent._resolve_child_tools", return_value=([], None, [])),
            patch("app.services.subagent.AgentService", return_value=mock_service),
            patch("app.services.subagent.settings") as mock_settings,
        ):
            mock_settings.SUBAGENT_MAX_ITERATIONS = 3
            mock_settings.MAX_PLAN_RETRIES = 3
            mock_settings.SUBAGENT_MAX_HISTORY_SIZE = 16
            mock_settings.SUBAGENT_POLL_THROTTLE_THRESHOLD = 5
            mock_settings.SUBAGENT_POLL_THROTTLE_DELAY = 2.0
            text, usage = await _execute_subagent_task(record, request, _registry)

        assert "maximum iterations" in text.lower()
        assert usage.input_tokens == 30  # 3 iterations × 10
        mock_service.aclose.assert_called_once()

    @pytest.mark.asyncio
    async def test_persist_enqueue_calls_are_ordered_without_await_blocking(self):
        from app.services.subagent import _execute_subagent_task
        from app.skills.plan_task.service import _registry

        record = SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="hello")
        request = SpawnRequest(parent_session_id="p1", task="hello")

        mock_service = MagicMock()
        mock_service.process_messages_with_tools = AsyncMock(
            return_value=self._make_text_result("All done")
        )
        mock_service.message_controller.session_state_controller.set_session = MagicMock()
        mock_service.aclose = AsyncMock()

        calls: list[str] = []

        async def _run_start(*args, **kwargs):
            calls.append("start")

        async def _message(*args, **kwargs):
            calls.append(f"message:{kwargs.get('role', '')}")

        mock_pc = MagicMock()
        mock_pc.enqueue_subagent_run_start = MagicMock(side_effect=lambda *a, **k: calls.append("start"))
        mock_pc.enqueue_subagent_message = MagicMock(
            side_effect=lambda *a, **k: calls.append(f"message:{k.get('role', '')}")
        )
        mock_pc.subagent_run_start = AsyncMock(side_effect=_run_start)
        mock_pc.subagent_message = AsyncMock(side_effect=_message)

        self._set_ctx(persist_controller=mock_pc)
        with (
            patch("app.services.subagent._resolve_child_tools", return_value=([], None, [])),
            patch("app.services.subagent.AgentService", return_value=mock_service),
        ):
            await _execute_subagent_task(record, request, _registry)

        assert calls == ["start", "message:user", "message:assistant"]
        mock_pc.subagent_run_start.assert_not_called()
        mock_pc.subagent_message.assert_not_called()


# ---------------------------------------------------------------------------
# await_active_subagents
# ---------------------------------------------------------------------------


class TestAwaitActiveSubagents:
    @pytest.mark.asyncio
    async def test_no_active_returns_empty(self):
        result = await await_active_subagents("nonexistent")
        assert result == []

    @pytest.mark.asyncio
    async def test_waits_for_active_tasks(self):
        from app.skills.plan_task.service import _registry

        done = asyncio.Event()

        async def child_work():
            done.set()

        task = asyncio.create_task(child_work())
        record = SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="t")
        record.asyncio_task = task
        _registry.register(record)

        result = await await_active_subagents("p1", timeout=5.0)
        assert len(result) == 1
        assert result[0].child_session_id == "c1"
        assert done.is_set()

    @pytest.mark.asyncio
    async def test_skips_completed_records(self):
        from app.skills.plan_task.service import _registry

        record = SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="t")
        record.status = "completed"
        record.asyncio_task = asyncio.create_task(asyncio.sleep(0))
        _registry.register(record)

        result = await await_active_subagents("p1")
        assert result == []


# ---------------------------------------------------------------------------
# _announce_completion – exhausted retries
# ---------------------------------------------------------------------------


# ---------------------------------------------------------------------------
# PersistController.sweep_stale_runs
# ---------------------------------------------------------------------------


class TestPersistControllerSweep:
    @pytest.mark.asyncio
    async def test_sweep_returns_count(self):
        from app.services.messages.persist import PersistController

        ctrl = PersistController("http://fake")
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"ok": True, "swept_count": 5}

        with patch.object(ctrl._client, "post", new=AsyncMock(return_value=mock_resp)) as mock_post:
            result = await ctrl.sweep_stale_runs(stale_seconds=300)

        assert result == 5
        mock_post.assert_called_once_with(
            "http://fake/api/v1/subagents/internal/runs/sweep/",
            json={"stale_seconds": 300},
            timeout=ctrl.TIMEOUT,
        )

    @pytest.mark.asyncio
    async def test_sweep_returns_zero_on_error(self):
        from app.services.messages.persist import PersistController

        ctrl = PersistController("http://fake")

        with patch.object(ctrl._client, "post", new=AsyncMock(side_effect=Exception("conn refused"))):
            result = await ctrl.sweep_stale_runs()

        assert result == 0

    @pytest.mark.asyncio
    async def test_sweep_default_stale_seconds(self):
        from app.services.messages.persist import PersistController

        ctrl = PersistController("http://fake")
        mock_resp = MagicMock()
        mock_resp.json.return_value = {"ok": True, "swept_count": 0}

        with patch.object(ctrl._client, "post", new=AsyncMock(return_value=mock_resp)) as mock_post:
            await ctrl.sweep_stale_runs()

        call_json = mock_post.call_args[1]["json"]
        assert call_json["stale_seconds"] == 600


class TestAnnounceCompletionExhaustedRetries:
    @pytest.mark.asyncio
    async def test_all_retries_fail(self):
        record = SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="test")

        class FailingSessions:
            def __contains__(self, key):
                raise RuntimeError("always fail")

        mock_svc = MagicMock()
        mock_svc._sessions = FailingSessions()
        set_subagent_context(
            SubagentContext(
                agent_service=mock_svc,
                mcp_client=MagicMock(),
                skill_controller=MagicMock(),
                tool_controller=MagicMock(),
                execute_tool=AsyncMock(),
            )
        )

        with patch("asyncio.sleep", new=AsyncMock()):
            # Should not raise even after all retries exhausted
            await _announce_completion(record, "done", max_retries=2)


# ---------------------------------------------------------------------------
# SkillController deny-list methods
# ---------------------------------------------------------------------------


def _make_skill_meta(name: str, tools: list, subagent_access: str = "always") -> SkillMeta:
    return SkillMeta(
        name=name, description="", body="",
        tools=tools, depends_on=[],
        subagent_access=subagent_access,
    )


class TestSkillControllerDenyList:
    def _build_controller(self):
        from app.services.skills.controller import SkillController

        ctrl = SkillController()
        return ctrl

    def test_deny_never_tools_at_any_depth(self):
        ctrl = self._build_controller()
        denied = ctrl.get_subagent_denied_tools(depth=1, max_depth=2)
        # activate_skill (never), notify_user (never), manage_periodic_task (never)
        assert "activate_skill" in denied
        assert "notify_user" in denied
        assert "manage_periodic_task" in denied
        # orchestrator tools NOT denied at non-leaf depth
        assert "manage_todo" not in denied
        assert "sessions_spawn" not in denied

    def test_deny_orchestrator_tools_at_leaf_depth(self):
        ctrl = self._build_controller()
        denied = ctrl.get_subagent_denied_tools(depth=2, max_depth=2)
        # never tools
        assert "activate_skill" in denied
        assert "notify_user" in denied
        assert "manage_periodic_task" in denied
        # orchestrator tools denied at leaf
        assert "manage_todo" in denied
        assert "sessions_spawn" in denied
        assert "sessions_spawn_status" in denied

    def test_beyond_max_depth_denies_orchestrator(self):
        ctrl = self._build_controller()
        denied = ctrl.get_subagent_denied_tools(depth=5, max_depth=2)
        assert "manage_todo" in denied
        assert "sessions_spawn" in denied

    def test_orchestrator_tools_excludes_never(self):
        ctrl = self._build_controller()
        orch_tools = ctrl.get_subagent_orchestrator_tools()
        assert "manage_todo" in orch_tools
        assert "sessions_spawn" in orch_tools
        assert "sessions_spawn_status" in orch_tools
        # never tools excluded
        assert "activate_skill" not in orch_tools
        assert "notify_user" not in orch_tools
        assert "manage_periodic_task" not in orch_tools


# ---------------------------------------------------------------------------
# _resolve_child_tools — deny-list filtering
# ---------------------------------------------------------------------------


class TestResolveChildToolsDenyList:
    def _set_ctx(self, mock_svc, mock_mcp, mock_skill):
        mock_skill.get_subagent_denied_tools.side_effect = _mock_deny_side_effect
        mock_skill.get_subagent_orchestrator_tools.return_value = set(_DENY_ORCH)
        set_subagent_context(
            SubagentContext(
                agent_service=mock_svc,
                mcp_client=mock_mcp,
                skill_controller=mock_skill,
                tool_controller=MagicMock(),
                execute_tool=AsyncMock(),
            )
        )

    def test_deny_list_removes_deny_always_from_all_tools(self):
        """When no tools/skills specified, DENY_ALWAYS tools are denied."""
        mock_svc = MagicMock()
        mock_svc.mcp_tool_controller.get_tool_schemas.return_value = [
            {"function": {"name": "bash"}},
            {"function": {"name": "read"}},
        ]
        mock_skill = MagicMock()
        mock_skill.get_all_tool_schemas.return_value = [
            {"function": {"name": "activate_skill"}},
            {"function": {"name": "notify_user"}},
            {"function": {"name": "manage_periodic_task"}},
            {"function": {"name": "manage_todo"}},
        ]
        mock_skill._session_snapshots = {}
        mock_skill._skills = {"plan_task": MagicMock()}
        mock_skill._tools_by_skill = {"plan_task": {"manage_todo"}}

        self._set_ctx(mock_svc, MagicMock(), mock_skill)
        _session_depth["p1"] = 0  # parent at depth 0, child will be depth 1

        request = SpawnRequest(parent_session_id="p1", task="t", tools=None)
        mcp_tools, sp, names = _resolve_child_tools(request)

        assert "activate_skill" not in names
        assert "notify_user" not in names
        assert "manage_periodic_task" not in names
        assert "bash" in names
        assert "read" in names

    def test_deny_list_applied_to_explicit_tools(self):
        """Explicit tools whitelist also gets deny-list filtering."""
        mock_svc = MagicMock()
        mock_svc.mcp_tool_controller.get_tool_schemas.return_value = [
            {"function": {"name": "bash"}},
            {"function": {"name": "activate_skill"}},
        ]
        mock_skill = MagicMock()
        mock_skill.get_all_tool_schemas.return_value = []

        self._set_ctx(mock_svc, MagicMock(), mock_skill)
        _session_depth["p1"] = 0

        request = SpawnRequest(
            parent_session_id="p1", task="t", tools=["bash", "activate_skill"]
        )
        mcp_tools, sp, names = _resolve_child_tools(request)

        assert "activate_skill" not in names
        assert "bash" in names

    def test_skill_based_resolution_orchestrator(self):
        """When request.skills is set, resolve_skill_tools returns only skill-defined tools."""
        mock_svc = MagicMock()
        mock_svc.mcp_tool_controller.get_tool_schemas.return_value = [
            {"function": {"name": "bash"}},
            {"function": {"name": "write_file"}},
            {"function": {"name": "web_search"}},
        ]
        mock_skill = MagicMock()
        # resolve_skill_tools returns only the tools for the requested skills
        mock_skill.resolve_skill_tools.return_value = {"bash", "write_file"}
        mock_skill.filtered.return_value = mock_skill
        mock_skill.get_all_tool_schemas.return_value = []

        self._set_ctx(mock_svc, MagicMock(), mock_skill)
        _session_depth["p1"] = 0  # child will be depth 1, max=2 → orchestrator

        request = SpawnRequest(
            parent_session_id="p1", task="t", skills=["coding_task"]
        )
        mcp_tools, sp, names = _resolve_child_tools(request)

        # Only coding_task tools — no auto-injection of orchestrator or MCP tools
        assert "bash" in names
        assert "write_file" in names
        # No orchestrator tools auto-injected
        assert "manage_todo" not in names
        # No unrelated MCP tools injected
        assert "web_search" not in names
        # DENY_ALWAYS tools not present
        assert "activate_skill" not in names
        assert "notify_user" not in names

    def test_skill_based_resolution_leaf_no_server_tools(self):
        """When request.skills is set at leaf depth, resolve_skill_tools determines tools."""
        mock_svc = MagicMock()
        mock_svc.mcp_tool_controller.get_tool_schemas.return_value = [
            {"function": {"name": "bash"}},
            {"function": {"name": "write_file"}},
        ]
        mock_skill = MagicMock()
        mock_skill.resolve_skill_tools.return_value = {"bash", "write_file"}
        mock_skill.filtered.return_value = mock_skill
        mock_skill.get_all_tool_schemas.return_value = []

        self._set_ctx(mock_svc, MagicMock(), mock_skill)
        _session_depth["p1"] = 1  # child will be depth 2, max=2 → leaf

        request = SpawnRequest(
            parent_session_id="p1", task="t", skills=["coding_task"]
        )
        mcp_tools, sp, names = _resolve_child_tools(request)

        # Only skill-defined tools
        assert "bash" in names
        assert "write_file" in names
        # No server tools injected
        assert "manage_todo" not in names
        assert "sessions_spawn" not in names
        assert "sessions_spawn_status" not in names

    def test_skill_based_resolution_only_skill_tools(self):
        """Skills-based resolution returns ONLY resolve_skill_tools output — no MCP auto-inject."""
        mock_svc = MagicMock()
        mock_svc.mcp_tool_controller.get_tool_schemas.return_value = [
            {"function": {"name": "mcp_web__search"}},
            {"function": {"name": "mcp_web__fetch"}},
            {"function": {"name": "mcp_filesystem__bash"}},
        ]
        mock_skill = MagicMock()
        # resolve_skill_tools returns only the tools declared in the skill schema
        mock_skill.resolve_skill_tools.return_value = {
            "mcp_web__search", "web_fetch", "read",
        }
        mock_skill.filtered.return_value = mock_skill
        mock_skill.get_all_tool_schemas.return_value = []

        self._set_ctx(mock_svc, MagicMock(), mock_skill)
        _session_depth["p1"] = 0  # orchestrator depth

        request = SpawnRequest(
            parent_session_id="p1", task="t", skills=["web_search_task"]
        )
        mcp_tools, sp, names = _resolve_child_tools(request)

        # Only skill-defined tools — mcp_web__search is in the skill, others are not
        assert "mcp_web__search" in names
        assert "web_fetch" not in [t.get("function", {}).get("name") for t in mcp_tools]
        # MCP tools not in skill schema are excluded
        assert "mcp_filesystem__bash" not in names

    def test_skill_based_resolution_leaf_only_skill_tools(self):
        """At leaf depth, only skill-defined tools are included."""
        mock_svc = MagicMock()
        mock_svc.mcp_tool_controller.get_tool_schemas.return_value = [
            {"function": {"name": "mcp_web__search"}},
            {"function": {"name": "mcp_web__fetch"}},
        ]
        mock_skill = MagicMock()
        # resolve_skill_tools returns only the tool declared in the skill
        mock_skill.resolve_skill_tools.return_value = {"mcp_web__search"}
        mock_skill.filtered.return_value = mock_skill
        mock_skill.get_all_tool_schemas.return_value = []

        self._set_ctx(mock_svc, MagicMock(), mock_skill)
        _session_depth["p1"] = 1  # child will be depth 2, max=2 → leaf

        request = SpawnRequest(
            parent_session_id="p1", task="t", skills=["web_search_task"]
        )
        mcp_tools, sp, names = _resolve_child_tools(request)

        # Only skill-defined tool
        assert "mcp_web__search" in names
        # mcp_web__fetch not in skill schema → excluded
        assert "mcp_web__fetch" not in names
        # No server tools
        assert "manage_todo" not in names
        assert "sessions_spawn" not in names
