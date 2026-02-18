# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Web fetch tool.

Fetches a URL and extracts readable content using httpx + readability-lxml.
Uses DNS-pinned transport with manual redirect handling for SSRF protection.
Falls back to Firecrawl when primary extraction fails.

Includes HTML→Markdown conversion, plain text extraction, content truncation,
and Firecrawl fallback for content extraction.

When called with session context (via ``_meta``), the fetched content is
automatically saved to the Platform DB so that filesystem tools (``read``,
``find``, ``ls``) can access it within the same session.
"""
import hashlib
import json
import logging
import os
import re
import time
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal, Optional
from urllib.parse import urlparse

import html2text
import httpx
from readability import Document

from mcp.server.fastmcp import Context, FastMCP
from src.common.cache import make_cache_key, raw_content_cache
from src.common.content_safety import wrap_and_truncate, wrapper_overhead
from src.common.security import SSRFError, fetch_with_ssrf_guard
from src.common.session_context import extract_session_context, get_platform_client, SessionContext
from src.config import settings

logger = logging.getLogger(__name__)

ExtractMode = Literal["markdown", "text"]


# ---------------------------------------------------------------------------
# HTML / Markdown extraction helpers (powered by html2text)
# ---------------------------------------------------------------------------


def _make_html2text(*, body_width: int = 78) -> html2text.HTML2Text:
    """Create a pre-configured html2text converter."""
    h = html2text.HTML2Text()
    h.body_width = body_width        # word-wrap at 78 chars (LangChain default)
    h.ignore_images = True            # images aren't useful for LLM context
    h.ignore_emphasis = False
    h.protect_links = True            # keep [text](url) intact
    h.unicode_snob = True             # use unicode instead of HTML entities
    h.wrap_links = False              # don't break URLs across lines
    h.wrap_list_items = True          # wrap long list items
    h.single_line_break = False       # CommonMark: blank line between paragraphs
    return h


def html_to_markdown(html: str) -> tuple[str, str | None]:
    """Convert HTML to Markdown using html2text.

    Args:
        html (str): Raw HTML content to convert.

    Returns:
        tuple[str, str | None]: A tuple of (markdown_text, title) where title
            is extracted from the HTML <title> tag, or None if not present.
    """
    # Extract title before html2text strips it
    title_match = re.search(r"<title[^>]*>([\s\S]*?)</title>", html, re.I)
    title = title_match.group(1).strip() if title_match else None
    if title:
        # Clean HTML entities in title
        title = _make_html2text(body_width=0).handle(title).strip()

    h = _make_html2text()
    text = h.handle(html).strip()

    # Collapse 3+ blank lines to 2
    text = re.sub(r"\n{3,}", "\n\n", text)

    return text, title


def html_to_text(html: str) -> tuple[str, str | None]:
    """Convert HTML to plain text (no Markdown formatting).

    Args:
        html (str): Raw HTML content to convert.

    Returns:
        tuple[str, str | None]: A tuple of (plain_text, title).
    """
    title_match = re.search(r"<title[^>]*>([\s\S]*?)</title>", html, re.I)
    title = title_match.group(1).strip() if title_match else None
    if title:
        title = _make_html2text(body_width=0).handle(title).strip()

    h = _make_html2text()
    h.ignore_links = True
    h.ignore_emphasis = True
    text = h.handle(html).strip()

    # Strip remaining markdown artifacts
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.M)
    text = re.sub(r"\n{3,}", "\n\n", text)

    return text, title


# ---------------------------------------------------------------------------
# Content extraction
# ---------------------------------------------------------------------------


@dataclass
class ExtractedContent:
    """Result of extracting content from a web page.

    Attributes:
        title (str | None): Page title, or None if unavailable.
        text (str): The extracted content body.
        extractor (str): Name of the extraction method used, e.g.
            "readability", "html_fallback", "json", "raw", or "firecrawl".
    """

    title: str | None
    text: str
    extractor: str


def extract_content(
    body: str,
    *,
    content_type: str,
    url: str = "",
    extract_mode: ExtractMode = "markdown",
) -> ExtractedContent:
    """Extract readable content from an HTTP response body.

    Handles HTML (via Readability + Markdown conversion), JSON, and plain text.

    Args:
        body (str): The raw HTTP response body.
        content_type (str): The Content-Type header value from the response.
        url (str): The URL of the fetched page, used for context.
        extract_mode (ExtractMode): Output format, either "markdown" or "text".

    Returns:
        ExtractedContent: Extracted content with title, text body, and
            extractor name.
    """
    ct_lower = content_type.lower()

    if "text/html" in ct_lower:
        return _extract_html(body, url=url, extract_mode=extract_mode)

    if "application/json" in ct_lower or "text/json" in ct_lower:
        return _extract_json(body)

    # Plain text or unknown: return as-is
    return ExtractedContent(title=None, text=body.strip(), extractor="raw")


def _extract_html(body: str, *, url: str, extract_mode: ExtractMode) -> ExtractedContent:
    """Extract content from HTML using Readability with Markdown/text fallback."""
    try:
        doc = Document(body)
        content_html = doc.summary()
        title = doc.title() or None

        if not content_html or len(content_html.strip()) < 50:
            # Readability failed to extract meaningful content, use raw HTML conversion
            return _fallback_html(body, extract_mode=extract_mode)

        if extract_mode == "text":
            text, _ = html_to_text(content_html)
        else:
            text, _ = html_to_markdown(content_html)

        if not text.strip():
            return _fallback_html(body, extract_mode=extract_mode)

        return ExtractedContent(title=title, text=text, extractor="readability")

    except Exception:
        return _fallback_html(body, extract_mode=extract_mode)


def _fallback_html(body: str, *, extract_mode: ExtractMode) -> ExtractedContent:
    """Fallback: convert raw HTML directly."""
    if extract_mode == "text":
        text, title = html_to_text(body)
    else:
        text, title = html_to_markdown(body)
    return ExtractedContent(title=title, text=text, extractor="html_fallback")


def _extract_json(body: str) -> ExtractedContent:
    """Extract JSON content with pretty-printing."""
    try:
        parsed = json.loads(body)
        text = json.dumps(parsed, indent=2, ensure_ascii=False)
        return ExtractedContent(title=None, text=text, extractor="json")
    except (json.JSONDecodeError, ValueError):
        return ExtractedContent(title=None, text=body.strip(), extractor="raw")


# ---------------------------------------------------------------------------
# Firecrawl fallback
# ---------------------------------------------------------------------------


async def fetch_firecrawl(url: str) -> ExtractedContent | None:
    """Fallback: extract content via Firecrawl API.

    Silently catches all errors so the caller can continue with other fallbacks.

    Args:
        url (str): The URL to scrape via Firecrawl.

    Returns:
        ExtractedContent | None: Extracted content on success, or None if
            Firecrawl is disabled, the API key is missing, or any error occurs.
    """
    if not settings.FIRECRAWL_ENABLED or not settings.FIRECRAWL_API_KEY:
        return None

    try:
        async with httpx.AsyncClient(timeout=settings.FIRECRAWL_TIMEOUT) as client:
            response = await client.post(
                f"{settings.FIRECRAWL_BASE_URL}/v1/scrape",
                json={
                    "url": url,
                    "formats": ["markdown"],
                    "onlyMainContent": True,
                    "timeout": int(settings.FIRECRAWL_TIMEOUT * 1000),
                },
                headers={
                    "Authorization": f"Bearer {settings.FIRECRAWL_API_KEY}",
                },
            )

            if not response.is_success:
                logger.warning("Firecrawl API error: HTTP %d", response.status_code)
                return None

            data = response.json()
            if not data.get("success"):
                logger.warning("Firecrawl returned success=false for %s", url)
                return None

            content = data.get("data", {})
            markdown = content.get("markdown", "")
            if not markdown:
                return None

            metadata = content.get("metadata", {})
            title = metadata.get("title")

            return ExtractedContent(
                title=title,
                text=markdown,
                extractor="firecrawl",
            )
    except Exception as e:
        logger.warning("Firecrawl fallback failed: %s", e)
        return None


# ---------------------------------------------------------------------------
# Web fetch tool
# ---------------------------------------------------------------------------


def register_web_fetch(mcp: FastMCP) -> None:
    """Register the web_fetch tool with the MCP server.

    Args:
        mcp (FastMCP): The MCP server instance to register the web_fetch
            tool with.
    """

    @mcp.tool(name="mcp_web__fetch", meta={"requires_approval": True, "display_name": "Web Fetch"})
    async def web_fetch(
        url: str,
        max_length: int = settings.WEB_FETCH_MAX_LENGTH,
        start_index: int = 0,
        extract_mode: str = "markdown",
        headers: Optional[dict] = None,
        ctx: Context = None,
    ) -> str:
        """Fetch a web page on the server and save its full content to the \
