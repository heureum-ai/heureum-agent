# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Compaction-domain controller and orchestration helpers."""

from __future__ import annotations

import logging
from collections.abc import Sequence
from dataclasses import replace

from app.services.compaction.tokens import _text_content
from langchain_core.messages import SystemMessage as LCSystemMessage
from app.services.compaction.settings import CompactionSettings
from app.services.compaction.summarizer import compact_history
from app.services.compaction.tokens import estimate_messages_tokens
from app.services.compaction.truncation import truncate_oversized_tool_results
from app.services.compaction.pruning import prune_context_messages
from app.services.prompts import COMPACTION_PREFIX
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import BaseMessage

logger = logging.getLogger(__name__)


class CompactionController:
    """Central controller for layered compaction and overflow helpers."""

    def __init__(self, settings: CompactionSettings | None = None) -> None:
        self.settings = settings or CompactionSettings()

    def estimate_messages_tokens(self, messages: list[BaseMessage]) -> int:
        """Estimate total token count for a message list."""
        return estimate_messages_tokens(messages)

    def truncate_oversized_tool_results(
        self,
        messages: list[BaseMessage],
    ) -> tuple[list[BaseMessage], int]:
        """Apply layer-1 tool result truncation."""
        return truncate_oversized_tool_results(messages, self.settings)

    def prune_context_messages(
        self,
        messages: list[BaseMessage],
    ) -> list[BaseMessage]:
        """Apply layer-2 pruning."""
        return prune_context_messages(messages, self.settings)

    async def compact_history(
        self,
        messages: list[BaseMessage],
        llm: BaseChatModel,
    ) -> list[BaseMessage]:
        """Apply layer-3 LLM compaction."""
        return await compact_history(messages, llm, self.settings)

    def build_aggressive_truncation_settings(self) -> CompactionSettings:
        """Build one-shot aggressive truncation settings for overflow fallback."""
        return replace(
            self.settings,
            max_tool_result_context_share=self.settings.max_tool_result_context_share / 4,
            hard_max_tool_result_chars=min(
                self.settings.hard_max_tool_result_chars // 4,
                50_000,
            ),
        )

    def truncate_aggressive(
        self,
        messages: list[BaseMessage],
    ) -> tuple[list[BaseMessage], int]:
        """Apply aggressive truncation (1/4 of normal thresholds)."""
        aggressive = self.build_aggressive_truncation_settings()
        return truncate_oversized_tool_results(messages, aggressive)

    def rebuild_lc_history_with_tail_preservation(
        self,
        *,
        compacted_history: list[BaseMessage],
        original_lc: Sequence[BaseMessage],
    ) -> list[BaseMessage]:
        """Rebuild LC history while preserving original kept-tail metadata."""
        lc_result: list[BaseMessage] = []
        original_len = len(original_lc)
        kept_tail_len = 0

        for msg in compacted_history:
            if isinstance(msg, LCSystemMessage) and _text_content(msg.content).startswith(
                COMPACTION_PREFIX
            ):
                lc_result.append(msg)
            else:
                kept_tail_len += 1

        if kept_tail_len > 0 and kept_tail_len <= original_len:
            lc_result.extend(original_lc[original_len - kept_tail_len :])
            return lc_result

        for msg in compacted_history:
            if isinstance(msg, LCSystemMessage) and _text_content(msg.content).startswith(
                COMPACTION_PREFIX
            ):
                continue
            lc_result.append(msg)
        return lc_result

    async def compact_session_history(
        self,
        *,
        history: list[BaseMessage],
        original_lc: Sequence[BaseMessage],
        llm: BaseChatModel,
    ) -> tuple[list[BaseMessage], list[BaseMessage]]:
        """Run layered compaction and rebuild LC history with tail preservation."""
        compacted_history, truncated = self.truncate_oversized_tool_results(history)
        if truncated:
            logger.info("Layer 1: truncated %d tool result(s)", truncated)

        compacted_history = self.prune_context_messages(compacted_history)
        compacted_history = await self.compact_history(compacted_history, llm)
        lc_history = self.rebuild_lc_history_with_tail_preservation(
            compacted_history=compacted_history,
            original_lc=original_lc,
        )
        return compacted_history, lc_history
