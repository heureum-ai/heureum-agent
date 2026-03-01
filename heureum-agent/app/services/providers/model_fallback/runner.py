# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Model-fallback orchestration runner and LLM cache."""

import logging
from typing import Any, Callable, Coroutine, Dict, List, Optional

from app.config import settings
from app.services.providers.controller import create_llm
from app.services.providers.model_fallback.classify import classify_error
from app.services.providers.model_fallback.cooldown import (
    AuthProfileManager,
    get_profile_manager,
)
from app.services.providers.model_fallback.types import (
    AllModelsFailedError,
    ErrorAction,
    FallbackAttempt,
    FallbackResult,
    ModelCandidate,
    T,
)

logger = logging.getLogger(__name__)


class MultiProviderLLM:
    """Caches LangChain LLM instances per provider/model spec."""

    def __init__(self) -> None:
        self._cache: Dict[str, Any] = {}

    def get_llm(self, candidate: ModelCandidate, **kwargs) -> Any:
        if candidate.spec in self._cache:
            return self._cache[candidate.spec]

        llm = create_llm(
            model=candidate.model,
            provider=candidate.provider,
            settings=settings,
        )
        self._cache[candidate.spec] = llm
        return llm


async def run_with_model_fallback(
    candidates: List[ModelCandidate],
    call_fn: Callable[[Any], Coroutine[Any, Any, T]],
    multi_provider: MultiProviderLLM,
    profile_manager: Optional[AuthProfileManager] = None,
    **llm_kwargs,
) -> FallbackResult[T]:
    """Try candidates in order, failing over on eligible errors."""
    manager = profile_manager or get_profile_manager()
    attempts: List[FallbackAttempt] = []

    for index, candidate in enumerate(candidates):
        is_primary = index == 0

        if manager.is_in_cooldown(candidate.provider):
            if is_primary and manager.should_probe_primary(candidate.provider):
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
            manager.mark_success(candidate.provider)
            return FallbackResult(
                value=result,
                candidate=candidate,
                attempts=attempts,
                succeeded=True,
            )
        except Exception as error:
            action = classify_error(error)
            attempts.append(FallbackAttempt(candidate=candidate, error=error))

            if action == ErrorAction.RETHROW:
                raise

            manager.mark_failure(candidate.provider, error)
            if action == ErrorAction.FAILOVER:
                logger.warning(
                    "Model %s failed (failover): %s. Trying next candidate.",
                    candidate.spec,
                    error,
                )
            else:
                logger.warning(
                    "Model %s failed (retry-eligible, treating as failover): %s",
                    candidate.spec,
                    error,
                )
            continue

    raise AllModelsFailedError(attempts)
