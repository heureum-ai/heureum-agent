"""File read tool.

Source: pi-mono/packages/coding-agent/src/core/tools/read.ts
"""

from __future__ import annotations

import asyncio
import base64
import mimetypes
import os
from typing import Any, Dict, List, Optional, Protocol

from pydantic import BaseModel, Field

from .path_utils import resolve_read_path
from .truncate import (
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    TruncationResult,
    format_size,
    truncate_head,
)

# Supported image MIME types
SUPPORTED_IMAGE_TYPES = {
    "image/jpeg",
    "image/png",
    "image/gif",
    "image/webp",
}


class ReadToolInput(BaseModel):
    """Input schema for read tool."""

    path: str = Field(description="Path to the file to read (relative or absolute)")
    offset: Optional[int] = Field(
        default=None, description="Line number to start reading from (1-indexed)"
    )
    limit: Optional[int] = Field(default=None, description="Maximum number of lines to read")


class ReadToolDetails(BaseModel):
    """Details returned from read tool execution."""

    truncation: Optional[TruncationResult] = None


class ReadOperations(Protocol):
    """Protocol for pluggable read operations."""

    async def read_file(self, absolute_path: str) -> bytes:
        """Read file contents as bytes."""
        ...

    async def access(self, absolute_path: str) -> None:
        """Check if file is readable (raise if not)."""
        ...

    async def detect_image_mime_type(self, absolute_path: str) -> Optional[str]:
        """Detect image MIME type, return None for non-images."""
        ...


class DefaultReadOperations:
    """Default read operations using local filesystem."""

    async def read_file(self, absolute_path: str) -> bytes:
        """Read file contents as bytes."""

        def _read() -> bytes:
            with open(absolute_path, "rb") as f:
                return f.read()

        return await asyncio.to_thread(_read)

    async def access(self, absolute_path: str) -> None:
        """Check if file is readable."""

        def _access() -> None:
            if not os.path.exists(absolute_path):
                raise FileNotFoundError(f"File not found: {absolute_path}")
            if not os.access(absolute_path, os.R_OK):
                raise PermissionError(f"Permission denied: {absolute_path}")

        await asyncio.to_thread(_access)

    async def detect_image_mime_type(self, absolute_path: str) -> Optional[str]:
        """Detect image MIME type based on file extension and content."""

        def _detect() -> Optional[str]:
            # First try by extension
            mime_type, _ = mimetypes.guess_type(absolute_path)
            if mime_type in SUPPORTED_IMAGE_TYPES:
                return mime_type

            # Try by magic bytes for common image formats
            try:
                with open(absolute_path, "rb") as f:
                    header = f.read(12)

                # JPEG
                if header[:2] == b"\xff\xd8":
                    return "image/jpeg"
                # PNG
                if header[:8] == b"\x89PNG\r\n\x1a\n":
                    return "image/png"
                # GIF
                if header[:6] in (b"GIF87a", b"GIF89a"):
                    return "image/gif"
                # WebP
                if header[:4] == b"RIFF" and header[8:12] == b"WEBP":
                    return "image/webp"
            except (OSError, IOError):
                pass

            return None

        return await asyncio.to_thread(_detect)


class ReadToolOptions(BaseModel):
    """Options for read tool creation."""

    model_config = {"arbitrary_types_allowed": True}

    auto_resize_images: bool = True
    operations: Optional[Any] = None  # ReadOperations


class TextContent(BaseModel):
    """Text content block."""

    type: str = "text"
    text: str


class ImageContent(BaseModel):
    """Image content block."""

    type: str = "image"
    data: str
    mime_type: str


class ReadToolResult(BaseModel):
    """Result from read tool execution."""

    content: List[Dict[str, Any]]
    details: Optional[ReadToolDetails] = None


