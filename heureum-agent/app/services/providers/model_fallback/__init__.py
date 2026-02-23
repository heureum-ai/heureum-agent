# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Model fallback package facade."""

from app.services.providers.model_fallback.candidates import resolve_candidates
from app.services.providers.model_fallback.classify import classify_error, is_failover_error
from app.services.providers.model_fallback.cooldown import (
    AuthProfileManager,
    calculate_billing_cooldown_ms,
    calculate_cooldown_ms,
    get_profile_manager,
)
from app.services.providers.model_fallback.runner import MultiProviderLLM, run_with_model_fallback
from app.services.providers.model_fallback.types import (
    AllModelsFailedError,
    ErrorAction,
    FallbackAttempt,
    FallbackResult,
    ModelCandidate,
    ProfileUsageStats,
)

__all__ = [
    "AllModelsFailedError",
    "AuthProfileManager",
    "ErrorAction",
    "FallbackAttempt",
    "FallbackResult",
    "ModelCandidate",
    "MultiProviderLLM",
    "ProfileUsageStats",
    "calculate_billing_cooldown_ms",
    "calculate_cooldown_ms",
    "classify_error",
    "get_profile_manager",
    "is_failover_error",
    "resolve_candidates",
    "run_with_model_fallback",
]
