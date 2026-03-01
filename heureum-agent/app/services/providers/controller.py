# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Shared LLM factory — single source of truth for creating LLM instances."""

import os
from typing import Any

from app.config import Settings, settings as app_settings

# Google AI Studio OpenAI-compatible endpoint
_GOOGLE_OPENAI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/"

_cache_configured: bool = False


def _configure_llm_cache(settings: Settings) -> None:
    """Enable LangChain in-memory response cache when LLM_CACHE_ENABLED is set."""
    global _cache_configured
    if _cache_configured or not settings.LLM_CACHE_ENABLED:
        return
    from langchain_community.cache import InMemoryCache
    from langchain_core.globals import set_llm_cache

    set_llm_cache(InMemoryCache())
    _cache_configured = True


def _infer_provider(model: str, settings: Settings) -> str:
    """Infer provider from model name and settings.

    Gemini models use Vertex AI when ``GOOGLE_CLOUD_PROJECT`` is set without
    ``GOOGLE_API_KEY``; otherwise they use Google AI Studio.
    """
    if model.startswith("gemini"):
        if settings.GOOGLE_CLOUD_PROJECT and not settings.GOOGLE_API_KEY:
            return "vertex_ai"
        return "gemini"
    if model.startswith("claude"):
        return "anthropic"
    return "openai"


def _get_vertex_access_token(settings: Settings) -> str:
    """Obtain a short-lived OAuth2 Bearer token for Vertex AI.

    Uses ``GOOGLE_APPLICATION_CREDENTIALS`` (service account JSON) when set,
    otherwise falls back to Application Default Credentials.
    """
    if settings.GOOGLE_APPLICATION_CREDENTIALS:
        os.environ.setdefault(
            "GOOGLE_APPLICATION_CREDENTIALS",
            settings.GOOGLE_APPLICATION_CREDENTIALS,
        )
    import google.auth
    import google.auth.transport.requests

    creds, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/cloud-platform"]
    )
    creds.refresh(google.auth.transport.requests.Request())
    return creds.token  # type: ignore[return-value]


def _resolve_api_config(
    model: str, provider: str | None, settings: Settings
) -> tuple[str, str | None]:
    """Return ``(api_key, base_url)`` for the resolved provider.

    - ``openai``    → OpenAI default endpoint (``base_url=None``)
    - ``gemini``    → Google AI Studio OpenAI-compatible endpoint
    - ``vertex_ai`` → Vertex AI OpenAI-compatible endpoint (OAuth2 token)
    - ``anthropic`` → Anthropic OpenAI-compatible endpoint
    """
    p = provider or _infer_provider(model, settings)

    if p == "gemini":
        return settings.GOOGLE_API_KEY, _GOOGLE_OPENAI_BASE_URL

    if p == "vertex_ai":
        location = settings.GOOGLE_CLOUD_LOCATION or "us-central1"
        project = settings.GOOGLE_CLOUD_PROJECT
        base_url = (
            f"https://{location}-aiplatform.googleapis.com/v1beta1"
            f"/projects/{project}/locations/{location}/endpoints/openapi"
        )
        return _get_vertex_access_token(settings), base_url

    if p == "anthropic":
        return settings.ANTHROPIC_API_KEY, "https://api.anthropic.com/v1/"

    # openai — use SDK default base URL
    return settings.OPENAI_API_KEY, None


def _build_extra_body(
    model: str, provider: str | None, settings: Settings
) -> dict[str, Any] | None:
    """Build provider-specific extra request body (e.g. Gemini thinking budget)."""
    p = provider or _infer_provider(model, settings)
    if p in ("gemini", "vertex_ai") and settings.AGENT_THINKING_BUDGET:
        return {
            "thinking": {
                "type": "enabled",
                "budget_tokens": settings.AGENT_THINKING_BUDGET,
            }
        }
    return None


def create_llm(
    *,
    model: str,
    provider: str | None = None,
    settings: Settings,
) -> Any:
    """Create a LangChain LLM instance using ``ChatOpenAI`` with provider-specific base URLs.

    Provider routing (auto-inferred from model name when ``provider`` is ``None``):

    - **OpenAI** — default SDK endpoint
    - **Gemini** — Google AI Studio: ``https://generativelanguage.googleapis.com/v1beta/openai/``
    - **Vertex AI** — ``https://{location}-aiplatform.googleapis.com/v1beta1/…/endpoints/openapi``
      (triggered when ``GOOGLE_CLOUD_PROJECT`` is set and ``GOOGLE_API_KEY`` is absent)
    - **Anthropic** — ``https://api.anthropic.com/v1/``

    Args:
        model: Model identifier (e.g. ``"gemini-2.0-flash"``, ``"gpt-4o"``).
        provider: Explicit provider override; inferred from *model* when omitted.
        settings: Application settings providing API keys and parameters.

    Returns:
        A ``ChatOpenAI`` instance configured for the target provider.
    """
    from langchain_openai import ChatOpenAI

    _configure_llm_cache(settings)
    api_key, base_url = _resolve_api_config(model, provider, settings)
    extra_body = _build_extra_body(model, provider, settings)

    kwargs: dict[str, Any] = dict(
        model=model,
        temperature=settings.AGENT_TEMPERATURE,
        max_tokens=settings.AGENT_MAX_TOKENS,
    )
    if api_key:
        kwargs["api_key"] = api_key
    if base_url:
        kwargs["base_url"] = base_url
    if extra_body:
        kwargs["extra_body"] = extra_body

    return ChatOpenAI(**kwargs)


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
