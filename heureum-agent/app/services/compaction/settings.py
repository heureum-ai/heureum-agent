# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Compaction settings.

Mirrors OpenClaw's context-pruning/settings.ts.
All thresholds expressed as ratios of the context window.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional

from app.services.prompts import TRUNCATION_SUFFIX as _DEFAULT_TRUNCATION_SUFFIX


@dataclass(frozen=True)
class ToolPruningConfig:
    """Selective tool pruning via allow/deny glob patterns.

    When both are ``None`` (default), all tools are prunable.
    When ``allow`` is set, only matching tools are prunable.
    When ``deny`` is set, matching tools are never pruned.
    ``deny`` takes precedence over ``allow``.

    Patterns use ``fnmatch`` syntax (e.g. ``"bash"``, ``"file_*"``).

    Attributes:
        allow (Optional[List[str]]): Glob patterns of tools that may be pruned.
        deny (Optional[List[str]]): Glob patterns of tools that must not be pruned.
    """

    allow: Optional[List[str]] = None
    deny: Optional[List[str]] = None


@dataclass(frozen=True)
class SoftTrimConfig:
    """Soft-trim keeps head + tail of oversized tool results.

    Attributes:
        max_chars (int): Maximum character count before soft-trimming is applied.
        head_chars (int): Number of characters to keep from the beginning.
        tail_chars (int): Number of characters to keep from the end.
    """

    max_chars: int = 4_000
    head_chars: int = 1_500
    tail_chars: int = 1_500


@dataclass(frozen=True)
class HardClearConfig:
    """Hard-clear replaces entire tool result with a placeholder.

    Attributes:
        enabled (bool): Whether hard-clear is enabled.
        placeholder (str): Replacement text for cleared tool results.
    """

    enabled: bool = True
    placeholder: str = "[Old tool result content cleared]"


@dataclass
class CompactionSettings:
    """All compaction-related configuration in one place.

    Layers (applied in order):
      1. Tool result truncation  — cap individual results
      2. Context pruning         — soft-trim / hard-clear old results
      3. LLM compaction          — summarize history

    Attributes:
        context_window_tokens (int): Maximum context window size in tokens.
        chars_per_token (int): Approximate characters per token for estimation.
        max_tool_result_context_share (float): Maximum share of the context
            window a single tool result may occupy.
        hard_max_tool_result_chars (int): Absolute upper bound on tool result
            characters regardless of context share.
        min_keep_chars (int): Minimum characters to keep when truncating tool
            results.
        truncation_suffix (str): Suffix appended to truncated tool results.
        keep_last_assistants (int): Number of recent assistant messages
            protected from pruning.
        soft_trim_ratio (float): Context usage ratio that triggers soft
            trimming.
        hard_clear_ratio (float): Context usage ratio that triggers hard
            clearing.
        min_prunable_tool_chars (int): Minimum total prunable tool characters
            required before hard-clear is applied.
        soft_trim (SoftTrimConfig): Configuration for soft-trim behaviour.
        hard_clear (HardClearConfig): Configuration for hard-clear behaviour.
        compaction_enabled (bool): Whether LLM-based compaction is enabled.
        base_chunk_ratio (float): Base ratio of context window used for chunk
            sizing.
        min_chunk_ratio (float): Minimum chunk ratio after adaptive reduction.
        safety_margin (float): Multiplier applied to average message size for
            adaptive chunk sizing.
        tool_pruning (ToolPruningConfig): Selective pruning via tool name
            allow/deny patterns.
        proactive_pruning_ratio (float): Context usage ratio that triggers
            proactive compaction before the LLM call to avoid overflow errors.
    """

    context_window_tokens: int = 128_000
    chars_per_token: int = 4
    max_tool_result_context_share: float = 0.3
    hard_max_tool_result_chars: int = 400_000
    min_keep_chars: int = 2_000
    truncation_suffix: str = _DEFAULT_TRUNCATION_SUFFIX
    keep_last_assistants: int = 3
    soft_trim_ratio: float = 0.3
    hard_clear_ratio: float = 0.5
    min_prunable_tool_chars: int = 50_000
    soft_trim: SoftTrimConfig = field(default_factory=SoftTrimConfig)
    hard_clear: HardClearConfig = field(default_factory=HardClearConfig)
    compaction_enabled: bool = True
    base_chunk_ratio: float = 0.4
    min_chunk_ratio: float = 0.15
    safety_margin: float = 1.2
    tool_pruning: ToolPruningConfig = field(default_factory=ToolPruningConfig)
    proactive_pruning_ratio: float = 0.7

    @property
    def context_window_chars(self) -> int:
        """Estimated context window size in characters.

        Returns:
            int: Product of ``context_window_tokens`` and ``chars_per_token``.
        """
        return self.context_window_tokens * self.chars_per_token
