# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for the compaction module — truncation, pruning, repair, and summarization."""

from typing import List, Optional
from unittest.mock import AsyncMock, MagicMock

import pytest
from app.models import Message
from app.schemas.open_responses import MessageRole
from app.services.compaction.pruning import (
    _find_assistant_cutoff_index,
    _find_first_user_index,
    _is_tool_prunable,
    _soft_trim_content,
    prune_context_messages,
)
from app.services.compaction.repair import repair_tool_use_result_pairing
from app.services.compaction.settings import CompactionSettings, HardClearConfig, ToolPruningConfig
from app.services.compaction.tokens import estimate_context_chars, estimate_message_chars
from app.services.compaction.summarizer import (
    _chunk_messages_by_max_tokens,
    _compute_adaptive_chunk_ratio,
    _messages_to_text,
    _split_by_token_share,
    compact_history,
    summarize_chunks,
    summarize_in_stages,
    summarize_with_fallback,
)
from app.services.compaction.truncation import (
    calculate_max_tool_result_chars,
    has_oversized_tool_results,
    truncate_oversized_tool_results,
    truncate_tool_result_text,
)
from app.services.prompts.compaction import COMPACTION_PREFIX

# ---------------------------------------------------------------------------
# Common helpers
# ---------------------------------------------------------------------------


def _msg(role: MessageRole, content: str = "x" * 100) -> Message:
    """Create a test Message with the given role and content."""
    return Message(role=role, content=content)


def _mock_llm(response_text: str = "Summary of conversation.") -> AsyncMock:
    """Create a mock async LLM that returns the given response text."""
    llm = AsyncMock()
    result = MagicMock()
    result.content = response_text
    llm.ainvoke.return_value = result
    return llm


# ===========================================================================
# Layer 1 — Tool result truncation
# ===========================================================================

# ---------------------------------------------------------------------------
# calculate_max_tool_result_chars
# ---------------------------------------------------------------------------


class TestCalculateMaxToolResultChars:
    """Tests for calculate_max_tool_result_chars threshold computation."""

    def test_default_settings(self):
        """Verify the default settings produce the expected character limit."""
        s = CompactionSettings()
        # 128_000 * 0.3 * 4 = 153_600
        assert calculate_max_tool_result_chars(s) == 153_600

    def test_hard_cap(self):
        """Verify the hard cap limits the character count."""
        s = CompactionSettings(
            context_window_tokens=1_000_000,
            max_tool_result_context_share=0.5,
        )
        # 1_000_000 * 0.5 * 4 = 2_000_000 → capped at 400_000
        assert calculate_max_tool_result_chars(s) == 400_000

    def test_zero_window(self):
        """Verify a zero context window yields a zero character limit."""
        s = CompactionSettings(context_window_tokens=0)
        assert calculate_max_tool_result_chars(s) == 0

    def test_small_window(self):
        """Verify a small window produces a proportionally small character limit."""
        s = CompactionSettings(context_window_tokens=100)
        # 100 * 0.3 * 4 = 120
        assert calculate_max_tool_result_chars(s) == 120


# ---------------------------------------------------------------------------
# truncate_tool_result_text
# ---------------------------------------------------------------------------


class TestTruncateToolResultText:
    """Tests for truncate_tool_result_text string truncation."""

    def test_short_text_unchanged(self):
        """Verify text within the limit is returned unchanged."""
        text = "hello world"
        assert truncate_tool_result_text(text, 100) == text

    def test_exact_limit_unchanged(self):
        """Verify text exactly at the limit is returned unchanged."""
        text = "x" * 100
        assert truncate_tool_result_text(text, 100) == text

    def test_truncation_with_suffix(self):
        """Verify truncation appends the specified suffix."""
        text = "x" * 10_000
        result = truncate_tool_result_text(text, 5_000, suffix="[truncated]")
        assert result.endswith("[truncated]")

    def test_newline_boundary(self):
        """Verify truncation snaps to the nearest newline boundary."""
        # Place newline at ~90% of keep region
        text = "A" * 4_500 + "\n" + "B" * 5_500
        result = truncate_tool_result_text(text, 5_000, suffix="")
        # Should cut at the newline (4500) since 4500 > 5000 * 0.8 = 4000
        assert len(result) == 4_500

    def test_no_newline_cuts_at_keep_chars(self):
        """Verify truncation cuts at keep_chars when no newline is found."""
        text = "x" * 10_000  # no newlines
        result = truncate_tool_result_text(text, 5_000, suffix="")
        assert len(result) == 5_000

    def test_min_keep_chars_floor(self):
        """Verify min_keep_chars overrides max_chars as a floor."""
        text = "x" * 10_000
        result = truncate_tool_result_text(
            text,
            500,
            min_keep_chars=2_000,
            suffix="",
        )
        # min_keep_chars overrides max_chars
        assert len(result) == 2_000

    def test_empty_text(self):
        """Verify empty text is returned as-is."""
        assert truncate_tool_result_text("", 100) == ""


# ---------------------------------------------------------------------------
# truncate_oversized_tool_results
# ---------------------------------------------------------------------------