server workspace. Always call this after 'search' to retrieve page \
details from the returned URLs. The content is saved to a session_file \
— use 'read' or 'grep' on that path to access it. Supports pagination \
via start_index/max_length for long pages.

        Args:
            url: The URL to fetch.
            max_length: Maximum characters to return (default 5000).
            start_index: Start reading from this character offset (default 0).
                Use with max_length for pagination of long pages.
            extract_mode: "markdown" (default, preserves links/headings) or "text" (plain text).
            headers: Optional custom HTTP headers to include in the request.

        Returns:
            str: JSON with metadata (URL, status, title), pagination info,
                and a session_file path. Use 'read' on the session_file
                to view content. On error, returns JSON with an error message.
        """
        start = time.monotonic()
        mode: ExtractMode = "text" if extract_mode == "text" else "markdown"
        has_custom_headers = bool(headers)

        # Raw content cache key: URL + mode only (no start_index / max_length)
        raw_cache_key = make_cache_key("fetch_raw", url, mode)

        # Resolve session context once for potential post-fetch save
        session_ctx = extract_session_context(ctx) if ctx else None

        # Check raw content cache first (avoids re-fetching for pagination)
        cached_raw: dict | None = None
        if settings.CACHE_ENABLED and not has_custom_headers:
            cached_raw = raw_content_cache.get(raw_cache_key)

        if cached_raw is not None:
            result_json, full_text = _build_result(
                url=url,
                final_url=cached_raw["final_url"],
                status_code=cached_raw["status_code"],
                content_type=cached_raw["content_type"],
                title=cached_raw["title"],
                text=cached_raw["text"],
                extractor=cached_raw["extractor"],
                mode=mode,
                max_length=max_length,
                start_index=start_index,
                start_time=start,
                source_url=url,
                cached=True,
            )
            return await _maybe_save_to_session(result_json, url, session_ctx, full_text=full_text)

        # --- HTTP fetch path (no cache hit) ---
        request_headers = {"User-Agent": settings.WEB_FETCH_USER_AGENT}
        if headers:
            request_headers.update(headers)

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
                _cache_raw(raw_cache_key, has_custom_headers,
                           final_url=url, status_code=0, content_type="",
                           title=fc_result.title or "", text=fc_result.text,
                           extractor=fc_result.extractor)
                result_json, full_text = _build_result(
                    url=url, final_url=url, status_code=0, content_type="",
                    title=fc_result.title or "", text=fc_result.text,
                    extractor=fc_result.extractor, mode=mode,
                    max_length=max_length, start_index=start_index,
                    start_time=start, source_url=url,
                )
                return await _maybe_save_to_session(result_json, url, session_ctx, full_text=full_text)

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
                _cache_raw(raw_cache_key, has_custom_headers,
                           final_url=url, status_code=response.status_code,
                           content_type="", title=fc_result.title or "",
                           text=fc_result.text, extractor=fc_result.extractor)
                result_json, full_text = _build_result(
                    url=url, final_url=url, status_code=response.status_code,
                    content_type="", title=fc_result.title or "",
                    text=fc_result.text, extractor=fc_result.extractor,
                    mode=mode, max_length=max_length, start_index=start_index,
                    start_time=start, source_url=url,
                )
                return await _maybe_save_to_session(result_json, url, session_ctx, full_text=full_text)

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

        _cache_raw(raw_cache_key, has_custom_headers,
                   final_url=final_url, status_code=status_code,
                   content_type=content_type, title=extracted.title or "",
                   text=extracted.text, extractor=extracted.extractor)

        result_json, full_text = _build_result(
            url=url, final_url=final_url, status_code=status_code,
            content_type=content_type, title=extracted.title or "",
            text=extracted.text, extractor=extracted.extractor,
            mode=mode, max_length=max_length, start_index=start_index,
            start_time=start, source_url=url,
        )
        return await _maybe_save_to_session(result_json, url, session_ctx, full_text=full_text)


def _cache_raw(
    raw_cache_key: str,
    has_custom_headers: bool,
    *,
    final_url: str,
    status_code: int,
    content_type: str,
    title: str,
    text: str,
    extractor: str,
) -> None:
    """Store raw extracted content in the content cache (keyed by URL + mode)."""
    if has_custom_headers or not settings.CACHE_ENABLED:
        return
    raw_content_cache.set(raw_cache_key, {
        "final_url": final_url,
        "status_code": status_code,
        "content_type": content_type,
        "title": title,
        "text": text,
        "extractor": extractor,
    })


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
    source_url: str,
    cached: bool = False,
) -> tuple[str, str]:
    """Build the JSON response with pagination and wrapping.

    Returns:
        tuple[str, str]: (result_json, full_text) where full_text is the
            complete extracted text before any slicing or truncation.
    """
    full_text = text
    total_length = len(text)

    if start_index > 0:
        text = text[start_index:]

    wrapped_text, truncated = wrap_and_truncate(
        text,
        max_length=max_length,
        source="web_fetch",
        include_warning=True,
        source_url=source_url,
    )

    # Account for wrapper overhead in content_length calculation
    overhead = wrapper_overhead(source="web_fetch", include_warning=True)
    max_inner = max(0, max_length - overhead)
    content_length = min(len(text), max_inner)

    # Pagination metadata
    remaining = max(0, total_length - (start_index + content_length))
    next_start_index = start_index + content_length if remaining > 0 else None

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
        "start_index": start_index,
        "total_length": total_length,
        "length": content_length,
        "remaining": remaining,
        "next_start_index": next_start_index,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "took_ms": took_ms,
        "cached": cached,
        "text": wrapped_text,
    }

    return json.dumps(result, ensure_ascii=False), full_text


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
    *,
    full_text: str | None = None,
) -> str:
    """Save fetched content to storage and strip text from the result.

    In session mode, content is saved to Platform DB.  Otherwise it is
    written to a local file under ``FILESYSTEM_CWD``.  Either way, the
    ``text`` field is replaced with a ``session_file`` path so the LLM
    must use ``read`` to view the content.

    When *full_text* is provided, the complete (non-truncated) content is
    saved so the ``read`` tool can paginate through the full page.

    On failure, logs a warning and returns the original result unchanged.
    """
    try:
        data = json.loads(result_json)
        if "error" in data or not data.get("text"):
            return result_json

        content_to_save = full_text if full_text is not None else data["text"]
        rel_path = _make_session_path(url)

        if session_ctx:
            client = get_platform_client(session_ctx)
            await client.write_file(rel_path, content_to_save)
            data["session_file"] = f"/session/{rel_path}"
        else:
            local_path = os.path.join(settings.FILESYSTEM_CWD, rel_path)
            os.makedirs(os.path.dirname(local_path), exist_ok=True)
            with open(local_path, "w", encoding="utf-8") as f:
                f.write(content_to_save)
            data["session_file"] = local_path

        data.pop("text", None)

        # Full content is saved — override pagination to prevent unnecessary re-fetch
        saved_len = len(content_to_save)
        data["truncated"] = False
        data["start_index"] = 0
        data["length"] = saved_len
        data["total_length"] = saved_len
        data["remaining"] = 0
        data["next_start_index"] = None
        data["instruction"] = (
            f"Full content ({saved_len} chars) saved to session_file. "
            f"Use read(path=\"{data['session_file']}\") to view the content."
        )
        return json.dumps(data, ensure_ascii=False)
    except Exception:
        logger.warning("Failed to save web_fetch content to storage", exc_info=True)
        return result_json
