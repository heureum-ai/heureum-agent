# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for tool loop detection."""

import pytest
from app.services.tools.loop_detection import (
    BUCKET_SIZE,
    LoopSeverity,
    ToolCallRecord,
    ToolLoopDetectionConfig,
    clear_session_loop_state,
    detect_tool_call_loop,
    get_no_progress_streak,
    get_ping_pong_streak,
    get_session_loop_state,
    hash_tool_call,
    record_tool_call,
    record_tool_outcome,
    should_emit_warning,
    stable_stringify,
)


@pytest.fixture(autouse=True)
def _clean_state():
    """Clear global loop state between tests."""
    yield
    # Clear all session states
    from app.services.tools.loop_detection import _session_states

    _session_states.clear()


# ---------------------------------------------------------------------------
# stable_stringify
# ---------------------------------------------------------------------------


class TestStableStringify:
    def test_key_order_deterministic(self):
        assert stable_stringify({"b": 1, "a": 2}) == stable_stringify({"a": 2, "b": 1})

    def test_nested_dict(self):
        obj = {"z": {"b": 1, "a": 2}, "a": 0}
        result = stable_stringify(obj)
        assert "'a'" in result
        assert "'z'" in result

    def test_list(self):
        assert stable_stringify([3, 1, 2]) == "[3,1,2]"

    def test_primitive(self):
        assert stable_stringify("hello") == "'hello'"
        assert stable_stringify(42) == "42"


# ---------------------------------------------------------------------------
# hash_tool_call
# ---------------------------------------------------------------------------


class TestHashToolCall:
    def test_same_args_different_order(self):
        h1 = hash_tool_call("read", {"path": "/a", "lines": 10})
        h2 = hash_tool_call("read", {"lines": 10, "path": "/a"})
        assert h1 == h2

    def test_different_tools(self):
        h1 = hash_tool_call("read", {"path": "/a"})
        h2 = hash_tool_call("write", {"path": "/a"})
        assert h1 != h2

    def test_different_args(self):
        h1 = hash_tool_call("read", {"path": "/a"})
        h2 = hash_tool_call("read", {"path": "/b"})
        assert h1 != h2


# ---------------------------------------------------------------------------
# get_no_progress_streak
# ---------------------------------------------------------------------------


class TestGetNoProgressStreak:
    def test_empty(self):
        assert get_no_progress_streak([]) == 0

    def test_single_no_result(self):
        records = [ToolCallRecord(tool_name="a", call_hash="h1")]
        assert get_no_progress_streak(records) == 0

    def test_single_with_result(self):
        records = [ToolCallRecord(tool_name="a", call_hash="h1", result_hash="r1")]
        assert get_no_progress_streak(records) == 1

    def test_streak_breaks_on_different_result(self):
        records = [
            ToolCallRecord(tool_name="a", call_hash="h1", result_hash="r1"),
            ToolCallRecord(tool_name="a", call_hash="h1", result_hash="r2"),
            ToolCallRecord(tool_name="a", call_hash="h1", result_hash="r2"),
            ToolCallRecord(tool_name="a", call_hash="h1", result_hash="r2"),
        ]
        assert get_no_progress_streak(records) == 3

    def test_all_same(self):
        records = [ToolCallRecord(tool_name="a", call_hash="h", result_hash="r") for _ in range(5)]
        assert get_no_progress_streak(records) == 5


# ---------------------------------------------------------------------------
# get_ping_pong_streak
# ---------------------------------------------------------------------------


class TestGetPingPongStreak:
    def test_no_alternation(self):
        records = [ToolCallRecord(tool_name="a", call_hash="h", result_hash="r") for _ in range(4)]
        assert get_ping_pong_streak(records) == 0

    def test_too_few_records(self):
        records = [
            ToolCallRecord(tool_name="a", call_hash="h", result_hash="r"),
            ToolCallRecord(tool_name="b", call_hash="h", result_hash="r"),
            ToolCallRecord(tool_name="a", call_hash="h", result_hash="r"),
        ]
        assert get_ping_pong_streak(records) == 0

    def test_alternation_detected(self):
        records = [
            ToolCallRecord(tool_name="a", call_hash="h1", result_hash="r"),
            ToolCallRecord(tool_name="b", call_hash="h2", result_hash="r"),
            ToolCallRecord(tool_name="a", call_hash="h1", result_hash="r"),
            ToolCallRecord(tool_name="b", call_hash="h2", result_hash="r"),
        ]
        assert get_ping_pong_streak(records) == 4

    def test_longer_alternation(self):
        records = []
        for i in range(8):
            name = "a" if i % 2 == 0 else "b"
            records.append(ToolCallRecord(tool_name=name, call_hash=f"h{name}", result_hash="r"))
        assert get_ping_pong_streak(records) == 8


