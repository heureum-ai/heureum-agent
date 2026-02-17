"""Shared diff computation utilities for the edit tool.

Source: pi-mono/packages/coding-agent/src/core/tools/edit-diff.ts

Used by both edit.py (for execution) and tool-execution (for preview rendering).
"""

from __future__ import annotations

import difflib
from typing import Literal, Optional, TypedDict, Union

from pydantic import BaseModel

from .path_utils import resolve_to_cwd


def detect_line_ending(content: str) -> Literal["\r\n", "\n"]:
    """Detect the line ending style of content."""
    crlf_idx = content.find("\r\n")
    lf_idx = content.find("\n")
    if lf_idx == -1:
        return "\n"
    if crlf_idx == -1:
        return "\n"
    return "\r\n" if crlf_idx < lf_idx else "\n"


def normalize_to_lf(text: str) -> str:
    """Normalize all line endings to LF."""
    return text.replace("\r\n", "\n").replace("\r", "\n")


def restore_line_endings(text: str, ending: Literal["\r\n", "\n"]) -> str:
    """Restore line endings to the specified style."""
    return text.replace("\n", "\r\n") if ending == "\r\n" else text


def normalize_for_fuzzy_match(text: str) -> str:
    """Normalize text for fuzzy matching.

    Applies progressive transformations:
    - Strip trailing whitespace from each line
    - Normalize smart quotes to ASCII equivalents
    - Normalize Unicode dashes/hyphens to ASCII hyphen
    - Normalize special Unicode spaces to regular space
    """
    return (
        # Strip trailing whitespace per line
        "\n".join(line.rstrip() for line in text.split("\n"))
        # Smart single quotes → '
        .replace("\u2018", "'")
        .replace("\u2019", "'")
        .replace("\u201a", "'")
        .replace("\u201b", "'")
        # Smart double quotes → "
        .replace("\u201c", '"')
        .replace("\u201d", '"')
        .replace("\u201e", '"')
        .replace("\u201f", '"')
        # Various dashes/hyphens → -
        # U+2010 hyphen, U+2011 non-breaking hyphen, U+2012 figure dash,
        # U+2013 en-dash, U+2014 em-dash, U+2015 horizontal bar, U+2212 minus
        .replace("\u2010", "-")
        .replace("\u2011", "-")
        .replace("\u2012", "-")
        .replace("\u2013", "-")
        .replace("\u2014", "-")
        .replace("\u2015", "-")
        .replace("\u2212", "-")
        # Special spaces → regular space
        # U+00A0 NBSP, U+2002-U+200A various spaces, U+202F narrow NBSP,
        # U+205F medium math space, U+3000 ideographic space
        .replace("\u00a0", " ")
        .replace("\u2002", " ")
        .replace("\u2003", " ")
        .replace("\u2004", " ")
        .replace("\u2005", " ")
        .replace("\u2006", " ")
        .replace("\u2007", " ")
        .replace("\u2008", " ")
        .replace("\u2009", " ")
        .replace("\u200a", " ")
        .replace("\u202f", " ")
        .replace("\u205f", " ")
        .replace("\u3000", " ")
    )


class FuzzyMatchResult(BaseModel):
    """Result of fuzzy text matching."""

    # Whether a match was found
    found: bool
    # The index where the match starts (in the content that should be used for replacement)
    index: int
    # Length of the matched text
    match_length: int
    # Whether fuzzy matching was used (False = exact match)
    used_fuzzy_match: bool
    # The content to use for replacement operations.
    # When exact match: original content. When fuzzy match: normalized content.
    content_for_replacement: str


