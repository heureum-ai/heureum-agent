# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for LoopIntelligenceController and LoopIntelligenceMiddleware."""

from unittest.mock import patch

import pytest

from app.services.agent_loop.intelligence import (
    LoopIntelligenceController,
    _describe_pattern,
)
from app.services.middleware.runner import MiddlewareRunner
from app.services.middleware.types import (
    BeforeResult,
    CompactionEvent,
    Domain,
    MessageInjectEvent,
    Middleware,
    MiddlewareContext,
    MiddlewareEvent,
    PromptBuildEvent,
    SkillExecuteEvent,
    ToolCallEvent,
)
from app.services.tools.loop_detection import LoopDetectionResult, LoopSeverity


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_tool_event(
    session_id: str = "s1",
    tool_name: str = "tool_a",
    result: str | None = "ok",
    error: str | None = None,
) -> ToolCallEvent:
    return ToolCallEvent(
        context=MiddlewareContext(session_id=session_id),
        tool_name=tool_name,
        result=result,
        error=error,
    )


def _make_prompt_event(
    session_id: str = "s1",
    state_prompts: list[str] | None = None,
    display_names: dict | None = None,
) -> PromptBuildEvent:
    extras = {}
    if display_names is not None:
        extras["display_names"] = display_names
    return PromptBuildEvent(
        context=MiddlewareContext(session_id=session_id, extras=extras),
        state_prompts=state_prompts,
    )


def _make_message_event(
    session_id: str = "s1",
    key: str = "loop.plan_retry",
    content: str = "Please retry.",
) -> MessageInjectEvent:
    return MessageInjectEvent(
        context=MiddlewareContext(session_id=session_id),
        key=key,
        content=content,
    )


def _ok_detection() -> LoopDetectionResult:
    return LoopDetectionResult(severity=LoopSeverity.OK)


def _warning_detection(pattern: str = "no_progress") -> LoopDetectionResult:
    return LoopDetectionResult(
        severity=LoopSeverity.WARNING,
        streak=10,
        pattern=pattern,
        message="warning msg",
    )


def _critical_detection(pattern: str = "ping_pong") -> LoopDetectionResult:
    return LoopDetectionResult(
        severity=LoopSeverity.CRITICAL,
        streak=20,
        pattern=pattern,
        message="critical msg",
    )


# ---------------------------------------------------------------------------
# TOOL after — failure tracking
# ---------------------------------------------------------------------------


class TestToolAfterFailureTracking:
    @pytest.mark.asyncio
    @patch(
        "app.services.agent_loop.intelligence.detect_tool_call_loop",
        return_value=_ok_detection(),
    )
    async def test_failure_increments_count(self, _mock_detect):
        ctrl = LoopIntelligenceController()
        mw = ctrl.create_middleware()

        event = _make_tool_event(error="some error")
        await mw.after(event)

        session = ctrl.get_session("s1")
        assert session.tool_failure_counts["tool_a"] == 1
        assert session.total_tool_failures == 1

    @pytest.mark.asyncio
    @patch(
        "app.services.agent_loop.intelligence.detect_tool_call_loop",
        return_value=_ok_detection(),
    )
    async def test_success_resets_failure_count(self, _mock_detect):
        ctrl = LoopIntelligenceController()
        mw = ctrl.create_middleware()

        # Fail twice
        await mw.after(_make_tool_event(error="err"))
        await mw.after(_make_tool_event(error="err"))
        assert ctrl.get_session("s1").tool_failure_counts["tool_a"] == 2

        # Succeed resets
        await mw.after(_make_tool_event(result="ok"))
        assert "tool_a" not in ctrl.get_session("s1").tool_failure_counts

    @pytest.mark.asyncio
    @patch(
        "app.services.agent_loop.intelligence.detect_tool_call_loop",
        return_value=_ok_detection(),
    )
    async def test_is_tool_error_string_detected(self, _mock_detect):
        """Tool result containing error markers should be tracked as failure."""
        ctrl = LoopIntelligenceController()
        mw = ctrl.create_middleware()

        event = _make_tool_event(result="Error executing tool 'bash': permission denied")
        await mw.after(event)

        assert ctrl.get_session("s1").tool_failure_counts["tool_a"] == 1

    @pytest.mark.asyncio
    async def test_loop_detection_state_updated(self):
        """After a tool call, loop detection result is stored in session."""
        ctrl = LoopIntelligenceController()
        mw = ctrl.create_middleware()

        detection = _warning_detection("ping_pong")
        with patch(
            "app.services.agent_loop.intelligence.detect_tool_call_loop",
            return_value=detection,
        ):
            await mw.after(_make_tool_event(result="ok"))

        session = ctrl.get_session("s1")
        assert session.last_loop_severity == LoopSeverity.WARNING
        assert session.last_loop_pattern == "ping_pong"
        assert session.last_loop_message == "warning msg"


