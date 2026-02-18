# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Web search tool using OpenAI search-preview model.

Uses OpenAI's Chat Completions API with web_search_options.
Input/output schema follows OpenAI's web_search_preview tool convention.
"""
import json
import logging
import time
from typing import Optional
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

from openai import AsyncOpenAI

from mcp.server.fastmcp import FastMCP
from src.common.cache import make_cache_key, search_cache
from src.config import settings
from src.common.content_safety import wrap_content

logger = logging.getLogger(__name__)

_TRACKING_PARAMS = {"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"}


def _strip_tracking_params(url: str) -> str:
    """Remove UTM tracking parameters from a URL."""
    parsed = urlparse(url)
    params = parse_qs(parsed.query)
    cleaned = {k: v for k, v in params.items() if k not in _TRACKING_PARAMS}
    new_query = urlencode(cleaned, doseq=True)
    return urlunparse(parsed._replace(query=new_query))


def register_web_search(mcp: FastMCP) -> None:
    """Register the web_search tool with the MCP server.

    Args:
        mcp (FastMCP): The MCP server instance to register the web_search
            tool with.
    """

    # Reuse connection pool across calls
    client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)

    @mcp.tool(
        meta={
            "requires_approval": True,
            # "chain": [
            #     {
            #         "target": "web_fetch",
            #         "extract": "results[*].url",
            #         "arg_mapping": {"url": "$value"},
            #     },
            # ],
        }
    )
    async def web_search(
        query: str,
        search_context_size: str = "medium",
        user_location: Optional[dict] = None,
    ) -> str:
        """Search the web for current information. Returns a summary with url_citation annotations.

        When researching a topic, call this tool multiple times in parallel with
        diverse query keywords to cover different angles. Up to 3 parallel calls
        are recommended for thorough results.

        Args:
            query: The search query string. Use specific, descriptive
                keywords rather than single words.
            search_context_size: Amount of context to retrieve.
                "low" = minimal context, fastest.
                "medium" = balanced (default).
                "high" = most comprehensive, slowest.
            user_location: Optional location for geo-relevant results.
                Example: {"type": "approximate", "approximate": {"country": "KR", "city": "Seoul"}}

        Returns:
            str: JSON string containing the search summary text, citation
                annotations with URLs and titles, query metadata, and
                timing details. On error, returns a JSON string with an
                error message.
        """
        start = time.monotonic()

        if not settings.OPENAI_API_KEY:
            return json.dumps({
                "error": "missing_api_key",
                "message": "web_search needs an OpenAI API key. "
                           "Set OPENAI_API_KEY in your .env file.",
            }, ensure_ascii=False)

        location_str = json.dumps(user_location, sort_keys=True) if user_location else ""
        cache_key = make_cache_key("search", query, search_context_size, location_str)

        if settings.CACHE_ENABLED:
            cached = search_cache.get(cache_key)
            if cached is not None:
                cached["cached"] = True
                cached["took_ms"] = int((time.monotonic() - start) * 1000)
                return json.dumps(cached, ensure_ascii=False)

        web_search_options: dict = {
            "search_context_size": search_context_size,
        }
        if user_location:
            web_search_options["user_location"] = user_location

        try:
            response = await client.chat.completions.create(
                model=settings.OPENAI_SEARCH_MODEL,
                messages=[{"role": "user", "content": query}],
                web_search_options=web_search_options,
            )
        except Exception as e:
            error_type = type(e).__name__
            logger.error("OpenAI search API error (%s): %s", error_type, e)
            return json.dumps({
                "error": error_type,
                "message": f"Search API error: {e}",
                "query": query,
            }, ensure_ascii=False)

        message = response.choices[0].message
        text = message.content or ""

        results = []
        if hasattr(message, "annotations") and message.annotations:
            for ann in message.annotations:
                if hasattr(ann, "url_citation"):
                    results.append({
                        "title": ann.url_citation.title,
                        "url": _strip_tracking_params(ann.url_citation.url),
                        "start_index": ann.url_citation.start_index,
                        "end_index": ann.url_citation.end_index,
                    })

        wrapped_text = wrap_content(
            text,
            source="web_search",
            source_url="openai-search",
        ) if text else "(no search results)"

        took_ms = int((time.monotonic() - start) * 1000)

        result = {
            "query": query,
            "provider": "openai",
            "model": settings.OPENAI_SEARCH_MODEL,
            "search_context_size": search_context_size,
            "count": len(results),
            "took_ms": took_ms,
            "cached": False,
            "text": wrapped_text,
            "results": results,
        }

        if settings.CACHE_ENABLED:
            search_cache.set(cache_key, result)

        return json.dumps(result, ensure_ascii=False)
