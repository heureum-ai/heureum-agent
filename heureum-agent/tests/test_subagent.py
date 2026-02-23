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
        assert "## Constraints" in result

    def test_can_spawn_false_keeps_constraint(self):
        result = _build_subagent_instructions("task", [], can_spawn=False)
        assert "Do NOT spawn sub-agents" in result


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


class TestResolveChildTools:
    def _set_ctx(self, mock_svc, mock_mcp, mock_skill):
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

    def test_excludes_approval_required_tools(self):
        mock_svc = MagicMock()
        mock_svc.mcp_tool_controller.get_tool_schemas.return_value = [
            {"function": {"name": "bash"}},
            {"function": {"name": "dangerous"}},
        ]
        mock_mcp = MagicMock()
        mock_mcp._approval_required_tools = {"dangerous"}
        mock_skill = MagicMock()
        mock_skill.get_all_tool_schemas.return_value = []

        self._set_ctx(mock_svc, mock_mcp, mock_skill)
        request = SpawnRequest(parent_session_id="p1", task="t", tools=None)
        mcp_tools, sp, names = _resolve_child_tools(request)

        assert len(mcp_tools) == 1
        assert "dangerous" not in names

    def test_includes_skill_tool_names(self):
        mock_svc = MagicMock()
        mock_svc.mcp_tool_controller.get_tool_schemas.return_value = []
        mock_mcp = MagicMock()
        mock_mcp._approval_required_tools = set()
        mock_skill = MagicMock()
        mock_skill.get_all_tool_schemas.return_value = [
            {"function": {"name": "plan_task"}},
        ]

        self._set_ctx(mock_svc, mock_mcp, mock_skill)
        request = SpawnRequest(parent_session_id="p1", task="t", tools=None)
        mcp_tools, sp, names = _resolve_child_tools(request)

        assert "plan_task" in names


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
                new=AsyncMock(return_value="Done"),
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

        record = SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="test")
        _registry.register(record)
        request = SpawnRequest(parent_session_id="p1", task="test", cleanup="keep")
        mock_clear_depth = MagicMock()

        with (
            patch(
                "app.services.subagent._execute_subagent_task",
                new=AsyncMock(return_value="Done"),
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

    def _set_ctx(self, execute_tool=None):
        set_subagent_context(
            SubagentContext(
                agent_service=MagicMock(),
                mcp_client=MagicMock(),
                skill_controller=MagicMock(),
                tool_controller=ToolController(
                    tool_hook_runner=ToolHookRunner(register_defaults=False)
                ),
                execute_tool=execute_tool or AsyncMock(),
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
            result = await _execute_subagent_task(record, request, _registry)

        assert result == "All done"
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
            result = await _execute_subagent_task(record, request, _registry)

        assert result == "Finished"
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
            result = await _execute_subagent_task(record, request, _registry)

        assert result == "Done anyway"
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
            result = await _execute_subagent_task(record, request, _registry)

        assert "maximum iterations" in result.lower()
        mock_service.aclose.assert_called_once()


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
