"""Find (glob) file search tool.

Source: pi-mono/packages/coding-agent/src/core/tools/find.ts
"""

from __future__ import annotations

import asyncio
import glob as glob_module
import os
import shutil
from pathlib import Path
from typing import Any, List, Optional, Protocol

from pydantic import BaseModel, Field

from .path_utils import resolve_to_cwd
from .truncate import DEFAULT_MAX_BYTES, TruncationResult, format_size, truncate_head


class FindToolInput(BaseModel):
    """Input schema for find tool."""

    pattern: str = Field(
        description="Glob pattern to match files, e.g. '*.ts', '**/*.json', or 'src/**/*.spec.ts'"
    )
    path: Optional[str] = Field(
        default=None, description="Directory to search in (default: current directory)"
    )
    limit: Optional[int] = Field(
        default=None, description="Maximum number of results (default: 1000)"
    )


DEFAULT_LIMIT = 1000


class FindToolDetails(BaseModel):
    """Details returned from find tool execution."""

    truncation: Optional[TruncationResult] = None
    result_limit_reached: Optional[int] = None


class FindOperations(Protocol):
    """Protocol for pluggable find operations."""

    async def exists(self, absolute_path: str) -> bool:
        """Check if path exists."""
        ...

    async def glob(
        self,
        pattern: str,
        cwd: str,
        ignore: List[str],
        limit: int,
    ) -> List[str]:
        """Find files matching glob pattern. Returns relative paths."""
        ...


class DefaultFindOperations:
    """Default find operations using local filesystem."""

    async def exists(self, absolute_path: str) -> bool:
        """Check if path exists."""
        return os.path.exists(absolute_path)

    async def glob(
        self,
        pattern: str,
        cwd: str,
        ignore: List[str],
        limit: int,
    ) -> List[str]:
        """Find files matching glob pattern."""
        # This is a placeholder - actual fd execution happens in execute
        return []


class FindToolOptions(BaseModel):
    """Options for find tool creation."""

    model_config = {"arbitrary_types_allowed": True}

    operations: Optional[Any] = None  # FindOperations


class FindToolResult(BaseModel):
    """Result from find tool execution."""

    content: List[dict]
    details: Optional[FindToolDetails] = None


def _ensure_fd() -> Optional[str]:
    """Ensure fd is available, return path or None."""
    fd_path = shutil.which("fd")
    return fd_path


def _python_glob_fallback(pattern: str, search_path: str, limit: int) -> List[str]:
    """Fallback implementation when `fd` is unavailable.

    Attempts to mimic `fd --glob` behavior:
    - recursive search under search_path
    - returns paths relative to search_path
    - skips `.git/` and `node_modules/`
    """
    base = Path(search_path)
    if not base.exists():
        raise RuntimeError(f"Path not found: {search_path}")

    results: List[str] = []
    try:
        iterator = base.rglob(pattern)
    except Exception:
        # If the pattern is invalid for rglob, fall back to non-recursive glob.
        iterator = (Path(p) for p in glob_module.glob(str(base / pattern), recursive=True))

    for p in iterator:
        # Skip common heavy/irrelevant directories.
        parts = p.parts
        if ".git" in parts or "node_modules" in parts:
            continue

        rel = os.path.relpath(str(p), search_path)
        if p.is_dir() and not rel.endswith("/"):
            rel += "/"
        results.append(rel)
        if len(results) >= limit:
            break

    results.sort()
    return results


def _find_gitignore_files(search_path: str) -> List[str]:
    """Find all .gitignore files in the search path."""
    gitignore_files = set()

    # Root .gitignore
    root_gitignore = os.path.join(search_path, ".gitignore")
    if os.path.exists(root_gitignore):
        gitignore_files.add(root_gitignore)

    # Nested .gitignore files
    try:
        for path in glob_module.glob(os.path.join(search_path, "**", ".gitignore"), recursive=True):
            # Skip node_modules and .git
            if "node_modules" not in path and ".git" not in path.split(os.sep):
                gitignore_files.add(path)
    except Exception:
        pass

    return list(gitignore_files)