def fuzzy_find_text(content: str, old_text: str) -> FuzzyMatchResult:
    """Find old_text in content, trying exact match first, then fuzzy match.

    When fuzzy matching is used, the returned content_for_replacement is the
    fuzzy-normalized version of the content (trailing whitespace stripped,
    Unicode quotes/dashes normalized to ASCII).
    """
    # Try exact match first
    exact_index = content.find(old_text)
    if exact_index != -1:
        return FuzzyMatchResult(
            found=True,
            index=exact_index,
            match_length=len(old_text),
            used_fuzzy_match=False,
            content_for_replacement=content,
        )

    # Try fuzzy match - work entirely in normalized space
    fuzzy_content = normalize_for_fuzzy_match(content)
    fuzzy_old_text = normalize_for_fuzzy_match(old_text)
    fuzzy_index = fuzzy_content.find(fuzzy_old_text)

    if fuzzy_index == -1:
        return FuzzyMatchResult(
            found=False,
            index=-1,
            match_length=0,
            used_fuzzy_match=False,
            content_for_replacement=content,
        )

    # When fuzzy matching, we work in the normalized space for replacement.
    # This means the output will have normalized whitespace/quotes/dashes,
    # which is acceptable since we're fixing minor formatting differences anyway.
    return FuzzyMatchResult(
        found=True,
        index=fuzzy_index,
        match_length=len(fuzzy_old_text),
        used_fuzzy_match=True,
        content_for_replacement=fuzzy_content,
    )


class StripBomResult(TypedDict):
    """Result of stripping UTF-8 BOM."""

    bom: str
    text: str


def strip_bom(content: str) -> StripBomResult:
    """Strip UTF-8 BOM if present, return both the BOM (if any) and the text without it."""
    if content.startswith("\ufeff"):
        return {"bom": "\ufeff", "text": content[1:]}
    return {"bom": "", "text": content}


class _DiffPart:
    """A part of a diff result (matches npm diff package's Change type)."""

    def __init__(self, value: str, added: bool = False, removed: bool = False):
        self.value = value
        self.added = added
        self.removed = removed


def _diff_lines(old_text: str, new_text: str) -> list[_DiffPart]:
    """Compute line-based diff (matches npm diff package's diffLines).

    Returns a list of parts with {value, added, removed} similar to npm diff.
    """
    old_lines = old_text.split("\n")
    new_lines = new_text.split("\n")

    # Use difflib's SequenceMatcher to get opcodes
    matcher = difflib.SequenceMatcher(None, old_lines, new_lines)
    opcodes = matcher.get_opcodes()

    parts: list[_DiffPart] = []

    for tag, i1, i2, j1, j2 in opcodes:
        if tag == "equal":
            # Unchanged lines
            value = "\n".join(old_lines[i1:i2])
            if i2 > i1:
                value += "\n"
            parts.append(_DiffPart(value, added=False, removed=False))
        elif tag == "delete":
            # Removed lines
            value = "\n".join(old_lines[i1:i2])
            if i2 > i1:
                value += "\n"
            parts.append(_DiffPart(value, added=False, removed=True))
        elif tag == "insert":
            # Added lines
            value = "\n".join(new_lines[j1:j2])
            if j2 > j1:
                value += "\n"
            parts.append(_DiffPart(value, added=True, removed=False))
        elif tag == "replace":
            # Changed lines - emit as remove then add (matches npm diff behavior)
            old_value = "\n".join(old_lines[i1:i2])
            if i2 > i1:
                old_value += "\n"
            parts.append(_DiffPart(old_value, added=False, removed=True))

            new_value = "\n".join(new_lines[j1:j2])
            if j2 > j1:
                new_value += "\n"
            parts.append(_DiffPart(new_value, added=True, removed=False))

    return parts


class DiffResult(BaseModel):
    """Result of diff generation."""

    diff: str
    first_changed_line: Optional[int]


