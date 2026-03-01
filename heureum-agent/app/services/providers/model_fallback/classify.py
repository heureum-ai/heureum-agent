# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Model-fallback error classification."""

from app.services.error import LLMErrorClassifier
from app.services.providers.model_fallback.types import ErrorAction

FAILOVER_KEYWORDS = (
    "rate limit",
    "rate_limit",
    "429",
    "overloaded",
    "temporarily unavailable",
    "service unavailable",
    "resource exhausted",
    "resource_exhausted",
    "internal server error",
    "502",
    "503",
    "504",
    "500",
    "529",
    "402",
    "payment required",
    "quota exceeded",
    "quota_exceeded",
    "unauthorized",
    "forbidden",
    "408",
    "timeout",
)


def is_failover_error(error: Exception) -> bool:
    """Check if an error should trigger model failover."""
    if LLMErrorClassifier.is_context_overflow(error):
        return False
    if LLMErrorClassifier.is_thought_signature(error):
        return False

    message = str(error).lower()
    return any(keyword in message for keyword in FAILOVER_KEYWORDS)


def classify_error(error: Exception) -> ErrorAction:
    """Classify an error into an action."""
    if LLMErrorClassifier.is_context_overflow(error):
        return ErrorAction.RETHROW
    if LLMErrorClassifier.is_thought_signature(error):
        return ErrorAction.RETHROW
    if is_failover_error(error):
        return ErrorAction.FAILOVER
    if LLMErrorClassifier.is_retryable(error):
        return ErrorAction.RETRY
    return ErrorAction.RETHROW
