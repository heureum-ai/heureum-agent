"""Bash command execution tool.

Source: pi-mono/packages/coding-agent/src/core/tools/bash.ts
"""

from __future__ import annotations

import asyncio
import os
import secrets
import signal
import tempfile
from typing import Any, Callable, Dict, List, Optional, Protocol

from pydantic import BaseModel, Field

from .truncate import (
    DEFAULT_MAX_BYTES,
    DEFAULT_MAX_LINES,
    TruncationResult,
    format_size,
    truncate_tail,
)


def _get_temp_file_path() -> str:
    """Generate a unique temp file path for bash output."""
    random_id = secrets.token_hex(8)
    return os.path.join(tempfile.gettempdir(), f"pi-bash-{random_id}.log")


class BashToolInput(BaseModel):
    """Input schema for bash tool."""

    command: str = Field(description="Bash command to execute")
    timeout: Optional[int] = Field(
        default=None, description="Timeout in seconds (optional, no default timeout)"
    )


class BashToolDetails(BaseModel):
    """Details returned from bash tool execution."""

    truncation: Optional[TruncationResult] = None
    full_output_path: Optional[str] = None


class BashOperations(Protocol):
    """Protocol for pluggable bash operations.

    Override these to delegate command execution to remote systems (e.g., SSH).
    """

    async def exec(
        self,
        command: str,
        cwd: str,
        *,
        on_data: Callable[[bytes], None],
        timeout: Optional[int] = None,
        env: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """Execute a command and stream output.

        Args:
            command: The command to execute
            cwd: Working directory
            on_data: Callback for output data
            timeout: Timeout in seconds
            env: Environment variables

        Returns:
            Dict with 'exit_code' key (int or None if killed)
        """
        ...


class DefaultBashOperations:
    """Default bash operations using local shell."""

    async def exec(
        self,
        command: str,
        cwd: str,
        *,
        on_data: Callable[[bytes], None],
        timeout: Optional[int] = None,
        env: Optional[Dict[str, str]] = None,
    ) -> Dict[str, Any]:
        """Execute command using asyncio subprocess."""
        if not os.path.exists(cwd):
            raise RuntimeError(
                f"Working directory does not exist: {cwd}\nCannot execute bash commands."
            )

        shell_env = env if env is not None else dict(os.environ)

        process = await asyncio.create_subprocess_shell(
            command,
            cwd=cwd,
            env=shell_env,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            start_new_session=True,
        )

        timed_out = False

        async def read_output():
            nonlocal timed_out
            assert process.stdout is not None
            while True:
                chunk = await process.stdout.read(4096)
                if not chunk:
                    break
                on_data(chunk)

        try:
            if timeout is not None and timeout > 0:
                await asyncio.wait_for(read_output(), timeout=timeout)
            else:
                await read_output()
        except asyncio.TimeoutError:
            timed_out = True
            # Kill the process group
            try:
                os.killpg(os.getpgid(process.pid), signal.SIGTERM)
            except (ProcessLookupError, OSError):
                pass

        await process.wait()

        if timed_out:
            raise TimeoutError(f"timeout:{timeout}")

        return {"exit_code": process.returncode}


class BashSpawnContext(BaseModel):
    """Context for bash command spawning."""

    command: str
    cwd: str
    env: Dict[str, str]


# Type alias for spawn hook
BashSpawnHook = Callable[[BashSpawnContext], BashSpawnContext]


def _resolve_spawn_context(
    command: str,
    cwd: str,
    spawn_hook: Optional[BashSpawnHook] = None,
) -> BashSpawnContext:
    """Resolve the spawn context, applying hook if provided."""
    base_context = BashSpawnContext(
        command=command,
        cwd=cwd,
        env=dict(os.environ),
    )
    return spawn_hook(base_context) if spawn_hook else base_context


class BashToolOptions(BaseModel):
    """Options for bash tool creation."""

    model_config = {"arbitrary_types_allowed": True}

    operations: Optional[Any] = None  # BashOperations
    command_prefix: Optional[str] = None
    spawn_hook: Optional[Any] = None  # BashSpawnHook


class BashToolResult(BaseModel):
    """Result from bash tool execution."""

    content: List[Dict[str, str]]
    details: Optional[BashToolDetails] = None


class BashTool:
    """Bash command execution tool."""

    name = "bash"
    label = "bash"
    description = (
        f"Execute a bash command in the current working directory. "
        f"Returns stdout and stderr. Output is truncated to last {DEFAULT_MAX_LINES} lines "
        f"or {DEFAULT_MAX_BYTES // 1024}KB (whichever is hit first). "
        f"If truncated, full output is saved to a temp file. "
        f"Optionally provide a timeout in seconds."
    )

    def __init__(
        self,
        cwd: str,
        options: Optional[BashToolOptions] = None,
    ):
        self.cwd = cwd
        self.options = options or BashToolOptions()
        self._ops = self.options.operations or DefaultBashOperations()
        self._command_prefix = self.options.command_prefix
        self._spawn_hook = self.options.spawn_hook

    @property
    def parameters(self) -> dict:
        """Return JSON schema for tool parameters."""
        return BashToolInput.model_json_schema()

    async def execute(
        self,
        tool_call_id: str,
        command: str,
        timeout: Optional[int] = None,
        on_update: Optional[Callable[[Dict[str, Any]], None]] = None,
    ) -> BashToolResult:
        """Execute a bash command."""
        # Apply command prefix if configured
        resolved_command = f"{self._command_prefix}\n{command}" if self._command_prefix else command
        spawn_context = _resolve_spawn_context(resolved_command, self.cwd, self._spawn_hook)

        # Track output
        temp_file_path: Optional[str] = None
        temp_file = None
        total_bytes = 0

        # Keep a rolling buffer of the last chunks for tail truncation
        chunks: list[bytes] = []
        chunk_newlines: Optional[list[int]] = [] if on_update else None
        chunks_bytes = 0
        rolling_buffer = bytearray()
        rolling_newlines = 0
        max_chunks_bytes = DEFAULT_MAX_BYTES * 2

        def handle_data(data: bytes) -> None:
            nonlocal temp_file_path, temp_file, total_bytes, chunks_bytes, rolling_newlines

            total_bytes += len(data)

            # Start writing to temp file once we exceed the threshold
            if total_bytes > DEFAULT_MAX_BYTES and temp_file_path is None:
                temp_file_path = _get_temp_file_path()
                temp_file = open(temp_file_path, "wb")
                # Write all buffered chunks to the file
                for chunk in chunks:
                    temp_file.write(chunk)

            # Write to temp file if we have one
            if temp_file is not None:
                temp_file.write(data)

            # Keep rolling buffer of recent data
            chunks.append(data)
            chunks_bytes += len(data)
            rolling_buffer.extend(data)
            if chunk_newlines is not None:
                newlines = data.count(b"\n")
                rolling_newlines += newlines
                chunk_newlines.append(newlines)

            # Trim old chunks if buffer is too large
            while chunks_bytes > max_chunks_bytes and len(chunks) > 1:
                removed = chunks.pop(0)
                chunks_bytes -= len(removed)
                if chunk_newlines is not None:
                    removed_newlines = chunk_newlines.pop(0)
                    rolling_newlines -= removed_newlines
                del rolling_buffer[: len(removed)]

            # Stream partial output to callback
            if on_update:
                full_text = rolling_buffer.decode("utf-8", errors="replace")
                truncation = None
                output_text = full_text
                if (
                    len(rolling_buffer) > DEFAULT_MAX_BYTES
                    or rolling_newlines + 1 > DEFAULT_MAX_LINES
                ):
                    truncation = truncate_tail(full_text)
                    output_text = truncation.content
                on_update(
                    {
                        "content": [{"type": "text", "text": output_text or ""}],
                        "details": {
                            "truncation": (
                                truncation if truncation and truncation.truncated else None
                            ),
                            "full_output_path": temp_file_path,
                        },
                    }
                )

        try:
            result = await self._ops.exec(
                spawn_context.command,
                spawn_context.cwd,
                on_data=handle_data,
                timeout=timeout,
                env=spawn_context.env,
            )
            exit_code = result.get("exit_code")
        except TimeoutError as e:
            # Handle timeout
            if temp_file is not None:
                temp_file.close()

            output = bytes(rolling_buffer).decode("utf-8", errors="replace")

            timeout_secs = str(e).split(":")[1] if ":" in str(e) else str(timeout)
            if output:
                output += "\n\n"
            output += f"Command timed out after {timeout_secs} seconds"
            raise RuntimeError(output)
        except Exception:
            if temp_file is not None:
                temp_file.close()
            raise

        # Close temp file stream
        if temp_file is not None:
            temp_file.close()

        # Combine all buffered chunks
        full_output = bytes(rolling_buffer).decode("utf-8", errors="replace")

        # Apply tail truncation
        truncation = truncate_tail(full_output)
        output_text = truncation.content or "(no output)"

        # Build details with truncation info
        details: Optional[BashToolDetails] = None

        if truncation.truncated:
            details = BashToolDetails(
                truncation=truncation,
                full_output_path=temp_file_path,
            )

            # Build actionable notice
            start_line = truncation.total_lines - truncation.output_lines + 1
            end_line = truncation.total_lines

            if truncation.last_line_partial:
                # Edge case: last line alone > limit
                last_line = full_output.split("\n")[-1] if full_output else ""
                last_line_size = format_size(len(last_line.encode("utf-8")))
                output_text += (
                    f"\n\n[Showing last {format_size(truncation.output_bytes)} "
                    f"of line {end_line} (line is {last_line_size}). "
                    f"Full output: {temp_file_path}]"
                )
            elif truncation.truncated_by == "lines":
                output_text += (
                    f"\n\n[Showing lines {start_line}-{end_line} of {truncation.total_lines}. "
                    f"Full output: {temp_file_path}]"
                )
            else:
                output_text += (
                    f"\n\n[Showing lines {start_line}-{end_line} of {truncation.total_lines} "
                    f"({format_size(DEFAULT_MAX_BYTES)} limit). "
                    f"Full output: {temp_file_path}]"
                )

        if exit_code != 0 and exit_code is not None:
            output_text += f"\n\nCommand exited with code {exit_code}"
            raise RuntimeError(output_text)

        return BashToolResult(
            content=[{"type": "text", "text": output_text}],
            details=details,
        )


def create_bash_tool(cwd: str, options: Optional[BashToolOptions] = None) -> BashTool:
    """Create a bash tool configured for a specific working directory."""
    return BashTool(cwd, options)


# Default bash tool using current working directory
def bash_tool() -> BashTool:
    """Get default bash tool using current working directory."""
    return create_bash_tool(os.getcwd())