class TestTruncateOversizedToolResults:
    """Tests for truncate_oversized_tool_results message-list processing."""

    def _settings(self, window=1_000):
        """Build a CompactionSettings with the given context window size."""
        return CompactionSettings(context_window_tokens=window)

    def test_no_tool_messages(self):
        """Verify non-tool messages are left untouched."""
        msgs = [
            Message(role=MessageRole.USER, content="x" * 100_000),
            Message(role=MessageRole.ASSISTANT, content="y" * 100_000),
        ]
        result, count = truncate_oversized_tool_results(msgs, self._settings())
        assert count == 0
        assert len(result) == 2

    def test_tool_within_limit(self):
        """Verify tool results within the limit are not truncated."""
        s = self._settings(window=200_000)
        msgs = [Message(role=MessageRole.TOOL, content="small")]
        result, count = truncate_oversized_tool_results(msgs, s)
        assert count == 0
        assert result[0].content == "small"

    def test_tool_truncated(self):
        """Verify oversized tool results are truncated."""
        s = self._settings(window=1_000)
        # max_chars = 1000 * 0.3 * 4 = 1200
        msgs = [Message(role=MessageRole.TOOL, content="x" * 50_000)]
        result, count = truncate_oversized_tool_results(msgs, s)
        assert count == 1
        assert len(result[0].content) < 50_000

    def test_multiple_tools_mixed(self):
        """Verify only oversized tool results are truncated in a mixed list."""
        s = self._settings(window=1_000)
        msgs = [
            Message(role=MessageRole.USER, content="q"),
            Message(role=MessageRole.TOOL, content="A" * 50_000),
            Message(role=MessageRole.TOOL, content="small"),
            Message(role=MessageRole.ASSISTANT, content="a"),
        ]
        result, count = truncate_oversized_tool_results(msgs, s)
        assert count == 1
        assert result[2].content == "small"

    def test_original_not_mutated(self):
        """Verify the original message objects are not mutated."""
        s = self._settings(window=1_000)
        original = Message(role=MessageRole.TOOL, content="x" * 50_000)
        msgs = [original]
        truncate_oversized_tool_results(msgs, s)
        assert len(original.content) == 50_000


# ---------------------------------------------------------------------------
# has_oversized_tool_results
# ---------------------------------------------------------------------------


class TestHasOversizedToolResults:
    """Tests for has_oversized_tool_results detection predicate."""

    def test_no_oversized(self):
        """Verify False is returned when no tool results exceed the limit."""
        s = CompactionSettings()
        msgs = [Message(role=MessageRole.TOOL, content="short")]
        assert has_oversized_tool_results(msgs, s) is False

    def test_has_oversized(self):
        """Verify True is returned when a tool result exceeds the limit."""
        s = CompactionSettings(context_window_tokens=100)
        msgs = [Message(role=MessageRole.TOOL, content="x" * 50_000)]
        assert has_oversized_tool_results(msgs, s) is True

    def test_ignores_non_tool(self):
        """Verify non-tool messages are ignored even if they are large."""
        s = CompactionSettings(context_window_tokens=100)
        msgs = [Message(role=MessageRole.USER, content="x" * 50_000)]
        assert has_oversized_tool_results(msgs, s) is False

    def test_empty(self):
        """Verify False is returned for an empty message list."""
        s = CompactionSettings()
        assert has_oversized_tool_results([], s) is False


# ===========================================================================
# Layer 2 — Context pruning
# ===========================================================================

# ---------------------------------------------------------------------------
# _find_assistant_cutoff_index
# ---------------------------------------------------------------------------


class TestFindAssistantCutoffIndex:
    """Tests for _find_assistant_cutoff_index boundary calculations."""

    def test_finds_nth_from_last(self):
        """Verify the nth assistant message from the end is found correctly."""
        msgs = [_msg(MessageRole.USER), _msg(MessageRole.ASSISTANT), _msg(MessageRole.USER), _msg(MessageRole.ASSISTANT)]
        assert _find_assistant_cutoff_index(msgs, 1) == 3
        assert _find_assistant_cutoff_index(msgs, 2) == 1

    def test_fewer_than_n_returns_zero(self):
        """Verify index 0 is returned when fewer than n assistants exist."""
        msgs = [_msg(MessageRole.USER), _msg(MessageRole.ASSISTANT)]
        assert _find_assistant_cutoff_index(msgs, 5) == 0

    def test_no_assistants_returns_zero(self):
        """Verify index 0 is returned when no assistant messages exist."""
        msgs = [_msg(MessageRole.USER), _msg(MessageRole.TOOL), _msg(MessageRole.SYSTEM)]
        assert _find_assistant_cutoff_index(msgs, 3) == 0

    def test_keep_zero_returns_len(self):
        """Verify keeping zero assistants returns len(msgs)."""
        msgs = [_msg(MessageRole.USER), _msg(MessageRole.ASSISTANT)]
        assert _find_assistant_cutoff_index(msgs, 0) == len(msgs)

    def test_keep_negative_returns_len(self):
        """Verify a negative keep value returns len(msgs)."""
        msgs = [_msg(MessageRole.ASSISTANT)]
        assert _find_assistant_cutoff_index(msgs, -1) == len(msgs)

    def test_empty(self):
        """Verify an empty list returns index 0."""
        assert _find_assistant_cutoff_index([], 3) == 0


# ---------------------------------------------------------------------------
# _find_first_user_index
# ---------------------------------------------------------------------------


class TestFindFirstUserIndex:
    """Tests for _find_first_user_index lookup in message lists."""

    def test_finds_first_user(self):
        """Verify the first user message index is returned correctly."""
        msgs = [_msg(MessageRole.SYSTEM), _msg(MessageRole.SYSTEM), _msg(MessageRole.USER), _msg(MessageRole.USER)]
        assert _find_first_user_index(msgs) == 2

    def test_user_at_start(self):
        """Verify index 0 is returned when user message is first."""
        msgs = [_msg(MessageRole.USER), _msg(MessageRole.ASSISTANT)]
        assert _find_first_user_index(msgs) == 0

    def test_no_user(self):
        """Verify None is returned when no user messages exist."""
        msgs = [_msg(MessageRole.SYSTEM), _msg(MessageRole.ASSISTANT)]
        assert _find_first_user_index(msgs) is None

    def test_empty(self):
        """Verify None is returned for an empty list."""
        assert _find_first_user_index([]) is None


