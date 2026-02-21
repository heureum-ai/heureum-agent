# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for sub-agent spawning."""

import asyncio
import time
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from app.models import LLMResult, LLMResultType, ToolCallInfo
from app.schemas.open_responses import InputTokenDetails, OutputTokenDetails, Usage
from app.services.subagent import (
    ProgressStep,
    SpawnRequest,
    SubagentRegistry,
    SubagentRunRecord,
    _announce_completion,
    _build_subagent_instructions,
    _clear_depth,
    _FilteredSkillProvider,
    _resolve_child_tools,
    _session_depth,
    _tool_detail,
    await_active_subagents,
    get_registry,
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

        with (
            patch("app.services.subagent._clear_depth"),
            patch("app.routers.agent.mcp_client"),
            patch("app.routers.agent.chain_registry"),
            patch("app.routers.agent.skill_provider"),
            patch("app.services.loop_detection.clear_session_loop_state"),
        ):
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

    def test_sweep_cleans_shared_state(self):
        reg = SubagentRegistry()
        r = SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="t1")
        r.status = "failed"
        r.completed_at = time.time() - 700
        reg.register(r)

        mock_mcp = MagicMock()
        mock_chain = MagicMock()
        mock_skill = MagicMock()
        mock_loop_clear = MagicMock()

        with (
            patch("app.services.subagent._clear_depth"),
            patch("app.routers.agent.mcp_client", mock_mcp),
            patch("app.routers.agent.chain_registry", mock_chain),
            patch("app.routers.agent.skill_provider", mock_skill),
            patch("app.services.loop_detection.clear_session_loop_state", mock_loop_clear),
        ):
            reg.sweep_stale()

        mock_mcp.clear_session_state.assert_called_once_with("c1")
        mock_chain.clear_session.assert_called_once_with("c1")
        mock_skill.clear_session.assert_called_once_with("c1")
        mock_loop_clear.assert_called_once_with("c1")


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


# ---------------------------------------------------------------------------
# _FilteredSkillProvider
# ---------------------------------------------------------------------------


class TestFilteredSkillProvider:
    def setup_method(self):
        self.base = MagicMock()
        self.provider = _FilteredSkillProvider(self.base, {"tool_a", "tool_b"})

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
    def test_inherits_all_tools_without_whitelist(self):
        mock_svc = MagicMock()
        mock_svc.mcp_tools = [
            {"function": {"name": "bash"}},
            {"function": {"name": "read"}},
        ]
        mock_mcp = MagicMock()
        mock_mcp._approval_required_tools = set()
        mock_skill = MagicMock()
        mock_skill.get_all_tool_schemas.return_value = []

        request = SpawnRequest(parent_session_id="p1", task="t", tools=None)

        with (
            patch("app.routers.agent.agent_service", mock_svc),
            patch("app.routers.agent.mcp_client", mock_mcp),
            patch("app.routers.agent.skill_provider", mock_skill),
        ):
            mcp_tools, sp, names = _resolve_child_tools(request)

        assert len(mcp_tools) == 2
        assert "bash" in names
        assert "read" in names

    def test_whitelist_filters_tools(self):
        mock_svc = MagicMock()
        mock_svc.mcp_tools = [
            {"function": {"name": "bash"}},
            {"function": {"name": "read"}},
            {"function": {"name": "write"}},
        ]
        mock_mcp = MagicMock()
        mock_mcp._approval_required_tools = set()
        mock_skill = MagicMock()
        mock_skill.get_all_tool_schemas.return_value = []

        request = SpawnRequest(parent_session_id="p1", task="t", tools=["bash", "read"])

        with (
            patch("app.routers.agent.agent_service", mock_svc),
            patch("app.routers.agent.mcp_client", mock_mcp),
            patch("app.routers.agent.skill_provider", mock_skill),
        ):
            mcp_tools, sp, names = _resolve_child_tools(request)

        assert len(mcp_tools) == 2
        assert "write" not in names

    def test_empty_whitelist_blocks_all_tools(self):
        mock_svc = MagicMock()
        mock_svc.mcp_tools = [
            {"function": {"name": "bash"}},
            {"function": {"name": "read"}},
        ]
        mock_mcp = MagicMock()
        mock_mcp._approval_required_tools = set()
        mock_skill = MagicMock()
        mock_skill.get_all_tool_schemas.return_value = [
            {"function": {"name": "plan_task"}},
        ]

        request = SpawnRequest(parent_session_id="p1", task="t", tools=[])

        with (
            patch("app.routers.agent.agent_service", mock_svc),
            patch("app.routers.agent.mcp_client", mock_mcp),
            patch("app.routers.agent.skill_provider", mock_skill),
        ):
            mcp_tools, sp, names = _resolve_child_tools(request)

        assert len(mcp_tools) == 0
        assert names == []

    def test_excludes_approval_required_tools(self):
        mock_svc = MagicMock()
        mock_svc.mcp_tools = [
            {"function": {"name": "bash"}},
            {"function": {"name": "dangerous"}},
        ]
        mock_mcp = MagicMock()
        mock_mcp._approval_required_tools = {"dangerous"}
        mock_skill = MagicMock()
        mock_skill.get_all_tool_schemas.return_value = []

        request = SpawnRequest(parent_session_id="p1", task="t", tools=None)

        with (
            patch("app.routers.agent.agent_service", mock_svc),
            patch("app.routers.agent.mcp_client", mock_mcp),
            patch("app.routers.agent.skill_provider", mock_skill),
        ):
            mcp_tools, sp, names = _resolve_child_tools(request)

        assert len(mcp_tools) == 1
        assert "dangerous" not in names

    def test_includes_skill_tool_names(self):
        mock_svc = MagicMock()
        mock_svc.mcp_tools = []
        mock_mcp = MagicMock()
        mock_mcp._approval_required_tools = set()
        mock_skill = MagicMock()
        mock_skill.get_all_tool_schemas.return_value = [
            {"function": {"name": "plan_task"}},
        ]

        request = SpawnRequest(parent_session_id="p1", task="t", tools=None)

        with (
            patch("app.routers.agent.agent_service", mock_svc),
            patch("app.routers.agent.mcp_client", mock_mcp),
            patch("app.routers.agent.skill_provider", mock_skill),
        ):
            mcp_tools, sp, names = _resolve_child_tools(request)

        assert "plan_task" in names


