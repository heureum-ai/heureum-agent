# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Filesystem domain tools: bash, read, write, edit, grep, find, ls, delete.

Server-side coding/filesystem tools registered as MCP tools.
Each tool class lives in its own module; this file wires them into FastMCP.

Dual-mode (dynamic per-request):
  - **local** (default): When no session context is provided via ``_meta``,
    tools operate on the local filesystem directly.
  - **platform**: When the Agent sends ``session_id`` + ``platform_api_url``
    via ``_meta``, tools transparently switch to Platform API cloud storage.
    Bash returns an error message in this mode.
"""

import os
from typing import Optional

from mcp.server.fastmcp import Context, FastMCP
from src.common.session_context import extract_session_context, get_platform_client
from src.config import settings


def _make_platform_tool(tool_cls, options_cls, ops_cls, client):
    """Create a platform-backed tool instance for a single request."""
    return tool_cls("/session", options_cls(operations=ops_cls(client)))


def register_filesystem_tools(mcp: FastMCP) -> None:
    """Register all filesystem-domain tools with the MCP server.

    Each tool checks for session context at call time.  If present,
    it delegates to Platform API operations; otherwise it uses the
    local filesystem.
    """

    cwd = getattr(settings, "FILESYSTEM_CWD", os.getcwd())

    # -- lazily import tool classes to keep top-level light --
    from .bash import BashTool
    from .delete import DeleteTool, DeleteToolOptions
    from .edit import EditTool, EditToolOptions
    from .find import FindTool, FindToolOptions
    from .grep import GrepTool
    from .ls import LsTool, LsToolOptions
    from .platform_ops import (
        PlatformDeleteOperations,
        PlatformEditOperations,
        PlatformFindOperations,
        PlatformLsOperations,
        PlatformReadOperations,
        PlatformWriteOperations,
    )
    from .read import ReadTool, ReadToolOptions
    from .write import WriteTool, WriteToolOptions

    # Local-mode tool instances (shared across requests)
    bash_tool = BashTool(cwd)
    read_tool = ReadTool(cwd)
    write_tool = WriteTool(cwd)
    edit_tool = EditTool(cwd)
    grep_tool = GrepTool(cwd)
    find_tool = FindTool(cwd)
    ls_tool = LsTool(cwd)
    delete_tool = DeleteTool(cwd)

    # ── bash ────────────────────────────────────────────────
    @mcp.tool(name="bash", meta={"requires_approval": True, "display_name": "Bash"})
    async def _bash(
        command: str,
        timeout: Optional[int] = None,
        ctx: Context = None,
    ) -> str:
        """Run a bash command on the server. Use this for server-side tasks \
such as installing packages, running scripts, or processing files in \
the server workspace. For commands on the user's local machine, \
prefer 'bash' instead.

        Returns stdout/stderr, truncated to 2000 lines or 50 KB.

        Args:
            command: Bash command to execute.
            timeout: Optional timeout in seconds.
        """
        session_ctx = extract_session_context(ctx) if ctx else None
        if session_ctx and session_ctx.cwd:
            local_tool = BashTool(session_ctx.cwd)
            result = await local_tool.execute("", command, timeout)
            return result.content[0]["text"]
        elif session_ctx:
            return "Error: bash is not available in cloud session mode. Use read/write/edit to work with files."
        result = await bash_tool.execute("", command, timeout)
        return result.content[0]["text"]

    # ── read ────────────────────────────────────────────────
    @mcp.tool(name="read", meta={"display_name": "Read"})
    async def _read(
        path: str,
        offset: Optional[int] = None,
        limit: Optional[int] = None,
        ctx: Context = None,
    ) -> str:
        """Read a file in the server workspace. Use this for server-side \
files such as web fetch results (session_file paths) or generated outputs. \
For the user's local files, prefer 'read' instead.

        Supports text and images (jpg, png, gif, webp). Text output is \