class FindTool:
    """Find file search tool using fd."""

    name = "find"
    label = "find"
    description = (
        f"Search for files by glob pattern. Returns matching file paths relative to the search directory. "
        f"Respects .gitignore. Output is truncated to {DEFAULT_LIMIT} results or "
        f"{DEFAULT_MAX_BYTES // 1024}KB (whichever is hit first)."
    )

    def __init__(self, cwd: str, options: Optional[FindToolOptions] = None):
        self.cwd = cwd
        self.options = options or FindToolOptions()
        self._custom_ops = self.options.operations

    @property
    def parameters(self) -> dict:
        """Return JSON schema for tool parameters."""
        return FindToolInput.model_json_schema()

    async def execute(
        self,
        tool_call_id: str,
        pattern: str,
        path: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> FindToolResult:
        """Execute find search."""
        search_path = resolve_to_cwd(path or ".", self.cwd)
        effective_limit = limit if limit is not None else DEFAULT_LIMIT

        # If custom operations provided with glob, use that
        if self._custom_ops and hasattr(self._custom_ops, "glob"):
            if not await self._custom_ops.exists(search_path):
                raise RuntimeError(f"Path not found: {search_path}")

            results = await self._custom_ops.glob(
                pattern,
                search_path,
                ["**/node_modules/**", "**/.git/**"],
                effective_limit,
            )

            if not results:
                return FindToolResult(
                    content=[{"type": "text", "text": "No files found matching pattern"}],
                    details=None,
                )

            # Relativize paths
            relativized = []
            for p in results:
                if p.startswith(search_path):
                    relativized.append(p[len(search_path) + 1 :])
                else:
                    relativized.append(os.path.relpath(p, search_path))

            result_limit_reached = len(relativized) >= effective_limit
            raw_output = "\n".join(relativized)
            truncation = truncate_head(raw_output, max_lines=2**31 - 1)

            result_output = truncation.content
            details = FindToolDetails()
            notices: List[str] = []

            if result_limit_reached:
                notices.append(f"{effective_limit} results limit reached")
                details.result_limit_reached = effective_limit

            if truncation.truncated:
                notices.append(f"{format_size(DEFAULT_MAX_BYTES)} limit reached")
                details.truncation = truncation

            if notices:
                result_output += f"\n\n[{'. '.join(notices)}]"

            return FindToolResult(
                content=[{"type": "text", "text": result_output}],
                details=(
                    details if any([details.truncation, details.result_limit_reached]) else None
                ),
            )

        # Default: use fd
        fd_path = _ensure_fd()
        if not fd_path:
            # No downloader in the Python port; fall back to a pure-Python implementation.
            relativized = await asyncio.to_thread(
                _python_glob_fallback, pattern, search_path, effective_limit
            )

            if not relativized:
                return FindToolResult(
                    content=[{"type": "text", "text": "No files found matching pattern"}],
                    details=None,
                )

            result_limit_reached = len(relativized) >= effective_limit
            raw_output = "\n".join(relativized)
            truncation = truncate_head(raw_output, max_lines=2**31 - 1)

            result_output = truncation.content
            details = FindToolDetails()
            notices: List[str] = []

            if result_limit_reached:
                notices.append(
                    f"{effective_limit} results limit reached. Use limit={effective_limit * 2} for more, or refine pattern"
                )
                details.result_limit_reached = effective_limit

            if truncation.truncated:
                notices.append(f"{format_size(DEFAULT_MAX_BYTES)} limit reached")
                details.truncation = truncation

            if notices:
                result_output += f"\n\n[{'. '.join(notices)}]"

            return FindToolResult(
                content=[{"type": "text", "text": result_output}],
                details=(
                    details if any([details.truncation, details.result_limit_reached]) else None
                ),
            )

        # Build fd arguments
        args = [
            fd_path,
            "--glob",
            "--color=never",
            "--hidden",
            "--max-results",
            str(effective_limit),
        ]

        # Include .gitignore files
        gitignore_files = await asyncio.to_thread(_find_gitignore_files, search_path)
        for gitignore_path in gitignore_files:
            args.extend(["--ignore-file", gitignore_path])

        args.extend([pattern, search_path])

        # Run fd
        process = await asyncio.create_subprocess_exec(
            *args,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )

        stdout, stderr = await process.communicate()
        output = stdout.decode("utf-8", errors="replace").strip()

        if process.returncode != 0 and process.returncode != 1:
            error_msg = stderr.decode("utf-8", errors="replace").strip()
            if error_msg and not output:
                raise RuntimeError(error_msg)

        if not output:
            return FindToolResult(
                content=[{"type": "text", "text": "No files found matching pattern"}],
                details=None,
            )

        # Process output
        lines = output.split("\n")
        relativized: List[str] = []

        for raw_line in lines:
            line = raw_line.rstrip("\r").strip()
            if not line:
                continue

            had_trailing_slash = line.endswith("/") or line.endswith("\\")
            relative_path = line

            if line.startswith(search_path):
                relative_path = line[len(search_path) + 1 :]
            else:
                relative_path = os.path.relpath(line, search_path)

            if had_trailing_slash and not relative_path.endswith("/"):
                relative_path += "/"

            relativized.append(relative_path)

        result_limit_reached = len(relativized) >= effective_limit
        raw_output = "\n".join(relativized)
        truncation = truncate_head(raw_output, max_lines=2**31 - 1)

        result_output = truncation.content
        details = FindToolDetails()
        notices: List[str] = []

        if result_limit_reached:
            notices.append(
                f"{effective_limit} results limit reached. Use limit={effective_limit * 2} for more, or refine pattern"
            )
            details.result_limit_reached = effective_limit

        if truncation.truncated:
            notices.append(f"{format_size(DEFAULT_MAX_BYTES)} limit reached")
            details.truncation = truncation

        if notices:
            result_output += f"\n\n[{'. '.join(notices)}]"

        return FindToolResult(
            content=[{"type": "text", "text": result_output}],
            details=(details if any([details.truncation, details.result_limit_reached]) else None),
        )


def create_find_tool(cwd: str, options: Optional[FindToolOptions] = None) -> FindTool:
    """Create a find tool configured for a specific working directory."""
    return FindTool(cwd, options)


def find_tool() -> FindTool:
    """Get default find tool using current working directory."""
    return create_find_tool(os.getcwd())
