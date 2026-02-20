# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for model fallback."""

import pytest
from app.services.model_fallback import (
    AllModelsFailedError,
    AuthProfileManager,
    ErrorAction,
    ModelCandidate,
    MultiProviderLLM,
    calculate_cooldown_ms,
    classify_error,
    is_failover_error,
    resolve_candidates,
    run_with_model_fallback,
)

# ---------------------------------------------------------------------------
# is_failover_error
# ---------------------------------------------------------------------------


class TestIsFailoverError:
    def test_rate_limit(self):
        assert is_failover_error(Exception("429 rate limit exceeded")) is True

    def test_context_overflow_not_failover(self):
        assert is_failover_error(Exception("context_length_exceeded")) is False

    def test_thought_signature_not_failover(self):
        assert is_failover_error(Exception("Thought signature is not valid")) is False

    def test_server_error(self):
        assert is_failover_error(Exception("503 service unavailable")) is True

    def test_overloaded(self):
        assert is_failover_error(Exception("model is overloaded")) is True

    def test_unknown_error(self):
        assert is_failover_error(Exception("some random error")) is False


# ---------------------------------------------------------------------------
# classify_error
# ---------------------------------------------------------------------------


class TestClassifyError:
    def test_context_overflow(self):
        assert classify_error(Exception("context_length_exceeded")) == ErrorAction.RETHROW

    def test_thought_signature(self):
        assert classify_error(Exception("Thought signature is not valid")) == ErrorAction.RETHROW

    def test_rate_limit(self):
        assert classify_error(Exception("429 rate limit")) == ErrorAction.FAILOVER

    def test_unknown(self):
        assert classify_error(Exception("totally unknown")) == ErrorAction.RETHROW


# ---------------------------------------------------------------------------
# resolve_candidates
# ---------------------------------------------------------------------------


class TestResolveCandidates:
    def test_basic(self):
        candidates = resolve_candidates(
            "google/gemini-2.5-flash",
            ["openai/gpt-4o"],
        )
        assert len(candidates) == 2
        assert candidates[0].provider == "google"
        assert candidates[0].model == "gemini-2.5-flash"
        assert candidates[1].provider == "openai"

    def test_dedup(self):
        candidates = resolve_candidates(
            "google/gemini-2.5-flash",
            ["google/gemini-2.5-flash", "openai/gpt-4o"],
        )
        assert len(candidates) == 2  # deduped

    def test_primary_first(self):
        candidates = resolve_candidates(
            "openai/gpt-4o",
            ["google/gemini-2.5-flash"],
        )
        assert candidates[0].spec == "openai/gpt-4o"

    def test_bad_spec_skipped(self):
        candidates = resolve_candidates(
            "google/gemini-2.5-flash",
            ["invalid", "openai/gpt-4o"],
        )
        assert len(candidates) == 2

    def test_empty_specs(self):
        candidates = resolve_candidates("", [])
        assert candidates == []

    def test_unknown_provider_skipped(self):
        candidates = resolve_candidates(
            "google/gemini-2.5-flash",
            ["baidu/ernie-4"],
        )
        assert len(candidates) == 1

    def test_provider_aliases(self):
        candidates = resolve_candidates(
            "gemini/gemini-2.5-flash",
            ["claude/claude-3-opus"],
        )
        assert candidates[0].provider == "google"
        assert candidates[1].provider == "anthropic"


# ---------------------------------------------------------------------------
# calculate_cooldown_ms
# ---------------------------------------------------------------------------


class TestCalculateCooldownMs:
    def test_zero_errors(self):
        assert calculate_cooldown_ms(0) == 0.0

    def test_first_error(self):
        assert calculate_cooldown_ms(1, base_seconds=60) == 60_000.0

    def test_second_error(self):
        assert calculate_cooldown_ms(2, base_seconds=60) == 300_000.0  # 60 * 5

    def test_third_error(self):
        assert calculate_cooldown_ms(3, base_seconds=60) == 1_500_000.0  # 60 * 25

    def test_cap(self):
        result = calculate_cooldown_ms(10, base_seconds=60, max_seconds=3600)
        assert result == 3_600_000.0


# ---------------------------------------------------------------------------
# AuthProfileManager
# ---------------------------------------------------------------------------


