# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Shared LLM factory — single source of truth for creating LLM instances."""

import os
from typing import Any

from app.config import Settings, settings as app_settings


def _configure_litellm_env(settings: Settings) -> None:
    """Map application settings to LiteLLM-expected environment variables."""
    if settings.OPENAI_API_KEY:
        os.environ.setdefault("OPENAI_API_KEY", settings.OPENAI_API_KEY)
    if settings.GOOGLE_API_KEY:
        # LiteLLM uses GEMINI_API_KEY for Google AI Studio
        os.environ.setdefault("GEMINI_API_KEY", settings.GOOGLE_API_KEY)
    if settings.ANTHROPIC_API_KEY:
        os.environ.setdefault("ANTHROPIC_API_KEY", settings.ANTHROPIC_API_KEY)
    if settings.GOOGLE_APPLICATION_CREDENTIALS:
        os.environ.setdefault(
            "GOOGLE_APPLICATION_CREDENTIALS",
            settings.GOOGLE_APPLICATION_CREDENTIALS,
        )


def _to_litellm_model(model: str, provider: str | None, settings: Settings) -> str:
    """Convert a model name to LiteLLM's ``provider/model`` format.

    Args:
        model: Raw model identifier (e.g. ``"gemini-2.0-flash"``).
        provider: Explicit provider override; inferred from *model* when ``None``.
        settings: Application settings used to detect Vertex AI configuration.

    Returns:
        LiteLLM-formatted model string (e.g. ``"gemini/gemini-2.0-flash"``).
    """
    if "/" in model:
        return model  # already prefixed

    if provider:
        return f"{provider}/{model}"

    if model.startswith("gemini"):
        # Use Vertex AI when GOOGLE_CLOUD_PROJECT is set without a direct API key
        if settings.GOOGLE_CLOUD_PROJECT and not settings.GOOGLE_API_KEY:
            return f"vertex_ai/{model}"
        return f"gemini/{model}"

    if model.startswith("claude"):
        return f"anthropic/{model}"

    # OpenAI models (gpt-*, o1, o3, o4-*): LiteLLM auto-detects without prefix
    return model


def _build_model_kwargs(litellm_model: str, settings: Settings) -> dict[str, Any] | None:
    """Build provider-specific ``model_kwargs`` (e.g. Gemini thinking budget).

    Args:
        litellm_model: LiteLLM-formatted model string.
        settings: Application settings.

    Returns:
        Dict of extra kwargs for LiteLLM, or ``None`` if none are needed.
    """
    kwargs: dict[str, Any] = {}

    # Gemini 2.5 thinking budget
    if litellm_model.startswith(("gemini/", "vertex_ai/")) and settings.AGENT_THINKING_BUDGET:
        kwargs["thinking"] = {
            "type": "enabled",
            "budget_tokens": settings.AGENT_THINKING_BUDGET,
        }

    # Vertex AI project / location
    if litellm_model.startswith("vertex_ai/"):
        if settings.GOOGLE_CLOUD_PROJECT:
            kwargs["vertex_project"] = settings.GOOGLE_CLOUD_PROJECT
        if settings.GOOGLE_CLOUD_LOCATION:
            kwargs["vertex_location"] = settings.GOOGLE_CLOUD_LOCATION

    return kwargs or None


def create_llm(
    *,
    model: str,
    provider: str | None = None,
    settings: Settings,
) -> Any:
    """Create a LangChain LLM instance backed by LiteLLM.

    A single ``ChatLiteLLM`` covers OpenAI, Google (AI Studio + Vertex AI),
    Anthropic, and any other provider supported by LiteLLM.

    Args:
        model: Model identifier (e.g. ``"gemini-2.0-flash"``).
        provider: Explicit provider prefix (``"google"``, ``"openai"``, …).
            Inferred from *model* when omitted.
        settings: Application settings providing API keys and parameters.

    Returns:
        A ``ChatLiteLLM`` instance.

    Raises:
        ImportError: If ``langchain-community`` or ``litellm`` is not installed.
    """
    from langchain_litellm import ChatLiteLLM

    _configure_litellm_env(settings)
    litellm_model = _to_litellm_model(model, provider, settings)
    model_kwargs = _build_model_kwargs(litellm_model, settings)

    return ChatLiteLLM(
        model=litellm_model,
        temperature=settings.AGENT_TEMPERATURE,
        max_tokens=settings.AGENT_MAX_TOKENS,
        model_kwargs=model_kwargs,
    )


class LLMController:
    """Creates the primary LLM instance from application settings."""

    def __init__(self, settings: Settings | None = None) -> None:
        self.settings = settings or app_settings

    def create_primary(self) -> Any:
        """Create LLM instance based on AGENT_MODEL setting."""
        return create_llm(
            model=self.settings.AGENT_MODEL,
            settings=self.settings,
        )
