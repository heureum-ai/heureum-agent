# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Model-fallback candidate resolution."""

import logging
from typing import List

from app.services.providers.model_fallback.types import ModelCandidate

logger = logging.getLogger(__name__)

PROVIDER_ALIASES = {
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
    """Parse provider/model specs into a deduplicated candidate list."""
    candidates: List[ModelCandidate] = []
    seen = set()

    for spec in [primary_spec] + fallback_chain:
        if not spec or not spec.strip():
            continue
        spec = spec.strip()

        parts = spec.split("/", 1)
        if len(parts) != 2:
            logger.warning("Invalid model spec (expected 'provider/model'): %s", spec)
            continue

        provider_key = parts[0].lower()
        model = parts[1]
        provider = PROVIDER_ALIASES.get(provider_key)
        if not provider:
            logger.warning("Unknown provider '%s' in spec: %s", provider_key, spec)
            continue

        if spec in seen:
            continue
        seen.add(spec)

        candidates.append(ModelCandidate(provider=provider, model=model, spec=spec))

    return candidates