def generate_diff_string(
    old_content: str,
    new_content: str,
    context_lines: int = 4,
) -> DiffResult:
    """Generate a unified diff string with line numbers and context.

    Returns both the diff string and the first changed line number (in the new file).
    """
    parts = _diff_lines(old_content, new_content)
    output: list[str] = []

    old_lines = old_content.split("\n")
    new_lines = new_content.split("\n")
    max_line_num = max(len(old_lines), len(new_lines))
    line_num_width = len(str(max_line_num))

    old_line_num = 1
    new_line_num = 1
    last_was_change = False
    first_changed_line: Optional[int] = None

    for i, part in enumerate(parts):
        raw = part.value.split("\n")
        if raw[len(raw) - 1] == "":
            raw.pop()

        if part.added or part.removed:
            # Capture the first changed line (in the new file)
            if first_changed_line is None:
                first_changed_line = new_line_num

            # Show the change
            for line in raw:
                if part.added:
                    line_num = str(new_line_num).rjust(line_num_width, " ")
                    output.append(f"+{line_num} {line}")
                    new_line_num += 1
                else:
                    # removed
                    line_num = str(old_line_num).rjust(line_num_width, " ")
                    output.append(f"-{line_num} {line}")
                    old_line_num += 1
            last_was_change = True
        else:
            # Context lines - only show a few before/after changes
            next_part_is_change = i < len(parts) - 1 and (
                parts[i + 1].added or parts[i + 1].removed
            )

            if last_was_change or next_part_is_change:
                # Show context
                lines_to_show = raw
                skip_start = 0
                skip_end = 0

                if not last_was_change:
                    # Show only last N lines as leading context
                    skip_start = max(0, len(raw) - context_lines)
                    lines_to_show = raw[skip_start:]

                if not next_part_is_change and len(lines_to_show) > context_lines:
                    # Show only first N lines as trailing context
                    skip_end = len(lines_to_show) - context_lines
                    lines_to_show = lines_to_show[:context_lines]

                # Add ellipsis if we skipped lines at start
                if skip_start > 0:
                    output.append(f" {''.rjust(line_num_width, ' ')} ...")
                    # Update line numbers for the skipped leading context
                    old_line_num += skip_start
                    new_line_num += skip_start

                for line in lines_to_show:
                    line_num = str(old_line_num).rjust(line_num_width, " ")
                    output.append(f" {line_num} {line}")
                    old_line_num += 1
                    new_line_num += 1

                # Add ellipsis if we skipped lines at end
                if skip_end > 0:
                    output.append(f" {''.rjust(line_num_width, ' ')} ...")
                    # Update line numbers for the skipped trailing context
                    old_line_num += skip_end
                    new_line_num += skip_end
            else:
                # Skip these context lines entirely
                old_line_num += len(raw)
                new_line_num += len(raw)

            last_was_change = False

    return DiffResult(diff="\n".join(output), first_changed_line=first_changed_line)


class EditDiffError(BaseModel):
    """Error result from edit diff computation."""

    error: str


async def compute_edit_diff(
    path: str,
    old_text: str,
    new_text: str,
    cwd: str,
) -> Union[DiffResult, EditDiffError]:
    """Compute the diff for an edit operation without applying it.

    Used for preview rendering in the TUI before the tool executes.
    """
    import asyncio
    import os as _os

    absolute_path = resolve_to_cwd(path, cwd)

    try:
        # Check if file exists and is readable
        if not _os.path.exists(absolute_path):
            return EditDiffError(error=f"File not found: {path}")

        # Read the file
        def _read() -> str:
            with open(absolute_path, "r", encoding="utf-8") as fh:
                return fh.read()

        raw_content = await asyncio.to_thread(_read)

        # Strip BOM before matching (LLM won't include invisible BOM in old_text)
        bom_result = strip_bom(raw_content)
        content = bom_result["text"]

        normalized_content = normalize_to_lf(content)
        normalized_old_text = normalize_to_lf(old_text)
        normalized_new_text = normalize_to_lf(new_text)

        # Find the old text using fuzzy matching (tries exact match first, then fuzzy)
        match_result = fuzzy_find_text(normalized_content, normalized_old_text)

        if not match_result.found:
            return EditDiffError(
                error=f"Could not find the exact text in {path}. "
                "The old text must match exactly including all whitespace and newlines."
            )

        # Count occurrences using fuzzy-normalized content for consistency
        fuzzy_content = normalize_for_fuzzy_match(normalized_content)
        fuzzy_old_text = normalize_for_fuzzy_match(normalized_old_text)
        occurrences = len(fuzzy_content.split(fuzzy_old_text)) - 1

        if occurrences > 1:
            return EditDiffError(
                error=f"Found {occurrences} occurrences of the text in {path}. "
                "The text must be unique. Please provide more context to make it unique."
            )

        # Compute the new content using the matched position
        # When fuzzy matching was used, content_for_replacement is the normalized version
        base_content = match_result.content_for_replacement
        new_content = (
            base_content[: match_result.index]
            + normalized_new_text
            + base_content[match_result.index + match_result.match_length :]
        )

        # Check if it would actually change anything
        if base_content == new_content:
            return EditDiffError(
                error=f"No changes would be made to {path}. The replacement produces identical content."
            )

        # Generate the diff
        return generate_diff_string(base_content, new_content)

    except Exception as err:
        return EditDiffError(error=str(err) if not isinstance(err, Exception) else str(err))