# ---------------------------------------------------------------------------
# detect_tool_call_loop
# ---------------------------------------------------------------------------


class TestDetectToolCallLoop:
    def test_disabled(self):
        cfg = ToolLoopDetectionConfig(enabled=False)
        result = detect_tool_call_loop("s1", config=cfg)
        assert result.severity == LoopSeverity.OK

    def test_no_records(self):
        result = detect_tool_call_loop("empty-session")
        assert result.severity == LoopSeverity.OK

    def test_generic_warning(self):
        cfg = ToolLoopDetectionConfig(
            warning_threshold=3, critical_threshold=6, circuit_breaker_threshold=10
        )
        state = get_session_loop_state("s2")
        for _ in range(4):
            rec = ToolCallRecord(tool_name="read", call_hash="h", result_hash="same")
            state.records.append(rec)

        result = detect_tool_call_loop("s2", config=cfg)
        assert result.severity == LoopSeverity.WARNING
        assert result.pattern == "no_progress"

    def test_circuit_breaker(self):
        cfg = ToolLoopDetectionConfig(
            warning_threshold=3, critical_threshold=6, circuit_breaker_threshold=10
        )
        state = get_session_loop_state("s3")
        for _ in range(12):
            rec = ToolCallRecord(tool_name="read", call_hash="h", result_hash="same")
            state.records.append(rec)

        result = detect_tool_call_loop("s3", config=cfg)
        assert result.severity == LoopSeverity.CIRCUIT_BREAKER

    def test_critical_poll(self):
        cfg = ToolLoopDetectionConfig(
            warning_threshold=3, critical_threshold=5, circuit_breaker_threshold=30
        )
        state = get_session_loop_state("s4")
        for _ in range(6):
            rec = ToolCallRecord(tool_name="browser_wait", call_hash="h", result_hash="same")
            state.records.append(rec)

        result = detect_tool_call_loop(
            "s4", config=cfg, dynamic_poll_tools=frozenset({"browser_wait"})
        )
        assert result.severity == LoopSeverity.CRITICAL
        assert result.pattern == "poll_loop"


# ---------------------------------------------------------------------------
# should_emit_warning
# ---------------------------------------------------------------------------


class TestShouldEmitWarning:
    def test_first_bucket(self):
        assert should_emit_warning("w1", BUCKET_SIZE) is True

    def test_same_bucket_skip(self):
        should_emit_warning("w2", BUCKET_SIZE)
        assert should_emit_warning("w2", BUCKET_SIZE + 1) is False

    def test_next_bucket_emit(self):
        should_emit_warning("w3", BUCKET_SIZE)
        assert should_emit_warning("w3", BUCKET_SIZE * 2) is True

    def test_zero_streak(self):
        assert should_emit_warning("w4", 0) is False


# ---------------------------------------------------------------------------
# record_tool_call / record_tool_outcome
# ---------------------------------------------------------------------------


class TestRecording:
    def test_record_and_outcome(self):
        rec = record_tool_call("rec1", "read", {"path": "/a"})
        assert rec.result_hash is None
        record_tool_outcome(rec, "file content")
        assert rec.result_hash is not None

    def test_sliding_window(self):
        cfg = ToolLoopDetectionConfig(history_size=5)
        for i in range(10):
            record_tool_call("rec2", "read", {"i": i}, config=cfg)
        state = get_session_loop_state("rec2")
        assert len(state.records) == 5

    def test_clear_state(self):
        record_tool_call("rec3", "read", {})
        assert get_session_loop_state("rec3").records
        clear_session_loop_state("rec3")
        # After clear, new state is empty
        state = get_session_loop_state("rec3")
        assert not state.records
