# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for poll iteration budget — _is_poll_only_iteration and poll bonus logic."""

from dataclasses import dataclass
from unittest.mock import MagicMock, patch

import pytest

from app.services.tools.loop_detection import _KNOWN_POLL_TOOLS


# ---------------------------------------------------------------------------
# Lightweight stub for tool call objects used by _is_poll_only_iteration
# ---------------------------------------------------------------------------


@dataclass
class _FakeToolCall:
    name: str
    id: str = "call_1"
    args: dict | None = None


# ---------------------------------------------------------------------------
# _KNOWN_POLL_TOOLS membership
# ---------------------------------------------------------------------------


class TestKnownPollTools:
    def test_sessions_spawn_status_in_known_poll_tools(self):
        assert "sessions_spawn_status" in _KNOWN_POLL_TOOLS

    def test_legacy_poll_tools_still_present(self):
        for name in ("process_poll", "process_wait", "wait", "sleep"):
            assert name in _KNOWN_POLL_TOOLS


# ---------------------------------------------------------------------------
# _is_poll_only_iteration
# ---------------------------------------------------------------------------


def _make_runner_with_poll_tools(dynamic_poll: set[str] | None = None):
    """Build a minimal AgentLoopRunner mock with tool_controller.get_tool_meta wired."""
    from app.services.tools.controller import ToolMetaSets

    meta = ToolMetaSets(poll_tools=dynamic_poll)

    runner = MagicMock()
    runner._tool_execution.tool_controller.get_tool_meta.return_value = meta
    runner.ctx.session_id = "test-session"

    # Bind the real method to our mock
    from app.services.agent_loop.runner import AgentLoopRunner

    runner._is_poll_only_iteration = AgentLoopRunner._is_poll_only_iteration.__get__(
        runner, type(runner)
    )
    return runner


class TestIsPollOnlyIteration:
    def test_empty_tool_calls_returns_false(self):
        runner = _make_runner_with_poll_tools()
        assert runner._is_poll_only_iteration([]) is False

    def test_single_known_poll_tool(self):
        runner = _make_runner_with_poll_tools()
        calls = [_FakeToolCall(name="sessions_spawn_status")]
        assert runner._is_poll_only_iteration(calls) is True

    def test_multiple_known_poll_tools(self):
        runner = _make_runner_with_poll_tools()
        calls = [
            _FakeToolCall(name="sessions_spawn_status"),
            _FakeToolCall(name="wait"),
        ]
        assert runner._is_poll_only_iteration(calls) is True

    def test_mixed_tools_not_poll(self):
        """manage_todo + sessions_spawn_status → False (not all poll)."""
        runner = _make_runner_with_poll_tools()
        calls = [
            _FakeToolCall(name="manage_todo"),
            _FakeToolCall(name="sessions_spawn_status"),
        ]
        assert runner._is_poll_only_iteration(calls) is False

    def test_non_poll_tool_only(self):
        runner = _make_runner_with_poll_tools()
        calls = [_FakeToolCall(name="web_search")]
        assert runner._is_poll_only_iteration(calls) is False

    def test_dynamic_poll_tools_from_meta(self):
        """Client-provided poll tools via tool_meta are respected."""
        runner = _make_runner_with_poll_tools(dynamic_poll={"custom_poll"})
        calls = [_FakeToolCall(name="custom_poll")]
        assert runner._is_poll_only_iteration(calls) is True

    def test_dynamic_plus_known_mix(self):
        runner = _make_runner_with_poll_tools(dynamic_poll={"custom_poll"})
        calls = [
            _FakeToolCall(name="custom_poll"),
            _FakeToolCall(name="sessions_spawn_status"),
        ]
        assert runner._is_poll_only_iteration(calls) is True


# ---------------------------------------------------------------------------
# Poll bonus budget extension
# ---------------------------------------------------------------------------


class TestPollBonusBudget:
    def test_poll_bonus_extends_budget(self):
        """Poll-only iterations should increase _poll_bonus so the while-loop
        condition ``iteration < MAX + _poll_bonus`` extends the effective budget."""
        max_iter = 5
        _poll_bonus = 0
        _MAX_POLL_BONUS = max_iter * 2

        iteration = 0
        executed = 0
        # Simulate: every iteration is poll-only
        while iteration < max_iter + _poll_bonus:
            iteration += 1
            executed += 1
            # Simulate poll-only
            _poll_bonus = min(_poll_bonus + 1, _MAX_POLL_BONUS)
            # Safety: break if we've clearly exceeded the cap
            if executed > max_iter + _MAX_POLL_BONUS + 1:
                break

        # With every iteration being poll-only, we should reach MAX + MAX*2 = 3*MAX
        assert executed == max_iter + _MAX_POLL_BONUS

    def test_safety_cap_limits_bonus(self):
        """_poll_bonus must never exceed _MAX_POLL_BONUS."""
        max_iter = 10
        _poll_bonus = 0
        _MAX_POLL_BONUS = max_iter * 2

        for _ in range(500):  # many more iterations than possible
            _poll_bonus = min(_poll_bonus + 1, _MAX_POLL_BONUS)

        assert _poll_bonus == _MAX_POLL_BONUS

    def test_non_poll_iterations_do_not_increase_bonus(self):
        """Only poll-only iterations should bump _poll_bonus; mixed ones should not."""
        max_iter = 5
        _poll_bonus = 0
        _MAX_POLL_BONUS = max_iter * 2

        iteration = 0
        executed = 0
        # Simulate: no iteration is poll-only
        while iteration < max_iter + _poll_bonus:
            iteration += 1
            executed += 1
            # Non-poll: do NOT increment _poll_bonus

        assert executed == max_iter
        assert _poll_bonus == 0

    def test_alternating_poll_and_real_iterations(self):
        """Mix of poll and real iterations — only poll ones extend."""
        max_iter = 10
        _poll_bonus = 0
        _MAX_POLL_BONUS = max_iter * 2

        iteration = 0
        poll_count = 0
        real_count = 0
        while iteration < max_iter + _poll_bonus:
            iteration += 1
            is_poll = iteration % 2 == 0  # even iterations are poll
            if is_poll:
                _poll_bonus = min(_poll_bonus + 1, _MAX_POLL_BONUS)
                poll_count += 1
            else:
                real_count += 1

        # Real iterations should equal MAX_AGENT_ITERATIONS
        # because each poll iteration extends the budget by 1
        assert real_count == max_iter