# ---------------------------------------------------------------------------
# _soft_trim_content
# ---------------------------------------------------------------------------


class TestSoftTrimContent:
    """Tests for _soft_trim_content head/tail preservation."""

    def test_keeps_head_and_tail(self):
        """Verify head and tail characters are preserved with ellipsis in between."""
        text = "AAAA" + "B" * 100 + "CCCC"
        result = _soft_trim_content(text, head_chars=4, tail_chars=4)
        assert result.startswith("AAAA")
        assert "CCCC" in result
        assert "..." in result

    def test_zero_tail(self):
        """Verify zero tail_chars still trims correctly."""
        text = "x" * 100
        result = _soft_trim_content(text, head_chars=10, tail_chars=0)
        assert result.startswith("x" * 10)
        assert "last 0 chars" in result


# ---------------------------------------------------------------------------
# prune_context_messages — integration
# ---------------------------------------------------------------------------


class TestPruneContextMessages:
    """Tests for the prune_context_messages integration pipeline."""

    def _settings(self, **kw):
        """Build a CompactionSettings with sensible test defaults."""
        defaults = dict(
            context_window_tokens=500,  # 2000 chars
            keep_last_assistants=1,
            soft_trim_ratio=0.3,
            hard_clear_ratio=0.5,
            min_prunable_tool_chars=0,
        )
        defaults.update(kw)
        return CompactionSettings(**defaults)

    # -- basic ---

    def test_empty_messages(self):
        """Verify empty input returns an empty list."""
        assert prune_context_messages([], self._settings()) == []

    def test_below_ratio_unchanged(self):
        """Verify messages below the pruning ratio threshold are returned unchanged."""
        s = CompactionSettings()
        msgs = [_msg(MessageRole.USER, "x" * 10), _msg(MessageRole.TOOL, "x" * 100), _msg(MessageRole.ASSISTANT, "x" * 10)]
        assert prune_context_messages(msgs, s) is msgs

    def test_zero_window_unchanged(self):
        """Verify a zero context window disables pruning."""
        s = CompactionSettings(context_window_tokens=0)
        msgs = [_msg(MessageRole.TOOL, "x" * 10_000)]
        assert prune_context_messages(msgs, s) is msgs

    # -- soft trim ---

    def test_soft_trim_triggers(self):
        """Verify soft trimming reduces oversized tool result content."""
        s = self._settings()
        msgs = [
            Message(role=MessageRole.USER, content="hi"),
            Message(role=MessageRole.TOOL, content="T" * 10_000),
            Message(role=MessageRole.ASSISTANT, content="r1"),
            Message(role=MessageRole.USER, content="q2"),
            Message(role=MessageRole.ASSISTANT, content="r2"),
        ]
        result = prune_context_messages(msgs, s)
        assert len(result[1].content) < 10_000

    # -- hard clear ---

    def test_hard_clear_triggers(self):
        """Verify hard clear replaces extremely large tool results with a cleared marker."""
        s = self._settings(hard_clear_ratio=0.3)
        msgs = [
            Message(role=MessageRole.USER, content="hi"),
            Message(role=MessageRole.TOOL, content="T" * 100_000),
            Message(role=MessageRole.ASSISTANT, content="r1"),
            Message(role=MessageRole.USER, content="q2"),
            Message(role=MessageRole.ASSISTANT, content="r2"),
        ]
        result = prune_context_messages(msgs, s)
        assert "cleared" in result[1].content.lower()

    def test_hard_clear_disabled(self):
        """Verify hard clear is skipped when disabled in configuration."""
        s = self._settings(
            hard_clear=HardClearConfig(enabled=False),
            hard_clear_ratio=0.3,
        )
        msgs = [
            Message(role=MessageRole.USER, content="hi"),
            Message(role=MessageRole.TOOL, content="T" * 100_000),
            Message(role=MessageRole.ASSISTANT, content="r1"),
            Message(role=MessageRole.USER, content="q2"),
            Message(role=MessageRole.ASSISTANT, content="r2"),
        ]
        result = prune_context_messages(msgs, s)
        assert "cleared" not in result[1].content.lower()

    # -- protected regions ---

    def test_recent_assistants_protected(self):
        """Verify tool results near recent assistant messages are protected from pruning."""
        s = self._settings(keep_last_assistants=2)
        msgs = [
            Message(role=MessageRole.USER, content="q1"),
            Message(role=MessageRole.TOOL, content="T" * 10_000),
            Message(role=MessageRole.ASSISTANT, content="a1"),
            Message(role=MessageRole.TOOL, content="T" * 10_000),
            Message(role=MessageRole.ASSISTANT, content="a2"),
            Message(role=MessageRole.TOOL, content="T" * 10_000),
            Message(role=MessageRole.ASSISTANT, content="a3"),
        ]
        result = prune_context_messages(msgs, s)
        assert len(result[1].content) < 10_000  # pruned
        assert len(result[5].content) == 10_000  # protected

    def test_bootstrap_messages_protected(self):
        """Verify system bootstrap messages are never pruned."""
        s = self._settings()
        msgs = [
            Message(role=MessageRole.SYSTEM, content="identity" * 500),
            Message(role=MessageRole.SYSTEM, content="config" * 500),
            Message(role=MessageRole.USER, content="hi"),
            Message(role=MessageRole.TOOL, content="T" * 10_000),
            Message(role=MessageRole.ASSISTANT, content="done"),
        ]
        result = prune_context_messages(msgs, s)
        assert result[0].content == msgs[0].content
        assert result[1].content == msgs[1].content

    # -- edge cases ---

    def test_no_user_messages(self):
        """Verify pruning works correctly when no user messages are present."""
        s = self._settings(keep_last_assistants=1)
        msgs = [
            Message(role=MessageRole.TOOL, content="T" * 10_000),
            Message(role=MessageRole.ASSISTANT, content="a1"),
            Message(role=MessageRole.TOOL, content="T" * 10_000),
            Message(role=MessageRole.ASSISTANT, content="a2"),
        ]
        result = prune_context_messages(msgs, s)
        assert len(result[0].content) < 10_000

    def test_no_tool_messages(self):
        """Verify non-tool messages are left unchanged when no tools exist."""
        s = self._settings()
        msgs = [
            Message(role=MessageRole.USER, content="q" * 5_000),
            Message(role=MessageRole.ASSISTANT, content="a" * 5_000),
        ]
        result = prune_context_messages(msgs, s)
        assert result[0].content == msgs[0].content

    def test_only_system_messages(self):
        """Verify system-only messages are not pruned."""
        s = self._settings()
        msgs = [_msg(MessageRole.SYSTEM, "x" * 10_000), _msg(MessageRole.SYSTEM, "x" * 10_000)]
        result = prune_context_messages(msgs, s)
        assert result[0].content == msgs[0].content

    def test_fewer_assistants_than_keep(self):
        """Verify all messages are protected when keep exceeds actual assistant count."""
        s = self._settings(keep_last_assistants=10)
        msgs = [
            Message(role=MessageRole.USER, content="hi"),
            Message(role=MessageRole.TOOL, content="T" * 10_000),
            Message(role=MessageRole.ASSISTANT, content="only one"),
        ]
        result = prune_context_messages(msgs, s)
        assert result[1].content == msgs[1].content

    def test_original_list_not_mutated(self):
        """Verify the original message list is not mutated by pruning."""
        s = self._settings()
        original_tool = Message(role=MessageRole.TOOL, content="T" * 10_000)
        msgs = [
            Message(role=MessageRole.USER, content="hi"),
            original_tool,
            Message(role=MessageRole.ASSISTANT, content="a1"),
            Message(role=MessageRole.USER, content="q2"),
            Message(role=MessageRole.ASSISTANT, content="a2"),
        ]
        original_len = len(msgs)
        prune_context_messages(msgs, s)
        assert len(msgs) == original_len
        assert msgs[1] is original_tool


