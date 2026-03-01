# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Layer 1 — Tool result truncation.

Caps individual tool result messages before they enter the context.
Mirrors OpenClaw's tool-result-truncation.ts.

Limitation — multi-block content:
  OpenClaw handles tool results with multiple content blocks (text + image).
  It distributes the character budget proportionally across text blocks and
  preserves non-text blocks (images) as-is.
  Our implementation assumes Message.content is a single string.
  When Message gains structured content (List[ContentBlock]), this module
  needs:
    - getToolResultTextLength() — sum text lengths across blocks
    - Proportional budget distribution per text block
    - Pass-through for non-text blocks (image, etc.)
  Reference: OpenClaw truncateToolResultMessage()
"""

from __future__ import annotations

import logging
from typing import List, Tuple

from app.services.compaction.settings import CompactionSettings
from app.services.compaction.tokens import _text_content
from langchain_core.messages import BaseMessage, ToolMessage

logger = logging.getLogger(__name__)


def calculate_max_tool_result_chars(settings: CompactionSettings) -> int:
    """Max allowed characters for a single tool result.

    = min(context_window * share * chars_per_token, hard_max)

    Args:
        settings (CompactionSettings): Compaction configuration providing
            context window size, share ratio, and hard maximum.

    Returns:
        int: Maximum character count allowed for a single tool result.
    """
    max_tokens = int(settings.context_window_tokens * settings.max_tool_result_context_share)
    max_chars = max_tokens * settings.chars_per_token
    return min(max_chars, settings.hard_max_tool_result_chars)


def truncate_tool_result_text(
    text: str,
    max_chars: int,
    *,
    min_keep_chars: int = 2_000,
    suffix: str = "",
) -> str:
    """Truncate a single text string, trying to cut at a newline boundary.

    Args:
        text (str): Text to truncate.
        max_chars (int): Maximum allowed character count.
        min_keep_chars (int): Minimum characters to preserve even when the
            suffix is large. Defaults to 2000.
        suffix (str): Text appended after truncation. Defaults to ``""``.

    Returns:
        str: The original text if within limits, otherwise the truncated text
            with the suffix appended.
    """
    if len(text) <= max_chars:
        return text

    keep_chars = max(min_keep_chars, max_chars - len(suffix))
    # Prefer breaking at a newline within the last 20 % of the kept region
    cut_point = keep_chars
    last_newline = text.rfind("\n", 0, keep_chars)
    if last_newline > keep_chars * 0.8:
        cut_point = last_newline

    return text[:cut_point] + suffix


def truncate_oversized_tool_results(
    messages: List[BaseMessage],
    settings: CompactionSettings,
) -> Tuple[List[BaseMessage], int]:
    """Truncate oversized tool results in-memory (does not mutate originals).

    Args:
        messages (List[BaseMessage]): Conversation message list to process.
        settings (CompactionSettings): Compaction configuration providing
            truncation thresholds and suffix.

    Returns:
        Tuple[List[BaseMessage], int]: A tuple of the new message list (with
            oversized tool results truncated) and the count of messages
            that were truncated.
    """
    max_chars = calculate_max_tool_result_chars(settings)
    truncated_count = 0
    result: List[BaseMessage] = []

    for msg in messages:
        if not isinstance(msg, ToolMessage):
            result.append(msg)
            continue
        text = _text_content(msg.content)
        if len(text) <= max_chars:
            result.append(msg)
            continue

        original_len = len(text)
        truncated_content = truncate_tool_result_text(
            text,
            max_chars,
            min_keep_chars=settings.min_keep_chars,
            suffix=settings.truncation_suffix,
        )
        result.append(
            ToolMessage(
                content=truncated_content,
                tool_call_id=msg.tool_call_id,
                name=msg.name,
            )
        )
        truncated_count += 1
        logger.info(
            "Truncated tool result: %d chars -> %d chars",
            original_len,
            len(truncated_content),
        )

    return result, truncated_count


def has_oversized_tool_results(
    messages: List[BaseMessage],
    settings: CompactionSettings,
) -> bool:
    """Check whether any tool result exceeds the size limit.

    Args:
        messages (List[BaseMessage]): Conversation message list to check.
        settings (CompactionSettings): Compaction configuration providing
            the size limit.

    Returns:
        bool: ``True`` if at least one tool result message exceeds the
            maximum allowed character count.
    """
    max_chars = calculate_max_tool_result_chars(settings)
    return any(
        isinstance(msg, ToolMessage) and len(_text_content(msg.content)) > max_chars
        for msg in messages
    )
