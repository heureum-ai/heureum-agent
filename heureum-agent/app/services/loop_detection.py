# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Tool loop detection — identifies repetitive tool call patterns.

Detects four patterns:
  1. Generic no-progress streak (same result hash repeated)
  2. Ping-pong alternation (A↔B with no progress)
  3. Known poll tools (browser_wait, process_poll, etc.)
  4. Circuit breaker (absolute streak limit)

Pure logic module with no dependency on agent internals.
"""

import hashlib
import logging
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


@dataclass
class ToolLoopDetectionConfig:
    """Tunable thresholds for loop detection."""

    enabled: bool = True
    history_size: int = 30
    warning_threshold: int = 10
    critical_threshold: int = 20
    circuit_breaker_threshold: int = 30


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------


class LoopSeverity(str, Enum):
    OK = "ok"
    WARNING = "warning"
    CRITICAL = "critical"
    CIRCUIT_BREAKER = "circuit_breaker"


@dataclass
class ToolCallRecord:
    """A single recorded tool call."""

    tool_name: str
    call_hash: str
    result_hash: Optional[str] = None
    timestamp: float = field(default_factory=time.time)


@dataclass
class LoopDetectionResult:
    """Result from the loop detector."""

    severity: LoopSeverity
    streak: int = 0
    pattern: str = ""
    message: str = ""


@dataclass
class SessionLoopState:
    """Per-session mutable loop detection state."""

    records: List[ToolCallRecord] = field(default_factory=list)
    last_warning_bucket: int = -1


# ---------------------------------------------------------------------------
# Module-level state
# ---------------------------------------------------------------------------

_session_states: Dict[str, SessionLoopState] = {}
_default_config = ToolLoopDetectionConfig()

BUCKET_SIZE = 10

_KNOWN_POLL_TOOLS = frozenset(
    {
        "browser_wait",
        "browser_wait_for",
        "process_poll",
        "process_wait",
        "wait",
        "sleep",
    }
)


# ---------------------------------------------------------------------------
# Hash helpers
# ---------------------------------------------------------------------------


def stable_stringify(obj: Any) -> str:
    """Deterministic JSON string with sorted keys."""
    if isinstance(obj, dict):
        sorted_items = sorted((k, stable_stringify(v)) for k, v in obj.items())
        return "{" + ",".join(f"{k!r}:{v}" for k, v in sorted_items) + "}"
    if isinstance(obj, (list, tuple)):
        return "[" + ",".join(stable_stringify(x) for x in obj) + "]"
    return repr(obj)


def digest_stable(text: str) -> str:
    """SHA-256 hex digest of a UTF-8 string."""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def hash_tool_call(tool_name: str, args: Any) -> str:
    """Hash a tool call by name + deterministic args."""
    payload = stable_stringify({"name": tool_name, "args": args})
    return digest_stable(payload)


def hash_tool_outcome(result: Any) -> str:
    """Hash a tool result."""
    if isinstance(result, str):
        return digest_stable(result)
    return digest_stable(stable_stringify(result))


# ---------------------------------------------------------------------------
# Session state management
# ---------------------------------------------------------------------------


def get_session_loop_state(session_id: str) -> SessionLoopState:
    """Get or create loop state for a session."""
    if session_id not in _session_states:
        _session_states[session_id] = SessionLoopState()
    return _session_states[session_id]


def clear_session_loop_state(session_id: str) -> None:
    """Remove loop state for a session."""
    _session_states.pop(session_id, None)


# ---------------------------------------------------------------------------
# Recording
# ---------------------------------------------------------------------------


def record_tool_call(
    session_id: str,
    tool_name: str,
    args: Any,
    config: Optional[ToolLoopDetectionConfig] = None,
) -> ToolCallRecord:
    """Record a tool call and return the record (result_hash filled later)."""
    cfg = config or _default_config
    state = get_session_loop_state(session_id)

    record = ToolCallRecord(
        tool_name=tool_name,
        call_hash=hash_tool_call(tool_name, args),
    )
    state.records.append(record)

    # Sliding window trim
    if len(state.records) > cfg.history_size:
        state.records = state.records[-cfg.history_size :]

    return record


def record_tool_outcome(
    record: ToolCallRecord,
    result: Any,
) -> None:
    """Fill in the result_hash on an existing record."""
    record.result_hash = hash_tool_outcome(result)


# ---------------------------------------------------------------------------
# Detectors
# ---------------------------------------------------------------------------


def get_no_progress_streak(records: List[ToolCallRecord]) -> int:
    """Count consecutive records with the same result_hash from the tail."""
    if not records:
        return 0

    last = records[-1]
    if last.result_hash is None:
        return 0

    streak = 0
    for rec in reversed(records):
        if rec.result_hash == last.result_hash:
            streak += 1
        else:
            break
    return streak


def get_ping_pong_streak(records: List[ToolCallRecord]) -> int:
    """Detect A↔B alternating tool name pattern with no-progress evidence.

    Returns the length of the alternating streak, or 0 if not detected.
    """
    if len(records) < 4:
        return 0

    # Check last 4 records for A-B-A-B pattern
    names = [r.tool_name for r in records[-4:]]
    if not (names[0] == names[2] and names[1] == names[3] and names[0] != names[1]):
        return 0

    # Extend backwards to find full alternation length
    # The last 4 records are: ..., a, b, a, b
    # So records[-4].tool_name == a, records[-3].tool_name == b
    a, b = names[0], names[1]
    streak = 4
    idx = len(records) - 5

    while idx >= 0:
        # Position from the end: len-1-idx
        # Even positions from end (0,2,4,..) = b, odd (1,3,5,..) = a
        # But the last element is b, second-to-last is a, etc.
        pos_from_end = len(records) - 1 - idx
        expected = b if pos_from_end % 2 == 0 else a
        if records[idx].tool_name != expected:
            break
        streak += 1
        idx -= 1

    # Require no-progress evidence: at least half the records share result_hash
    result_hashes = [r.result_hash for r in records[-streak:] if r.result_hash]
    if not result_hashes:
        return streak

    most_common = max(set(result_hashes), key=result_hashes.count)
    if result_hashes.count(most_common) >= len(result_hashes) // 2:
        return streak

    return 0


def _is_known_poll_tool(tool_name: str) -> bool:
    """Check if a tool is a known polling/wait tool."""
    return tool_name in _KNOWN_POLL_TOOLS


# ---------------------------------------------------------------------------
# Main detector
# ---------------------------------------------------------------------------


def detect_tool_call_loop(
    session_id: str,
    config: Optional[ToolLoopDetectionConfig] = None,
) -> LoopDetectionResult:
    """Run all detectors and return the highest-priority result.

    Priority: circuit_breaker > critical poll > ping_pong > generic no-progress.
    """
    cfg = config or _default_config
    if not cfg.enabled:
        return LoopDetectionResult(severity=LoopSeverity.OK)

    state = get_session_loop_state(session_id)
    records = state.records

    if not records:
        return LoopDetectionResult(severity=LoopSeverity.OK)

    no_progress = get_no_progress_streak(records)
    ping_pong = get_ping_pong_streak(records)
    streak = max(no_progress, ping_pong)

    # Circuit breaker — absolute limit
    if streak >= cfg.circuit_breaker_threshold:
        return LoopDetectionResult(
            severity=LoopSeverity.CIRCUIT_BREAKER,
            streak=streak,
            pattern="circuit_breaker",
            message=f"Tool loop circuit breaker triggered after {streak} repetitions. Blocking further tool calls.",
        )

    # Critical poll detection
    last_tool = records[-1].tool_name
    if _is_known_poll_tool(last_tool) and no_progress >= cfg.critical_threshold:
        return LoopDetectionResult(
            severity=LoopSeverity.CRITICAL,
            streak=no_progress,
            pattern="poll_loop",
            message=f"Poll tool '{last_tool}' stuck in loop ({no_progress} identical results).",
        )

    # Ping-pong
    if ping_pong >= cfg.warning_threshold:
        sev = LoopSeverity.CRITICAL if ping_pong >= cfg.critical_threshold else LoopSeverity.WARNING
        return LoopDetectionResult(
            severity=sev,
            streak=ping_pong,
            pattern="ping_pong",
            message=f"Ping-pong pattern detected ({ping_pong} alternations).",
        )

    # Generic no-progress
    if no_progress >= cfg.warning_threshold:
        sev = (
            LoopSeverity.CRITICAL if no_progress >= cfg.critical_threshold else LoopSeverity.WARNING
        )
        return LoopDetectionResult(
            severity=sev,
            streak=no_progress,
            pattern="no_progress",
            message=f"No progress detected ({no_progress} identical results).",
        )

    return LoopDetectionResult(severity=LoopSeverity.OK)


# ---------------------------------------------------------------------------
# Warning dedup
# ---------------------------------------------------------------------------


def should_emit_warning(session_id: str, streak: int) -> bool:
    """Bucket-based warning dedup — emit once per BUCKET_SIZE streak increase."""
    if streak <= 0:
        return False

    bucket = streak // BUCKET_SIZE
    state = get_session_loop_state(session_id)

    if bucket <= state.last_warning_bucket:
        return False

    state.last_warning_bucket = bucket
    return True