truncated to 2000 lines or 50 KB; use offset/limit for large files.

        Args:
            path: File path (relative or absolute).
            offset: Line number to start reading from (1-indexed).
            limit: Maximum number of lines to read.
        """
        session_ctx = extract_session_context(ctx) if ctx else None
        if session_ctx and session_ctx.cwd:
            local_tool = ReadTool(session_ctx.cwd)
            result = await local_tool.execute("", path, offset, limit)
        elif session_ctx:
            client = get_platform_client(session_ctx)
            platform_tool = _make_platform_tool(ReadTool, ReadToolOptions, PlatformReadOperations, client)
            result = await platform_tool.execute("", path, offset, limit)
        else:
            result = await read_tool.execute("", path, offset, limit)
        texts = [c["text"] for c in result.content if c.get("type") == "text"]
        return "\n".join(texts)

    # ── write ───────────────────────────────────────────────
    @mcp.tool(name="write", meta={"requires_approval": True, "display_name": "Write"})
    async def _write(
        path: str,
        content: str,
        ctx: Context = None,
    ) -> str:
        """Write a file to the server workspace. Use this for server-generated \
content such as reports, processed data, or documents. For writing to \
the user's local filesystem, prefer 'write' instead.

        Creates parent directories automatically; overwrites existing files.

        Args:
            path: File path (relative or absolute).
            content: Text content to write.
        """
        session_ctx = extract_session_context(ctx) if ctx else None
        if session_ctx and session_ctx.cwd:
            local_tool = WriteTool(session_ctx.cwd)
            result = await local_tool.execute("", path, content)
        elif session_ctx:
            client = get_platform_client(session_ctx)
            platform_tool = _make_platform_tool(WriteTool, WriteToolOptions, PlatformWriteOperations, client)
            result = await platform_tool.execute("", path, content)
        else:
            result = await write_tool.execute("", path, content)
        return result.content[0]["text"]

    # ── edit ────────────────────────────────────────────────
    @mcp.tool(name="edit", meta={"requires_approval": True, "display_name": "Edit"})
    async def _edit(
        path: str,
        old_text: str,
        new_text: str,
        ctx: Context = None,
    ) -> str:
        """Edit a file in the server workspace by replacing exact text. \
Use this for server-side files only. For the user's local files, \
prefer 'edit' instead.

        The old_text must match exactly including whitespace.

        Args:
            path: File path (relative or absolute).
            old_text: Exact text to find and replace.
            new_text: New text to replace the old text with.
        """
        session_ctx = extract_session_context(ctx) if ctx else None
        if session_ctx and session_ctx.cwd:
            local_tool = EditTool(session_ctx.cwd)
            result = await local_tool.execute("", path, old_text, new_text)
        elif session_ctx:
            client = get_platform_client(session_ctx)
            platform_tool = _make_platform_tool(EditTool, EditToolOptions, PlatformEditOperations, client)
            result = await platform_tool.execute("", path, old_text, new_text)
        else:
            result = await edit_tool.execute("", path, old_text, new_text)
        return result.content[0]["text"]

    # ── grep ────────────────────────────────────────────────
    @mcp.tool(name="grep", meta={"display_name": "Grep"})
    async def _grep(
        pattern: str,
        path: Optional[str] = None,
        glob: Optional[str] = None,
        ignore_case: Optional[bool] = None,
        context: Optional[int] = None,
        limit: Optional[int] = None,
        ctx: Context = None,
    ) -> str:
        """Search file contents in the server workspace. Use this to search \
