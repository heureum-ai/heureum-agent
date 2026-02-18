"""Web search tools: Tavily, OpenAI, and Gemini Grounding Search.

Tavily is the primary provider (~0.8s). Gemini Grounding with Google Search
and OpenAI search-preview serve as fallbacks.

Fallback order: Tavily → Gemini Grounding → OpenAI
"""

import json
import logging
import os
import time
from dataclasses import dataclass, field
from typing import Optional
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

import httpx
from google import genai
from google.genai import types
from mcp.server.fastmcp import FastMCP
from openai import AsyncOpenAI
from src.common.cache import make_cache_key, search_cache
from src.config import settings

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------

TAVILY_SEARCH_URL = "https://api.tavily.com/search"

_TRACKING_PARAMS = {
    "utm_source",
    "utm_medium",
    "utm_campaign",
    "utm_term",
    "utm_content",
}

_COUNTRY_CODE_MAP = {
    "KR": "south korea",
    "US": "united states",
    "GB": "united kingdom",
    "JP": "japan",
    "CN": "china",
    "DE": "germany",
    "FR": "france",
    "CA": "canada",
    "AU": "australia",
    "IN": "india",
    "BR": "brazil",
    "IT": "italy",
    "ES": "spain",
    "MX": "mexico",
    "NL": "netherlands",
    "SE": "sweden",
    "CH": "switzerland",
    "SG": "singapore",
    "TW": "taiwan",
    "HK": "hong kong",
    "NZ": "new zealand",
    "IE": "ireland",
    "IL": "israel",
}

# Gemini Grounding — read from env (not in Settings; shared GCP config)
_GEMINI_GROUNDING_MODEL = os.getenv("GEMINI_GROUNDING_SEARCH_MODEL", "gemini-2.5-flash-lite")
_GOOGLE_CLOUD_PROJECT = os.getenv("GOOGLE_CLOUD_PROJECT", "")
_GOOGLE_CLOUD_LOCATION = os.getenv("GOOGLE_CLOUD_LOCATION", "us-central1")

# ---------------------------------------------------------------------------
# Unified search result schema
# ---------------------------------------------------------------------------


@dataclass
class SearchItem:
    """Single search result entry (common across all providers)."""

    title: str = ""
    url: str = ""
    content: Optional[str] = None  # Tavily only; None = not provided
    score: Optional[float] = None  # Tavily only; None = not provided


@dataclass
class SearchResponse:
    """Normalised output returned by every provider adapter."""

    provider: str = ""
    model: Optional[str] = None
    answer: Optional[str] = None  # LLM-generated answer (Gemini, OpenAI)
    results: list[SearchItem] = field(default_factory=list)

    def to_results_list(self) -> list[dict]:
        """Convert results to dicts, including only fields that were set."""
        out = []
        for item in self.results:
            d: dict = {"title": item.title, "url": item.url}
            if item.content is not None:
                d["content"] = item.content
            if item.score is not None:
                d["score"] = item.score
            out.append(d)
        return out


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


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


def _clean_url(url: str) -> str:
    return _strip_tracking_params(url) if url else ""


# ---------------------------------------------------------------------------
# Provider implementations — each returns SearchResponse
# ---------------------------------------------------------------------------


async def _search_tavily(
    http: httpx.AsyncClient,
    query: str,
    search_depth: str,
    max_results: int,
    country: Optional[str],
) -> SearchResponse:
    """Call Tavily REST API."""
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

    data = resp.json()
    items = [
        SearchItem(
            title=r.get("title", ""),
            url=_clean_url(r.get("url", "")),
            content=r.get("content", ""),
            score=r.get("score", 0.0),
        )
        for r in data.get("results", [])
    ]
    return SearchResponse(provider="tavily", results=items)


async def _search_gemini_grounding(query: str, max_results: int) -> SearchResponse:
    """Search via Gemini Grounding with Google Search on Vertex AI."""
    client = genai.Client(
        vertexai=True,
        project=_GOOGLE_CLOUD_PROJECT,
        location=_GOOGLE_CLOUD_LOCATION,
    )
    response = await client.aio.models.generate_content(
        model=_GEMINI_GROUNDING_MODEL,
        contents=query,
        config=types.GenerateContentConfig(
            tools=[types.Tool(google_search=types.GoogleSearch())],
        ),
    )

    candidate = response.candidates[0] if response.candidates else None
    grounding_meta = getattr(candidate, "grounding_metadata", None)

    items: list[SearchItem] = []
    if grounding_meta:
        for chunk in getattr(grounding_meta, "grounding_chunks", None) or []:
            web = getattr(chunk, "web", None)
            if web:
                items.append(
                    SearchItem(
                        title=getattr(web, "title", ""),
                        url=_clean_url(getattr(web, "uri", "")),
                    )
                )

    if max_results > 0:
        items = items[:max_results]

    return SearchResponse(
        provider="gemini_grounding",
        model=_GEMINI_GROUNDING_MODEL,
        answer=response.text or "",
        results=items,
    )


