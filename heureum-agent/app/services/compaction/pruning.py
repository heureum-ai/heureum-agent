# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Layer 2 — Context pruning.

Two-phase strategy applied to old tool results:
  Phase 1  soft-trim:  keep head + tail  (ratio >= soft_trim_ratio)
  Phase 2  hard-clear: replace with placeholder  (ratio >= hard_clear_ratio)

Mirrors OpenClaw's context-pruning/pruner.ts.

Limitation — image-aware pruning:
  OpenClaw skips pruning of tool results that contain image blocks
  (hasImageBlocks check) because images are often directly relevant and
  hard to partially prune safely.  Our implementation prunes all tool-role
  messages regardless of content type.
  When Message gains structured content, add:
    - _has_image_blocks(msg) check before pruning
    - Skip soft-trim / hard-clear for image-containing messages
  Reference: OpenClaw pruner.ts lines 196-198, 279-281

Limitation — tool name filtering:
  OpenClaw supports selective pruning via isToolPrunable(toolName) with
  allow/deny pattern lists in settings (e.g. prune only "Bash", "Read").
  When Message gains a tool_name field, add:
    - isToolPrunable predicate with allow/deny glob matching
    - Skip pruning for non-prunable tools
  Reference: OpenClaw pruner.ts isToolPrunable / makeToolPrunablePredicate
