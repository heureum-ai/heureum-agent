# Copyright (c) 2026 Heureum AI. All rights reserved.

"""System prompt management."""

from app.services.prompts.base import NO_OUTPUT, TRUNCATION_SUFFIX
from app.services.prompts.compaction import (
    COMPACTION_MERGE_INSTRUCTIONS,
    COMPACTION_PREFIX,
    COMPACTION_SYSTEM_PROMPT,
    DEFAULT_SUMMARY_FALLBACK,
    build_compaction_prompt,
)
from app.services.prompts.controller import PromptController

__all__ = [
    "COMPACTION_MERGE_INSTRUCTIONS",
    "COMPACTION_PREFIX",
    "COMPACTION_SYSTEM_PROMPT",
    "DEFAULT_SUMMARY_FALLBACK",
    "NO_OUTPUT",
    "PromptController",
    "TRUNCATION_SUFFIX",
    "build_compaction_prompt",
]
