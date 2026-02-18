"""Unit tests for Tavily-backed web_search tool."""

import json
from unittest.mock import AsyncMock, patch

import pytest

from src.common.cache import search_cache
from src.tools.web.search import (
    register_search,
    SearchItem,
    SearchResponse,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_tavily_server():
    """Create an MCP server with the Tavily web_search tool registered."""
    from mcp.server.fastmcp import FastMCP
    mcp = FastMCP("test-tavily")
    register_search(mcp)
    return mcp


async def _call_tool(server, name: str, args: dict) -> dict:
    tools = server._tool_manager._tools
    result = await tools[name].fn(**args)
    return json.loads(result)


def _build_search_response(results: list[dict] | None = None) -> SearchResponse:
    """Build a SearchResponse from Tavily-style dicts."""
    items = [
        SearchItem(
            title=r.get("title", ""),
            url=r.get("url", ""),
            content=r.get("content"),
            score=r.get("score"),
        )
        for r in (results or [])
    ]
    return SearchResponse(provider="tavily", results=items)


def _patch_tavily(results: list[dict] | None = None):
    """Patch _search_tavily to return a SearchResponse built from dicts."""
    return patch(
        "src.tools.web.search._search_tavily",
        new_callable=AsyncMock,
        return_value=_build_search_response(results),
    )


def _patch_tavily_error(exc):
    """Patch _search_tavily to raise."""
    return patch(
        "src.tools.web.search._search_tavily",
        new_callable=AsyncMock,
        side_effect=exc,
    )


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clear_caches():
    search_cache.clear()
    yield
    search_cache.clear()


@pytest.fixture(autouse=True)
def _disable_cache():
    with patch("src.tools.web.search.settings") as mock_settings:
        from src.config import settings as real_settings
        for attr in dir(real_settings):
            if attr.isupper():
                setattr(mock_settings, attr, getattr(real_settings, attr))
        mock_settings.CACHE_ENABLED = False
        mock_settings.TAVILY_API_KEY = "tvly-test-key"
        yield mock_settings


# ===========================================================================
# 1. Tavily 기본 동작
# ===========================================================================


class TestTavilySearch:
    """Tests for Tavily-backed web_search tool."""

    @pytest.mark.asyncio
    async def test_single_result(self):
        """검색 결과 1개 정상 반환."""
        items = [{
            "title": "Example Page",
            "url": "https://example.com/article",
            "content": "This is the article content.",
            "score": 0.95,
        }]

        with _patch_tavily(items):
            server = _make_tavily_server()
            result = await _call_tool(server, "search", {"query": "example 2026"})

        assert result["provider"] == "tavily"
        assert result["count"] == 1
        assert result["results"][0]["url"] == "https://example.com/article"
        assert result["results"][0]["title"] == "Example Page"
        assert result["results"][0]["score"] == 0.95
        assert result["results"][0]["content"] == "This is the article content."

    @pytest.mark.asyncio
    async def test_multiple_results(self):
        """복수 결과 반환."""
        items = [
            {"title": "Python Docs", "url": "https://python.org/docs", "content": "Python info.", "score": 0.9},
            {"title": "Rust Lang", "url": "https://rust-lang.org", "content": "Rust info.", "score": 0.8},
        ]

        with _patch_tavily(items):
            server = _make_tavily_server()
            result = await _call_tool(server, "search", {"query": "python rust 2026"})

        assert result["count"] == 2
        urls = [r["url"] for r in result["results"]]
        assert "https://python.org/docs" in urls
        assert "https://rust-lang.org" in urls

    @pytest.mark.asyncio
    async def test_no_results(self):
        """검색 결과 없는 경우."""
        with _patch_tavily([]):
            server = _make_tavily_server()
            result = await _call_tool(server, "search", {"query": "nothing"})

        assert result["count"] == 0
        assert result["results"] == []

    @pytest.mark.asyncio
    async def test_api_error_returns_json(self):
        """Tavily API 에러 시 에러 JSON 반환."""
        with _patch_tavily_error(RuntimeError("API rate limit")):
            server = _make_tavily_server()
            result = await _call_tool(server, "search", {"query": "test"})

        assert result["error"] == "RuntimeError"
        assert "rate limit" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_missing_api_key(self, _disable_cache):
        """TAVILY_API_KEY가 비어있으면 에러 반환."""
        _disable_cache.TAVILY_API_KEY = ""
        _disable_cache.OPENAI_API_KEY = ""

        with patch("src.tools.web.search._GOOGLE_CLOUD_PROJECT", ""):
            server = _make_tavily_server()
            result = await _call_tool(server, "search", {"query": "test"})

        assert result["error"] == "missing_api_key"

    @pytest.mark.asyncio
    async def test_openai_fallback_when_tavily_key_missing(self, _disable_cache):
        """Tavily key 없고 OpenAI key 있으면 OpenAI fallback 사용."""
        _disable_cache.TAVILY_API_KEY = ""
        _disable_cache.OPENAI_API_KEY = "sk-test"

        fallback = SearchResponse(
            provider="openai",
            model="gpt-4o-mini-search-preview",
            results=[SearchItem(title="Fallback", url="https://example.com/fallback")],
        )

        with patch("src.tools.web.search._GOOGLE_CLOUD_PROJECT", ""), \
             patch("src.tools.web.search._search_openai", new_callable=AsyncMock, return_value=fallback) as mock_openai:
            server = _make_tavily_server()
            result = await _call_tool(server, "search", {"query": "fallback test"})

        assert result["provider"] == "openai"
        assert result["count"] == 1
        assert result["results"][0]["url"] == "https://example.com/fallback"
        mock_openai.assert_awaited_once()

    def test_utm_params_stripped(self):
        """UTM 트래킹 파라미터가 URL에서 제거되는지 확인."""
        from src.tools.web.search import _strip_tracking_params

        url = "https://example.com/page?utm_source=google&utm_medium=cpc&id=123"
        cleaned = _strip_tracking_params(url)

        assert "utm_source" not in cleaned
        assert "utm_medium" not in cleaned
        assert "id=123" in cleaned

    @pytest.mark.asyncio
    async def test_advanced_search_depth(self):
        """search_depth=advanced 전달 확인."""
        sr = _build_search_response([
            {"title": "Deep", "url": "https://deep.com", "content": "Deep result.", "score": 0.99},
        ])

        mock_fn = AsyncMock(return_value=sr)
        with patch("src.tools.web.search._search_tavily", mock_fn):
            server = _make_tavily_server()
            result = await _call_tool(server, "search", {
                "query": "deep search",
                "search_depth": "advanced",
                "max_results": 10,
            })

        assert result["search_depth"] == "advanced"
        args = mock_fn.call_args[0]
        assert args[1:] == ("deep search", "advanced", 10, None)

    @pytest.mark.asyncio
    async def test_country_param(self):
        """country 파라미터 전달 확인."""
        sr = _build_search_response([
            {"title": "KR", "url": "https://kr.com", "content": "Korean result.", "score": 0.9},
        ])

        mock_fn = AsyncMock(return_value=sr)
        with patch("src.tools.web.search._search_tavily", mock_fn):
            server = _make_tavily_server()
            result = await _call_tool(server, "search", {
                "query": "korean news",
                "country": "KR",
            })

        assert result["count"] == 1
        args = mock_fn.call_args[0]
        assert args[1:] == ("korean news", "basic", 1, "KR")

    @pytest.mark.asyncio
    async def test_empty_content_preserved(self):
        """content가 빈 결과도 그대로 전달."""
        items = [
            {"title": "A", "url": "https://a.com", "content": "Real content.", "score": 0.9},
            {"title": "B", "url": "https://b.com", "content": "", "score": 0.5},
        ]

        with _patch_tavily(items):
            server = _make_tavily_server()
            result = await _call_tool(server, "search", {"query": "test"})

        assert result["count"] == 2
        assert result["results"][0]["content"] == "Real content."
        assert result["results"][1]["content"] == ""


# ===========================================================================
# 2. Tavily 캐시 동작
# ===========================================================================


class TestTavilyCaching:
    """Tavily 검색 캐시 테스트."""

    @pytest.mark.asyncio
    async def test_cache_hit(self, _disable_cache):
        """같은 쿼리 두 번 호출 시 두 번째는 캐시에서 반환."""
        _disable_cache.CACHE_ENABLED = True

        sr = _build_search_response([
            {"title": "Cached", "url": "https://example.com/cached", "content": "Cached text.", "score": 0.9},
        ])

        mock_fn = AsyncMock(return_value=sr)
        with patch("src.tools.web.search._search_tavily", mock_fn):
            server = _make_tavily_server()

            first = await _call_tool(server, "search", {"query": "cache test"})
            second = await _call_tool(server, "search", {"query": "cache test"})

        assert first["cached"] is False
        assert second["cached"] is True
        assert mock_fn.call_count == 1
