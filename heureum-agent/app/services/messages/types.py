# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Typed DTOs for message-domain pipelines."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Dict, List, Optional


class SubagentStatus(str, Enum):
    """Canonical persistence status for sub-agent runs."""

    COMPLETED = "completed"
    FAILED = "failed"
    TIMEOUT = "timeout"
    CANCELLED = "cancelled"
    RUNNING = "running"


class TodoStepStatus(str, Enum):
    """TODO step status used in response.todo.updated payloads."""

    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"


@dataclass(frozen=True)
class SubagentPersistEvent:
    """Persistence event emitted when a sub-agent run state is finalized."""

    root_session_id: str
    parent_session_id: str
    child_session_id: str
    task: str
    status: SubagentStatus
    result_summary: str = ""
    started_at: Optional[float] = None
    completed_at: Optional[float] = None
    metadata: Dict[str, Any] = field(default_factory=dict)


@dataclass(frozen=True)
class PersistResult:
    """Result of a persistence attempt."""

    ok: bool
    path: str = ""
    detail: str = ""
    status_code: Optional[int] = None


@dataclass(frozen=True)
class TodoStepState:
    """Serializable TODO step state."""

    description: str
    status: TodoStepStatus = TodoStepStatus.PENDING
    result: Optional[str] = None
    step_name: Optional[str] = None
    assigned_agent: Optional[str] = None
    batch_index: Optional[int] = None


@dataclass(frozen=True)
class TodoStateMessage:
    """Serializable TODO state used by task-level message helpers."""

    task: str
    steps: list[TodoStepState] = field(default_factory=list)


@dataclass(frozen=True)
class NormalizedLLMOutput:
    """LLM 응답에서 즉시 추출한 정규화 결과."""

    text: str
    reasoning: str  # thinking/reasoning content from LLM (empty string if none)
    usage: Any  # Usage (open_responses) — Any to avoid circular import
    tool_calls: List[Dict[str, Any]] | None  # response.tool_calls (None이면 텍스트 응답)
    raw_message: Any  # 원본 AIMessage (히스토리 저장용)


# Generic map-like payloads exchanged with Platform API.
PlatformMessageRecord = Dict[str, Any]
ToolHistoryItem = Dict[str, Any]
