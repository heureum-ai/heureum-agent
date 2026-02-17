# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Filesystem domain tools: bash, read, write, edit, grep, find, ls, delete.

Server-side coding/filesystem tools registered as MCP tools.
Each tool class lives in its own module; this file wires them into FastMCP.

Two modes:
  - **local** (default): Tools operate on the local filesystem directly.
  - **platform**: Tools operate on Platform API cloud storage via HTTP.
    Bash and grep are unavailable in this mode.
"""

import os
from typing import Optional

from mcp.server.fastmcp import FastMCP
from src.config import settings


def register_filesystem_tools(mcp: FastMCP) -> None:
    """Register all filesystem-domain tools with the MCP server (local mode)."""

    cwd = getattr(settings, "FILESYSTEM_CWD", os.getcwd())

    # -- lazily import tool classes to keep top-level light --
    from .bash import BashTool
    from .delete import DeleteTool
    from .edit import EditTool
    from .find import FindTool
    from .grep import GrepTool
    from .ls import LsTool
    from .read import ReadTool
    from .write import WriteTool

    bash_tool = BashTool(cwd)
    read_tool = ReadTool(cwd)
    write_tool = WriteTool(cwd)
    edit_tool = EditTool(cwd)
    grep_tool = GrepTool(cwd)
    find_tool = FindTool(cwd)
    ls_tool = LsTool(cwd)
    delete_tool = DeleteTool(cwd)

    # ── bash ────────────────────────────────────────────────
    @mcp.tool(name="bash", meta={"requires_approval": True})
    async def _bash(
        command: str,
        timeout: Optional[int] = None,
    ) -> str:
        """Execute a bash command in the working directory.

        Returns stdout/stderr. Output is truncated to the last 2000 lines
        or 50 KB (whichever is hit first).

        Args:
            command: Bash command to execute.
            timeout: Optional timeout in seconds.
        """
        result = await bash_tool.execute("", command, timeout)
        return result.content[0]["text"]

    # ── read ────────────────────────────────────────────────
    @mcp.tool(name="read")
    async def _read(
        path: str,
        offset: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> str:
        """Read the contents of a file.

        Supports text files and images (jpg, png, gif, webp).
        Text output is truncated to 2000 lines or 50 KB.
        Use offset/limit for large files.

        Args:
            path: File path (relative or absolute).
            offset: Line number to start reading from (1-indexed).
            limit: Maximum number of lines to read.
        """
        result = await read_tool.execute("", path, offset, limit)
        # Images return multiple content blocks; join text parts
        texts = [c["text"] for c in result.content if c.get("type") == "text"]
        return "\n".join(texts)

    # ── write ───────────────────────────────────────────────
    @mcp.tool(name="write", meta={"requires_approval": True})
    async def _write(
        path: str,
        content: str,
    ) -> str:
        """Write content to a file, creating it if it doesn't exist.

        Overwrites if the file already exists.
        Automatically creates parent directories.

        Args:
            path: File path (relative or absolute).
            content: Text content to write.
        """
        result = await write_tool.execute("", path, content)
        return result.content[0]["text"]

    # ── edit ────────────────────────────────────────────────
    @mcp.tool(name="edit", meta={"requires_approval": True})
    async def _edit(
        path: str,
        old_text: str,
        new_text: str,
    ) -> str:
        """Edit a file by replacing exact text.

        The old_text must match exactly (including whitespace).
        Use this for precise, surgical edits.

        Args:
            path: File path (relative or absolute).
            old_text: Exact text to find and replace.
            new_text: New text to replace the old text with.
        """
        result = await edit_tool.execute("", path, old_text, new_text)
        return result.content[0]["text"]

    # ── grep ────────────────────────────────────────────────
    @mcp.tool(name="grep")
    async def _grep(
        pattern: str,
        path: Optional[str] = None,
        glob: Optional[str] = None,
        ignore_case: Optional[bool] = None,
        literal: Optional[bool] = None,
        context: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> str:
        """Search file contents for a pattern using ripgrep.

        Returns matching lines with file paths and line numbers.
        Respects .gitignore.

        Args:
            pattern: Search pattern (regex or literal string).
            path: Directory or file to search (default: working directory).
            glob: Filter files by glob pattern, e.g. '*.ts'.
            ignore_case: Case-insensitive search.
            literal: Treat pattern as literal string instead of regex.
            context: Lines of context before and after each match.
            limit: Maximum number of matches (default: 100).
        """
        result = await grep_tool.execute("", pattern, path, glob, ignore_case, literal, context, limit)
        return result.content[0]["text"]

    # ── find ────────────────────────────────────────────────
    @mcp.tool(name="find")
    async def _find(
        pattern: str,
        path: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> str:
        """Search for files by glob pattern.

        Returns matching file paths relative to the search directory.
        Respects .gitignore.

        Args:
            pattern: Glob pattern, e.g. '*.ts', '**/*.json'.
            path: Directory to search in (default: working directory).
            limit: Maximum number of results (default: 1000).
        """
        result = await find_tool.execute("", pattern, path, limit)
        return result.content[0]["text"]

    # ── ls ──────────────────────────────────────────────────
    @mcp.tool(name="ls")
    async def _ls(
        path: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> str:
        """List directory contents.

        Returns entries sorted alphabetically with '/' suffix for directories.
        Includes dotfiles.

        Args:
            path: Directory to list (default: working directory).
            limit: Maximum number of entries (default: 500).
        """
        result = await ls_tool.execute("", path, limit)
        return result.content[0]["text"]

    # ── delete ───────────────────────────────────────────────
    @mcp.tool(name="delete", meta={"requires_approval": True})
    async def _delete(
        path: str,
    ) -> str:
        """Delete a file.

        Args:
            path: File path (relative or absolute).
        """
        result = await delete_tool.execute("", path)
        return result.content[0]["text"]


def register_platform_filesystem_tools(
    mcp: FastMCP,
    platform_api_url: str,
    session_id: str,
) -> None:
    """Register filesystem tools backed by Platform API (cloud storage mode).

    Tools operate on the session's cloud storage via Platform REST API
    instead of the local filesystem.  Bash and grep are **not registered**
    because they require local subprocess execution.

    Args:
        mcp: The MCP server instance to register tools with.
        platform_api_url: Base URL of the Platform API.
        session_id: Session identifier for file scoping.
    """

    from .delete import DeleteTool, DeleteToolOptions
    from .edit import EditTool, EditToolOptions
    from .find import FindTool, FindToolOptions
    from .ls import LsTool, LsToolOptions
    from .platform_ops import (
        PlatformDeleteOperations,
        PlatformEditOperations,
        PlatformFileClient,
        PlatformFindOperations,
        PlatformLsOperations,
        PlatformReadOperations,
        PlatformWriteOperations,
    )
    from .read import ReadTool, ReadToolOptions
    from .write import WriteTool, WriteToolOptions

    # Virtual cwd — tools resolve paths relative to this root
    cwd = "/session"

    client = PlatformFileClient(platform_api_url, session_id, cwd=cwd)

    read_tool = ReadTool(cwd, ReadToolOptions(operations=PlatformReadOperations(client)))
    write_tool = WriteTool(cwd, WriteToolOptions(operations=PlatformWriteOperations(client)))
    edit_tool = EditTool(cwd, EditToolOptions(operations=PlatformEditOperations(client)))
    find_tool = FindTool(cwd, FindToolOptions(operations=PlatformFindOperations(client)))
    ls_tool = LsTool(cwd, LsToolOptions(operations=PlatformLsOperations(client)))
    delete_tool = DeleteTool(cwd, DeleteToolOptions(operations=PlatformDeleteOperations(client)))

    # ── read ────────────────────────────────────────────────
    @mcp.tool(name="read")
    async def _read(
        path: str,
        offset: Optional[int] = None,
        limit: Optional[int] = None,
    ) -> str:
        """Read the contents of a file.

        Supports text files and images (jpg, png, gif, webp).
        Text output is truncated to 2000 lines or 50 KB.
        Use offset/limit for large files.

        Args:
            path: File path (relative or absolute).
            offset: Line number to start reading from (1-indexed).
            limit: Maximum number of lines to read.
        """
        result = await read_tool.execute("", path, offset, limit)
        texts = [c["text"] for c in result.content if c.get("type") == "text"]
        return "\n".join(texts)

    # ── write ───────────────────────────────────────────────
    @mcp.tool(name="write", meta={"requires_approval": True})
    async def _write(
        path: str,
        content: str,
    ) -> str:
        """Write content to a file, creating it if it doesn't exist.

        Overwrites if the file already exists.
        Automatically creates parent directories.

        Args:
            path: File path (relative or absolute).
            content: Text content to write.
        """
        result = await write_tool.execute("", path, content)
        return result.content[0]["text"]

    # ── edit ────────────────────────────────────────────────
    @mcp.tool(name="edit", meta={"requires_approval": True})
    async def _edit(
        path: str,
        old_text: str,
        new_text: str,
    ) -> str:
        """Edit a file by replacing exact text.

        The old_text must match exactly (including whitespace).
        Use this for precise, surgical edits.

        Args:
            path: File path (relative or absolute).
            old_text: Exact text to find and replace.
            new_text: New text to replace the old text with.
        """
        result = await edit_tool.execute("", path, old_text, new_text)
        return result.content[0]["text"]

    # ── find ────────────────────────────────────────────────
    @mcp.tool(name="find")
    async def _find(
        pattern: str,
        path: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> str:
        """Search for files by glob pattern.

        Returns matching file paths relative to the search directory.
        Respects .gitignore.

        Args:
            pattern: Glob pattern, e.g. '*.ts', '**/*.json'.
            path: Directory to search in (default: working directory).
            limit: Maximum number of results (default: 1000).
        """
        result = await find_tool.execute("", pattern, path, limit)
        return result.content[0]["text"]

    # ── ls ──────────────────────────────────────────────────
    @mcp.tool(name="ls")
    async def _ls(
        path: Optional[str] = None,
        limit: Optional[int] = None,
    ) -> str:
        """List directory contents.

        Returns entries sorted alphabetically with '/' suffix for directories.
        Includes dotfiles.

        Args:
            path: Directory to list (default: working directory).
            limit: Maximum number of entries (default: 500).
        """
        result = await ls_tool.execute("", path, limit)
        return result.content[0]["text"]

    # ── delete ───────────────────────────────────────────────
    @mcp.tool(name="delete", meta={"requires_approval": True})
    async def _delete(
        path: str,
    ) -> str:
        """Delete a file.

        Args:
            path: File path (relative or absolute).
        """
        result = await delete_tool.execute("", path)
        return result.content[0]["text"]