# ---------------------------------------------------------------------------
# PROMPT before — warning injection
# ---------------------------------------------------------------------------


class TestPromptBeforeWarningInjection:
    @pytest.mark.asyncio
    async def test_no_injection_when_ok(self):
        ctrl = LoopIntelligenceController()
        mw = ctrl.create_middleware()

        event = _make_prompt_event(state_prompts=["existing"])
        result = await mw.before(event)

        # No modification when everything is OK
        assert result.modified_args is None

    @pytest.mark.asyncio
    async def test_loop_warning_injected_on_warning(self):
        ctrl = LoopIntelligenceController()
        mw = ctrl.create_middleware()

        session = ctrl.get_session("s1")
        session.last_loop_severity = LoopSeverity.WARNING
        session.last_loop_pattern = "no_progress"

        event = _make_prompt_event(state_prompts=["existing"])
        result = await mw.before(event)

        assert result.modified_args is not None
        prompts = result.modified_args["state_prompts"]
        assert len(prompts) == 2  # existing + loop_warning
        assert 'severity="moderate"' in prompts[1]
        assert "repeating actions that produce identical results" in prompts[1]

    @pytest.mark.asyncio
    async def test_loop_warning_severity_high_on_critical(self):
        ctrl = LoopIntelligenceController()
        mw = ctrl.create_middleware()

        session = ctrl.get_session("s1")
        session.last_loop_severity = LoopSeverity.CRITICAL
        session.last_loop_pattern = "ping_pong"

        event = _make_prompt_event(state_prompts=[])
        result = await mw.before(event)

        prompts = result.modified_args["state_prompts"]
        assert 'severity="high"' in prompts[0]
        assert "alternating between the same two tools" in prompts[0]

    @pytest.mark.asyncio
    async def test_pattern_abstraction(self):
        """Internal pattern names should be converted to user-friendly descriptions."""
        assert (
            _describe_pattern("ping_pong")
            == "alternating between the same two tools with no progress"
        )
        assert (
            _describe_pattern("no_progress") == "repeating actions that produce identical results"
        )
        assert _describe_pattern("poll_loop") == "polling tool stuck producing identical results"
        assert _describe_pattern("circuit_breaker") == "maximum repetition limit reached"
        assert _describe_pattern("unknown_pattern") == "repetitive tool call pattern detected"

    @pytest.mark.asyncio
    async def test_tool_failure_summary_uses_display_name(self):
        ctrl = LoopIntelligenceController()
        mw = ctrl.create_middleware()

        session = ctrl.get_session("s1")
        session.tool_failure_counts = {"mcp_web__search": 3}
        session.display_names = {"mcp_web__search": "Web Search"}

        event = _make_prompt_event(state_prompts=[])
        result = await mw.before(event)

        prompts = result.modified_args["state_prompts"]
        summary = prompts[0]
        assert "<tool_failure_summary>" in summary
        assert "Web Search: 3 consecutive failure(s)" in summary
        assert "mcp_web__search" not in summary

    @pytest.mark.asyncio
    async def test_tool_failure_summary_fallback_to_internal_name(self):
        """When no display name is available, use internal name."""
        ctrl = LoopIntelligenceController()
        mw = ctrl.create_middleware()

        session = ctrl.get_session("s1")
        session.tool_failure_counts = {"some_tool": 2}

        event = _make_prompt_event(state_prompts=[])
        result = await mw.before(event)

        prompts = result.modified_args["state_prompts"]
        assert "some_tool: 2 consecutive failure(s)" in prompts[0]

    @pytest.mark.asyncio
    async def test_both_warnings_injected(self):
        """Loop warning + tool failure summary both injected."""
        ctrl = LoopIntelligenceController()
        mw = ctrl.create_middleware()

        session = ctrl.get_session("s1")
        session.last_loop_severity = LoopSeverity.WARNING
        session.last_loop_pattern = "no_progress"
        session.tool_failure_counts = {"tool_a": 1}

        event = _make_prompt_event(state_prompts=["existing"])
        result = await mw.before(event)

        prompts = result.modified_args["state_prompts"]
        assert len(prompts) == 3  # existing + loop_warning + failure_summary