# ===========================================================================
# Repair — Orphaned tool_result repair
# ===========================================================================

# ---------------------------------------------------------------------------
# No-op when Message lacks fields
# ---------------------------------------------------------------------------


class TestRepairNoOp:
    """Tests for repair_tool_use_result_pairing when no repair is needed."""

    def test_plain_messages_unchanged(self):
        """Verify plain messages without tool_call fields are returned unchanged."""
        msgs = [
            Message(role=MessageRole.ASSISTANT, content="hello"),
            Message(role=MessageRole.TOOL, content="result"),
            Message(role=MessageRole.ASSISTANT, content="done"),
        ]
        report = repair_tool_use_result_pairing(msgs)
        assert report.dropped_orphan_count == 0
        assert report.messages is msgs

    def test_empty_messages(self):
        """Verify an empty list returns zero drops and an empty list."""
        report = repair_tool_use_result_pairing([])
        assert report.dropped_orphan_count == 0
        assert report.messages == []


# ---------------------------------------------------------------------------
# Active repair with extended Message
# ---------------------------------------------------------------------------


class TestRepairActive:
    """Tests for active orphan detection and repair with extended Messages."""

    def test_drops_orphaned_tool_result(self):
        """Verify orphaned tool results with unmatched call IDs are dropped."""
        msgs = [
            Message(
                role=MessageRole.ASSISTANT,
                content="use tool",
                tool_calls=[{"id": "call_1"}, {"id": "call_2"}],
            ),
            Message(role=MessageRole.TOOL, content="result 1", tool_call_id="call_1"),
            Message(role=MessageRole.TOOL, content="result 2", tool_call_id="call_2"),
            Message(role=MessageRole.TOOL, content="orphan", tool_call_id="call_GONE"),
        ]
        report = repair_tool_use_result_pairing(msgs)
        assert report.dropped_orphan_count == 1
        assert len(report.messages) == 3

    def test_keeps_all_matched(self):
        """Verify all messages are kept when every tool result has a matching call."""
        msgs = [
            Message(
                role=MessageRole.ASSISTANT,
                content="use tool",
                tool_calls=[{"id": "call_A"}],
            ),
            Message(role=MessageRole.TOOL, content="result", tool_call_id="call_A"),
        ]
        report = repair_tool_use_result_pairing(msgs)
        assert report.dropped_orphan_count == 0
        assert len(report.messages) == 2

    def test_keeps_tool_without_id(self):
        """Verify tool results without a tool_call_id are preserved."""
        msgs = [
            Message(
                role=MessageRole.ASSISTANT,
                content="use",
                tool_calls=[{"id": "call_X"}],
            ),
            Message(role=MessageRole.TOOL, content="legacy result"),
            Message(role=MessageRole.TOOL, content="matched", tool_call_id="call_X"),
        ]
        report = repair_tool_use_result_pairing(msgs)
        assert report.dropped_orphan_count == 0
        assert len(report.messages) == 3

    def test_multiple_orphans(self):
        """Verify multiple orphaned tool results are all dropped."""
        msgs = [
            Message(
                role=MessageRole.ASSISTANT,
                content="use",
                tool_calls=[{"id": "call_1"}],
            ),
            Message(role=MessageRole.TOOL, content="ok", tool_call_id="call_1"),
            Message(role=MessageRole.TOOL, content="orphan1", tool_call_id="call_99"),
            Message(role=MessageRole.TOOL, content="orphan2", tool_call_id="call_100"),
        ]
        report = repair_tool_use_result_pairing(msgs)
        assert report.dropped_orphan_count == 2
        assert len(report.messages) == 2

    def test_preserves_non_tool_messages(self):
        """Verify user and system messages are preserved even when orphans are dropped."""
        msgs = [
            Message(
                role=MessageRole.ASSISTANT,
                content="thinking",
                tool_calls=[{"id": "call_1"}],
            ),
            Message(role=MessageRole.TOOL, content="orphan", tool_call_id="call_DROPPED"),
            Message(role=MessageRole.USER, content="continue"),
            Message(role=MessageRole.SYSTEM, content="note"),
        ]
        report = repair_tool_use_result_pairing(msgs)
        assert report.dropped_orphan_count == 1
        assert len(report.messages) == 3
        roles = [m.role for m in report.messages]
        assert MessageRole.USER in roles
        assert MessageRole.SYSTEM in roles

    def test_multiple_assistants_collect_all_ids(self):
        """Verify tool call IDs are collected across multiple assistant messages."""
        msgs = [
            Message(
                role=MessageRole.ASSISTANT,
                content="first",
                tool_calls=[{"id": "call_A"}],
            ),
            Message(role=MessageRole.TOOL, content="r1", tool_call_id="call_A"),
            Message(
                role=MessageRole.ASSISTANT,
                content="second",
                tool_calls=[{"id": "call_B"}],
            ),
            Message(role=MessageRole.TOOL, content="r2", tool_call_id="call_B"),
        ]
        report = repair_tool_use_result_pairing(msgs)
        assert report.dropped_orphan_count == 0

    def test_assistant_with_empty_tool_calls(self):
        """Empty tool_calls means the tool_result is orphaned and should be dropped."""
        msgs = [
            Message(role=MessageRole.ASSISTANT, content="no tools", tool_calls=[]),
            Message(role=MessageRole.TOOL, content="orphan", tool_call_id="call_X"),
        ]
        report = repair_tool_use_result_pairing(msgs)
        # No matching tool_use for call_X → orphan is dropped
        assert report.dropped_orphan_count == 1