# ---------------------------------------------------------------------------
# _run_subagent
# ---------------------------------------------------------------------------


class TestRunSubagent:
    @pytest.mark.asyncio
    async def test_success_path(self):
        from app.services.subagent import _registry, _run_subagent

        record = SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="test")
        _registry.register(record)
        request = SpawnRequest(parent_session_id="p1", task="test", cleanup="delete")

        with (
            patch(
                "app.services.subagent._execute_subagent_task",
                new=AsyncMock(return_value="Done"),
            ),
            patch("app.services.subagent._announce_completion", new=AsyncMock()) as mock_announce,
            patch("app.services.subagent._clear_depth"),
            patch("app.routers.agent.mcp_client"),
            patch("app.routers.agent.chain_registry"),
            patch("app.routers.agent.skill_provider"),
            patch("app.services.loop_detection.clear_session_loop_state"),
        ):
            await _run_subagent(record, request)

        from app.services.subagent import _registry

        r = _registry.get("c1")
        # The record gets marked completed by _run_subagent
        assert r is None or r.status == "completed"
        mock_announce.assert_called_once()

    @pytest.mark.asyncio
    async def test_timeout_path(self):
        from app.services.subagent import _registry, _run_subagent

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
            await _run_subagent(record, request)

        assert record.status == "timeout"
        mock_announce.assert_called_once()
        assert "timed out" in mock_announce.call_args[0][1].lower()

    @pytest.mark.asyncio
    async def test_error_path(self):
        from app.services.subagent import _registry, _run_subagent

        record = SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="test")
        _registry.register(record)
        request = SpawnRequest(parent_session_id="p1", task="test", cleanup="keep")

        async def failing_task(*args, **kwargs):
            raise ValueError("something broke")

        with (
            patch("app.services.subagent._execute_subagent_task", new=failing_task),
            patch("app.services.subagent._announce_completion", new=AsyncMock()) as mock_announce,
        ):
            await _run_subagent(record, request)

        assert record.status == "failed"
        mock_announce.assert_called_once()
        assert "failed" in mock_announce.call_args[0][1].lower()

    @pytest.mark.asyncio
    async def test_cancel_path(self):
        from app.services.subagent import _registry, _run_subagent

        record = SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="test")
        _registry.register(record)
        request = SpawnRequest(parent_session_id="p1", task="test", cleanup="keep")

        async def cancelled_task(*args, **kwargs):
            raise asyncio.CancelledError()

        with (
            patch("app.services.subagent._execute_subagent_task", new=cancelled_task),
            patch("app.services.subagent._announce_completion", new=AsyncMock()) as mock_announce,
        ):
            await _run_subagent(record, request)

        assert record.status == "failed"
        # CancelledError does NOT call _announce_completion
        mock_announce.assert_not_called()

    @pytest.mark.asyncio
    async def test_cleanup_keep_skips_depth_clear(self):
        from app.services.subagent import _registry, _run_subagent

        record = SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="test")
        _registry.register(record)
        request = SpawnRequest(parent_session_id="p1", task="test", cleanup="keep")

        with (
            patch(
                "app.services.subagent._execute_subagent_task",
                new=AsyncMock(return_value="Done"),
            ),
            patch("app.services.subagent._announce_completion", new=AsyncMock()),
            patch("app.services.subagent._clear_depth") as mock_clear_depth,
        ):
            await _run_subagent(record, request)

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

    @pytest.mark.asyncio
    async def test_text_response_returns_immediately(self):
        from app.services.subagent import _execute_subagent_task

        record = SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="hello")
        request = SpawnRequest(parent_session_id="p1", task="hello")

        mock_service = MagicMock()
        mock_service.process_messages_with_tools = AsyncMock(
            return_value=self._make_text_result("All done")
        )
        mock_service._lc_sessions = {}
        mock_service._session_last_access = {}
        mock_service.aclose = AsyncMock()

        with (
            patch("app.services.subagent._resolve_child_tools", return_value=([], None, [])),
            patch("app.services.subagent.AgentService", return_value=mock_service),
            patch("app.routers.agent._execute_tool", new=AsyncMock()),
        ):
            result = await _execute_subagent_task(record, request)

        assert result == "All done"
        mock_service.aclose.assert_called_once()

    @pytest.mark.asyncio
    async def test_tool_call_then_text(self):
        from app.services.subagent import _execute_subagent_task

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
        mock_service._lc_sessions = {}
        mock_service._session_last_access = {}
        mock_service.aclose = AsyncMock()

        with (
            patch("app.services.subagent._resolve_child_tools", return_value=([], None, [])),
            patch("app.services.subagent.AgentService", return_value=mock_service),
            patch("app.routers.agent._execute_tool", new=AsyncMock(return_value="output")),
        ):
            result = await _execute_subagent_task(record, request)

        assert result == "Finished"
        assert record.current_iteration == 2
        assert len(record.progress_log) == 1
        assert record.progress_log[0].tool_name == "bash"
        assert record.progress_log[0].status == "completed"

    @pytest.mark.asyncio
    async def test_tool_execution_failure_records_error(self):
        from app.services.subagent import _execute_subagent_task

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
        mock_service._lc_sessions = {}
        mock_service._session_last_access = {}
        mock_service.aclose = AsyncMock()

        async def failing_execute(*args, **kwargs):
            raise RuntimeError("tool broke")

        with (
            patch("app.services.subagent._resolve_child_tools", return_value=([], None, [])),
            patch("app.services.subagent.AgentService", return_value=mock_service),
            patch("app.routers.agent._execute_tool", new=failing_execute),
        ):
            result = await _execute_subagent_task(record, request)

        assert result == "Done anyway"
        assert record.progress_log[0].status == "failed"

    @pytest.mark.asyncio
    async def test_max_iterations_returns_message(self):
        from app.services.subagent import _execute_subagent_task

        record = SubagentRunRecord(child_session_id="c1", parent_session_id="p1", task="task")
        request = SpawnRequest(parent_session_id="p1", task="task")

        mock_service = MagicMock()
        # Always return tool calls, never text
        mock_service.process_messages_with_tools = AsyncMock(
            return_value=self._make_tool_result("bash", {}, "c1")
        )
        mock_service.append_tool_interaction = AsyncMock()
        mock_service._lc_sessions = {}
        mock_service._session_last_access = {}
        mock_service.aclose = AsyncMock()

        with (
            patch("app.services.subagent._resolve_child_tools", return_value=([], None, [])),
            patch("app.services.subagent.AgentService", return_value=mock_service),
            patch("app.routers.agent._execute_tool", new=AsyncMock(return_value="")),
            patch("app.services.subagent.settings") as mock_settings,
        ):
            mock_settings.MAX_AGENT_ITERATIONS = 3
            result = await _execute_subagent_task(record, request)

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
        from app.services.subagent import _registry

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
        from app.services.subagent import _registry

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

        mock_svc = MagicMock()
        mock_svc._lc_sessions = property(lambda self: (_ for _ in ()).throw(RuntimeError("fail")))
        # Make accessing _lc_sessions always raise
        type(mock_svc)._lc_sessions = property(
            lambda self: (_ for _ in ()).throw(RuntimeError("always fail"))
        )

        with (
            patch("app.routers.agent.agent_service", mock_svc),
            patch("asyncio.sleep", new=AsyncMock()),
        ):
            # Should not raise even after all retries exhausted
            await _announce_completion(record, "done", max_retries=2)