# ---------------------------------------------------------------------------
# MESSAGE before — adaptive retry escalation
# ---------------------------------------------------------------------------


class TestMessageBeforeRetryEscalation:
    @pytest.mark.asyncio
    async def test_retry_count_below_2_no_modification(self):
        ctrl = LoopIntelligenceController()
        mw = ctrl.create_middleware()

        event = _make_message_event(content="Please retry.")
        result = await mw.before(event)

        # retry_count is now 1 (incremented), but < 2, so no modification
        assert result.modified_args is None

    @pytest.mark.asyncio
    async def test_retry_count_2_adds_failing_tools(self):
        ctrl = LoopIntelligenceController()
        mw = ctrl.create_middleware()

        session = ctrl.get_session("s1")
        session.retry_count = 1  # will become 2 after increment
        session.tool_failure_counts = {"mcp_web__search": 3}
        session.display_names = {"mcp_web__search": "Web Search"}

        event = _make_message_event(content="Original message.")
        result = await mw.before(event)

        assert result.modified_args is not None
        content = result.modified_args["content"]
        assert "Original message." in content
        assert "Web Search (3x)" in content
        assert "mcp_web__search" not in content

    @pytest.mark.asyncio
    async def test_retry_count_3_final_attempt_escalation(self):
        ctrl = LoopIntelligenceController()
        mw = ctrl.create_middleware()

        session = ctrl.get_session("s1")
        session.retry_count = 2  # will become 3 after increment
        session.tool_failure_counts = {"tool_a": 2}
        session.display_names = {"tool_a": "Tool Alpha"}

        event = _make_message_event(content="Original.")
        result = await mw.before(event)

        content = result.modified_args["content"]
        assert "FINAL ATTEMPT" in content
        assert "retry #3" in content
        assert "completely different strategy" in content
        assert "Avoid these tools: Tool Alpha" in content
        assert "tool_a" not in content

    @pytest.mark.asyncio
    async def test_non_retry_message_key_ignored(self):
        """MessageInjectEvent with unrelated key should not be modified."""
        ctrl = LoopIntelligenceController()
        mw = ctrl.create_middleware()

        event = _make_message_event(key="tool.error_exec", content="Error")
        result = await mw.before(event)

        assert result.modified_args is None

    @pytest.mark.asyncio
    async def test_plan_retry_key_also_handled(self):
        """loop.plan_retry should also trigger escalation."""
        ctrl = LoopIntelligenceController()
        mw = ctrl.create_middleware()

        session = ctrl.get_session("s1")
        session.retry_count = 2  # will become 3

        event = _make_message_event(key="loop.plan_retry", content="Plan retry.")
        result = await mw.before(event)

        content = result.modified_args["content"]
        assert "FINAL ATTEMPT" in content


# ---------------------------------------------------------------------------
# Session lifecycle
# ---------------------------------------------------------------------------


class TestSessionLifecycle:
    def test_clear_session(self):
        ctrl = LoopIntelligenceController()
        session = ctrl.get_session("s1")
        session.tool_failure_counts = {"a": 1}
        session.retry_count = 5

        ctrl.clear_session("s1")
        new_session = ctrl.get_session("s1")

        assert new_session.tool_failure_counts == {}
        assert new_session.retry_count == 0

    def test_clear_nonexistent_session_no_error(self):
        ctrl = LoopIntelligenceController()
        ctrl.clear_session("nonexistent")  # should not raise

    @pytest.mark.asyncio
    async def test_display_names_updated_from_extras(self):
        ctrl = LoopIntelligenceController()
        mw = ctrl.create_middleware()

        # Ensure there's something to inject so before returns modified_args
        session = ctrl.get_session("s1")
        session.tool_failure_counts = {"tool_x": 1}

        event = _make_prompt_event(
            state_prompts=[],
            display_names={"tool_x": "Tool X Display"},
        )
        await mw.before(event)

        session = ctrl.get_session("s1")
        assert session.display_names["tool_x"] == "Tool X Display"

    @pytest.mark.asyncio
    async def test_display_names_persist_across_calls(self):
        """Display names set in one prompt event persist for message events."""
        ctrl = LoopIntelligenceController()
        mw = ctrl.create_middleware()

        session = ctrl.get_session("s1")
        session.tool_failure_counts = {"tool_x": 1}

        # First call: set display names via prompt event
        event = _make_prompt_event(
            state_prompts=[],
            display_names={"tool_x": "Fancy Tool"},
        )
        await mw.before(event)

        # Second call: message event uses stored display name
        session.retry_count = 1  # will become 2
        msg_event = _make_message_event(content="Retry.")
        result = await mw.before(msg_event)

        assert "Fancy Tool (1x)" in result.modified_args["content"]


