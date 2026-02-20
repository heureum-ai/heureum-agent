# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Token and character estimation utilities.

Mirrors OpenClaw's estimateTokens / estimateMessagesTokens.
Uses tiktoken when available, falls back to chars/4 heuristic.

OpenClaw includes tool-call arguments in character estimation
(pruner.ts:126-132):
    if (b.type === "toolCall") {
        chars += JSON.stringify(b.arguments ?? {}).length;
    }
Our implementation mirrors this by serialising ``tool_calls`` JSON.
"""

from __future__ import annotations

import json
import logging
from typing import List

from app.models import Message

TOOL_CALL_FALLBACK_CHARS = 128
CHARS_PER_TOKEN_FALLBACK = 4

logger = logging.getLogger(__name__)

try:
    import tiktoken

    _encoding = tiktoken.encoding_for_model("gpt-4o")

    def estimate_tokens(text: str) -> int:
        """Estimate token count using tiktoken.

        Args:
            text (str): Text to tokenize.

        Returns:
            int: Number of tokens produced by the tiktoken encoder.
        """
        return len(_encoding.encode(text))

except Exception:
    logger.info("tiktoken unavailable, using chars/%d heuristic", CHARS_PER_TOKEN_FALLBACK)

    def estimate_tokens(text: str) -> int:  # type: ignore[misc]
        """Estimate token count using character heuristic.

        Args:
            text (str): Text to estimate tokens for.

        Returns:
            int: Estimated token count (at least 1), computed as
                ``len(text) // CHARS_PER_TOKEN_FALLBACK``.
        """
        return max(1, len(text) // CHARS_PER_TOKEN_FALLBACK)


def _tool_calls_chars(msg: Message) -> int:
    """Extra characters contributed by tool_calls metadata.

    Mirrors OpenClaw's pruner.ts (line 126-132) which adds
    ``JSON.stringify(b.arguments ?? {}).length`` for each toolCall block.

    Args:
        msg (Message): Message whose tool_calls to measure.

    Returns:
        int: Estimated character count of serialised tool_calls.
    """
    if not msg.tool_calls:
        return 0
    chars = 0
    for tc in msg.tool_calls:
        try:
            chars += len(json.dumps(tc, ensure_ascii=False))
        except (TypeError, ValueError):
            chars += TOOL_CALL_FALLBACK_CHARS
    return chars


def estimate_message_tokens(msg: Message) -> int:
    """Estimate token count for a single message.

    Includes both ``content`` and serialised ``tool_calls`` (if any)
    to match OpenClaw's estimateTokens behaviour.

    Args:
        msg (Message): Message to estimate tokens for.

    Returns:
        int: Estimated token count of the message content plus tool
            calls.
    """
    extra = _tool_calls_chars(msg)
    if extra:
        return estimate_tokens(msg.content) + max(1, extra // CHARS_PER_TOKEN_FALLBACK)
    return estimate_tokens(msg.content)


def estimate_messages_tokens(messages: List[Message]) -> int:
    """Estimate total token count for a list of messages.

    Args:
        messages (List[Message]): Messages to estimate tokens for.

    Returns:
        int: Sum of estimated token counts across all messages.
    """
    return sum(estimate_message_tokens(m) for m in messages)


def estimate_message_chars(msg: Message) -> int:
    """Character count for a single message including tool_calls.

    Args:
        msg (Message): Message to measure.

    Returns:
        int: Number of characters in the message content plus tool
            calls metadata.
    """
    return len(msg.content) + _tool_calls_chars(msg)


def estimate_context_chars(messages: List[Message]) -> int:
    """Total character count across all messages, including tool_calls.

    Args:
        messages (List[Message]): Messages to measure.

    Returns:
        int: Sum of character lengths of all message contents plus
            serialised tool_calls metadata.
    """
    return sum(estimate_message_chars(m) for m in messages)