class TestAuthProfileManager:
    def test_mark_failure_sets_cooldown(self):
        pm = AuthProfileManager()
        pm.mark_failure("google", Exception("429 rate limit"))
        assert pm.is_in_cooldown("google") is True

    def test_mark_success_resets(self):
        pm = AuthProfileManager()
        pm.mark_failure("google", Exception("429 rate limit"))
        pm.mark_success("google")
        assert pm.is_in_cooldown("google") is False

    def test_not_in_cooldown_initially(self):
        pm = AuthProfileManager()
        assert pm.is_in_cooldown("google") is False

    def test_probe_throttle(self):
        pm = AuthProfileManager()
        pm.mark_failure("google", Exception("429"), base_seconds=300)
        # First probe should succeed
        assert pm.should_probe_primary("google", probe_interval=0.01) is True
        # Immediately after, should be throttled
        assert pm.should_probe_primary("google", probe_interval=30.0) is False


# ---------------------------------------------------------------------------
# run_with_model_fallback
# ---------------------------------------------------------------------------


class TestRunWithModelFallback:
    @pytest.mark.asyncio
    async def test_success_primary(self):
        candidates = [
            ModelCandidate(provider="google", model="flash", spec="google/flash"),
        ]
        mp = MultiProviderLLM()
        mp._cache["google/flash"] = "mock_llm"

        async def call_fn(llm):
            return "ok"

        result = await run_with_model_fallback(
            candidates, call_fn, mp, profile_manager=AuthProfileManager()
        )
        assert result.succeeded is True
        assert result.value == "ok"

    @pytest.mark.asyncio
    async def test_fallback_on_429(self):
        candidates = [
            ModelCandidate(provider="google", model="flash", spec="google/flash"),
            ModelCandidate(provider="openai", model="gpt-4o", spec="openai/gpt-4o"),
        ]
        mp = MultiProviderLLM()
        mp._cache["google/flash"] = "mock_google"
        mp._cache["openai/gpt-4o"] = "mock_openai"

        call_count = 0

        async def call_fn(llm):
            nonlocal call_count
            call_count += 1
            if llm == "mock_google":
                raise Exception("429 rate limit exceeded")
            return "fallback_ok"

        result = await run_with_model_fallback(
            candidates, call_fn, mp, profile_manager=AuthProfileManager()
        )
        assert result.succeeded is True
        assert result.value == "fallback_ok"
        assert result.candidate.spec == "openai/gpt-4o"
        assert call_count == 2

    @pytest.mark.asyncio
    async def test_overflow_raises(self):
        candidates = [
            ModelCandidate(provider="google", model="flash", spec="google/flash"),
            ModelCandidate(provider="openai", model="gpt-4o", spec="openai/gpt-4o"),
        ]
        mp = MultiProviderLLM()
        mp._cache["google/flash"] = "mock_google"
        mp._cache["openai/gpt-4o"] = "mock_openai"

        async def call_fn(llm):
            raise Exception("context_length_exceeded: too many tokens")

        with pytest.raises(Exception, match="context_length_exceeded"):
            await run_with_model_fallback(
                candidates, call_fn, mp, profile_manager=AuthProfileManager()
            )

    @pytest.mark.asyncio
    async def test_all_fail(self):
        candidates = [
            ModelCandidate(provider="google", model="flash", spec="google/flash"),
            ModelCandidate(provider="openai", model="gpt-4o", spec="openai/gpt-4o"),
        ]
        mp = MultiProviderLLM()
        mp._cache["google/flash"] = "mock_google"
        mp._cache["openai/gpt-4o"] = "mock_openai"

        async def call_fn(llm):
            raise Exception("503 service unavailable")

        with pytest.raises(AllModelsFailedError) as exc_info:
            await run_with_model_fallback(
                candidates, call_fn, mp, profile_manager=AuthProfileManager()
            )
        assert len(exc_info.value.attempts) == 2


# ---------------------------------------------------------------------------
# MultiProviderLLM
# ---------------------------------------------------------------------------


class TestMultiProviderLLM:
    def test_same_key_cached(self):
        mp = MultiProviderLLM()
        mp._cache["google/flash"] = "cached_llm"
        candidate = ModelCandidate(provider="google", model="flash", spec="google/flash")
        assert mp.get_llm(candidate) == "cached_llm"
        # Second call returns same object
        assert mp.get_llm(candidate) is mp._cache["google/flash"]