def _circuit_breaker_detection() -> LoopDetectionResult:
    return LoopDetectionResult(
        severity=LoopSeverity.CIRCUIT_BREAKER,
        streak=30,
        pattern="circuit_breaker",
        message="circuit breaker msg",
    )


# ---------------------------------------------------------------------------
# Phase 2: Edge case tests
# ---------------------------------------------------------------------------


class TestEdgeCases:
    @pytest.mark.asyncio
    async def test_loop_warning_on_circuit_breaker(self):
        """CIRCUIT_BREAKER severity should inject loop_warning with severity=high."""
        ctrl = LoopIntelligenceController()
        mw = ctrl.create_middleware()

        session = ctrl.get_session("s1")
        session.last_loop_severity = LoopSeverity.CIRCUIT_BREAKER
        session.last_loop_pattern = "circuit_breaker"

        event = _make_prompt_event(state_prompts=[])
        result = await mw.before(event)

        assert result.modified_args is not None
        prompts = result.modified_args["state_prompts"]
        assert len(prompts) >= 1
        assert 'severity="high"' in prompts[0]
        assert "maximum repetition limit reached" in prompts[0]

    @pytest.mark.asyncio
    async def test_prompt_state_prompts_none(self):
        """state_prompts=None should be handled gracefully."""
        ctrl = LoopIntelligenceController()
        mw = ctrl.create_middleware()

        session = ctrl.get_session("s1")
        session.last_loop_severity = LoopSeverity.WARNING
        session.last_loop_pattern = "no_progress"

        event = _make_prompt_event(state_prompts=None)
        result = await mw.before(event)

        assert result.modified_args is not None
        prompts = result.modified_args["state_prompts"]
        assert isinstance(prompts, list)
        assert len(prompts) == 1
        assert "<loop_warning" in prompts[0]

    @pytest.mark.asyncio
    async def test_multiple_tools_failing(self):
        """Multiple failing tools should all appear in the summary with display names."""
        ctrl = LoopIntelligenceController()
        mw = ctrl.create_middleware()

        session = ctrl.get_session("s1")
        session.tool_failure_counts = {"tool_a": 3, "tool_b": 2, "tool_c": 1}
        session.display_names = {"tool_a": "Search", "tool_b": "Read", "tool_c": "Write"}

        event = _make_prompt_event(state_prompts=[])
        result = await mw.before(event)

        prompts = result.modified_args["state_prompts"]
        summary = prompts[0]
        assert "Search: 3 consecutive failure(s)" in summary
        assert "Read: 2 consecutive failure(s)" in summary
        assert "Write: 1 consecutive failure(s)" in summary

    @pytest.mark.asyncio
    async def test_display_names_empty_dict_no_update(self):
        """Empty display_names dict should not overwrite existing values."""
        ctrl = LoopIntelligenceController()
        mw = ctrl.create_middleware()

        session = ctrl.get_session("s1")
        session.display_names = {"tool_x": "Existing Name"}
        session.tool_failure_counts = {"tool_x": 1}

        event = _make_prompt_event(state_prompts=[], display_names={})
        await mw.before(event)

        assert session.display_names["tool_x"] == "Existing Name"

    @pytest.mark.asyncio
    async def test_retry_count_accumulates_across_events(self):
        """retry_count should accumulate and trigger FINAL ATTEMPT at 3."""
        ctrl = LoopIntelligenceController()
        mw = ctrl.create_middleware()

        # 3 consecutive MESSAGE events
        for _ in range(2):
            await mw.before(_make_message_event(content="Retry."))

        session = ctrl.get_session("s1")
        assert session.retry_count == 2

        result = await mw.before(_make_message_event(content="Retry."))
        assert session.retry_count == 3
        assert "FINAL ATTEMPT" in result.modified_args["content"]

    def test_retry_count_resets_on_clear(self):
        """clear_session should reset retry_count to 0."""
        ctrl = LoopIntelligenceController()
        session = ctrl.get_session("s1")
        session.retry_count = 5

        ctrl.clear_session("s1")
        new_session = ctrl.get_session("s1")
        assert new_session.retry_count == 0

    @pytest.mark.asyncio
    @patch(
        "app.services.agent_loop.intelligence.detect_tool_call_loop",
        return_value=_ok_detection(),
    )
    async def test_tool_error_field_and_result_both_error(self, _mock_detect):
        """error field + is_tool_error result should only increment failure count once."""
        ctrl = LoopIntelligenceController()
        mw = ctrl.create_middleware()

        event = _make_tool_event(
            error="timeout",
            result="Error executing tool 'bash': permission denied",
        )
        await mw.after(event)

        session = ctrl.get_session("s1")
        assert session.tool_failure_counts["tool_a"] == 1
        assert session.total_tool_failures == 1


