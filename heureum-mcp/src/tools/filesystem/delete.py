"""File delete tool.

Deletes a single file from the filesystem.
"""

from __future__ import annotations

import asyncio
import os
from typing import Any, Dict, List, Optional, Protocol

from pydantic import BaseModel, Field

from .path_utils import resolve_to_cwd


class DeleteToolInput(BaseModel):
    """Input schema for delete tool."""

    path: str = Field(description="Path to the file to delete (relative or absolute)")


class DeleteOperations(Protocol):
    """Protocol for pluggable delete operations."""

    async def delete_file(self, absolute_path: str) -> None:
        """Delete a file."""
        ...


class DefaultDeleteOperations:
    """Default delete operations using local filesystem."""

    async def delete_file(self, absolute_path: str) -> None:
        """Delete a file."""

        def _delete() -> None:
            if not os.path.exists(absolute_path):
                raise FileNotFoundError(f"File not found: {absolute_path}")
            os.remove(absolute_path)

        await asyncio.to_thread(_delete)


class DeleteToolOptions(BaseModel):
    """Options for delete tool creation."""

    model_config = {"arbitrary_types_allowed": True}

    operations: Optional[Any] = None  # DeleteOperations


class DeleteToolResult(BaseModel):
    """Result from delete tool execution."""

    content: List[Dict[str, str]]
    details: None = None


class DeleteTool:
    """File delete tool."""

    name = "delete"
    label = "delete"
    description = "Delete a file from the filesystem."

    def __init__(self, cwd: str, options: Optional[DeleteToolOptions] = None):
        self.cwd = cwd
        self.options = options or DeleteToolOptions()
        self._ops = self.options.operations or DefaultDeleteOperations()

    @property
    def parameters(self) -> dict:
        """Return JSON schema for tool parameters."""
        return DeleteToolInput.model_json_schema()

    async def execute(
        self,
        tool_call_id: str,
        path: str,
    ) -> DeleteToolResult:
        """Execute file delete."""
        absolute_path = resolve_to_cwd(path, self.cwd)

        await self._ops.delete_file(absolute_path)

        return DeleteToolResult(
            content=[
                {
                    "type": "text",
                    "text": f"Deleted {path}",
                }
            ],
            details=None,
        )
