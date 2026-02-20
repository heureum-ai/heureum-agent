# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Model fallback — multi-provider LLM failover with cooldown management.

Provides:
  - Error classification for failover decisions
  - Per-provider cooldown tracking
  - Candidate resolution and fallback orchestration
  - Multi-provider LLM instance cache
"""

import logging
import os
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any, Callable, Coroutine, Dict, Generic, List, Optional, TypeVar

from app.config import settings
from app.services.error import LLMErrorClassifier

logger = logging.getLogger(__name__)

T = TypeVar("T")


# ---------------------------------------------------------------------------
# Error classification
# ---------------------------------------------------------------------------


class ErrorAction(str, Enum):
    FAILOVER = "failover"
    RETHROW = "rethrow"
    RETRY = "retry"


_FAILOVER_STATUS_CODES = {429, 402, 401, 403, 408}
_FAILOVER_STATUS_RANGES = range(500, 530)

_FAILOVER_KEYWORDS = (
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
    # Don't failover on context overflow or thought signature — those have
    # dedicated handling in the existing recovery pipeline.
    if LLMErrorClassifier.is_context_overflow(error):
        return False
    if LLMErrorClassifier.is_thought_signature(error):
        return False

    msg = str(error).lower()
    return any(kw in msg for kw in _FAILOVER_KEYWORDS)


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


# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------


@dataclass
class ModelCandidate:
    """A provider/model pair for fallback."""

    provider: str  # "google", "openai", "anthropic"
    model: str  # full model name
    spec: str  # original "provider/model" string

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


# ---------------------------------------------------------------------------
# Cooldown
# ---------------------------------------------------------------------------


@dataclass
class ProfileUsageStats:
    """Per-provider cooldown tracking."""

    error_count: int = 0
    last_failure_time: float = 0.0
    cooldown_until: float = 0.0
    last_probe_time: float = 0.0


def calculate_cooldown_ms(
    error_count: int,
    base_seconds: int = 60,
    max_seconds: int = 3600,
) -> float:
    """Calculate cooldown in milliseconds: base × 5^(n-1), capped."""
    if error_count <= 0:
        return 0.0
    seconds = min(base_seconds * (5 ** (error_count - 1)), max_seconds)
    return seconds * 1000.0


def calculate_billing_cooldown_ms(
    error_count: int,
    base_seconds: int = 18000,  # 5 hours
    max_seconds: int = 86400,  # 24 hours
) -> float:
    """Calculate billing error cooldown: 5h × 2^(n-1), capped at 24h."""
    if error_count <= 0:
        return 0.0
    seconds = min(base_seconds * (2 ** (error_count - 1)), max_seconds)
    return seconds * 1000.0


# ---------------------------------------------------------------------------
# AuthProfileManager
# ---------------------------------------------------------------------------


class AuthProfileManager:
    """Per-provider cooldown state manager (module-level singleton)."""

    def __init__(self) -> None:
        self._profiles: Dict[str, ProfileUsageStats] = {}

    def _get_profile(self, provider: str) -> ProfileUsageStats:
        if provider not in self._profiles:
            self._profiles[provider] = ProfileUsageStats()
        return self._profiles[provider]

    def is_in_cooldown(self, provider: str) -> bool:
        """Check if a provider is currently in cooldown."""
        profile = self._get_profile(provider)
        return time.time() < profile.cooldown_until

    def mark_success(self, provider: str) -> None:
        """Reset error count and cooldown on success."""
        profile = self._get_profile(provider)
        profile.error_count = 0
        profile.cooldown_until = 0.0

    def mark_failure(
        self,
        provider: str,
        error: Exception,
        base_seconds: int = 60,
        max_seconds: int = 3600,
    ) -> None:
        """Increment error count and set cooldown."""
        profile = self._get_profile(provider)
        profile.error_count += 1
        profile.last_failure_time = time.time()

        # Check for billing errors (402, payment required, quota exceeded)
        msg = str(error).lower()
        is_billing = "402" in msg or "payment required" in msg or "quota exceeded" in msg

        if is_billing:
            cooldown_ms = calculate_billing_cooldown_ms(profile.error_count)
        else:
            cooldown_ms = calculate_cooldown_ms(
                profile.error_count,
                base_seconds=base_seconds,
                max_seconds=max_seconds,
            )

        profile.cooldown_until = time.time() + cooldown_ms / 1000.0
        logger.info(
            "Provider %s cooldown set for %.1fs (error_count=%d, billing=%s)",
            provider,
            cooldown_ms / 1000.0,
            profile.error_count,
            is_billing,
        )

    def should_probe_primary(self, provider: str, probe_interval: float = 30.0) -> bool:
        """Check if we should probe a cooled-down primary provider.

        Throttled to once per probe_interval seconds. Also probes when
        cooldown is about to expire (within 2 minutes).
        """
        profile = self._get_profile(provider)
        if not self.is_in_cooldown(provider):
            return False

        now = time.time()

        # Probe when cooldown is about to expire (within 2 minutes)
        if profile.cooldown_until - now < 120:
            if now - profile.last_probe_time >= probe_interval:
                profile.last_probe_time = now
                return True

        # Throttled probe
        if now - profile.last_probe_time >= probe_interval:
            profile.last_probe_time = now
            return True

        return False


# Module-level singleton
_profile_manager = AuthProfileManager()


def get_profile_manager() -> AuthProfileManager:
    return _profile_manager


# ---------------------------------------------------------------------------
# Candidate resolution
# ---------------------------------------------------------------------------


_PROVIDER_ALIASES = {
    "google": "google",
    "gemini": "google",
    "openai": "openai",
    "gpt": "openai",
    "anthropic": "anthropic",
    "claude": "anthropic",
}


def resolve_candidates(
    primary_spec: str,
    fallback_chain: List[str],
) -> List[ModelCandidate]:
    """Parse 'provider/model' specs into deduplicated ModelCandidate list.

    Primary is always first. Invalid specs are skipped with a warning.
    """
    candidates: List[ModelCandidate] = []
    seen: set = set()

    for spec in [primary_spec] + fallback_chain:
        if not spec or not spec.strip():
            continue
        spec = spec.strip()

        parts = spec.split("/", 1)
        if len(parts) != 2:
            logger.warning("Invalid model spec (expected 'provider/model'): %s", spec)
            continue

        provider_key, model = parts[0].lower(), parts[1]
        provider = _PROVIDER_ALIASES.get(provider_key)
        if not provider:
            logger.warning("Unknown provider '%s' in spec: %s", provider_key, spec)
            continue

        if spec in seen:
            continue
        seen.add(spec)

        candidates.append(ModelCandidate(provider=provider, model=model, spec=spec))

    return candidates


# ---------------------------------------------------------------------------
# Multi-provider LLM cache
# ---------------------------------------------------------------------------


class MultiProviderLLM:
    """Caches LangChain LLM instances per provider/model spec."""

    def __init__(self) -> None:
        self._cache: Dict[str, Any] = {}

    def get_llm(self, candidate: ModelCandidate, **kwargs) -> Any:
        """Get or create an LLM instance for a candidate."""
        if candidate.spec in self._cache:
            return self._cache[candidate.spec]

        llm = self._create_llm(candidate, **kwargs)
        self._cache[candidate.spec] = llm
        return llm

    def _create_llm(self, candidate: ModelCandidate, **kwargs) -> Any:
        """Create a new LLM instance for a candidate."""
        if candidate.provider == "google":
            from langchain_google_genai import ChatGoogleGenerativeAI

            thinking_budget = settings.AGENT_THINKING_BUDGET or None
            if settings.GOOGLE_API_KEY:
                return ChatGoogleGenerativeAI(
                    model=candidate.model,
                    google_api_key=settings.GOOGLE_API_KEY,
                    temperature=settings.AGENT_TEMPERATURE,
                    max_output_tokens=settings.AGENT_MAX_TOKENS,
                    thinking_budget=thinking_budget,
                )
            if settings.GOOGLE_APPLICATION_CREDENTIALS:
                os.environ.setdefault(
                    "GOOGLE_APPLICATION_CREDENTIALS",
                    settings.GOOGLE_APPLICATION_CREDENTIALS,
                )
            return ChatGoogleGenerativeAI(
                model=candidate.model,
                vertexai=True,
                project=settings.GOOGLE_CLOUD_PROJECT,
                location=settings.GOOGLE_CLOUD_LOCATION,
                temperature=settings.AGENT_TEMPERATURE,
                max_output_tokens=settings.AGENT_MAX_TOKENS,
                thinking_budget=thinking_budget,
            )

        if candidate.provider == "openai":
            from langchain_openai import ChatOpenAI
            from pydantic import SecretStr

            return ChatOpenAI(
                api_key=SecretStr(settings.OPENAI_API_KEY),
                model=candidate.model,
                temperature=settings.AGENT_TEMPERATURE,
                max_completion_tokens=settings.AGENT_MAX_TOKENS,
            )

        if candidate.provider == "anthropic":
            try:
                from langchain_anthropic import ChatAnthropic
            except ImportError:
                logger.warning("langchain-anthropic not installed; cannot create Anthropic LLM")
                raise ImportError("langchain-anthropic is required for Anthropic provider")

            return ChatAnthropic(
                api_key=settings.ANTHROPIC_API_KEY,
                model=candidate.model,
                temperature=settings.AGENT_TEMPERATURE,
                max_tokens=settings.AGENT_MAX_TOKENS,
            )

        raise ValueError(f"Unsupported provider: {candidate.provider}")


# ---------------------------------------------------------------------------
# Main orchestrator
# ---------------------------------------------------------------------------


class AllModelsFailedError(Exception):
    """All model candidates failed."""

    def __init__(self, attempts: List[FallbackAttempt]) -> None:
        self.attempts = attempts
        models = [a.candidate.spec for a in attempts]
        super().__init__(f"All models failed: {models}")


async def run_with_model_fallback(
    candidates: List[ModelCandidate],
    call_fn: Callable[[Any], Coroutine[Any, Any, T]],
    multi_provider: MultiProviderLLM,
    profile_manager: Optional[AuthProfileManager] = None,
    **llm_kwargs,
) -> FallbackResult[T]:
    """Try candidates in order, failing over on eligible errors.

    Args:
        candidates: Ordered list of model candidates (primary first).
        call_fn: Async function that takes an LLM instance and returns result.
        multi_provider: LLM instance cache.
        profile_manager: Cooldown tracker (uses module singleton if None).
        **llm_kwargs: Extra kwargs passed to MultiProviderLLM.get_llm().

    Returns:
        FallbackResult with the successful value or all attempts on failure.
    """
    pm = profile_manager or _profile_manager
    attempts: List[FallbackAttempt] = []

    for i, candidate in enumerate(candidates):
        is_primary = i == 0

        # Skip cooled-down candidates (unless primary and probe is due)
        if pm.is_in_cooldown(candidate.provider):
            if is_primary and pm.should_probe_primary(candidate.provider):
                logger.info("Probing primary provider %s", candidate.provider)
            else:
                logger.debug("Skipping %s (in cooldown)", candidate.spec)
                attempts.append(
                    FallbackAttempt(candidate=candidate, error=Exception("in cooldown"))
                )
                continue

        try:
            llm = multi_provider.get_llm(candidate, **llm_kwargs)
            result = await call_fn(llm)
            pm.mark_success(candidate.provider)
            return FallbackResult(
                value=result,
                candidate=candidate,
                attempts=attempts,
                succeeded=True,
            )
        except Exception as e:
            action = classify_error(e)
            attempt = FallbackAttempt(candidate=candidate, error=e)
            attempts.append(attempt)

            if action == ErrorAction.RETHROW:
                # Don't failover — re-raise for existing recovery pipeline
                raise

            if action == ErrorAction.FAILOVER:
                pm.mark_failure(candidate.provider, e)
                logger.warning(
                    "Model %s failed (failover): %s. Trying next candidate.",
                    candidate.spec,
                    e,
                )
                continue

            # RETRY action — but we don't retry here, just failover
            pm.mark_failure(candidate.provider, e)
            logger.warning(
                "Model %s failed (retry-eligible, treating as failover): %s",
                candidate.spec,
                e,
            )
            continue

    raise AllModelsFailedError(attempts)