# ===========================================================================
# Layer 3 — LLM compaction (summarizer)
# ===========================================================================

# ---------------------------------------------------------------------------
# Pure helpers
# ---------------------------------------------------------------------------


class TestMessagesToText:
    """Tests for _messages_to_text formatting utility."""

    def test_formats_messages(self):
        """Verify messages are formatted as [Role]: content with double newlines."""
        msgs = [_msg(MessageRole.USER, "hello"), _msg(MessageRole.ASSISTANT, "world")]
        text = _messages_to_text(msgs)
        assert "[User]: hello" in text
        assert "[Assistant]: world" in text
        assert "\n\n" in text

    def test_truncates_long_content(self):
        """Verify long message content is truncated at the per-message limit."""
        msgs = [_msg(MessageRole.USER, "A" * 5_000)]
        text = _messages_to_text(msgs, max_chars_per_message=100)
        assert len(text) < 200

    def test_empty(self):
        """Verify empty input returns an empty string."""
        assert _messages_to_text([]) == ""


class TestChunkMessagesByMaxTokens:
    """Tests for _chunk_messages_by_max_tokens splitting logic."""

    def test_single_chunk(self):
        """Verify small messages fit into a single chunk."""
        msgs = [_msg(MessageRole.USER, "x" * 40) for _ in range(3)]
        chunks = _chunk_messages_by_max_tokens(msgs, max_tokens=1_000)
        assert len(chunks) == 1

    def test_splits_at_budget(self):
        """Verify messages are split into multiple chunks at the token budget."""
        msgs = [_msg(MessageRole.USER, "x" * 1_000) for _ in range(10)]
        chunks = _chunk_messages_by_max_tokens(msgs, max_tokens=300)
        assert len(chunks) > 1

    def test_oversized_single_message(self):
        """Verify a single oversized message stays in one chunk."""
        msgs = [_msg(MessageRole.USER, "x" * 10_000)]
        chunks = _chunk_messages_by_max_tokens(msgs, max_tokens=100)
        assert len(chunks) == 1

    def test_empty(self):
        """Verify empty input returns an empty list."""
        assert _chunk_messages_by_max_tokens([], 100) == []


class TestSplitByTokenShare:
    """Tests for _split_by_token_share proportional splitting."""

    def test_splits_into_parts(self):
        """Verify messages are split into the requested number of parts."""
        msgs = [_msg(MessageRole.USER, "x" * 400) for _ in range(10)]
        splits = _split_by_token_share(msgs, parts=3)
        assert len(splits) == 3
        total = sum(len(s) for s in splits)
        assert total == 10

    def test_single_part(self):
        """Verify requesting one part returns all messages in a single split."""
        msgs = [_msg(MessageRole.USER)]
        splits = _split_by_token_share(msgs, parts=1)
        assert len(splits) == 1

    def test_more_parts_than_messages(self):
        """Verify requesting more parts than messages caps at message count."""
        msgs = [_msg(MessageRole.USER), _msg(MessageRole.USER)]
        splits = _split_by_token_share(msgs, parts=10)
        assert len(splits) == 2

    def test_empty(self):
        """Verify empty input returns an empty list."""
        assert _split_by_token_share([], parts=3) == []