# ---------------------------------------------------------------------------
# Phase 3: Integration tests
# ---------------------------------------------------------------------------


class TestIntegration:
    @pytest.mark.asyncio
    async def test_full_cycle_tool_after_then_prompt_before(self):
        """TOOL after (error) → loop detection = WARNING → PROMPT before injects warnings."""
        ctrl = LoopIntelligenceController()
        mw = ctrl.create_middleware()

        # Step 1: TOOL after with error + detect returns WARNING
        with patch(
            "app.services.agent_loop.intelligence.detect_tool_call_loop",
            return_value=_warning_detection("no_progress"),
        ):
            await mw.after(_make_tool_event(tool_name="bash", error="command failed"))

        # Step 2: PROMPT before should inject both warnings
        event = _make_prompt_event(
            state_prompts=["base_prompt"],
            display_names={"bash": "Bash Shell"},
        )
        result = await mw.before(event)

        prompts = result.modified_args["state_prompts"]
        # Should have: base_prompt + loop_warning + tool_failure_summary
        assert len(prompts) == 3
        assert "<loop_warning" in prompts[1]
        assert "<tool_failure_summary>" in prompts[2]
        assert "Bash Shell" in prompts[2]

    @pytest.mark.asyncio
    async def test_middleware_runner_integration(self):
        """LoopIntelligenceMiddleware should work alongside other middleware in MiddlewareRunner."""

        class OtherMiddleware(Middleware):
            """Adds a custom state prompt."""

            async def before(self, event: MiddlewareEvent) -> BeforeResult:
                if isinstance(event, PromptBuildEvent):
                    existing = list(event.state_prompts or [])
                    existing.append("other_mw_prompt")
                    return BeforeResult(modified_args={"state_prompts": existing})
                return BeforeResult()

        ctrl = LoopIntelligenceController()
        intelligence_mw = ctrl.create_middleware()

        session = ctrl.get_session("s1")
        session.last_loop_severity = LoopSeverity.WARNING
        session.last_loop_pattern = "no_progress"

        runner = MiddlewareRunner()
        runner.register(OtherMiddleware(), domains=[Domain.PROMPT])
        runner.register(intelligence_mw, domains=[Domain.PROMPT, Domain.TOOL, Domain.MESSAGE])

        event = _make_prompt_event(state_prompts=["original"])
        result = await runner.run_before(event)

        # MiddlewareRunner accumulates via update() — last writer wins for state_prompts.
        # intelligence_mw reads event.state_prompts (original), not OtherMiddleware's output.
        # So final state_prompts = intelligence_mw's output (original + loop_warning).
        # This is the expected "last writer wins" behavior.
        assert result.modified_args is not None
        prompts = result.modified_args["state_prompts"]
        assert "original" in prompts
        assert any("<loop_warning" in p for p in prompts)

    @pytest.mark.asyncio
    async def test_non_matching_domain_ignored(self):
        """Events from non-matching domains should produce no modifications."""
        ctrl = LoopIntelligenceController()
        mw = ctrl.create_middleware()

        # SkillExecuteEvent → before should return empty BeforeResult
        skill_event = SkillExecuteEvent(
            context=MiddlewareContext(session_id="s1"),
            tool_name="some_skill",
        )
        result = await mw.before(skill_event)
        assert result.modified_args is None

        # CompactionEvent → after should be no-op (no error)
        compaction_event = CompactionEvent(
            context=MiddlewareContext(session_id="s1"),
            message_count=10,
        )
        await mw.after(compaction_event)  # should not raise
