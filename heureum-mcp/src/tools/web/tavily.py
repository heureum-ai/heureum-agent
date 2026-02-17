"""Web search tool using Tavily Search API.

Uses Tavily's REST API for fast web search (~0.6s vs OpenAI's ~4.6s).
Registered as `web_search` — same tool name as the OpenAI variant for
downstream compatibility.
"""
import json
import logging
import time
from typing import Optional
from urllib.parse import urlparse, parse_qs, urlencode, urlunparse

import httpx

from mcp.server.fastmcp import FastMCP
from src.common.cache import make_cache_key, search_cache
from src.config import settings
from src.common.content_safety import wrap_content

logger = logging.getLogger(__name__)

_TRACKING_PARAMS = {"utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"}

TAVILY_SEARCH_URL = "https://api.tavily.com/search"

# ISO 2-letter code → Tavily country name (lowercase)
_COUNTRY_CODE_MAP = {
    "KR": "south korea", "US": "united states", "GB": "united kingdom",
    "JP": "japan", "CN": "china", "DE": "germany", "FR": "france",
    "CA": "canada", "AU": "australia", "IN": "india", "BR": "brazil",
    "IT": "italy", "ES": "spain", "MX": "mexico", "NL": "netherlands",
    "SE": "sweden", "CH": "switzerland", "SG": "singapore", "TW": "taiwan",
    "HK": "hong kong", "NZ": "new zealand", "IE": "ireland", "IL": "israel",
}


def _normalize_country(value: str) -> str:
    """Convert country input to Tavily-compatible lowercase name."""
    upper = value.strip().upper()
    if upper in _COUNTRY_CODE_MAP:
        return _COUNTRY_CODE_MAP[upper]
    return value.strip().lower()


def _strip_tracking_params(url: str) -> str:
    """Remove UTM tracking parameters from a URL."""
    parsed = urlparse(url)
    params = parse_qs(parsed.query)
    cleaned = {k: v for k, v in params.items() if k not in _TRACKING_PARAMS}
    new_query = urlencode(cleaned, doseq=True)
    return urlunparse(parsed._replace(query=new_query))


async def _search_tavily(
    http: httpx.AsyncClient,
    query: str,
    search_depth: str,
    max_results: int,
    country: Optional[str],
) -> dict:
    """Call Tavily REST API and return the raw JSON response."""
    payload: dict = {
        "query": query,
        "search_depth": search_depth,
        "include_answer": False,
        "max_results": max_results,
    }

    if country:
        payload["country"] = _normalize_country(country)

    resp = await http.post(
        TAVILY_SEARCH_URL,
        json=payload,
        headers={"Authorization": f"Bearer {settings.TAVILY_API_KEY}"},
        timeout=15.0,
    )
    if not resp.is_success:
        logger.error("Tavily API %s: %s", resp.status_code, resp.text)
    resp.raise_for_status()
    return resp.json()


def register_tavily_search(mcp: FastMCP) -> None:
    """Register the web_search tool (Tavily-backed) with the MCP server.

    Args:
        mcp (FastMCP): The MCP server instance to register the web_search
            tool with.
    """

    # Reuse connection pool across concurrent calls
    http = httpx.AsyncClient()

    @mcp.tool(
        meta={
            "requires_approval": True,
        }
    )
    async def web_search(
        query: str,
        search_depth: str = "basic",
        max_results: int = 5,
        country: Optional[str] = None,
    ) -> str:
        """Search the web for current information using Tavily.

        Returns brief snippets and URLs. To get full page content, use
        web_fetch on the most relevant URLs from the results.

        When researching a topic, call this tool multiple times in parallel with
        diverse query keywords to cover different angles. Up to 3 parallel calls
        are recommended for thorough results.

        Args:
            query: The search query string. MUST include the 4-digit current
                year (e.g. "2026") in the query for accurate results.
                Use specific, descriptive keywords rather than single words.
            search_depth: "basic" (faster, default) or "advanced" (slower, more thorough).
            max_results: Number of results to return (1-20, default 5).
            country: Optional country for geo-relevant results. Accepts ISO code ("KR") or name ("south korea").

        Returns:
            str: JSON string containing search result snippets, URLs with titles,
                query metadata, and timing details. On error, returns a JSON
                string with an error message.
        """
        start = time.monotonic()

        if not settings.TAVILY_API_KEY:
            return json.dumps({
                "error": "missing_api_key",
                "message": "web_search needs a Tavily API key. "
                           "Set TAVILY_API_KEY in your .env file.",
            }, ensure_ascii=False)

        cache_key = make_cache_key("search", query, search_depth, str(max_results), country or "")

        if settings.CACHE_ENABLED:
            cached = search_cache.get(cache_key)
            if cached is not None:
                cached["cached"] = True
                cached["took_ms"] = int((time.monotonic() - start) * 1000)
                return json.dumps(cached, ensure_ascii=False)

        try:
            tavily_data = await _search_tavily(http, query, search_depth, max_results, country)
        except httpx.HTTPStatusError as e:
            error_type = type(e).__name__
            body = e.response.text if e.response else ""
            logger.error("Tavily search API error (%s): %s body=%s", error_type, e, body)
            return json.dumps({
                "error": error_type,
                "message": f"Search API error: {e}",
                "detail": body,
                "query": query,
            }, ensure_ascii=False)
        except Exception as e:
            error_type = type(e).__name__
            logger.error("Tavily search API error (%s): %s", error_type, e)
            return json.dumps({
                "error": error_type,
                "message": f"Search API error: {e}",
                "query": query,
            }, ensure_ascii=False)

        tavily_results = tavily_data.get("results", [])
        snippets = [r.get("content", "") for r in tavily_results if r.get("content")]
        combined_text = "\n\n".join(snippets)

        wrapped_text = wrap_content(
            combined_text,
            source="web_search",
            source_url="tavily-search",
        ) if combined_text else "(no search results)"

        results = [
            {
                "title": r.get("title", ""),
                "url": _strip_tracking_params(r.get("url", "")),
                "score": r.get("score"),
            }
            for r in tavily_results
        ]

        took_ms = int((time.monotonic() - start) * 1000)

        result = {
            "query": query,
            "provider": "tavily",
            "search_depth": search_depth,
            "count": len(results),
            "took_ms": took_ms,
            "cached": False,
            "text": wrapped_text,
            "results": results,
        }

        if settings.CACHE_ENABLED:
            search_cache.set(cache_key, result)

        return json.dumps(result, ensure_ascii=False)