"""

from __future__ import annotations

import fnmatch
import logging
from typing import List, Optional

from app.services.compaction.settings import CompactionSettings, ToolPruningConfig
from app.services.compaction.tokens import _text_content, estimate_message_chars
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, ToolMessage

logger = logging.getLogger(__name__)


def _is_tool_prunable(tool_name: Optional[str], config: ToolPruningConfig) -> bool:
    """Check whether a tool result is eligible for pruning.

    Mirrors OpenClaw's ``isToolPrunable`` / ``makeToolPrunablePredicate``
    with allow/deny glob pattern lists.  ``deny`` takes precedence.

    Args:
        tool_name (Optional[str]): Name of the tool, or ``None`` if unknown.
        config (ToolPruningConfig): Allow/deny pattern configuration.

    Returns:
        bool: ``True`` if the tool result may be pruned.
    """
    if not config.deny and not config.allow:
        return True

    name = (tool_name or "").strip().lower()

    if config.deny:
        for pattern in config.deny:
            if fnmatch.fnmatch(name, pattern.strip().lower()):
                return False

    if config.allow:
        for pattern in config.allow:
            if fnmatch.fnmatch(name, pattern.strip().lower()):
                return True
        return False

    return True


def _find_assistant_cutoff_index(
    messages: List[BaseMessage],
    keep_last_assistants: int,
) -> int:
    """Index of the Nth-from-last assistant message.

    Everything *before* this index is eligible for pruning.
    When fewer than N assistants exist, all of them are already within the
    protected tail, so we return 0 to allow pruning of older tool results.

    Args:
        messages (List[BaseMessage]): Conversation message list to scan.
        keep_last_assistants (int): Number of recent assistant messages to
            protect from pruning.

    Returns:
        int: Index of the cutoff assistant message, or 0 if fewer than
            ``keep_last_assistants`` assistant messages exist.
    """
    if keep_last_assistants <= 0:
        return len(messages)

    remaining = keep_last_assistants
    for i in range(len(messages) - 1, -1, -1):
        if isinstance(messages[i], AIMessage):
            remaining -= 1
            if remaining == 0:
                return i
    # Fewer than keep_last_assistants exist — they are all implicitly
    # protected (in the tail).  Allow pruning from the start.
    return 0


def _find_first_user_index(messages: List[BaseMessage]) -> Optional[int]:
    """Index of the first user message (identity/bootstrap messages before it are protected).

    Args:
        messages (List[BaseMessage]): Conversation message list to scan.

    Returns:
        Optional[int]: Index of the first HumanMessage,
            or ``None`` if no user message exists.
    """
    for i, msg in enumerate(messages):
        if isinstance(msg, HumanMessage):
            return i
    return None


def _soft_trim_content(
    text: str,
    head_chars: int,
    tail_chars: int,
) -> str:
    """Keep head + tail of text, insert trimming note.

    Args:
        text (str): Original text to trim.
        head_chars (int): Number of characters to keep from the beginning.
        tail_chars (int): Number of characters to keep from the end.

    Returns:
        str: Trimmed text with head, ellipsis separator, tail, and an
            informational note about the trimming.
    """
    head = text[:head_chars]
    tail = text[-tail_chars:] if tail_chars > 0 else ""
    note = (
        f"\n\n[Tool result trimmed: kept first {head_chars} "
        f"and last {tail_chars} chars of {len(text)} chars.]"
    )
    return f"{head}\n...\n{tail}{note}"


def _soft_trim_message(
    msg: BaseMessage,
    settings: CompactionSettings,
) -> Optional[BaseMessage]:
    """Soft-trim a tool result message. Returns None if no trimming needed.

    Args:
        msg (BaseMessage): Tool result message to potentially trim.
        settings (CompactionSettings): Compaction configuration containing
            soft-trim thresholds.

    Returns:
        Optional[BaseMessage]: A new message with trimmed content, or ``None``
            if the message is already within the size limit.
    """
    text = _text_content(msg.content)
    if len(text) <= settings.soft_trim.max_chars:
        return None

    head = settings.soft_trim.head_chars
    tail = settings.soft_trim.tail_chars
    if head + tail >= len(text):
        return None

    trimmed = _soft_trim_content(text, head, tail)
    if isinstance(msg, ToolMessage):
        return ToolMessage(content=trimmed, tool_call_id=msg.tool_call_id, name=msg.name)
    return msg


def _estimate_chars(msg: BaseMessage) -> int:
    """Estimate the character count of a message including tool_calls.

    Args:
        msg (BaseMessage): Message to measure.

    Returns:
        int: Character count of content plus tool_calls metadata.
    """
    return estimate_message_chars(msg)


def _total_chars(messages: List[BaseMessage]) -> int:
    """Compute total character count across all messages including tool_calls.

    Args:
        messages (List[BaseMessage]): Messages to measure.

    Returns:
        int: Sum of character counts of all messages (content + tool_calls).
    """
    return sum(estimate_message_chars(m) for m in messages)


def prune_context_messages(
    messages: List[BaseMessage],
    settings: CompactionSettings,
) -> List[BaseMessage]:
    """Prune context messages using a 2-phase strategy.

    Phase 1 — soft trim (ratio >= soft_trim_ratio):
        Truncate old tool results to head + tail.
    Phase 2 — hard clear (ratio >= hard_clear_ratio):
        Replace old tool results with a short placeholder.

    Recent assistant messages (keep_last_assistants) and messages before the
    first user message are always protected.

    Args:
        messages (List[BaseMessage]): Full conversation message list to prune.
        settings (CompactionSettings): Compaction configuration containing
            pruning thresholds and trim parameters.

    Returns:
        List[BaseMessage]: Pruned message list. May be the original list if no
            pruning was needed, or a new list with trimmed/cleared tool
            results.
    """
    if not messages:
        return messages

    char_window = settings.context_window_chars
    if char_window <= 0:
        return messages

    cutoff_index = _find_assistant_cutoff_index(messages, settings.keep_last_assistants)
    first_user = _find_first_user_index(messages)
    prune_start = first_user if first_user is not None else 0

    total = _total_chars(messages)
    ratio = total / char_window

    if ratio < settings.soft_trim_ratio:
        return messages

    prunable_indices: List[int] = []
    result: Optional[List[BaseMessage]] = None

    for i in range(prune_start, cutoff_index):
        msg = messages[i]
        if not isinstance(msg, ToolMessage):
            continue
        if not _is_tool_prunable(msg.name, settings.tool_pruning):
            continue
        prunable_indices.append(i)

        trimmed = _soft_trim_message(msg, settings)
        if trimmed is None:
            continue

        before = _estimate_chars(msg)
        after = _estimate_chars(trimmed)
        total += after - before

        if result is None:
            result = list(messages)
        result[i] = trimmed

    output_after_soft = result if result is not None else messages
    ratio = total / char_window

    if ratio < settings.hard_clear_ratio:
        return output_after_soft

    if not settings.hard_clear.enabled:
        return output_after_soft

    prunable_chars = sum(
        _estimate_chars(output_after_soft[i])
        for i in prunable_indices
        if isinstance(output_after_soft[i], ToolMessage)
    )
    if prunable_chars < settings.min_prunable_tool_chars:
        return output_after_soft

    for i in prunable_indices:
        if ratio < settings.hard_clear_ratio:
            break

        msg = output_after_soft[i]
        if not isinstance(msg, ToolMessage):
            continue

        before = _estimate_chars(msg)
        cleared = ToolMessage(
            content=settings.hard_clear.placeholder,
            tool_call_id=msg.tool_call_id,
            name=msg.name,
        )

        if result is None:
            result = list(messages)
        result[i] = cleared

        after = _estimate_chars(cleared)
        total += after - before
        ratio = total / char_window

    return result if result is not None else messages
