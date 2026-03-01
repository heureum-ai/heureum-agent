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

from langchain_core.messages import BaseMessage

TOOL_CALL_FALLBACK_CHARS = 128
CHARS_PER_TOKEN_FALLBACK = 4

logger = logging.getLogger(__name__)


def _text_content(content) -> str:
    """Extract text from LangChain message content (str or list)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = []
        for item in content:
            if isinstance(item, str):
                parts.append(item)
            elif isinstance(item, dict):
                text = item.get("text") or item.get("refusal") or ""
                if text:
                    parts.append(text)
        return " ".join(parts)
    return str(content)


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


def _tool_calls_chars(msg: BaseMessage) -> int:
    """Extra characters contributed by tool_calls metadata.

    Mirrors OpenClaw's pruner.ts (line 126-132) which adds
    ``JSON.stringify(b.arguments ?? {}).length`` for each toolCall block.

    Args:
        msg (BaseMessage): Message whose tool_calls to measure.

    Returns:
        int: Estimated character count of serialised tool_calls.
    """
    tool_calls = getattr(msg, "tool_calls", None)
    if not tool_calls:
        return 0
    chars = 0
    for tc in tool_calls:
        try:
            obj = tc.model_dump() if hasattr(tc, "model_dump") else tc
            chars += len(json.dumps(obj, ensure_ascii=False))
        except (TypeError, ValueError):
            chars += TOOL_CALL_FALLBACK_CHARS
    return chars


def estimate_message_tokens(msg: BaseMessage) -> int:
    """Estimate token count for a single message.

    Includes both ``content`` and serialised ``tool_calls`` (if any)
    to match OpenClaw's estimateTokens behaviour.

    Args:
        msg (BaseMessage): Message to estimate tokens for.

    Returns:
        int: Estimated token count of the message content plus tool
            calls.
    """
    extra = _tool_calls_chars(msg)
    text = _text_content(msg.content)
    if extra:
        return estimate_tokens(text) + max(1, extra // CHARS_PER_TOKEN_FALLBACK)
    return estimate_tokens(text)


def estimate_messages_tokens(messages: List[BaseMessage]) -> int:
    """Estimate total token count for a list of messages.

    Args:
        messages (List[BaseMessage]): Messages to estimate tokens for.

    Returns:
        int: Sum of estimated token counts across all messages.
    """
    return sum(estimate_message_tokens(m) for m in messages)


def estimate_message_chars(msg: BaseMessage) -> int:
    """Character count for a single message including tool_calls.

    Args:
        msg (BaseMessage): Message to measure.

    Returns:
        int: Number of characters in the message content plus tool
            calls metadata.
    """
    return len(_text_content(msg.content)) + _tool_calls_chars(msg)


def estimate_context_chars(messages: List[BaseMessage]) -> int:
    """Total character count across all messages, including tool_calls.

    Args:
        messages (List[BaseMessage]): Messages to measure.

    Returns:
        int: Sum of character lengths of all message contents plus
            serialised tool_calls metadata.
    """
    return sum(estimate_message_chars(m) for m in messages)