async def _search_openai(query: str, max_results: int, country: Optional[str]) -> SearchResponse:
    """Fallback search via OpenAI search-preview."""
    client = AsyncOpenAI(api_key=settings.OPENAI_API_KEY)

    web_search_options: dict = {"search_context_size": "medium"}
    if country:
        country_code = country.strip().upper()
        if len(country_code) == 2:
            web_search_options["user_location"] = {
                "type": "approximate",
                "approximate": {"country": country_code},
            }

    response = await client.chat.completions.create(
        model=settings.OPENAI_SEARCH_MODEL,
        messages=[{"role": "user", "content": query}],
        web_search_options=web_search_options,
    )
    message = response.choices[0].message

    items: list[SearchItem] = []
    for ann in getattr(message, "annotations", None) or []:
        citation = getattr(ann, "url_citation", None)
        if citation:
            items.append(
                SearchItem(
                    title=citation.title,
                    url=_clean_url(citation.url),
                )
            )

    if max_results > 0:
        items = items[:max_results]

    return SearchResponse(
        provider="openai",
        model=settings.OPENAI_SEARCH_MODEL,
        answer=message.content or "",
        results=items,
    )


# ---------------------------------------------------------------------------
# Dispatch: pick provider → SearchResponse
# ---------------------------------------------------------------------------


async def _dispatch_search(
    http: httpx.AsyncClient,
    query: str,
    search_depth: str,
    max_results: int,
    country: Optional[str],
) -> SearchResponse:
    """Select a search provider and return a normalised SearchResponse."""
    if settings.TAVILY_API_KEY:
        return await _search_tavily(http, query, search_depth, max_results, country)

    if _GOOGLE_CLOUD_PROJECT:
        return await _search_gemini_grounding(query, max_results)

    if settings.OPENAI_API_KEY:
        return await _search_openai(query, max_results, country)

    raise LookupError(
        "No search API key configured. Set TAVILY_API_KEY, GOOGLE_CLOUD_PROJECT, or OPENAI_API_KEY."
    )


# ---------------------------------------------------------------------------
# MCP tool registration
# ---------------------------------------------------------------------------


def register_search(mcp: FastMCP) -> None:
    """Register the ``search`` tool with the MCP server."""

    http = httpx.AsyncClient()

    @mcp.tool(
        name="mcp_web__search",
        meta={
            "requires_approval": True,
            "display_name": "Web Search",
        },
    )
    async def web_search(
        query: str,
        search_depth: str = "basic",
        max_results: int = 3,
        country: Optional[str] = None,
    ) -> str:
        """Search the web for current information. Returns brief snippets \
and URLs. To get full page content, call 'fetch' on the most relevant \
URLs from the results — choose selectively based on title and snippet.

        When researching a topic, call this tool multiple times in parallel \
with diverse query keywords to cover different angles. Up to 3 parallel \
calls are recommended for thorough results.

        Args:
            query: The search query string. Use specific, descriptive
                keywords rather than single words.
            search_depth: "basic" (faster, default) or "advanced" (slower, more thorough).
            max_results: Number of results to return (1-20, default 1).
            country: Optional country for geo-relevant results. Accepts ISO code ("KR") or name ("south korea").

        Returns:
            str: JSON with search result snippets, URLs, and titles.
                Call 'fetch' on relevant URLs to retrieve full content.
        """
        start = time.monotonic()

        cache_key = make_cache_key("search", query, search_depth, str(max_results), country or "")

        if settings.CACHE_ENABLED:
            cached = search_cache.get(cache_key)
            if cached is not None:
                cached["cached"] = True
                cached["took_ms"] = int((time.monotonic() - start) * 1000)
                return json.dumps(cached, ensure_ascii=False)

        try:
            sr = await _dispatch_search(http, query, search_depth, max_results, country)
        except LookupError as e:
            return json.dumps(
                {
                    "error": "missing_api_key",
                    "message": str(e),
                },
                ensure_ascii=False,
            )
        except httpx.HTTPStatusError as e:
            body = e.response.text if e.response else ""
            logger.error("Search API error (%s): %s body=%s", type(e).__name__, e, body)
            return json.dumps(
                {
                    "error": type(e).__name__,
                    "message": f"Search API error: {e}",
                    "detail": body,
                    "query": query,
                },
                ensure_ascii=False,
            )
        except Exception as e:
            logger.error("Search API error (%s): %s", type(e).__name__, e)
            return json.dumps(
                {
                    "error": type(e).__name__,
                    "message": f"Search API error: {e}",
                    "query": query,
                },
                ensure_ascii=False,
            )

        took_ms = int((time.monotonic() - start) * 1000)

        result: dict = {
            "instruction": "Call fetch on the most relevant URLs to retrieve full content. "
            "Then use read or grep on the returned session_file paths.",
            "query": query,
            "provider": sr.provider,
            "search_depth": search_depth,
            "count": len(sr.results),
            "took_ms": took_ms,
            "cached": False,
            "results": sr.to_results_list(),
        }
        if sr.model:
            result["model"] = sr.model
        if sr.answer:
            result["answer"] = sr.answer

        if settings.CACHE_ENABLED:
            search_cache.set(cache_key, result)

        return json.dumps(result, ensure_ascii=False)
