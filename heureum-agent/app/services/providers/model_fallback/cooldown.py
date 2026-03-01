# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Model-fallback provider cooldown management."""

import logging
import time
from typing import Dict

from app.services.providers.model_fallback.types import ProfileUsageStats

logger = logging.getLogger(__name__)


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
    base_seconds: int = 18000,
    max_seconds: int = 86400,
) -> float:
    """Calculate billing error cooldown in milliseconds."""
    if error_count <= 0:
        return 0.0
    seconds = min(base_seconds * (2 ** (error_count - 1)), max_seconds)
    return seconds * 1000.0


class AuthProfileManager:
    """Per-provider cooldown state manager."""

    def __init__(self) -> None:
        self._profiles: Dict[str, ProfileUsageStats] = {}

    def _get_profile(self, provider: str) -> ProfileUsageStats:
        if provider not in self._profiles:
            self._profiles[provider] = ProfileUsageStats()
        return self._profiles[provider]

    def is_in_cooldown(self, provider: str) -> bool:
        profile = self._get_profile(provider)
        return time.time() < profile.cooldown_until

    def mark_success(self, provider: str) -> None:
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
        profile = self._get_profile(provider)
        profile.error_count += 1
        profile.last_failure_time = time.time()

        message = str(error).lower()
        is_billing = (
            "402" in message or "payment required" in message or "quota exceeded" in message
        )

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
        profile = self._get_profile(provider)
        if not self.is_in_cooldown(provider):
            return False

        now = time.time()
        if profile.cooldown_until - now < 120:
            if now - profile.last_probe_time >= probe_interval:
                profile.last_probe_time = now
                return True

        if now - profile.last_probe_time >= probe_interval:
            profile.last_probe_time = now
            return True

        return False


profile_manager = AuthProfileManager()


def get_profile_manager() -> AuthProfileManager:
    return profile_manager
