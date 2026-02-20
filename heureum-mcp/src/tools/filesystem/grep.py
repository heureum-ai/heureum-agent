"""Grep (ripgrep) pattern search tool.

Source: pi-mono/packages/coding-agent/src/core/tools/grep.ts
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
from typing import Any, Callable, Dict, List, Optional, Protocol

from pydantic import BaseModel, Field

from .path_utils import resolve_to_cwd
from .truncate import (
    DEFAULT_MAX_BYTES,
    GREP_MAX_LINE_LENGTH,
    TruncationResult,
    format_size,
    truncate_head,
    truncate_line,
)


class GrepToolInput(BaseModel):
    """Input schema for grep tool."""

    pattern: str = Field(description="Search pattern (regex or literal string)")
    path: Optional[str] = Field(
        default=None,
        description="Directory or file to search (default: current directory)",
    )
    glob: Optional[str] = Field(
        default=None,
        description="Filter files by glob pattern, e.g. '*.ts' or '**/*.spec.ts'",
    )
    ignore_case: Optional[bool] = Field(
        default=None, description="Case-insensitive search (default: false)"
    )
    literal: Optional[bool] = Field(
        default=None,
        description="Treat pattern as literal string instead of regex (default: false)",
    )
    context: Optional[int] = Field(
        default=None,
        description="Number of lines to show before and after each match (default: 0)",
    )
    limit: Optional[int] = Field(
        default=None, description="Maximum number of matches to return (default: 100)"
    )


DEFAULT_LIMIT = 100


class GrepToolDetails(BaseModel):
    """Details returned from grep tool execution."""

    truncation: Optional[TruncationResult] = None
    match_limit_reached: Optional[int] = None
    lines_truncated: Optional[bool] = None


class GrepOperations(Protocol):
    """Protocol for pluggable grep operations.

    Override these to delegate search to remote systems (e.g., SSH).
    """

    def is_directory(self, absolute_path: str) -> bool:
        """Check if path is a directory. Throws if path doesn't exist."""
        ...

    def read_file(self, absolute_path: str) -> str:
        """Read file contents for context lines."""
        ...


class DefaultGrepOperations:
    """Default grep operations using local filesystem."""

    def is_directory(self, absolute_path: str) -> bool:
        """Check if path is a directory."""
        return os.stat(absolute_path).st_mode & 0o170000 == 0o040000  # S_ISDIR

    def read_file(self, absolute_path: str) -> str:
        """Read file contents."""
        with open(absolute_path, "r", encoding="utf-8", errors="replace") as f:
            return f.read()


class GrepToolOptions(BaseModel):
    """Options for grep tool creation."""

    model_config = {"arbitrary_types_allowed": True}

    operations: Optional[Any] = None  # GrepOperations


class GrepToolResult(BaseModel):
    """Result from grep tool execution."""

    content: List[Dict[str, str]]
    details: Optional[GrepToolDetails] = None


