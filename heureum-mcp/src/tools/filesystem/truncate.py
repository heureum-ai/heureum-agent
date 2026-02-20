"""Truncation utilities for tool outputs.

Source: pi-mono/packages/coding-agent/src/core/tools/truncate.ts

Truncation is based on two independent limits - whichever is hit first wins:
- Line limit (default: 2000 lines)
- Byte limit (default: 50KB)

Never returns partial lines (except bash tail truncation edge case).
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel

DEFAULT_MAX_LINES = 2000
DEFAULT_MAX_BYTES = 50 * 1024  # 50KB
GREP_MAX_LINE_LENGTH = 500  # Max chars per grep match line


class TruncationResult(BaseModel):
    """Result of a truncation operation."""

    # The truncated content
    content: str
    # Whether truncation occurred
    truncated: bool
    # Which limit was hit: "lines", "bytes", or None if not truncated
    truncated_by: Optional[Literal["lines", "bytes"]]
    # Total number of lines in the original content
    total_lines: int
    # Total number of bytes in the original content
    total_bytes: int
    # Number of complete lines in the truncated output
    output_lines: int
    # Number of bytes in the truncated output
    output_bytes: int
    # Whether the last line was partially truncated (only for tail truncation edge case)
    last_line_partial: bool
    # Whether the first line exceeded the byte limit (for head truncation)
    first_line_exceeds_limit: bool
    # The max lines limit that was applied
    max_lines: int
    # The max bytes limit that was applied
    max_bytes: int


class TruncateLineResult(BaseModel):
    """Result of truncating a single line."""

    text: str
    was_truncated: bool


def format_size(num_bytes: int) -> str:
    """Format bytes as human-readable size."""
    if num_bytes < 1024:
        return f"{num_bytes}B"
    elif num_bytes < 1024 * 1024:
        return f"{num_bytes / 1024:.1f}KB"
    else:
        return f"{num_bytes / (1024 * 1024):.1f}MB"


def truncate_head(
    content: str,
    *,
    max_lines: int = DEFAULT_MAX_LINES,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> TruncationResult:
    """Truncate content from the head (keep first N lines/bytes).

    Suitable for file reads where you want to see the beginning.
    Never returns partial lines. If first line exceeds byte limit,
    returns empty content with first_line_exceeds_limit=True.
    """
    total_bytes = len(content.encode("utf-8"))
    lines = content.split("\n")
    total_lines = len(lines)

    # Check if no truncation needed
    if total_lines <= max_lines and total_bytes <= max_bytes:
        return TruncationResult(
            content=content,
            truncated=False,
            truncated_by=None,
            total_lines=total_lines,
            total_bytes=total_bytes,
            output_lines=total_lines,
            output_bytes=total_bytes,
            last_line_partial=False,
            first_line_exceeds_limit=False,
            max_lines=max_lines,
            max_bytes=max_bytes,
        )

    # Check if first line alone exceeds byte limit
    first_line_bytes = len(lines[0].encode("utf-8"))
    if first_line_bytes > max_bytes:
        return TruncationResult(
            content="",
            truncated=True,
            truncated_by="bytes",
            total_lines=total_lines,
            total_bytes=total_bytes,
            output_lines=0,
            output_bytes=0,
            last_line_partial=False,
            first_line_exceeds_limit=True,
            max_lines=max_lines,
            max_bytes=max_bytes,
        )

    # Collect complete lines that fit
    output_lines_arr: list[str] = []
    output_bytes_count = 0
    truncated_by: Literal["lines", "bytes"] = "lines"

    for i, line in enumerate(lines):
        if i >= max_lines:
            break

        line_bytes = len(line.encode("utf-8")) + (1 if i > 0 else 0)  # +1 for newline

        if output_bytes_count + line_bytes > max_bytes:
            truncated_by = "bytes"
            break

        output_lines_arr.append(line)
        output_bytes_count += line_bytes

    # If we exited due to line limit
    if len(output_lines_arr) >= max_lines and output_bytes_count <= max_bytes:
        truncated_by = "lines"

    output_content = "\n".join(output_lines_arr)
    final_output_bytes = len(output_content.encode("utf-8"))

    return TruncationResult(
        content=output_content,
        truncated=True,
        truncated_by=truncated_by,
        total_lines=total_lines,
        total_bytes=total_bytes,
        output_lines=len(output_lines_arr),
        output_bytes=final_output_bytes,
        last_line_partial=False,
        first_line_exceeds_limit=False,
        max_lines=max_lines,
        max_bytes=max_bytes,
    )


def _truncate_string_to_bytes_from_end(s: str, max_bytes: int) -> str:
    """Truncate a string to fit within a byte limit (from the end).

    Handles multi-byte UTF-8 characters correctly.
    """
    buf = s.encode("utf-8")
    if len(buf) <= max_bytes:
        return s

    # Start from the end, skip max_bytes back
    start = len(buf) - max_bytes

    # Find a valid UTF-8 boundary (start of a character)
    # UTF-8 continuation bytes have the pattern 10xxxxxx (0x80-0xBF)
    while start < len(buf) and (buf[start] & 0xC0) == 0x80:
        start += 1

    return buf[start:].decode("utf-8")


def truncate_tail(
    content: str,
    *,
    max_lines: int = DEFAULT_MAX_LINES,
    max_bytes: int = DEFAULT_MAX_BYTES,
) -> TruncationResult:
    """Truncate content from the tail (keep last N lines/bytes).

    Suitable for bash output where you want to see the end (errors, final results).
    May return partial first line if the last line of original content exceeds byte limit.
    """
    total_bytes = len(content.encode("utf-8"))
    lines = content.split("\n")
    total_lines = len(lines)

    # Check if no truncation needed
    if total_lines <= max_lines and total_bytes <= max_bytes:
        return TruncationResult(
            content=content,
            truncated=False,
            truncated_by=None,
            total_lines=total_lines,
            total_bytes=total_bytes,
            output_lines=total_lines,
            output_bytes=total_bytes,
            last_line_partial=False,
            first_line_exceeds_limit=False,
            max_lines=max_lines,
            max_bytes=max_bytes,
        )

    # Work backwards from the end
    output_lines_arr: list[str] = []
    output_bytes_count = 0
    truncated_by: Literal["lines", "bytes"] = "lines"
    last_line_partial = False

    for i in range(len(lines) - 1, -1, -1):
        if len(output_lines_arr) >= max_lines:
            break

        line = lines[i]
        line_bytes = len(line.encode("utf-8")) + (
            1 if len(output_lines_arr) > 0 else 0
        )  # +1 for newline

        if output_bytes_count + line_bytes > max_bytes:
            truncated_by = "bytes"
            # Edge case: if we haven't added ANY lines yet and this line exceeds max_bytes,
            # take the end of the line (partial)
            if len(output_lines_arr) == 0:
                truncated_line = _truncate_string_to_bytes_from_end(line, max_bytes)
                output_lines_arr.insert(0, truncated_line)
                output_bytes_count = len(truncated_line.encode("utf-8"))
                last_line_partial = True
            break

        output_lines_arr.insert(0, line)
        output_bytes_count += line_bytes

    # If we exited due to line limit
    if len(output_lines_arr) >= max_lines and output_bytes_count <= max_bytes:
        truncated_by = "lines"

    output_content = "\n".join(output_lines_arr)
    final_output_bytes = len(output_content.encode("utf-8"))

    return TruncationResult(
        content=output_content,
        truncated=True,
        truncated_by=truncated_by,
        total_lines=total_lines,
        total_bytes=total_bytes,
        output_lines=len(output_lines_arr),
        output_bytes=final_output_bytes,
        last_line_partial=last_line_partial,
        first_line_exceeds_limit=False,
        max_lines=max_lines,
        max_bytes=max_bytes,
    )


def truncate_line(
    line: str,
    max_chars: int = GREP_MAX_LINE_LENGTH,
) -> TruncateLineResult:
    """Truncate a single line to max characters, adding [truncated] suffix.

    Used for grep match lines.
    """
    if len(line) <= max_chars:
        return TruncateLineResult(text=line, was_truncated=False)
    return TruncateLineResult(text=f"{line[:max_chars]}... [truncated]", was_truncated=True)
