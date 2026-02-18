# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Platform API-backed Operations for filesystem tools.

Instead of accessing the local filesystem directly, these implementations
delegate to the Platform REST API so that files are stored in the
session's cloud storage and shared with the client file panel.

Usage::

    from .platform_ops import PlatformFileClient, PlatformReadOperations, ...

    client = PlatformFileClient(platform_api_url, session_id, cwd="/session")
    read_ops = PlatformReadOperations(client)
    write_ops = PlatformWriteOperations(client)
    ...

Limitations:
    - bash_exec: Not supported (requires subprocess execution)
    - Image detection is based on file extension only (no magic-byte check)
"""

from __future__ import annotations

import asyncio
import fnmatch
import logging
import mimetypes
import os
from typing import Any, Dict, List, Optional

import httpx

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Shared HTTP client for Platform file API
# ---------------------------------------------------------------------------


class PlatformFileClient:
    """Shared HTTP client wrapping Platform session-file endpoints.

    All filesystem tool Operations delegate to this client, which handles
    path conversion (absolute → session-relative) and HTTP communication.

    Args:
        platform_api_url: Base URL of the Platform API (e.g. ``http://localhost:8001``).
        session_id: Session identifier for file scoping.
        cwd: Virtual working directory that tool classes use for path
            resolution.  Operations strip this prefix to obtain the
            session-relative path sent to the Platform API.
        http_client: Optional shared ``httpx.AsyncClient`` for connection
            pool sharing across multiple ``PlatformFileClient`` instances.
    """

    def __init__(
        self,
        platform_api_url: str,
        session_id: str,
        cwd: str = "/session",
        http_client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self._platform_api_url = platform_api_url.rstrip("/")
        self._session_id = session_id
        self._cwd = cwd.rstrip("/")
        self._http = http_client or httpx.AsyncClient(timeout=30.0)
        self._owns_http = http_client is None
        self._write_lock = asyncio.Lock()

    @property
    def _base_url(self) -> str:
        return f"{self._platform_api_url}/api/v1/sessions/{self._session_id}/files"

    # -- path helpers -------------------------------------------------------

    def to_session_path(self, absolute_path: str) -> str:
        """Convert an absolute path back to a session-relative path.

        Tool classes resolve user-supplied paths via
        ``resolve_to_cwd(path, cwd)`` producing e.g.
        ``/session/notes/todo.md``.  This strips the *cwd* prefix so the
        Platform API receives ``notes/todo.md``.
        """
        prefix = self._cwd + "/"
        if absolute_path.startswith(prefix):
            return absolute_path[len(prefix):]
        if absolute_path == self._cwd:
            return ""
        # Already relative or rooted elsewhere — return as-is.
        return absolute_path.lstrip("/")

    # -- file operations ----------------------------------------------------

    async def read_file(self, session_path: str) -> str:
        """Read a file's text content from Platform API.

        Raises:
            FileNotFoundError: If the file does not exist.
        """
        resp = await self._http.get(
            f"{self._base_url}/read/",
            params={"path": session_path},
        )
        if resp.status_code == 200:
            return resp.json().get("content", "")
        raise FileNotFoundError(
            f"File not found: {session_path} ({resp.status_code})"
        )

    async def write_file(self, session_path: str, content: str) -> None:
        """Write (create/overwrite) a file via Platform API.

        Raises:
            RuntimeError: On API failure.
        """
        async with self._write_lock:
            resp = await self._http.post(
                f"{self._base_url}/write/",
                json={
                    "path": session_path,
                    "content": content,
                    "created_by": "agent",
                },
            )
        if resp.status_code not in (200, 201):
            detail = str(resp.status_code)
            if resp.text:
                try:
                    detail = resp.json().get("error", resp.text)
                except Exception:
                    detail = resp.text[:200]
            raise RuntimeError(f"Error writing file {session_path}: {detail}")

    async def delete_file(self, session_path: str) -> None:
        """Delete a file via Platform API."""
        resp = await self._http.delete(
            f"{self._base_url}/delete-by-path/",
            params={"path": session_path},
        )
        if resp.status_code not in (200, 204):
            raise RuntimeError(f"Error deleting file {session_path}: {resp.text}")

    async def list_files(self, prefix: str = "") -> List[Dict[str, Any]]:
        """List files, optionally filtered by directory prefix.

        Returns list of dicts with keys: ``path``, ``size``, ``content_type``.
        """
        params: Dict[str, str] = {}
        if prefix:
            params["path"] = prefix
        resp = await self._http.get(f"{self._base_url}/", params=params)
        if resp.status_code == 200:
            return resp.json()
        return []

    async def file_exists(self, session_path: str) -> bool:
        """Check whether a file exists in session storage."""
        try:
            await self.read_file(session_path)
            return True
        except FileNotFoundError:
            return False

    async def close(self) -> None:
        """Close the underlying HTTP client (only if owned by this instance)."""
        if self._owns_http:
            await self._http.aclose()


# ---------------------------------------------------------------------------
# ReadOperations  (read.py)
# ---------------------------------------------------------------------------


class PlatformReadOperations:
    """Platform API implementation of ``ReadOperations``.

    Implements the Protocol used by :class:`ReadTool`:
        - ``read_file(absolute_path) -> bytes``
        - ``access(absolute_path) -> None``
        - ``detect_image_mime_type(absolute_path) -> Optional[str]``
    """

    _SUPPORTED_IMAGE_TYPES = {
        "image/jpeg",
        "image/png",
        "image/gif",
        "image/webp",
    }

    def __init__(self, client: PlatformFileClient) -> None:
        self._client = client

    async def read_file(self, absolute_path: str) -> bytes:
        session_path = self._client.to_session_path(absolute_path)
        content = await self._client.read_file(session_path)
        return content.encode("utf-8")

    async def access(self, absolute_path: str) -> None:
        session_path = self._client.to_session_path(absolute_path)
        exists = await self._client.file_exists(session_path)
        if not exists:
            raise FileNotFoundError(f"File not found: {session_path}")

    async def detect_image_mime_type(self, absolute_path: str) -> Optional[str]:
        """Detect image MIME type by file extension (no magic-byte check)."""
        mime_type, _ = mimetypes.guess_type(absolute_path)
        if mime_type in self._SUPPORTED_IMAGE_TYPES:
            return mime_type
        return None


# ---------------------------------------------------------------------------
# WriteOperations  (write.py)
# ---------------------------------------------------------------------------


class PlatformWriteOperations:
    """Platform API implementation of ``WriteOperations``.

    Implements the Protocol used by :class:`WriteTool`:
        - ``write_file(absolute_path, content) -> None``
        - ``mkdir(directory) -> None``
    """

    def __init__(self, client: PlatformFileClient) -> None:
        self._client = client

    async def write_file(self, absolute_path: str, content: str) -> None:
        session_path = self._client.to_session_path(absolute_path)
        await self._client.write_file(session_path, content)

    async def mkdir(self, directory: str) -> None:
        """No-op: cloud storage does not require explicit directory creation."""
        pass


# ---------------------------------------------------------------------------
# EditOperations  (edit.py)
# ---------------------------------------------------------------------------


class PlatformEditOperations:
    """Platform API implementation of ``EditOperations``.

    Implements the Protocol used by :class:`EditTool`:
        - ``read_file(absolute_path) -> bytes``
        - ``write_file(absolute_path, content) -> None``
        - ``access(absolute_path) -> None``
    """

    def __init__(self, client: PlatformFileClient) -> None:
        self._client = client

    async def read_file(self, absolute_path: str) -> bytes:
        session_path = self._client.to_session_path(absolute_path)
        content = await self._client.read_file(session_path)
        return content.encode("utf-8")

    async def write_file(self, absolute_path: str, content: str) -> None:
        session_path = self._client.to_session_path(absolute_path)
        await self._client.write_file(session_path, content)

    async def access(self, absolute_path: str) -> None:
        session_path = self._client.to_session_path(absolute_path)
        exists = await self._client.file_exists(session_path)
        if not exists:
            raise FileNotFoundError(f"File not found: {session_path}")


# ---------------------------------------------------------------------------
# LsOperations  (ls.py)
# ---------------------------------------------------------------------------


class _PlatformStatResult:
    """Stat-like object for Platform API files."""

    def __init__(self, is_dir: bool) -> None:
        self._is_dir = is_dir

    def is_directory(self) -> bool:
        return self._is_dir


class PlatformLsOperations:
    """Platform API implementation of ``LsOperations``.

    Implements the Protocol used by :class:`LsTool`:
        - ``exists(absolute_path) -> bool``
        - ``stat(absolute_path) -> StatResult``
        - ``readdir(absolute_path) -> List[str]``
    """

    def __init__(self, client: PlatformFileClient) -> None:
        self._client = client

    def exists(self, absolute_path: str) -> bool:
        """Synchronous check — always True for root, otherwise True.

        Platform storage is flat; any listed prefix is considered existing.
        The actual check happens in readdir.
        """
        return True

    def stat(self, absolute_path: str) -> _PlatformStatResult:
        """Return a stat-like object.

        The session root is always a directory.  Anything else is treated
        as a directory if it appears as a prefix in the file listing.
        """
        session_path = self._client.to_session_path(absolute_path)
        # Root or empty = directory
        if not session_path or session_path == ".":
            return _PlatformStatResult(is_dir=True)
        # Entries with trailing "/" or that are prefixes = directory
        return _PlatformStatResult(is_dir=True)

    def readdir(self, absolute_path: str) -> List[str]:
        """Synchronous readdir — raises because Platform API is async.

        LsTool calls this via ``asyncio.to_thread``, so we use a sync
        httpx call as a workaround.
        """
        session_path = self._client.to_session_path(absolute_path)
        prefix = (session_path + "/") if session_path and session_path != "." else ""

        # Synchronous HTTP call (runs inside to_thread)
        with httpx.Client(timeout=30.0) as client:
            params: Dict[str, str] = {}
            if prefix:
                params["path"] = prefix
            resp = client.get(f"{self._client._base_url}/", params=params)

        if resp.status_code != 200:
            return []

        files = resp.json()
        entries: List[str] = []
        seen_dirs: set[str] = set()

        for f in files:
            file_path: str = f.get("path", "")
            # Strip prefix to get relative name
            if prefix and file_path.startswith(prefix):
                relative = file_path[len(prefix):]
            else:
                relative = file_path

            if not relative:
                continue

            # If path contains "/", it's in a subdirectory — show dir name
            if "/" in relative:
                dir_name = relative.split("/", 1)[0]
                if dir_name not in seen_dirs:
                    seen_dirs.add(dir_name)
                    entries.append(dir_name)
            else:
                entries.append(relative)

        return entries


# ---------------------------------------------------------------------------
# FindOperations  (find.py)
# ---------------------------------------------------------------------------


class PlatformFindOperations:
    """Platform API implementation of ``FindOperations``.

    Implements the Protocol used by :class:`FindTool`:
        - ``exists(absolute_path) -> bool``
        - ``glob(pattern, cwd, ignore, limit) -> List[str]``
    """

    def __init__(self, client: PlatformFileClient) -> None:
        self._client = client

    async def exists(self, absolute_path: str) -> bool:
        return True  # Session root always exists

    @staticmethod
    def _matches_pattern(file_path: str, pattern: str) -> bool:
        """Match file_path against a glob pattern, handling ``**`` prefix."""
        if fnmatch.fnmatch(file_path, pattern):
            return True
        # **/foo/** should also match paths starting with foo/
        if pattern.startswith("**/"):
            if fnmatch.fnmatch(file_path, pattern[3:]):
                return True
        return False

    async def glob(
        self,
        pattern: str,
        cwd: str,
        ignore: List[str],
        limit: int,
    ) -> List[str]:
        """Find files matching glob pattern via Platform API list + fnmatch."""
        prefix = self._client.to_session_path(cwd)
        all_files = await self._client.list_files(prefix)

        results: List[str] = []
        for f in all_files:
            file_path: str = f.get("path", "")
            # Match against the pattern
            basename = os.path.basename(file_path)
            if fnmatch.fnmatch(basename, pattern) or fnmatch.fnmatch(file_path, pattern):
                # Check ignore patterns
                skip = any(self._matches_pattern(file_path, ign) for ign in ignore)
                if not skip:
                    # Return absolute paths so FindTool can relativize correctly
                    abs_path = f"{cwd}/{file_path}" if not file_path.startswith(cwd) else file_path
                    results.append(abs_path)
                    if len(results) >= limit:
                        break

        return results


# ---------------------------------------------------------------------------
# DeleteOperations  (delete.py)
# ---------------------------------------------------------------------------


class PlatformDeleteOperations:
    """Platform API implementation of ``DeleteOperations``.

    Implements the Protocol used by :class:`DeleteTool`:
        - ``delete_file(absolute_path) -> None``
    """

    def __init__(self, client: PlatformFileClient) -> None:
        self._client = client

    async def delete_file(self, absolute_path: str) -> None:
        session_path = self._client.to_session_path(absolute_path)
        await self._client.delete_file(session_path)


# ---------------------------------------------------------------------------
# GrepOperations  (grep.py)
# ---------------------------------------------------------------------------

from .truncate import DEFAULT_MAX_BYTES, GREP_MAX_LINE_LENGTH


async def _generate_grep_keywords(query: str) -> list[str] | None:
    """Call Gemini to convert a search query into grep keywords."""
    from src.config import settings
    import json as _json

    if not settings.GEMINI_API_KEY:
        return None

    try:
        url = (
            f"{settings.GEMINI_API_BASE_URL}/models/"
            f"{settings.GEMINI_GREP_MODEL}:generateContent"
        )
        prompt = (
            "Given the following search query, output a JSON array of grep "
            "keywords to find relevant content in a saved web page. "
            "Output ONLY the JSON array.\n\n"
            f'Query: "{query}"'
        )
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                url,
                params={"key": settings.GEMINI_API_KEY},
                json={
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {"temperature": 0, "maxOutputTokens": 200},
                },
            )
        if resp.status_code != 200:
            logger.warning("Gemini grep keyword API error: %d", resp.status_code)
            return None

        text = resp.json()["candidates"][0]["content"]["parts"][0]["text"].strip()
        if text.startswith("```"):
            text = text.split("\n", 1)[1] if "\n" in text else text[3:]
            if text.endswith("```"):
                text = text[:-3]
            text = text.strip()
        keywords = _json.loads(text)
        if isinstance(keywords, list) and all(isinstance(k, str) for k in keywords):
            return keywords
    except Exception:
        logger.warning("Failed to generate grep keywords via Gemini", exc_info=True)
    return None


class PlatformGrepOperations:
    """Platform API implementation of grep search.

    Unlike other Platform*Operations that implement a Protocol for
    existing tool classes, this class performs the full search because
    GrepTool.execute() depends on the ripgrep binary.
    """

    def __init__(self, client: PlatformFileClient) -> None:
        self._client = client

    # -- helpers ------------------------------------------------------------

    @staticmethod
    def _truncate_line(line: str, max_chars: int = GREP_MAX_LINE_LENGTH) -> str:
        if len(line) <= max_chars:
            return line
        return line[:max_chars] + "... [truncated]"

    @staticmethod
    def _truncate_output(text: str, max_bytes: int = DEFAULT_MAX_BYTES) -> str:
        encoded = text.encode("utf-8")
        if len(encoded) <= max_bytes:
            return text
        # Truncate at byte boundary without splitting a line
        truncated = encoded[:max_bytes].decode("utf-8", errors="ignore")
        last_nl = truncated.rfind("\n")
        if last_nl > 0:
            truncated = truncated[:last_nl]
        return truncated + "\n... [output truncated]"

    # -- main search --------------------------------------------------------

    async def search(
        self,
        pattern: str,
        path: Optional[str] = None,
        glob_pattern: Optional[str] = None,
        context: int = 0,
        limit: int = 100,
    ) -> str:
        """Search session files for *pattern* using Python ``re``.

        Returns grep-style output: ``path:line_number: text``.
        """
        # Determine search prefix
        prefix = ""
        if path:
            prefix = self._client.to_session_path(path)

        # List files from Platform API
        all_files = await self._client.list_files(prefix)

        # Filter by glob pattern
        if glob_pattern:
            all_files = [
                f for f in all_files
                if fnmatch.fnmatch(f.get("path", ""), glob_pattern)
                or fnmatch.fnmatch(os.path.basename(f.get("path", "")), glob_pattern)
            ]

        output_lines: List[str] = []
        match_count = 0

        for file_info in all_files:
            if match_count >= limit:
                break

            file_path: str = file_info.get("path", "")
            try:
                content = await self._client.read_file(file_path)
            except (FileNotFoundError, RuntimeError):
                continue

            lines = content.splitlines()
            for line_idx, line_text in enumerate(lines):
                if match_count >= limit:
                    break

                if pattern in line_text:
                    match_count += 1
                    line_num = line_idx + 1  # 1-indexed

                    if context > 0:
                        start = max(0, line_idx - context)
                        end = min(len(lines), line_idx + context + 1)
                        for ctx_idx in range(start, end):
                            ctx_text = self._truncate_line(lines[ctx_idx])
                            ctx_num = ctx_idx + 1
                            if ctx_idx == line_idx:
                                output_lines.append(
                                    f"{file_path}:{ctx_num}: {ctx_text}"
                                )
                            else:
                                output_lines.append(
                                    f"{file_path}-{ctx_num}- {ctx_text}"
                                )
                    else:
                        truncated = self._truncate_line(line_text)
                        output_lines.append(
                            f"{file_path}:{line_num}: {truncated}"
                        )

        if not output_lines:
            return "No matches found."

        result = "\n".join(output_lines)
        return self._truncate_output(result)