server-side files such as web fetch results or generated outputs. \
For the user's local files, prefer 'grep' instead.

        Returns matching lines with file paths and line numbers.

        Args:
            pattern: Search pattern (literal string).
            path: Directory or file to search (default: working directory).
            glob: Filter files by glob pattern, e.g. '*.ts'.
            ignore_case: Case-insensitive search.
            context: Lines of context before and after each match.
            limit: Maximum number of matches (default: 100).
        """
        import shutil as _shutil
        import tempfile

        session_ctx = extract_session_context(ctx) if ctx else None
        if session_ctx and session_ctx.cwd:
            local_tool = GrepTool(session_ctx.cwd)
            result = await local_tool.execute("", pattern, path, glob, ignore_case, True, context, limit)
            return result.content[0]["text"]
        elif session_ctx:
            client = get_platform_client(session_ctx)
            tmp_dir = tempfile.mkdtemp()
            try:
                if path:
                    session_path = client.to_session_path(path)
                    try:
                        content = await client.read_file(session_path)
                        tmp_file = os.path.join(tmp_dir, os.path.basename(session_path))
                        with open(tmp_file, "w", encoding="utf-8") as f:
                            f.write(content)
                    except FileNotFoundError:
                        all_files = await client.list_files(session_path)
                        for fi in all_files:
                            fp = fi.get("path", "")
                            try:
                                content = await client.read_file(fp)
                            except (FileNotFoundError, RuntimeError):
                                continue
                            tmp_file = os.path.join(tmp_dir, fp)
                            os.makedirs(os.path.dirname(tmp_file), exist_ok=True)
                            with open(tmp_file, "w", encoding="utf-8") as f:
                                f.write(content)
                else:
                    all_files = await client.list_files()
                    for fi in all_files:
                        fp = fi.get("path", "")
                        try:
                            content = await client.read_file(fp)
                        except (FileNotFoundError, RuntimeError):
                            continue
                        tmp_file = os.path.join(tmp_dir, fp)
                        os.makedirs(os.path.dirname(tmp_file), exist_ok=True)
                        with open(tmp_file, "w", encoding="utf-8") as f:
                            f.write(content)
                result = await grep_tool.execute(
                    "", pattern, tmp_dir, glob, ignore_case, True, context, limit,
                )
                return result.content[0]["text"]
            finally:
                _shutil.rmtree(tmp_dir, ignore_errors=True)
        result = await grep_tool.execute("", pattern, path, glob, ignore_case, True, context, limit)
        return result.content[0]["text"]

    # ── find ────────────────────────────────────────────────
    @mcp.tool(name="find", meta={"display_name": "Find"})
    async def _find(
        pattern: str,
        path: Optional[str] = None,
        limit: Optional[int] = None,
        ctx: Context = None,
    ) -> str:
        """Find files in the server workspace by glob pattern. Use this to \
locate server-side files such as fetched web pages or generated outputs. \
For the user's local filesystem, prefer 'find' instead.

        Returns matching paths relative to the search directory. Respects .gitignore.

        Args:
            pattern: Glob pattern, e.g. '*.ts', '**/*.json'.
            path: Directory to search in (default: working directory).
            limit: Maximum number of results (default: 1000).
        """
        session_ctx = extract_session_context(ctx) if ctx else None
        if session_ctx and session_ctx.cwd:
            local_tool = FindTool(session_ctx.cwd)
            result = await local_tool.execute("", pattern, path, limit)
        elif session_ctx:
            client = get_platform_client(session_ctx)
            platform_tool = _make_platform_tool(FindTool, FindToolOptions, PlatformFindOperations, client)
            result = await platform_tool.execute("", pattern, path, limit)
        else:
            result = await find_tool.execute("", pattern, path, limit)
        return result.content[0]["text"]

    # ── ls ──────────────────────────────────────────────────
    @mcp.tool(name="ls", meta={"display_name": "List Files"})
    async def _ls(
        path: Optional[str] = None,
        limit: Optional[int] = None,
        ctx: Context = None,
    ) -> str:
        """List directory contents in the server workspace. Use this to \
browse server-side files and directories. For the user's local \
directories, prefer 'ls' instead.

        Returns entries sorted alphabetically with '/' suffix for directories.

        Args:
            path: Directory to list (default: working directory).
            limit: Maximum number of entries (default: 500).
        """
        session_ctx = extract_session_context(ctx) if ctx else None
        if session_ctx and session_ctx.cwd:
            local_tool = LsTool(session_ctx.cwd)
            result = await local_tool.execute("", path, limit)
        elif session_ctx:
            client = get_platform_client(session_ctx)
            platform_tool = _make_platform_tool(LsTool, LsToolOptions, PlatformLsOperations, client)
            result = await platform_tool.execute("", path, limit)
        else:
            result = await ls_tool.execute("", path, limit)
        return result.content[0]["text"]

    # ── delete ───────────────────────────────────────────────
    @mcp.tool(name="delete", meta={"requires_approval": True, "display_name": "Delete"})
    async def _delete(
        path: str,
        ctx: Context = None,
    ) -> str:
        """Delete a file in the server workspace. Use this to remove \
server-side files only.

        Args:
            path: File path (relative or absolute).
        """
        session_ctx = extract_session_context(ctx) if ctx else None
        if session_ctx and session_ctx.cwd:
            local_tool = DeleteTool(session_ctx.cwd)
            result = await local_tool.execute("", path)
        elif session_ctx:
            client = get_platform_client(session_ctx)
            platform_tool = _make_platform_tool(DeleteTool, DeleteToolOptions, PlatformDeleteOperations, client)
            result = await platform_tool.execute("", path)
        else:
            result = await delete_tool.execute("", path)
        return result.content[0]["text"]