class TestComputeAdaptiveChunkRatio:
    """Tests for _compute_adaptive_chunk_ratio scaling behavior."""

    def test_default_for_small(self):
        """Verify the base chunk ratio is used for small inputs."""
        s = CompactionSettings()
        msgs = [_msg(MessageRole.USER, "short") for _ in range(10)]
        assert _compute_adaptive_chunk_ratio(msgs, s) == s.base_chunk_ratio

    def test_reduces_for_large(self):
        """Verify the chunk ratio is reduced for large inputs."""
        s = CompactionSettings(context_window_tokens=1_000)
        msgs = [_msg(MessageRole.USER, "x" * 10_000) for _ in range(5)]
        ratio = _compute_adaptive_chunk_ratio(msgs, s)
        assert ratio < s.base_chunk_ratio
        assert ratio >= s.min_chunk_ratio

    def test_empty(self):
        """Verify empty input returns the base chunk ratio."""
        s = CompactionSettings()
        assert _compute_adaptive_chunk_ratio([], s) == s.base_chunk_ratio


# ---------------------------------------------------------------------------
# summarize_chunks
# ---------------------------------------------------------------------------


class TestSummarizeChunks:
    """Tests for summarize_chunks iterative chunk summarization."""

    @pytest.mark.asyncio
    async def test_basic(self):
        """Verify basic chunk summarization returns the LLM response."""
        llm = _mock_llm("chunk summary")
        result = await summarize_chunks([_msg(MessageRole.USER, "hello")], llm, 10_000)
        assert result == "chunk summary"

    @pytest.mark.asyncio
    async def test_empty_returns_fallback(self):
        """Verify empty input returns the fallback message."""
        result = await summarize_chunks([], _mock_llm(), 10_000)
        assert result == "No prior history."

    @pytest.mark.asyncio
    async def test_previous_summary_in_prompt(self):
        """Verify previous summary is included in the summarization prompt."""
        llm = _mock_llm("updated")
        await summarize_chunks(
            [_msg(MessageRole.USER)],
            llm,
            10_000,
            previous_summary="old summary",
        )
        prompt_text = llm.ainvoke.call_args[0][0][1].content
        assert "old summary" in prompt_text

    @pytest.mark.asyncio
    async def test_multiple_chunks(self):
        """Verify multiple chunks result in multiple LLM invocations."""
        llm = _mock_llm("iterative")
        msgs = [_msg(MessageRole.USER, "x" * 1_000) for _ in range(5)]
        await summarize_chunks(msgs, llm, 300)
        assert llm.ainvoke.call_count > 1


# ---------------------------------------------------------------------------
# summarize_with_fallback
# ---------------------------------------------------------------------------


class TestSummarizeWithFallback:
    """Tests for summarize_with_fallback error recovery."""

    @pytest.mark.asyncio
    async def test_success(self):
        """Verify successful summarization returns the LLM result."""
        result = await summarize_with_fallback(
            [_msg(MessageRole.USER)],
            _mock_llm("ok"),
            CompactionSettings(),
            10_000,
        )
        assert result == "ok"

    @pytest.mark.asyncio
    async def test_fallback_on_error(self):
        """Verify a descriptive fallback is returned when the LLM fails."""
        llm = AsyncMock()
        llm.ainvoke.side_effect = Exception("LLM error")
        result = await summarize_with_fallback(
            [_msg(MessageRole.USER, "x" * 100)],
            llm,
            CompactionSettings(),
            10_000,
        )
        assert "unavailable" in result.lower() or "1 messages" in result

    @pytest.mark.asyncio
    async def test_empty_returns_previous(self):
        """Verify empty input returns the previous summary as-is."""
        result = await summarize_with_fallback(
            [],
            _mock_llm(),
            CompactionSettings(),
            10_000,
            previous_summary="prev",
        )
        assert result == "prev"

    @pytest.mark.asyncio
    async def test_partial_with_oversized(self):
        """Verify partial summarization with oversized messages omits the large ones."""
        call_count = 0

        async def side_effect(msgs):
            nonlocal call_count
            call_count += 1
            if call_count == 1:
                raise Exception("too big")
            result = MagicMock()
            result.content = "partial summary"
            return result

        llm = AsyncMock()
        llm.ainvoke.side_effect = side_effect

        s = CompactionSettings(context_window_tokens=100)
        msgs = [_msg(MessageRole.USER, "small"), _msg(MessageRole.TOOL, "x" * 100_000)]
        result = await summarize_with_fallback(msgs, llm, s, 10_000)
        assert "partial summary" in result
        assert "omitted" in result.lower()


# ---------------------------------------------------------------------------
# summarize_in_stages
# ---------------------------------------------------------------------------


class TestSummarizeInStages:
    """Tests for summarize_in_stages multi-stage summarization."""

    @pytest.mark.asyncio
    async def test_small_input_no_split(self):
        """Verify small input is summarized in a single stage without splitting."""
        result = await summarize_in_stages(
            [_msg(MessageRole.USER, "hello")],
            _mock_llm("direct"),
            CompactionSettings(),
            100_000,
        )
        assert result == "direct"

    @pytest.mark.asyncio
    async def test_multi_stage(self):
        """Verify large input is split and summarized in multiple stages."""
        llm = _mock_llm("merged")
        s = CompactionSettings(context_window_tokens=500)
        msgs = [_msg(MessageRole.USER, "x" * 2_000) for _ in range(10)]
        result = await summarize_in_stages(
            msgs,
            llm,
            s,
            300,
            parts=2,
            min_messages_for_split=2,
        )
        assert result == "merged"
        assert llm.ainvoke.call_count >= 3

    @pytest.mark.asyncio
    async def test_empty(self):
        """Verify empty input returns the fallback message."""
        result = await summarize_in_stages(
            [],
            _mock_llm(),
            CompactionSettings(),
            10_000,
        )
        assert result == "No prior history."


