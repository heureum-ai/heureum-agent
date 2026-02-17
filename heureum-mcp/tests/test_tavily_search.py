"""Unit tests for Tavily-backed web_search tool."""

import json
from unittest.mock import AsyncMock, patch

import pytest

from src.common.cache import search_cache
from src.tools.web.tavily import register_tavily_search


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_tavily_server():
    """Create an MCP server with the Tavily web_search tool registered."""
    from mcp.server.fastmcp import FastMCP
    mcp = FastMCP("test-tavily")
    register_tavily_search(mcp)
    return mcp


async def _call_tool(server, name: str, args: dict) -> dict:
    tools = server._tool_manager._tools
    result = await tools[name].fn(**args)
    return json.loads(result)


def _build_tavily_response(results: list[dict] | None = None) -> dict:
    """Build a fake Tavily API response dict."""
    return {
        "query": "test",
        "results": results or [],
    }


def _patch_tavily(tavily_response: dict):
    """Patch _search_tavily to return given response."""
    return patch(
        "src.tools.web.tavily._search_tavily",
        new_callable=AsyncMock,
        return_value=tavily_response,
    )


def _patch_tavily_error(exc):
    """Patch _search_tavily to raise."""
    return patch(
        "src.tools.web.tavily._search_tavily",
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
    with patch("src.tools.web.tavily.settings") as mock_settings:
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
        tavily_resp = _build_tavily_response([
            {
                "title": "Example Page",
                "url": "https://example.com/article",
                "content": "This is the article content.",
                "score": 0.95,
            },
        ])

        with _patch_tavily(tavily_resp):
            server = _make_tavily_server()
            result = await _call_tool(server, "web_search", {"query": "example 2026"})

        assert result["provider"] == "tavily"
        assert result["count"] == 1
        assert result["results"][0]["url"] == "https://example.com/article"
        assert result["results"][0]["title"] == "Example Page"
        assert result["results"][0]["score"] == 0.95
        assert "article content" in result["text"].lower()

    @pytest.mark.asyncio
    async def test_multiple_results(self):
        """복수 결과 반환."""
        tavily_resp = _build_tavily_response([
            {"title": "Python Docs", "url": "https://python.org/docs", "content": "Python info.", "score": 0.9},
            {"title": "Rust Lang", "url": "https://rust-lang.org", "content": "Rust info.", "score": 0.8},
        ])

        with _patch_tavily(tavily_resp):
            server = _make_tavily_server()
            result = await _call_tool(server, "web_search", {"query": "python rust 2026"})

        assert result["count"] == 2
        urls = [r["url"] for r in result["results"]]
        assert "https://python.org/docs" in urls
        assert "https://rust-lang.org" in urls

    @pytest.mark.asyncio
    async def test_no_results(self):
        """검색 결과 없는 경우."""
        tavily_resp = _build_tavily_response([])

        with _patch_tavily(tavily_resp):
            server = _make_tavily_server()
            result = await _call_tool(server, "web_search", {"query": "nothing"})

        assert result["count"] == 0
        assert result["results"] == []
        assert result["text"] == "(no search results)"

    @pytest.mark.asyncio
    async def test_api_error_returns_json(self):
        """Tavily API 에러 시 에러 JSON 반환."""
        with _patch_tavily_error(RuntimeError("API rate limit")):
            server = _make_tavily_server()
            result = await _call_tool(server, "web_search", {"query": "test"})

        assert result["error"] == "RuntimeError"
        assert "rate limit" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_missing_api_key(self, _disable_cache):
        """TAVILY_API_KEY가 비어있으면 에러 반환."""
        _disable_cache.TAVILY_API_KEY = ""

        server = _make_tavily_server()
        result = await _call_tool(server, "web_search", {"query": "test"})

        assert result["error"] == "missing_api_key"

    @pytest.mark.asyncio
    async def test_utm_params_stripped(self):
        """UTM 트래킹 파라미터가 URL에서 제거되는지 확인."""
        tavily_resp = _build_tavily_response([
            {
                "title": "Page",
                "url": "https://example.com/page?utm_source=google&utm_medium=cpc&id=123",
                "content": "Content.",
                "score": 0.9,
            },
        ])

        with _patch_tavily(tavily_resp):
            server = _make_tavily_server()
            result = await _call_tool(server, "web_search", {"query": "utm test"})

        cleaned_url = result["results"][0]["url"]
        assert "utm_source" not in cleaned_url
        assert "utm_medium" not in cleaned_url
        assert "id=123" in cleaned_url

    @pytest.mark.asyncio
    async def test_advanced_search_depth(self):
        """search_depth=advanced 전달 확인."""
        tavily_resp = _build_tavily_response([
            {"title": "Deep", "url": "https://deep.com", "content": "Deep result.", "score": 0.99},
        ])

        mock_fn = AsyncMock(return_value=tavily_resp)
        with patch("src.tools.web.tavily._search_tavily", mock_fn):
            server = _make_tavily_server()
            result = await _call_tool(server, "web_search", {
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
        tavily_resp = _build_tavily_response([
            {"title": "KR", "url": "https://kr.com", "content": "Korean result.", "score": 0.9},
        ])

        mock_fn = AsyncMock(return_value=tavily_resp)
        with patch("src.tools.web.tavily._search_tavily", mock_fn):
            server = _make_tavily_server()
            result = await _call_tool(server, "web_search", {
                "query": "korean news",
                "country": "KR",
            })

        assert result["count"] == 1
        args = mock_fn.call_args[0]
        assert args[1:] == ("korean news", "basic", 5, "KR")

    @pytest.mark.asyncio
    async def test_empty_content_skipped(self):
        """content가 빈 결과는 text 합침에서 제외."""
        tavily_resp = _build_tavily_response([
            {"title": "A", "url": "https://a.com", "content": "Real content.", "score": 0.9},
            {"title": "B", "url": "https://b.com", "content": "", "score": 0.5},
        ])

        with _patch_tavily(tavily_resp):
            server = _make_tavily_server()
            result = await _call_tool(server, "web_search", {"query": "test"})

        assert result["count"] == 2
        assert "Real content" in result["text"]


# ===========================================================================
# 2. Tavily 캐시 동작
# ===========================================================================


class TestTavilyCaching:
    """Tavily 검색 캐시 테스트."""

    @pytest.mark.asyncio
    async def test_cache_hit(self, _disable_cache):
        """같은 쿼리 두 번 호출 시 두 번째는 캐시에서 반환."""
        _disable_cache.CACHE_ENABLED = True

        tavily_resp = _build_tavily_response([
            {"title": "Cached", "url": "https://example.com/cached", "content": "Cached text.", "score": 0.9},
        ])

        mock_fn = AsyncMock(return_value=tavily_resp)
        with patch("src.tools.web.tavily._search_tavily", mock_fn):
            server = _make_tavily_server()

            first = await _call_tool(server, "web_search", {"query": "cache test"})
            second = await _call_tool(server, "web_search", {"query": "cache test"})

        assert first["cached"] is False
        assert second["cached"] is True
        assert mock_fn.call_count == 1
