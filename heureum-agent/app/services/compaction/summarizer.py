# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Layer 3 — LLM-based compaction.

Summarizes conversation history to free context space when pruning alone
is insufficient. Supports chunked summarization, progressive fallback for
oversized messages, and multi-stage merge.

Mirrors OpenClaw's compaction.ts (summarizeChunks / summarizeWithFallback /
summarizeInStages / pruneHistoryForContextShare).

Integration requirements (outside compaction/):
  Agent runner (agent_service.py) must implement **overflow recovery loop**:
    1. Send messages to LLM
    2. On context overflow error → call compact_history() → retry (max 3 attempts)
    3. If compaction fails → call truncate_oversized_tool_results() → retry
    4. If still failing → return error to user
  Reference: OpenClaw run.ts lines 473-598, isContextOverflowError()
"""

from __future__ import annotations

import json
import logging
from typing import List, Optional

from app.models import Message
from app.schemas.open_responses import MessageRole
from app.services.compaction.repair import repair_tool_use_result_pairing
from app.services.compaction.settings import CompactionSettings
from app.services.compaction.tokens import (
    estimate_message_tokens,
    estimate_messages_tokens,
    estimate_tokens,
)
from app.services.prompts.compaction import (
    COMPACTION_MERGE_INSTRUCTIONS,
    COMPACTION_PREFIX,
    COMPACTION_SYSTEM_PROMPT,
    DEFAULT_SUMMARY_FALLBACK,
    build_compaction_prompt,
)
from langchain_core.language_models import BaseChatModel
from langchain_core.messages import HumanMessage, SystemMessage

logger = logging.getLogger(__name__)


def _messages_to_text(
    messages: List[Message],
    max_chars_per_message: int = 2_000,
) -> str:
    """Serialize messages to text for summarization.

    Mirrors OpenClaw's ``serializeConversation()`` format so that the
    summarizer sees clearly separated sections per role.  The text-only
    format prevents the model from treating the content as a conversation
    to continue.

    Format:
        [User]: ...
        [Assistant]: ...          (text content only)
        [Assistant tool calls]: name(key=val); name2(key=val)
        [Tool result]: ...        (or [Tool result (name)]: ...)

    Sections are separated by double newlines (``\\n\\n``).

    Args:
        messages (List[Message]): Messages to convert.
        max_chars_per_message (int): Maximum characters to keep per message
            content. Defaults to 2000.

    Returns:
        str: Double-newline-joined string of role-prefixed entries.
    """
    parts: List[str] = []
    for msg in messages:
        content = msg.content[:max_chars_per_message]

        if msg.role == MessageRole.USER:
            if content:
                parts.append(f"[User]: {content}")

        elif msg.role == MessageRole.ASSISTANT:
            # Emit text and tool_calls as separate sections
            if content:
                parts.append(f"[Assistant]: {content}")
            if msg.tool_calls:
                tc_strs: List[str] = []
                for tc in msg.tool_calls:
                    name = (
                        tc.get("name", "unknown")
                        if isinstance(tc, dict)
                        else getattr(tc, "name", "unknown")
                    )
                    args = tc.get("args", {}) if isinstance(tc, dict) else getattr(tc, "args", {})
                    try:
                        pairs = (
                            ", ".join(
                                f"{k}={json.dumps(v, ensure_ascii=False)}" for k, v in args.items()
                            )
                            if isinstance(args, dict)
                            else json.dumps(args, ensure_ascii=False)
                        )
                    except (TypeError, ValueError):
                        pairs = str(args)
                    tc_strs.append(f"{name}({pairs})")
                parts.append(f"[Assistant tool calls]: {'; '.join(tc_strs)}")

        elif msg.role == MessageRole.TOOL:
            label = f"[Tool result ({msg.tool_name})]" if msg.tool_name else "[Tool result]"
            if content:
                parts.append(f"{label}: {content}")

        elif msg.role == MessageRole.SYSTEM:
            if content:
                parts.append(f"[System]: {content}")

    return "\n\n".join(parts)


async def _generate_summary(
    messages: List[Message],
    llm: BaseChatModel,
    previous_summary: Optional[str] = None,
) -> str:
    """Generate an LLM summary of the given messages.

    Uses an update prompt when a previous summary exists to produce an
    incremental summary, otherwise generates a fresh one.

    Args:
        messages (List[Message]): Messages to summarize.
        llm (BaseChatModel): Language model used to produce the summary.
        previous_summary (Optional[str]): An existing summary to update
            incrementally. Defaults to ``None``.

    Returns:
        str: The generated summary text.
    """
    conversation = _messages_to_text(messages)
    if not conversation.strip():
        return previous_summary or DEFAULT_SUMMARY_FALLBACK

    prompt = build_compaction_prompt(conversation, previous_summary)

    response = await llm.ainvoke(
        [
            SystemMessage(content=COMPACTION_SYSTEM_PROMPT),
            HumanMessage(content=prompt),
        ]
    )
    return response.content if isinstance(response.content, str) else str(response.content)


def _chunk_messages_by_max_tokens(
    messages: List[Message],
    max_tokens: int,
) -> List[List[Message]]:
    """Split messages into chunks each fitting within *max_tokens*.

    Args:
        messages (List[Message]): Messages to split into chunks.
        max_tokens (int): Maximum estimated token count per chunk.

    Returns:
        List[List[Message]]: List of message chunks, each within the token
            budget. A single message exceeding the budget forms its own chunk.
    """
    if not messages:
        return []

    chunks: List[List[Message]] = []
    current: List[Message] = []
    current_tokens = 0

    for msg in messages:
        msg_tokens = estimate_message_tokens(msg)

        if current and current_tokens + msg_tokens > max_tokens:
            chunks.append(current)
            current = []
            current_tokens = 0

        current.append(msg)
        current_tokens += msg_tokens

        if msg_tokens > max_tokens:
            chunks.append(current)
            current = []
            current_tokens = 0

    if current:
        chunks.append(current)
    return chunks


def _split_by_token_share(
    messages: List[Message],
    parts: int = 2,
) -> List[List[Message]]:
    """Split messages into *parts* roughly equal by token count.

    Args:
        messages (List[Message]): Messages to split.
        parts (int): Desired number of roughly equal parts. Defaults to 2.

    Returns:
        List[List[Message]]: List of message chunks split approximately
            equally by token count.
    """
    if not messages or parts <= 1:
        return [messages] if messages else []

    parts = min(parts, len(messages))
    total_tokens = estimate_messages_tokens(messages)
    target = total_tokens / parts

    chunks: List[List[Message]] = []
    current: List[Message] = []
    current_tokens = 0

    for msg in messages:
        msg_tokens = estimate_message_tokens(msg)
        if len(chunks) < parts - 1 and current and current_tokens + msg_tokens > target:
            chunks.append(current)
            current = []
            current_tokens = 0

        current.append(msg)
        current_tokens += msg_tokens

    if current:
        chunks.append(current)
    return chunks


def _compute_adaptive_chunk_ratio(
    messages: List[Message],
    settings: CompactionSettings,
) -> float:
    """Reduce chunk ratio when average message size is large.

    Args:
        messages (List[Message]): Messages used to compute average size.
        settings (CompactionSettings): Compaction configuration providing
            base and minimum chunk ratios.

    Returns:
        float: Adjusted chunk ratio, reduced from ``base_chunk_ratio`` when
            average message tokens are large relative to the context window.
    """
    if not messages:
        return settings.base_chunk_ratio

    total = estimate_messages_tokens(messages)
    avg = total / len(messages)
    safe_avg = avg * settings.safety_margin
    avg_ratio = safe_avg / settings.context_window_tokens

    if avg_ratio > 0.1:
        reduction = min(avg_ratio * 2, settings.base_chunk_ratio - settings.min_chunk_ratio)
        return max(settings.min_chunk_ratio, settings.base_chunk_ratio - reduction)

    return settings.base_chunk_ratio


def _is_oversized_for_summary(msg: Message, settings: CompactionSettings) -> bool:
    """A single message > 50 % of context window cannot be summarized safely.

    Args:
        msg (Message): Message to check.
        settings (CompactionSettings): Compaction configuration providing
            context window size and safety margin.

    Returns:
        bool: ``True`` if the message is too large to be summarized safely.
    """
    tokens = estimate_tokens(msg.content) * settings.safety_margin
    return tokens > settings.context_window_tokens * 0.5


async def summarize_chunks(
    messages: List[Message],
    llm: BaseChatModel,
    max_chunk_tokens: int,
    previous_summary: Optional[str] = None,
) -> str:
    """Iteratively summarize message chunks.

    Args:
        messages (List[Message]): Messages to summarize.
        llm (BaseChatModel): Language model used to produce summaries.
        max_chunk_tokens (int): Maximum estimated tokens per chunk.
        previous_summary (Optional[str]): An existing summary to update
            incrementally. Defaults to ``None``.

    Returns:
        str: The final summary after iterating through all chunks.
    """
    if not messages:
        return previous_summary or DEFAULT_SUMMARY_FALLBACK

    chunks = _chunk_messages_by_max_tokens(messages, max_chunk_tokens)
    summary = previous_summary

    for chunk in chunks:
        summary = await _generate_summary(chunk, llm, summary)

    return summary or DEFAULT_SUMMARY_FALLBACK


async def summarize_with_fallback(
    messages: List[Message],
    llm: BaseChatModel,
    settings: CompactionSettings,
    max_chunk_tokens: int,
    previous_summary: Optional[str] = None,
) -> str:
    """Summarize with progressive fallback for oversized messages.

    1. Try full summarization.
    2. On failure, summarize only small messages and note oversized ones.
    3. On total failure, return a descriptive fallback.

    Args:
        messages (List[Message]): Messages to summarize.
        llm (BaseChatModel): Language model used to produce summaries.
        settings (CompactionSettings): Compaction configuration for oversized
            message detection.
        max_chunk_tokens (int): Maximum estimated tokens per chunk.
        previous_summary (Optional[str]): An existing summary to update
            incrementally. Defaults to ``None``.

    Returns:
        str: The best summary achievable given the input. Falls back to a
            partial summary or a descriptive error string when full
            summarization fails.
    """
    if not messages:
        return previous_summary or DEFAULT_SUMMARY_FALLBACK

    try:
        return await summarize_chunks(messages, llm, max_chunk_tokens, previous_summary)
    except Exception as e:
        logger.warning("Full summarization failed, trying partial: %s", e)

    small: List[Message] = []
    oversized_notes: List[str] = []

    for msg in messages:
        if _is_oversized_for_summary(msg, settings):
            tokens = estimate_tokens(msg.content)
            oversized_notes.append(
                f"[Large {msg.role} (~{tokens // 1000}K tokens) omitted from summary]"
            )
        else:
            small.append(msg)

    if small:
        try:
            partial = await summarize_chunks(small, llm, max_chunk_tokens, previous_summary)
            notes = "\n\n" + "\n".join(oversized_notes) if oversized_notes else ""
            return partial + notes
        except Exception as e:
            logger.warning("Partial summarization also failed: %s", e)

    return (
        f"Context contained {len(messages)} messages "
        f"({len(oversized_notes)} oversized). Summary unavailable due to size limits."
    )


async def summarize_in_stages(
    messages: List[Message],
    llm: BaseChatModel,
    settings: CompactionSettings,
    max_chunk_tokens: int,
    previous_summary: Optional[str] = None,
    parts: int = 2,
    min_messages_for_split: int = 4,
) -> str:
    """Multi-stage summarization: split -> summarize parts -> merge summaries.

    Args:
        messages (List[Message]): Messages to summarize.
        llm (BaseChatModel): Language model used to produce summaries.
        settings (CompactionSettings): Compaction configuration for chunk
            sizing and fallback behaviour.
        max_chunk_tokens (int): Maximum estimated tokens per chunk.
        previous_summary (Optional[str]): An existing summary to update
            incrementally. Defaults to ``None``.
        parts (int): Number of splits to divide messages into. Defaults to 2.
        min_messages_for_split (int): Minimum message count required before
            splitting is attempted. Defaults to 4.

    Returns:
        str: Merged summary produced from individually summarized parts, or
            a single-pass summary when splitting is unnecessary.
    """
    if not messages:
        return previous_summary or DEFAULT_SUMMARY_FALLBACK

    total = estimate_messages_tokens(messages)

    if parts <= 1 or len(messages) < min_messages_for_split or total <= max_chunk_tokens:
        return await summarize_with_fallback(
            messages,
            llm,
            settings,
            max_chunk_tokens,
            previous_summary,
        )

    splits = [s for s in _split_by_token_share(messages, parts) if s]
    if len(splits) <= 1:
        return await summarize_with_fallback(
            messages,
            llm,
            settings,
            max_chunk_tokens,
            previous_summary,
        )

    partial_summaries: List[str] = []
    for idx, chunk in enumerate(splits):
        chunk_prev = previous_summary if idx == 0 else None
        summary = await summarize_with_fallback(
            chunk,
            llm,
            settings,
            max_chunk_tokens,
            chunk_prev,
        )
        partial_summaries.append(summary)

    if len(partial_summaries) == 1:
        return partial_summaries[0]

    merge_messages = [Message(role=MessageRole.USER, content=s) for s in partial_summaries]
    return await summarize_with_fallback(
        merge_messages,
        llm,
        settings,
        max_chunk_tokens,
        COMPACTION_MERGE_INSTRUCTIONS,
    )


async def compact_history(
    messages: List[Message],
    llm: BaseChatModel,
    settings: CompactionSettings,
) -> List[Message]:
    """Compact conversation history by LLM summarization.

    - Detects a previous compaction summary and updates it incrementally.
    - Keeps the last *keep_last_assistants* turns intact.
    - Uses adaptive chunk sizing based on average message size.

    Args:
        messages (List[Message]): Full conversation message list to compact.
        llm (BaseChatModel): Language model used to produce summaries.
        settings (CompactionSettings): Compaction configuration controlling
            chunk sizing, safety margins, and tail retention.

    Returns:
        List[Message]: Compacted message list starting with a system summary
            message followed by the kept tail. Returns the original list
            unchanged if compaction is disabled, unnecessary, or fails.
    """
    if not settings.compaction_enabled or not messages:
        return messages

    previous_summary: Optional[str] = None
    compaction_idx: Optional[int] = None
    for i, msg in enumerate(messages):
        if msg.role == MessageRole.SYSTEM and msg.content.startswith(COMPACTION_PREFIX):
            previous_summary = msg.content[len(COMPACTION_PREFIX) :].strip()
            compaction_idx = i
            break

    start_idx = (compaction_idx + 1) if compaction_idx is not None else 0

    # Never summarize before the first user message — protects identity/system
    # messages that precede user interaction (OpenClaw pruner.ts:253-257).
    first_user_idx: Optional[int] = None
    for i, msg in enumerate(messages):
        if msg.role == MessageRole.USER:
            first_user_idx = i
            break
    if first_user_idx is not None and first_user_idx > start_idx:
        start_idx = first_user_idx

    # Compute kept-tail cutoff FIRST so we only summarize messages that will
    # be removed (avoids duplicating tail in both summary and output).
    keep = settings.keep_last_assistants
    assistant_indices = [i for i, m in enumerate(messages) if m.role == MessageRole.ASSISTANT]
    if len(assistant_indices) > keep:
        cutoff = assistant_indices[-keep]
    else:
        cutoff = max(0, len(messages) - keep)
    cutoff = max(cutoff, start_idx)

    # Ensure cutoff doesn't split an assistant's tool_calls from their
    # tool_results — walk back to keep the pair together.
    while cutoff > start_idx and cutoff < len(messages):
        prev = messages[cutoff - 1] if cutoff > 0 else None
        if prev and prev.role == MessageRole.ASSISTANT and prev.tool_calls:
            # The assistant at cutoff-1 has tool_calls — its tool_results
            # follow.  Move cutoff back to include it in the kept tail.
            cutoff = cutoff - 1
            break
        # If cutoff lands on a tool message, walk back to include the
        # preceding assistant with its tool_calls.
        if messages[cutoff].role == MessageRole.TOOL:
            cutoff = cutoff - 1
            continue
        break

    to_summarize = messages[start_idx:cutoff]

    if not to_summarize:
        return messages

    chunk_ratio = _compute_adaptive_chunk_ratio(to_summarize, settings)
    max_chunk_tokens = int(settings.context_window_tokens * chunk_ratio)

    try:
        summary_text = await summarize_in_stages(
            to_summarize,
            llm,
            settings,
            max_chunk_tokens,
            previous_summary,
        )

        kept_tail = messages[cutoff:]

        report = repair_tool_use_result_pairing(kept_tail)
        kept_tail = report.messages
        if report.dropped_orphan_count:
            logger.info(
                "Dropped %d orphaned tool_result(s) after compaction",
                report.dropped_orphan_count,
            )

        compacted = [
            Message(role=MessageRole.SYSTEM, content=f"{COMPACTION_PREFIX}\n{summary_text}"),
        ] + kept_tail

        logger.info(
            "Compacted %d messages -> %d (summary: %d tokens)",
            len(messages),
            len(compacted),
            estimate_tokens(summary_text),
        )
        return compacted

    except Exception as e:
        logger.error("Compaction failed: %s", e)
        return messages
