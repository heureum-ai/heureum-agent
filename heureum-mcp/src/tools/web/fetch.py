# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Web fetch tool.

Fetches a URL and extracts readable content using httpx + readability-lxml.
Uses DNS-pinned transport with manual redirect handling for SSRF protection.
Falls back to Firecrawl when primary extraction fails.

When called with session context (via ``_meta``), the fetched content is
automatically saved to the Platform DB so that filesystem tools (``read``,
``find``, ``ls``) can access it within the same session.
"""
import hashlib
import json
import logging
import os
import time
from datetime import datetime, timezone
from typing import Optional
from urllib.parse import urlparse

import httpx

from mcp.server.fastmcp import Context, FastMCP
from src.common.cache import fetch_cache, make_cache_key
from src.common.content_safety import wrap_and_truncate
from src.common.security import SSRFError, fetch_with_ssrf_guard
from src.common.session_context import extract_session_context, get_platform_client, SessionContext
from src.config import settings
from src.tools.web.fetch_utils import ExtractMode, extract_content, fetch_firecrawl

logger = logging.getLogger(__name__)


def register_web_fetch(mcp: FastMCP) -> None:
    """Register the web_fetch tool with the MCP server.

    Args:
        mcp (FastMCP): The MCP server instance to register the web_fetch
            tool with.
    """

    @mcp.tool(meta={"requires_approval": True, "display_name": "Web Fetch"})
    async def web_fetch(
        url: str,
        max_length: int = settings.WEB_FETCH_MAX_LENGTH,
        start_index: int = 0,
        extract_mode: str = "markdown",
        headers: Optional[dict] = None,
        ctx: Context = None,
    ) -> str:
        """Fetch a web page and return its readable content. Always call this after web_search to retrieve full details from the returned URLs.

        Args:
            url: The URL to fetch.
            max_length: Maximum characters to return (default 50000).
            start_index: Start reading from this character offset (default 0).
                Use with max_length for pagination of long pages.
            extract_mode: "markdown" (default, preserves links/headings) or "text" (plain text).
            headers: Optional custom HTTP headers to include in the request.

        Returns:
            str: JSON string containing the fetched content, metadata
                (URL, status, content type, title), pagination info,
                and timing details. On error, returns a JSON string
                with an error message. When session context is present,
                content is saved to platform and the ``text`` field is
                replaced with a ``session_file`` path — use ``read``
                or ``grep`` to view or search the saved content.
        """
        start = time.monotonic()
        mode: ExtractMode = "text" if extract_mode == "text" else "markdown"

        # Skip cache if custom headers
        cache_key = make_cache_key(
            "fetch", url, str(max_length), str(start_index), mode,
        )
        has_custom_headers = bool(headers)

        if settings.CACHE_ENABLED and not has_custom_headers:
            cached = fetch_cache.get(cache_key)
            if cached is not None:
                cached["cached"] = True
                cached["took_ms"] = int((time.monotonic() - start) * 1000)
                return json.dumps(cached, ensure_ascii=False)

        request_headers = {"User-Agent": settings.WEB_FETCH_USER_AGENT}
        if headers:
            request_headers.update(headers)

        # Resolve session context once for potential post-fetch save
        session_ctx = extract_session_context(ctx) if ctx else None

        response: httpx.Response | None = None
        try:
            response = await fetch_with_ssrf_guard(
                url,
                headers=request_headers,
                timeout=settings.WEB_FETCH_TIMEOUT,
            )
        except SSRFError as e:
            return json.dumps({
                "error": str(e),
                "url": url,
                "blocked": True,
            }, ensure_ascii=False)
        except (httpx.TimeoutException, httpx.HTTPStatusError, Exception) as e:
            # Fallback 1: network / HTTP error → try Firecrawl
            fc_result = await fetch_firecrawl(url)
            if fc_result is not None:
                result_json = _build_result(
                    url=url,
                    final_url=url,
                    status_code=0,
                    content_type="",
                    title=fc_result.title or "",
                    text=fc_result.text,
                    extractor=fc_result.extractor,
                    mode=mode,
                    max_length=max_length,
                    start_index=start_index,
                    start_time=start,
                    cache_key=cache_key if not has_custom_headers else None,
                    source_url=url,
                )
                return await _maybe_save_to_session(result_json, url, session_ctx)

            if isinstance(e, httpx.TimeoutException):
                error_msg = f"Request timed out after {settings.WEB_FETCH_TIMEOUT}s"
            elif isinstance(e, httpx.HTTPStatusError):
                error_msg = f"HTTP {e.response.status_code}: {e.response.reason_phrase}"
            else:
                error_msg = f"Fetch failed: {e}"

            return json.dumps({
                "error": error_msg,
                "url": url,
            }, ensure_ascii=False)

        # Fallback 2: non-success HTTP status → try Firecrawl
        if not response.is_success:
            fc_result = await fetch_firecrawl(url)
            if fc_result is not None:
                result_json = _build_result(
                    url=url,
                    final_url=url,
                    status_code=response.status_code,
                    content_type="",
                    title=fc_result.title or "",
                    text=fc_result.text,
                    extractor=fc_result.extractor,
                    mode=mode,
                    max_length=max_length,
                    start_index=start_index,
                    start_time=start,
                    cache_key=cache_key if not has_custom_headers else None,
                    source_url=url,
                )
                return await _maybe_save_to_session(result_json, url, session_ctx)

            return json.dumps({
                "error": f"HTTP {response.status_code}: {response.reason_phrase}",
                "url": url,
                "status": response.status_code,
            }, ensure_ascii=False)

        content_type = response.headers.get("content-type", "")
        final_url = str(response.url)
        status_code = response.status_code

        extracted = extract_content(
            response.text,
            content_type=content_type,
            url=final_url,
            extract_mode=mode,
        )

        # Fallback 3: empty extraction → try Firecrawl
        if not extracted.text.strip():
            fc_result = await fetch_firecrawl(url)
            if fc_result is not None:
                extracted = fc_result

        result_json = _build_result(
            url=url,
            final_url=final_url,
            status_code=status_code,
            content_type=content_type,
            title=extracted.title or "",
            text=extracted.text,
            extractor=extracted.extractor,
            mode=mode,
            max_length=max_length,
            start_index=start_index,
            start_time=start,
            cache_key=cache_key if not has_custom_headers else None,
            source_url=url,
        )
        return await _maybe_save_to_session(result_json, url, session_ctx)


def _build_result(
    *,
    url: str,
    final_url: str,
    status_code: int,
    content_type: str,
    title: str,
    text: str,
    extractor: str,
    mode: str,
    max_length: int,
    start_index: int,
    start_time: float,
    cache_key: str | None,
    source_url: str,
) -> str:
    """Build the JSON response with pagination, wrapping, and optional caching."""

    if start_index > 0:
        text = text[start_index:]

    wrapped_text, truncated = wrap_and_truncate(
        text,
        max_length=max_length,
        source="web_fetch",
        include_warning=True,
        source_url=source_url,
    )

    content_length = min(len(text), max_length)
    took_ms = int((time.monotonic() - start_time) * 1000)

    # Strip params like charset
    normalized_ct = content_type.split(";")[0].strip() if content_type else ""

    result = {
        "url": url,
        "final_url": final_url,
        "status": status_code,
        "content_type": normalized_ct,
        "title": title,
        "extract_mode": mode,
        "extractor": extractor,
        "truncated": truncated,
        "length": content_length,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "took_ms": took_ms,
        "cached": False,
        "text": wrapped_text,
    }

    if cache_key is not None and settings.CACHE_ENABLED:
        fetch_cache.set(cache_key, result)

    return json.dumps(result, ensure_ascii=False)


def _make_session_path(url: str) -> str:
    """Derive a session-file path from a URL.

    Format: ``web_fetch/{domain}/{slug}-{hash4}.md``
    """
    parsed = urlparse(url)
    domain = parsed.netloc or "unknown"
    # Build a short slug from the path
    path_part = parsed.path.strip("/").replace("/", "_") or "index"
    # Truncate slug to keep paths reasonable
    if len(path_part) > 60:
        path_part = path_part[:60]
    short_hash = hashlib.md5(url.encode()).hexdigest()[:4]
    return f"web_fetch/{domain}/{path_part}-{short_hash}.md"


async def _maybe_save_to_session(
    result_json: str,
    url: str,
    session_ctx: Optional[SessionContext],
) -> str:
    """Save fetched content to storage and strip text from the result.

    In session mode, content is saved to Platform DB.  Otherwise it is
    written to a local file under ``FILESYSTEM_CWD``.  Either way, the
    ``text`` field is replaced with a ``session_file`` path so the LLM
    must use ``read`` to view the content.

    On failure, logs a warning and returns the original result unchanged.
    """
    try:
        data = json.loads(result_json)
        if "error" in data or not data.get("text"):
            return result_json

        rel_path = _make_session_path(url)

        if session_ctx:
            client = get_platform_client(session_ctx)
            await client.write_file(rel_path, data["text"])
            data["session_file"] = f"/session/{rel_path}"
        else:
            local_path = os.path.join(settings.FILESYSTEM_CWD, rel_path)
            os.makedirs(os.path.dirname(local_path), exist_ok=True)
            with open(local_path, "w", encoding="utf-8") as f:
                f.write(data["text"])
            data["session_file"] = local_path

        data.pop("text", None)
        data["instruction"] = "Use read on the session_file path to view the content. For long pages, read returns the first portion with an offset hint to continue reading."
        return json.dumps(data, ensure_ascii=False)
    except Exception:
        logger.warning("Failed to save web_fetch content to storage", exc_info=True)
        return result_json