# ---------------------------------------------------------------------------
# compact_history
# ---------------------------------------------------------------------------


class TestCompactHistory:
    """Tests for compact_history end-to-end compaction pipeline."""

    @pytest.mark.asyncio
    async def test_basic_compaction(self):
        """Verify basic compaction produces a system summary and reduces message count."""
        llm = _mock_llm("compacted summary")
        s = CompactionSettings(context_window_tokens=500, keep_last_assistants=1)
        msgs = [
            _msg(MessageRole.USER, "q1"),
            _msg(MessageRole.ASSISTANT, "a1"),
            _msg(MessageRole.USER, "q2"),
            _msg(MessageRole.ASSISTANT, "a2"),
            _msg(MessageRole.USER, "q3"),
            _msg(MessageRole.ASSISTANT, "a3"),
        ]
        result = await compact_history(msgs, llm, s)
        assert result[0].role == MessageRole.SYSTEM
        assert result[0].content.startswith(COMPACTION_PREFIX)
        assert len(result) < len(msgs)

    @pytest.mark.asyncio
    async def test_disabled(self):
        """Verify compaction returns original messages when disabled."""
        s = CompactionSettings(compaction_enabled=False)
        msgs = [_msg(MessageRole.USER), _msg(MessageRole.ASSISTANT)]
        result = await compact_history(msgs, _mock_llm(), s)
        assert result is msgs

    @pytest.mark.asyncio
    async def test_empty(self):
        """Verify empty input returns an empty list."""
        result = await compact_history([], _mock_llm(), CompactionSettings())
        assert result == []

    @pytest.mark.asyncio
    async def test_detects_previous_summary(self):
        """Verify the previous compaction summary is detected and forwarded to the LLM."""
        llm = _mock_llm("updated summary")
        s = CompactionSettings(context_window_tokens=500, keep_last_assistants=1)
        msgs = [
            Message(role=MessageRole.SYSTEM, content=f"{COMPACTION_PREFIX}\nold summary"),
            _msg(MessageRole.USER, "q1"),
            _msg(MessageRole.ASSISTANT, "a1"),
            _msg(MessageRole.USER, "q2"),
            _msg(MessageRole.ASSISTANT, "a2"),
        ]
        result = await compact_history(msgs, llm, s)
        assert result[0].content.startswith(COMPACTION_PREFIX)
        prompt_text = llm.ainvoke.call_args[0][0][1].content
        assert "old summary" in prompt_text

    @pytest.mark.asyncio
    async def test_tail_not_in_summary_input(self):
        """Verify tail messages are preserved and not included in the summary input."""
        llm = _mock_llm("summary")
        s = CompactionSettings(context_window_tokens=500, keep_last_assistants=1)
        msgs = [
            _msg(MessageRole.USER, "q1"),
            _msg(MessageRole.ASSISTANT, "a1"),
            _msg(MessageRole.USER, "q2"),
            _msg(MessageRole.ASSISTANT, "TAIL_MSG"),
        ]
        result = await compact_history(msgs, llm, s)
        tail_contents = [m.content for m in result[1:]]
        assert "TAIL_MSG" in tail_contents

    @pytest.mark.asyncio
    async def test_no_summarizable_returns_original(self):
        """Verify original messages are returned when nothing is summarizable."""
        s = CompactionSettings(context_window_tokens=500, keep_last_assistants=10)
        msgs = [_msg(MessageRole.USER, "q"), _msg(MessageRole.ASSISTANT, "a")]
        result = await compact_history(msgs, _mock_llm(), s)
        assert result is msgs

    @pytest.mark.asyncio
    async def test_llm_failure_uses_fallback_summary(self):
        """When LLM fails, summarize_with_fallback produces a descriptive
        fallback string. compact_history still compacts with that string."""
        llm = AsyncMock()
        llm.ainvoke.side_effect = Exception("LLM down")
        s = CompactionSettings(context_window_tokens=500, keep_last_assistants=1)
        msgs = [
            _msg(MessageRole.USER, "q1"),
            _msg(MessageRole.ASSISTANT, "a1"),
            _msg(MessageRole.USER, "q2"),
            _msg(MessageRole.ASSISTANT, "a2"),
        ]
        result = await compact_history(msgs, llm, s)
        # Still compacts, but with a fallback summary
        assert result[0].role == MessageRole.SYSTEM
        assert "unavailable" in result[0].content.lower() or "messages" in result[0].content.lower()

    @pytest.mark.asyncio
    async def test_cutoff_never_before_start_idx(self):
        """Verify the cutoff index never precedes the start index."""
        llm = _mock_llm("new summary")
        s = CompactionSettings(context_window_tokens=500, keep_last_assistants=1)
        msgs = [
            Message(role=MessageRole.SYSTEM, content=f"{COMPACTION_PREFIX}\nold"),
            _msg(MessageRole.USER, "q1"),
            _msg(MessageRole.ASSISTANT, "a1"),
            _msg(MessageRole.USER, "q2"),
            _msg(MessageRole.ASSISTANT, "a2"),
        ]
        result = await compact_history(msgs, llm, s)
        assert result[0].role == MessageRole.SYSTEM
        assert result[0].content.startswith(COMPACTION_PREFIX)


# ===========================================================================
# Tool name selective pruning — _is_tool_prunable
# ===========================================================================


