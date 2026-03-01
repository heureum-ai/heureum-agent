# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Model-fallback shared types."""

from dataclasses import dataclass, field
from enum import Enum
from typing import Generic, List, Optional, TypeVar

T = TypeVar("T")


class ErrorAction(str, Enum):
    FAILOVER = "failover"
    RETHROW = "rethrow"
    RETRY = "retry"


@dataclass
class ModelCandidate:
    """A provider/model pair for fallback."""

    provider: str
    model: str
    spec: str

    def __eq__(self, other):
        if not isinstance(other, ModelCandidate):
            return NotImplemented
        return self.spec == other.spec

    def __hash__(self):
        return hash(self.spec)


@dataclass
class FallbackAttempt:
    """Record of a single fallback attempt."""

    candidate: ModelCandidate
    error: Optional[Exception] = None
    succeeded: bool = False


@dataclass
class FallbackResult(Generic[T]):
    """Result from run_with_model_fallback."""

    value: Optional[T] = None
    candidate: Optional[ModelCandidate] = None
    attempts: List[FallbackAttempt] = field(default_factory=list)
    succeeded: bool = False


@dataclass
class ProfileUsageStats:
    """Per-provider cooldown tracking."""

    error_count: int = 0
    last_failure_time: float = 0.0
    cooldown_until: float = 0.0
    last_probe_time: float = 0.0


class AllModelsFailedError(Exception):
    """All model candidates failed."""

    def __init__(self, attempts: List[FallbackAttempt]) -> None:
        self.attempts = attempts
        models = [attempt.candidate.spec for attempt in attempts]
        super().__init__(f"All models failed: {models}")
