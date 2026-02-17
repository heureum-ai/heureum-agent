"""Directory listing tool.

Source: pi-mono/packages/coding-agent/src/core/tools/ls.ts
"""

from __future__ import annotations

import asyncio
import heapq
import os
from typing import Any, List, Optional, Protocol

from pydantic import BaseModel, Field

from .path_utils import resolve_to_cwd
from .truncate import DEFAULT_MAX_BYTES, TruncationResult, format_size, truncate_head


class LsToolInput(BaseModel):
    """Input schema for ls tool."""

    path: Optional[str] = Field(
        default=None, description="Directory to list (default: current directory)"
    )
    limit: Optional[int] = Field(
        default=None, description="Maximum number of entries to return (default: 500)"
    )


DEFAULT_LIMIT = 500


class LsToolDetails(BaseModel):
    """Details returned from ls tool execution."""

    truncation: Optional[TruncationResult] = None
    entry_limit_reached: Optional[int] = None


class LsOperations(Protocol):
    """Protocol for pluggable ls operations.

    Override these to delegate directory listing to remote systems (e.g., SSH).
    """

    def exists(self, absolute_path: str) -> bool:
        """Check if path exists."""
        ...

    def stat(self, absolute_path: str) -> Any:
        """Get file/directory stats. Throws if not found."""
        ...

    def readdir(self, absolute_path: str) -> List[str]:
        """Read directory entries."""
        ...


class _DefaultStatResult:
    """Default stat result wrapper matching TypeScript interface."""

    def __init__(self, path: str):
        self._path = path
        self._stat = os.stat(path)

    def is_directory(self) -> bool:
        """Check if path is a directory."""
        import stat

        return stat.S_ISDIR(self._stat.st_mode)


class DefaultLsOperations:
    """Default ls operations using local filesystem."""

    def exists(self, absolute_path: str) -> bool:
        """Check if path exists."""
        return os.path.exists(absolute_path)

    def stat(self, absolute_path: str) -> _DefaultStatResult:
        """Get file/directory stats."""
        return _DefaultStatResult(absolute_path)

    def readdir(self, absolute_path: str) -> List[str]:
        """Read directory entries."""
        return os.listdir(absolute_path)


class LsToolOptions(BaseModel):
    """Options for ls tool creation."""

    model_config = {"arbitrary_types_allowed": True}

    operations: Optional[Any] = None  # LsOperations


class LsToolResult(BaseModel):
    """Result from ls tool execution."""

    content: List[dict]
    details: Optional[LsToolDetails] = None


class LsTool:
    """Directory listing tool."""

    name = "ls"
    label = "ls"
    description = (
        f"List directory contents. Returns entries sorted alphabetically, with '/' suffix for directories. "
        f"Includes dotfiles. Output is truncated to {DEFAULT_LIMIT} entries or "
        f"{DEFAULT_MAX_BYTES // 1024}KB (whichever is hit first)."
    )

    def __init__(self, cwd: str, options: Optional[LsToolOptions] = None):
        self.cwd = cwd
        self.options = options or LsToolOptions()
        self._ops = self.options.operations or DefaultLsOperations()

    @property
    def parameters(self) -> dict:
        """Return JSON schema for tool parameters."""
        return LsToolInput.model_json_schema()

    async def execute(
        self,
        tool_call_id: str,
        path: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> LsToolResult:
        """Execute directory listing."""
        dir_path = resolve_to_cwd(path or ".", self.cwd)
        effective_limit = limit if limit is not None else DEFAULT_LIMIT

        # Check if path exists
        if not await asyncio.to_thread(self._ops.exists, dir_path):
            raise RuntimeError(f"Path not found: {dir_path}")

        # Check if path is a directory
        stat_result = await asyncio.to_thread(self._ops.stat, dir_path)
        if not stat_result.is_directory():
            raise RuntimeError(f"Not a directory: {dir_path}")

        # Read directory entries
        try:
            entries = await asyncio.to_thread(self._ops.readdir, dir_path)
        except Exception as e:
            raise RuntimeError(f"Cannot read directory: {e}")

        # Sort alphabetically (case-insensitive) - matches TypeScript localeCompare
        use_heap = effective_limit > 0 and effective_limit < len(entries)
        heap: Optional[List[tuple[str, int, str]]] = None

        if use_heap:
            heap = [(entry.lower(), idx, entry) for idx, entry in enumerate(entries)]
            heapq.heapify(heap)
        else:
            entries.sort(key=lambda a: a.lower())

        # Format entries with directory indicators
        results: List[str] = []
        entry_limit_reached = False

        if heap is None:
            for entry in entries:
                if len(results) >= effective_limit:
                    entry_limit_reached = True
                    break

                full_path = os.path.join(dir_path, entry)
                suffix = ""

                try:
                    entry_stat = await asyncio.to_thread(self._ops.stat, full_path)
                    if entry_stat.is_directory():
                        suffix = "/"
                except Exception:
                    # Skip entries we can't stat
                    continue

                results.append(entry + suffix)
        else:
            while heap:
                if len(results) >= effective_limit:
                    entry_limit_reached = True
                    break

                _, _, entry = heapq.heappop(heap)
                full_path = os.path.join(dir_path, entry)
                suffix = ""

                try:
                    entry_stat = self._ops.stat(full_path)
                    if entry_stat.is_directory():
                        suffix = "/"
                except Exception:
                    # Skip entries we can't stat
                    continue

                results.append(entry + suffix)

        if not results:
            return LsToolResult(
                content=[{"type": "text", "text": "(empty directory)"}],
                details=None,
            )

        # Apply byte truncation (no line limit since we already have entry limit)
        raw_output = "\n".join(results)
        truncation = truncate_head(raw_output, max_lines=2**53 - 1)  # Number.MAX_SAFE_INTEGER

        output = truncation.content
        details: dict = {}

        # Build notices
        notices: List[str] = []

        if entry_limit_reached:
            notices.append(
                f"{effective_limit} entries limit reached. Use limit={effective_limit * 2} for more"
            )
            details["entry_limit_reached"] = effective_limit

        if truncation.truncated:
            notices.append(f"{format_size(DEFAULT_MAX_BYTES)} limit reached")
            details["truncation"] = truncation

        if notices:
            output += f"\n\n[{'. '.join(notices)}]"

        result_details = None
        if details:
            result_details = LsToolDetails(
                truncation=details.get("truncation"),
                entry_limit_reached=details.get("entry_limit_reached"),
            )

        return LsToolResult(
            content=[{"type": "text", "text": output}],
            details=result_details,
        )


def create_ls_tool(cwd: str, options: Optional[LsToolOptions] = None) -> LsTool:
    """Create a ls tool configured for a specific working directory."""
    return LsTool(cwd, options)


def ls_tool() -> LsTool:
    """Get default ls tool using current working directory."""
    return create_ls_tool(os.getcwd())