class TestIsToolPrunable:
    """Tests for _is_tool_prunable tool name filtering."""

    def test_no_config_allows_all(self):
        """No allow/deny patterns → everything is prunable."""
        cfg = ToolPruningConfig()
        assert _is_tool_prunable("bash", cfg) is True
        assert _is_tool_prunable("read_file", cfg) is True
        assert _is_tool_prunable(None, cfg) is True

    def test_deny_blocks_exact(self):
        """Deny pattern blocks exact tool name match."""
        cfg = ToolPruningConfig(deny=["send_email"])
        assert _is_tool_prunable("send_email", cfg) is False
        assert _is_tool_prunable("bash", cfg) is True

    def test_deny_blocks_glob(self):
        """Deny glob pattern blocks matching tools."""
        cfg = ToolPruningConfig(deny=["send_*"])
        assert _is_tool_prunable("send_email", cfg) is False
        assert _is_tool_prunable("send_slack", cfg) is False
        assert _is_tool_prunable("bash", cfg) is True

    def test_allow_only_permits_listed(self):
        """Allow pattern restricts pruning to listed tools only."""
        cfg = ToolPruningConfig(allow=["bash", "read_*"])
        assert _is_tool_prunable("bash", cfg) is True
        assert _is_tool_prunable("read_file", cfg) is True
        assert _is_tool_prunable("send_email", cfg) is False

    def test_deny_overrides_allow(self):
        """Deny takes precedence over allow."""
        cfg = ToolPruningConfig(allow=["*"], deny=["secret_*"])
        assert _is_tool_prunable("bash", cfg) is True
        assert _is_tool_prunable("secret_key", cfg) is False

    def test_case_insensitive(self):
        """Matching is case-insensitive."""
        cfg = ToolPruningConfig(deny=["Bash"])
        assert _is_tool_prunable("bash", cfg) is False
        assert _is_tool_prunable("BASH", cfg) is False

    def test_none_tool_name(self):
        """None tool_name defaults to empty string matching."""
        cfg = ToolPruningConfig(allow=["bash"])
        assert _is_tool_prunable(None, cfg) is False


class TestPruneWithToolName:
    """Tests for prune_context_messages respecting tool_name filtering."""

    def _settings(self, **kw):
        defaults = dict(
            context_window_tokens=500,
            keep_last_assistants=1,
            soft_trim_ratio=0.3,
            hard_clear_ratio=0.5,
            min_prunable_tool_chars=0,
        )
        defaults.update(kw)
        return CompactionSettings(**defaults)

    def test_deny_pattern_skips_pruning(self):
        """Tool results matching deny pattern are not pruned."""
        s = self._settings(tool_pruning=ToolPruningConfig(deny=["important_*"]))
        msgs = [
            Message(role=MessageRole.USER, content="hi"),
            Message(role=MessageRole.TOOL, content="T" * 10_000, tool_name="important_api"),
            Message(role=MessageRole.ASSISTANT, content="r1"),
            Message(role=MessageRole.USER, content="q2"),
            Message(role=MessageRole.ASSISTANT, content="r2"),
        ]
        result = prune_context_messages(msgs, s)
        # important_api should NOT be pruned
        assert len(result[1].content) == 10_000

    def test_allow_pattern_prunes_only_matching(self):
        """Only tools matching allow pattern are pruned."""
        s = self._settings(tool_pruning=ToolPruningConfig(allow=["bash"]))
        msgs = [
            Message(role=MessageRole.USER, content="hi"),
            Message(role=MessageRole.TOOL, content="T" * 10_000, tool_name="bash"),
            Message(role=MessageRole.TOOL, content="T" * 10_000, tool_name="read_file"),
            Message(role=MessageRole.ASSISTANT, content="r1"),
            Message(role=MessageRole.USER, content="q2"),
            Message(role=MessageRole.ASSISTANT, content="r2"),
        ]
        result = prune_context_messages(msgs, s)
        assert len(result[1].content) < 10_000   # bash pruned
        assert len(result[2].content) == 10_000   # read_file not pruned

    def test_tool_name_preserved_after_pruning(self):
        """tool_name is preserved on pruned messages."""
        s = self._settings()
        msgs = [
            Message(role=MessageRole.USER, content="hi"),
            Message(role=MessageRole.TOOL, content="T" * 10_000, tool_name="bash"),
            Message(role=MessageRole.ASSISTANT, content="r1"),
            Message(role=MessageRole.USER, content="q2"),
            Message(role=MessageRole.ASSISTANT, content="r2"),
        ]
        result = prune_context_messages(msgs, s)
        assert result[1].tool_name == "bash"


# ===========================================================================
# _total_chars / estimate_context_chars include tool_calls
# ===========================================================================


class TestCharsIncludeToolCalls:
    """Tests for character estimation including tool_calls metadata."""

    def test_message_without_tool_calls(self):
        """Plain message chars == content length."""
        msg = Message(role=MessageRole.USER, content="hello")
        assert estimate_message_chars(msg) == 5

    def test_message_with_tool_calls(self):
        """Message with tool_calls should have chars > content length."""
        msg = Message(
            role=MessageRole.ASSISTANT,
            content="thinking",
            tool_calls=[{"id": "call_1", "name": "bash", "args": {"command": "ls -la"}}],
        )
        chars = estimate_message_chars(msg)
        assert chars > len("thinking")

    def test_estimate_context_chars_includes_tool_calls(self):
        """estimate_context_chars should include tool_calls metadata."""
        msgs = [
            Message(role=MessageRole.USER, content="hi"),
            Message(
                role=MessageRole.ASSISTANT,
                content="ok",
                tool_calls=[{"id": "c1", "name": "bash", "args": {"cmd": "echo hello"}}],
            ),
        ]
        total = estimate_context_chars(msgs)
        content_only = sum(len(m.content) for m in msgs)
        assert total > content_only
