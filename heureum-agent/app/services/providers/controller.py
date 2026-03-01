# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Shared LLM factory — single source of truth for creating LLM instances."""

import os
from typing import Any

from app.config import Settings, settings as app_settings


def create_llm(
    *,
    model: str,
    provider: str | None = None,
    settings: Settings,
) -> Any:
    """Create a LangChain LLM instance for the given model/provider.

    When ``provider`` is None, the provider is inferred from the model name
    (models starting with ``"gemini"`` → Google, everything else → OpenAI).

    Args:
        model: Model identifier (e.g. ``"gemini-2.0-flash"``).
        provider: Explicit provider name (``"google"``, ``"openai"``,
            ``"anthropic"``).  Inferred from *model* when omitted.
        settings: Application settings providing API keys and parameters.

    Returns:
        A LangChain chat model instance.

    Raises:
        ValueError: If the provider is unsupported.
        ImportError: If the required LangChain integration package is missing.
    """
    resolved_provider = provider or _infer_provider(model)

    if resolved_provider == "google":
        return _create_google_llm(model=model, settings=settings)
    if resolved_provider == "openai":
        return _create_openai_llm(model=model, settings=settings)
    if resolved_provider == "anthropic":
        return _create_anthropic_llm(model=model, settings=settings)

    raise ValueError(f"Unsupported provider: {resolved_provider}")


def _infer_provider(model: str) -> str:
    if model.startswith("gemini"):
        return "google"
    return "openai"


def _create_google_llm(*, model: str, settings: Settings) -> Any:
    from langchain_google_genai import ChatGoogleGenerativeAI

    thinking_budget = settings.AGENT_THINKING_BUDGET or None
    include_thoughts = True if thinking_budget else None
    if settings.GOOGLE_API_KEY:
        return ChatGoogleGenerativeAI(
            model=model,
            google_api_key=settings.GOOGLE_API_KEY,
            temperature=settings.AGENT_TEMPERATURE,
            max_output_tokens=settings.AGENT_MAX_TOKENS,
            thinking_budget=thinking_budget,
            include_thoughts=include_thoughts,
        )
    if settings.GOOGLE_APPLICATION_CREDENTIALS:
        os.environ.setdefault(
            "GOOGLE_APPLICATION_CREDENTIALS",
            settings.GOOGLE_APPLICATION_CREDENTIALS,
        )
    return ChatGoogleGenerativeAI(
        model=model,
        vertexai=True,
        project=settings.GOOGLE_CLOUD_PROJECT,
        location=settings.GOOGLE_CLOUD_LOCATION,
        temperature=settings.AGENT_TEMPERATURE,
        max_output_tokens=settings.AGENT_MAX_TOKENS,
        thinking_budget=thinking_budget,
        include_thoughts=include_thoughts,
    )


def _create_openai_llm(*, model: str, settings: Settings) -> Any:
    from langchain_openai import ChatOpenAI
    from pydantic import SecretStr

    return ChatOpenAI(
        api_key=SecretStr(settings.OPENAI_API_KEY),
        model=model,
        temperature=settings.AGENT_TEMPERATURE,
        max_completion_tokens=settings.AGENT_MAX_TOKENS,
    )


def _create_anthropic_llm(*, model: str, settings: Settings) -> Any:
    try:
        from langchain_anthropic import ChatAnthropic
    except ImportError:
        raise ImportError("langchain-anthropic is required for Anthropic provider")

    return ChatAnthropic(
        api_key=settings.ANTHROPIC_API_KEY,
        model=model,
        temperature=settings.AGENT_TEMPERATURE,
        max_tokens=settings.AGENT_MAX_TOKENS,
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