class GrepTool:
    """Grep pattern search tool using ripgrep."""

    name = "grep"
    label = "grep"
    description = (
        f"Search file contents for a pattern. Returns matching lines with file paths and line numbers. "
        f"Respects .gitignore. Output is truncated to {DEFAULT_LIMIT} matches or "
        f"{DEFAULT_MAX_BYTES // 1024}KB (whichever is hit first). "
        f"Long lines are truncated to {GREP_MAX_LINE_LENGTH} chars."
    )

    def __init__(self, cwd: str, options: Optional[GrepToolOptions] = None):
        self.cwd = cwd
        self.options = options or GrepToolOptions()
        self._custom_ops = self.options.operations

    @property
    def parameters(self) -> dict:
        """Return JSON schema for tool parameters."""
        return GrepToolInput.model_json_schema()

    async def execute(
        self,
        tool_call_id: str,
        pattern: str,
        path: Optional[str] = None,
        glob: Optional[str] = None,
        ignore_case: Optional[bool] = None,
        literal: Optional[bool] = None,
        context: Optional[int] = None,
        limit: Optional[int] = None,
        signal: Optional[asyncio.Event] = None,
    ) -> GrepToolResult:
        """Execute grep search."""
        loop = asyncio.get_event_loop()
        future: asyncio.Future[GrepToolResult] = loop.create_future()

        if signal and signal.is_set():
            future.set_exception(RuntimeError("Operation aborted"))
            return await future

        settled = False

        def settle(fn: Callable[[], None]) -> None:
            nonlocal settled
            if not settled:
                settled = True
                fn()

        async def run() -> None:
            nonlocal settled
            try:
                rg_path = shutil.which("rg")
                if not rg_path:
                    settle(
                        lambda: future.set_exception(
                            RuntimeError(
                                "ripgrep (rg) is not available and could not be downloaded"
                            )
                        )
                    )
                    return

                search_path = resolve_to_cwd(path or ".", self.cwd)
                ops = self._custom_ops if self._custom_ops else DefaultGrepOperations()

                is_directory: bool
                try:
                    is_directory = ops.is_directory(search_path)
                except Exception:
                    settle(
                        lambda: future.set_exception(RuntimeError(f"Path not found: {search_path}"))
                    )
                    return

                context_value = context if context and context > 0 else 0
                effective_limit = max(1, limit if limit is not None else DEFAULT_LIMIT)

                path_cache: Dict[str, str] = {}

                def format_path(file_path: str) -> str:
                    cached = path_cache.get(file_path)
                    if cached is not None:
                        return cached

                    if is_directory:
                        relative = os.path.relpath(file_path, search_path)
                        if relative and not relative.startswith(".."):
                            cached = relative.replace("\\", "/")
                        else:
                            cached = os.path.basename(file_path)
                    else:
                        cached = os.path.basename(file_path)

                    path_cache[file_path] = cached
                    return cached

                file_cache: Dict[str, List[str]] = {}

                async def get_file_lines(file_path: str) -> List[str]:
                    if file_path not in file_cache:
                        try:
                            content = await asyncio.to_thread(ops.read_file, file_path)
                            lines = content.replace("\r\n", "\n").replace("\r", "\n").split("\n")
                        except Exception:
                            lines = []
                        file_cache[file_path] = lines
                    return file_cache[file_path]

                args: List[str] = [
                    rg_path,
                    "--json",
                    "--line-number",
                    "--color=never",
                    "--hidden",
                ]

                if ignore_case:
                    args.append("--ignore-case")

                if literal:
                    args.append("--fixed-strings")

                if glob:
                    args.extend(["--glob", glob])

                args.extend([pattern, search_path])

                child = await asyncio.create_subprocess_exec(
                    *args,
                    stdout=asyncio.subprocess.PIPE,
                    stderr=asyncio.subprocess.PIPE,
                    stdin=asyncio.subprocess.DEVNULL,
                )

                stderr = ""
                match_count = 0
                match_limit_reached = False
                lines_truncated = False
                aborted = False
                killed_due_to_limit = False
                output_lines: List[str] = []

                # Collect matches during streaming, format after
                matches: List[Dict[str, Any]] = []

                def stop_child(due_to_limit: bool = False) -> None:
                    nonlocal killed_due_to_limit
                    if child.returncode is None:
                        killed_due_to_limit = due_to_limit
                        child.kill()

                def on_abort() -> None:
                    nonlocal aborted
                    aborted = True
                    stop_child()

                # Set up abort handling
                abort_task = None
                if signal:

                    async def watch_abort():
                        await asyncio.get_event_loop().run_in_executor(None, signal.wait)
                        on_abort()

                    abort_task = asyncio.create_task(watch_abort())

                async def format_block(file_path: str, line_number: int) -> List[str]:
                    nonlocal lines_truncated
                    relative_path = format_path(file_path)
                    lines = await get_file_lines(file_path)
                    if not lines:
                        return [f"{relative_path}:{line_number}: (unable to read file)"]

                    if context_value == 0:
                        line_text = lines[line_number - 1] if line_number <= len(lines) else ""
                        sanitized = line_text.replace("\r", "")

                        # Truncate long lines
                        result = truncate_line(sanitized)
                        if result.was_truncated:
                            lines_truncated = True

                        return [f"{relative_path}:{line_number}: {result.text}"]

                    block: List[str] = []
                    start = (
                        max(1, line_number - context_value) if context_value > 0 else line_number
                    )
                    end = (
                        min(len(lines), line_number + context_value)
                        if context_value > 0
                        else line_number
                    )

                    for current in range(start, end + 1):
                        line_text = lines[current - 1] if current <= len(lines) else ""
                        sanitized = line_text.replace("\r", "")
                        is_match_line = current == line_number

                        # Truncate long lines
                        result = truncate_line(sanitized)
                        if result.was_truncated:
                            lines_truncated = True

                        if is_match_line:
                            block.append(f"{relative_path}:{current}: {result.text}")
                        else:
                            block.append(f"{relative_path}-{current}- {result.text}")

                    return block

                # Read stdout line by line (streaming)
                assert child.stdout is not None
                async for line_bytes in child.stdout:
                    line = line_bytes.decode("utf-8", errors="replace").rstrip("\n")

                    if not line.strip() or match_count >= effective_limit:
                        continue

                    try:
                        event = json.loads(line)
                    except json.JSONDecodeError:
                        continue

                    if event.get("type") == "match":
                        match_count += 1
                        file_path = event.get("data", {}).get("path", {}).get("text")
                        line_number = event.get("data", {}).get("line_number")

                        if file_path and isinstance(line_number, int):
                            matches.append({"filePath": file_path, "lineNumber": line_number})

                        if match_count >= effective_limit:
                            match_limit_reached = True
                            stop_child(True)

                # Read stderr
                if child.stderr:
                    stderr_bytes = await child.stderr.read()
                    stderr = stderr_bytes.decode("utf-8", errors="replace")

                # Wait for process to complete
                code = await child.wait()

                # Cancel abort watcher
                if abort_task:
                    abort_task.cancel()
                    try:
                        await abort_task
                    except asyncio.CancelledError:
                        pass

                if aborted:
                    settle(lambda: future.set_exception(RuntimeError("Operation aborted")))
                    return

                if not killed_due_to_limit and code != 0 and code != 1:
                    error_msg = stderr.strip() or f"ripgrep exited with code {code}"
                    settle(lambda: future.set_exception(RuntimeError(error_msg)))
                    return

                if match_count == 0:
                    settle(
                        lambda: future.set_result(
                            GrepToolResult(
                                content=[{"type": "text", "text": "No matches found"}],
                                details=None,
                            )
                        )
                    )
                    return

                # Format matches in parallel (preserving order)
                async def format_with_index(idx: int, m: Dict[str, Any]) -> tuple:
                    block = await format_block(m["filePath"], m["lineNumber"])
                    return idx, block

                tasks = [format_with_index(i, m) for i, m in enumerate(matches)]
                results = await asyncio.gather(*tasks)
                results.sort(key=lambda x: x[0])

                for _, block in results:
                    output_lines.extend(block)

                # Apply byte truncation (no line limit since we already have match limit)
                raw_output = "\n".join(output_lines)
                truncation = truncate_head(
                    raw_output, max_lines=2**53 - 1
                )  # Number.MAX_SAFE_INTEGER

                output = truncation.content
                details: Dict[str, Any] = {}

                # Build notices
                notices: List[str] = []

                if match_limit_reached:
                    notices.append(
                        f"{effective_limit} matches limit reached. Use limit={effective_limit * 2} for more, or refine pattern"
                    )
                    details["match_limit_reached"] = effective_limit

                if truncation.truncated:
                    notices.append(f"{format_size(DEFAULT_MAX_BYTES)} limit reached")
                    details["truncation"] = truncation

                if lines_truncated:
                    notices.append(
                        f"Some lines truncated to {GREP_MAX_LINE_LENGTH} chars. Use read tool to see full lines"
                    )
                    details["lines_truncated"] = True

                if notices:
                    output += f"\n\n[{'. '.join(notices)}]"

                result_details = None
                if details:
                    result_details = GrepToolDetails(
                        truncation=details.get("truncation"),
                        match_limit_reached=details.get("match_limit_reached"),
                        lines_truncated=details.get("lines_truncated"),
                    )

                settle(
                    lambda: future.set_result(
                        GrepToolResult(
                            content=[{"type": "text", "text": output}],
                            details=result_details,
                        )
                    )
                )

            except Exception as e:
                settle(lambda exc=e: future.set_exception(exc))

        asyncio.create_task(run())
        return await future


def create_grep_tool(cwd: str, options: Optional[GrepToolOptions] = None) -> GrepTool:
    """Create a grep tool configured for a specific working directory."""
    return GrepTool(cwd, options)


def grep_tool() -> GrepTool:
    """Get default grep tool using current working directory."""
    return create_grep_tool(os.getcwd())
