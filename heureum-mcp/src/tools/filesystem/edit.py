"""File edit tool.

Source: pi-mono/packages/coding-agent/src/core/tools/edit.ts
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, Dict, List, Optional, Protocol

from pydantic import BaseModel, Field

from .edit_diff import (
    detect_line_ending,
    fuzzy_find_text,
    generate_diff_string,
    normalize_for_fuzzy_match,
    normalize_to_lf,
    restore_line_endings,
    strip_bom,
)
from .path_utils import resolve_to_cwd


class EditToolInput(BaseModel):
    """Input schema for edit tool."""

    path: str = Field(description="Path to the file to edit (relative or absolute)")
    old_text: str = Field(description="Exact text to find and replace (must match exactly)")
    new_text: str = Field(description="New text to replace the old text with")


class EditToolDetails(BaseModel):
    """Details returned from edit tool execution."""

    diff: str
    first_changed_line: Optional[int] = None


class EditOperations(Protocol):
    """Protocol for pluggable edit operations."""

    async def read_file(self, absolute_path: str) -> bytes:
        """Read file contents as bytes."""
        ...

    async def write_file(self, absolute_path: str, content: str) -> None:
        """Write content to a file."""
        ...

    async def access(self, absolute_path: str) -> None:
        """Check if file is readable and writable (raise if not)."""
        ...


class DefaultEditOperations:
    """Default edit operations using local filesystem."""

    async def read_file(self, absolute_path: str) -> bytes:
        """Read file contents as bytes."""

        def _read() -> bytes:
            with open(absolute_path, "rb") as f:
                return f.read()

        return await asyncio.to_thread(_read)

    async def write_file(self, absolute_path: str, content: str) -> None:
        """Write content to a file."""

        def _write() -> None:
            with open(absolute_path, "w", encoding="utf-8") as f:
                f.write(content)

        await asyncio.to_thread(_write)

    async def access(self, absolute_path: str) -> None:
        """Check if file is readable and writable."""

        def _access() -> None:
            if not os.path.exists(absolute_path):
                raise FileNotFoundError(f"File not found: {absolute_path}")
            if not os.access(absolute_path, os.R_OK | os.W_OK):
                raise PermissionError(f"Permission denied: {absolute_path}")

        await asyncio.to_thread(_access)


class EditToolOptions(BaseModel):
    """Options for edit tool creation."""

    model_config = {"arbitrary_types_allowed": True}

    operations: Optional[Any] = None  # EditOperations


class EditToolResult(BaseModel):
    """Result from edit tool execution."""

    content: List[Dict[str, str]]
    details: Optional[EditToolDetails] = None


class EditTool:
    """File edit tool."""

    name = "edit"
    label = "edit"
    description = (
        "Edit a file by replacing exact text. The oldText must match exactly (including whitespace). "
        "Use this for precise, surgical edits."
    )

    def __init__(self, cwd: str, options: Optional[EditToolOptions] = None):
        self.cwd = cwd
        self.options = options or EditToolOptions()
        self._ops = self.options.operations or DefaultEditOperations()

    @property
    def parameters(self) -> dict:
        """Return JSON schema for tool parameters."""
        return EditToolInput.model_json_schema()

    async def execute(
        self,
        tool_call_id: str,
        path: str,
        old_text: str,
        new_text: str,
    ) -> EditToolResult:
        """Execute file edit."""
        absolute_path = resolve_to_cwd(path, self.cwd)

        # Check if file exists
        try:
            await self._ops.access(absolute_path)
        except FileNotFoundError:
            raise RuntimeError(f"File not found: {path}")

        # Read the file
        buffer = await self._ops.read_file(absolute_path)
        raw_content = buffer.decode("utf-8", errors="replace")

        # Strip BOM before matching (LLM won't include invisible BOM in old_text)
        bom_result = strip_bom(raw_content)
        bom = bom_result["bom"]
        content = bom_result["text"]

        original_ending = detect_line_ending(content)
        normalized_content = normalize_to_lf(content)
        normalized_old_text = normalize_to_lf(old_text)
        normalized_new_text = normalize_to_lf(new_text)

        # Find the old text using fuzzy matching (tries exact match first, then fuzzy)
        match_result = fuzzy_find_text(normalized_content, normalized_old_text)

        if not match_result.found:
            raise RuntimeError(
                f"Could not find the exact text in {path}. "
                "The old text must match exactly including all whitespace and newlines."
            )

        # Count occurrences using fuzzy-normalized content for consistency
        fuzzy_content = normalize_for_fuzzy_match(normalized_content)
        fuzzy_old_text = normalize_for_fuzzy_match(normalized_old_text)
        occurrences = len(fuzzy_content.split(fuzzy_old_text)) - 1

        if occurrences > 1:
            raise RuntimeError(
                f"Found {occurrences} occurrences of the text in {path}. "
                "The text must be unique. Please provide more context to make it unique."
            )

        # Perform replacement using the matched text position
        # When fuzzy matching was used, content_for_replacement is the normalized version
        base_content = match_result.content_for_replacement
        new_content = (
            base_content[: match_result.index]
            + normalized_new_text
            + base_content[match_result.index + match_result.match_length :]
        )

        # Verify the replacement actually changed something
        if base_content == new_content:
            raise RuntimeError(
                f"No changes made to {path}. The replacement produced identical content. "
                "This might indicate an issue with special characters or the text not existing as expected."
            )

        final_content = bom + restore_line_endings(new_content, original_ending)
        await self._ops.write_file(absolute_path, final_content)

        diff_result = generate_diff_string(base_content, new_content)

        return EditToolResult(
            content=[{"type": "text", "text": f"Successfully replaced text in {path}."}],
            details=EditToolDetails(
                diff=diff_result.diff,
                first_changed_line=diff_result.first_changed_line,
            ),
        )


def create_edit_tool(cwd: str, options: Optional[EditToolOptions] = None) -> EditTool:
    """Create an edit tool configured for a specific working directory."""
    return EditTool(cwd, options)


def edit_tool() -> EditTool:
    """Get default edit tool using current working directory."""
    return create_edit_tool(os.getcwd())