class ReadTool:
    """File read tool."""

    name = "read"
    label = "read"
    description = (
        f"Read the contents of a file. Supports text files and images (jpg, png, gif, webp). "
        f"Images are sent as attachments. For text files, output is truncated to {DEFAULT_MAX_LINES} lines "
        f"or {DEFAULT_MAX_BYTES // 1024}KB (whichever is hit first). "
        f"Use offset/limit for large files. When you need the full file, continue with offset until complete."
    )

    def __init__(self, cwd: str, options: Optional[ReadToolOptions] = None):
        self.cwd = cwd
        self.options = options or ReadToolOptions()
        self._auto_resize_images = self.options.auto_resize_images
        self._ops = self.options.operations or DefaultReadOperations()

    @property
    def parameters(self) -> dict:
        """Return JSON schema for tool parameters."""
        return ReadToolInput.model_json_schema()

    async def execute(
        self,
        tool_call_id: str,
        path: str,
        offset: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> ReadToolResult:
        """Execute file read."""
        absolute_path = resolve_read_path(path, self.cwd)

        # Check if file exists
        await self._ops.access(absolute_path)

        # Detect if it's an image
        mime_type = await self._ops.detect_image_mime_type(absolute_path)

        if mime_type:
            # Read as image (binary)
            buffer = await self._ops.read_file(absolute_path)
            base64_data = base64.b64encode(buffer).decode("ascii")

            # Note: Auto-resize is not implemented in Python version
            # In production, you might want to use PIL/Pillow for image resizing
            text_note = f"Read image file [{mime_type}]"

            return ReadToolResult(
                content=[
                    {"type": "text", "text": text_note},
                    {"type": "image", "data": base64_data, "mime_type": mime_type},
                ],
                details=None,
            )

        # Read as text
        buffer = await self._ops.read_file(absolute_path)
        text_content = buffer.decode("utf-8", errors="replace")
        all_lines = text_content.split("\n")
        total_file_lines = len(all_lines)

        # Apply offset if specified (1-indexed to 0-indexed)
        start_line = max(0, offset - 1) if offset else 0
        start_line_display = start_line + 1  # For display (1-indexed)

        # Check if offset is out of bounds
        if start_line >= len(all_lines):
            raise RuntimeError(
                f"Offset {offset} is beyond end of file ({len(all_lines)} lines total)"
            )

        # If limit is specified by user, use it; otherwise we'll let truncate_head decide
        user_limited_lines: Optional[int] = None
        if limit is not None:
            end_line = min(start_line + limit, len(all_lines))
            selected_content = "\n".join(all_lines[start_line:end_line])
            user_limited_lines = end_line - start_line
        else:
            selected_content = "\n".join(all_lines[start_line:])

        # Apply truncation (respects both line and byte limits)
        truncation = truncate_head(selected_content)

        details: Optional[ReadToolDetails] = None

        if truncation.first_line_exceeds_limit:
            # First line at offset exceeds limit - tell model to use bash
            first_line_size = format_size(len(all_lines[start_line].encode("utf-8")))
            output_text = (
                f"[Line {start_line_display} is {first_line_size}, exceeds {format_size(DEFAULT_MAX_BYTES)} limit. "
                f"Use bash: sed -n '{start_line_display}p' {path} | head -c {DEFAULT_MAX_BYTES}]"
            )
            details = ReadToolDetails(truncation=truncation)
        elif truncation.truncated:
            # Truncation occurred - build actionable notice
            end_line_display = start_line_display + truncation.output_lines - 1
            next_offset = end_line_display + 1

            output_text = truncation.content

            if truncation.truncated_by == "lines":
                output_text += (
                    f"\n\n[Showing lines {start_line_display}-{end_line_display} of {total_file_lines}. "
                    f"Use offset={next_offset} to continue.]"
                )
            else:
                output_text += (
                    f"\n\n[Showing lines {start_line_display}-{end_line_display} of {total_file_lines} "
                    f"({format_size(DEFAULT_MAX_BYTES)} limit). Use offset={next_offset} to continue.]"
                )
            details = ReadToolDetails(truncation=truncation)
        elif user_limited_lines is not None and start_line + user_limited_lines < len(all_lines):
            # User specified limit, there's more content, but no truncation
            remaining = len(all_lines) - (start_line + user_limited_lines)
            next_offset = start_line + user_limited_lines + 1

            output_text = truncation.content
            output_text += (
                f"\n\n[{remaining} more lines in file. Use offset={next_offset} to continue.]"
            )
        else:
            # No truncation, no user limit exceeded
            output_text = truncation.content

        return ReadToolResult(
            content=[{"type": "text", "text": output_text}],
            details=details,
        )


def create_read_tool(cwd: str, options: Optional[ReadToolOptions] = None) -> ReadTool:
    """Create a read tool configured for a specific working directory."""
    return ReadTool(cwd, options)


def read_tool() -> ReadTool:
    """Get default read tool using current working directory."""
    return create_read_tool(os.getcwd())
