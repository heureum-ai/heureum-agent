"""File write tool.

Source: pi-mono/packages/coding-agent/src/core/tools/write.ts
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, Dict, List, Optional, Protocol

from pydantic import BaseModel, Field

from .path_utils import resolve_to_cwd


class WriteToolInput(BaseModel):
    """Input schema for write tool."""

    path: str = Field(description="Path to the file to write (relative or absolute)")
    content: str = Field(description="Content to write to the file")


class WriteOperations(Protocol):
    """Protocol for pluggable write operations."""

    async def write_file(self, absolute_path: str, content: str) -> None:
        """Write content to a file."""
        ...

    async def mkdir(self, directory: str) -> None:
        """Create directory (recursively)."""
        ...


class DefaultWriteOperations:
    """Default write operations using local filesystem."""

    async def write_file(self, absolute_path: str, content: str) -> None:
        """Write content to a file."""

        def _write() -> None:
            with open(absolute_path, "w", encoding="utf-8") as f:
                f.write(content)

        await asyncio.to_thread(_write)

    async def mkdir(self, directory: str) -> None:
        """Create directory recursively."""
        await asyncio.to_thread(os.makedirs, directory, exist_ok=True)


class WriteToolOptions(BaseModel):
    """Options for write tool creation."""

    model_config = {"arbitrary_types_allowed": True}

    operations: Optional[Any] = None  # WriteOperations


class WriteToolResult(BaseModel):
    """Result from write tool execution."""

    content: List[Dict[str, str]]
    details: None = None


class WriteTool:
    """File write tool."""

    name = "write"
    label = "write"
    description = (
        "Write content to a file. Creates the file if it doesn't exist, "
        "overwrites if it does. Automatically creates parent directories."
    )

    def __init__(self, cwd: str, options: Optional[WriteToolOptions] = None):
        self.cwd = cwd
        self.options = options or WriteToolOptions()
        self._ops = self.options.operations or DefaultWriteOperations()

    @property
    def parameters(self) -> dict:
        """Return JSON schema for tool parameters."""
        return WriteToolInput.model_json_schema()

    async def execute(
        self,
        tool_call_id: str,
        path: str,
        content: str,
    ) -> WriteToolResult:
        """Execute file write."""
        absolute_path = resolve_to_cwd(path, self.cwd)
        directory = os.path.dirname(absolute_path)

        # Create parent directories if needed
        if directory:
            await self._ops.mkdir(directory)

        # Write the file
        await self._ops.write_file(absolute_path, content)

        return WriteToolResult(
            content=[
                {
                    "type": "text",
                    "text": f"Successfully wrote {len(content)} bytes to {path}",
                }
            ],
            details=None,
        )


def create_write_tool(cwd: str, options: Optional[WriteToolOptions] = None) -> WriteTool:
    """Create a write tool configured for a specific working directory."""
    return WriteTool(cwd, options)


def write_tool() -> WriteTool:
    """Get default write tool using current working directory."""
    return create_write_tool(os.getcwd())
