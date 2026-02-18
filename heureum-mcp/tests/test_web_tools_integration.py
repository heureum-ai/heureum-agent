# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Integration test: web_search → web_fetch pipeline with mocking."""

import json
from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest

from src.common.cache import search_cache, fetch_cache
from src.common.security import SSRFError

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_server():
    """Create a web MCP server with Tavily search + web_fetch registered."""
    from mcp.server.fastmcp import FastMCP
    from src.tools.web.tavily import register_tavily_search
    from src.tools.web.fetch import register_web_fetch

    mcp = FastMCP("test-web-integration")
    register_tavily_search(mcp)
    register_web_fetch(mcp)
    return mcp


async def _call_tool(server, name: str, args: dict) -> dict:
    """Call a registered tool by name and return parsed JSON."""
    tools = server._tool_manager._tools
    result = await tools[name].fn(**args)
    return json.loads(result)


# ---------------------------------------------------------------------------
# Fixtures
# ---------------------------------------------------------------------------


@pytest.fixture(autouse=True)
def _clear_caches():
    """Clear caches before each test to prevent cross-test pollution."""
    search_cache.clear()
    fetch_cache.clear()
    yield
    search_cache.clear()
    fetch_cache.clear()


@pytest.fixture(autouse=True)
def _disable_cache():
    """Disable cache by default. Tests that need cache can override."""
    with patch("src.tools.web.tavily.settings") as mock_search_settings, \
         patch("src.tools.web.fetch.settings") as mock_fetch_settings:
        # Copy real settings attrs, then disable cache
        from src.config import settings as real_settings
        for attr in dir(real_settings):
            if attr.isupper():
                setattr(mock_search_settings, attr, getattr(real_settings, attr))
                setattr(mock_fetch_settings, attr, getattr(real_settings, attr))
        mock_search_settings.CACHE_ENABLED = False
        mock_search_settings.TAVILY_API_KEY = "tvly-test-key"
        mock_fetch_settings.CACHE_ENABLED = False
        yield mock_search_settings, mock_fetch_settings


def _build_tavily_response(results: list[dict] | None = None) -> dict:
    """Build a fake Tavily API response dict."""
    return {
        "query": "test",
        "results": results or [],
    }


def _build_httpx_response(
    *,
    url: str = "https://example.com",
    status_code: int = 200,
    html: str = "<html><head><title>Test</title></head><body><p>content</p></body></html>",
    content_type: str = "text/html; charset=utf-8",
    is_success: bool = True,
):
    """Build a fake httpx response."""
    resp = MagicMock()
    resp.is_success = is_success
    resp.status_code = status_code
    resp.reason_phrase = "OK" if is_success else "Error"
    resp.url = url
    resp.headers = {"content-type": content_type}
    resp.text = html
    return resp


def _patch_tavily(tavily_response):
    """Context manager that patches _search_tavily to return given response."""
    return patch(
        "src.tools.web.tavily._search_tavily",
        new_callable=AsyncMock,
        return_value=tavily_response,
    )


def _patch_tavily_error(exc):
    """Context manager that patches _search_tavily to raise."""
    return patch(
        "src.tools.web.tavily._search_tavily",
        new_callable=AsyncMock,
        side_effect=exc,
    )


def _patch_fetch(httpx_response):
    """Context manager that patches fetch_with_ssrf_guard."""
    return patch(
        "src.tools.web.fetch.fetch_with_ssrf_guard",
        new_callable=AsyncMock,
        return_value=httpx_response,
    )


def _patch_fetch_error(exc):
    """Context manager that patches fetch_with_ssrf_guard to raise."""
    return patch(
        "src.tools.web.fetch.fetch_with_ssrf_guard",
        new_callable=AsyncMock,
        side_effect=exc,
    )


# ===========================================================================
# 1. search → fetch 파이프라인
# ===========================================================================

class TestSearchThenFetch:
    """web_search 결과의 URL을 web_fetch로 가져오는 E2E 파이프라인."""

    @pytest.mark.asyncio
    async def test_single_result_pipeline(self, tmp_path):
        """검색 결과 1개 → fetch 성공."""
        tmp_path_str = str(tmp_path)
        tavily_resp = _build_tavily_response([
            {
                "title": "Example Page",
                "url": "https://example.com/article",
                "content": "Example Domain is reserved for documentation.",
                "score": 0.95,
            },
        ])
        httpx_resp = _build_httpx_response(
            url="https://example.com/article",
            html="<html><head><title>Example Page</title></head>"
                 "<body><p>This is the full article content.</p></body></html>",
        )

        with _patch_tavily(tavily_resp):
            server = _make_server()
            search = await _call_tool(server, "web_search", {"query": "example 2026"})

        assert search["count"] == 1
        url = search["results"][0]["url"]
        assert url == "https://example.com/article"

        with _patch_fetch(httpx_resp), patch("src.tools.web.fetch.settings") as mock_s:
            mock_s.FILESYSTEM_CWD = tmp_path_str
            mock_s.WEB_FETCH_MAX_LENGTH = 50000
            mock_s.WEB_FETCH_TIMEOUT = 30
            mock_s.WEB_FETCH_USER_AGENT = "test"
            mock_s.CACHE_ENABLED = False
            fetch = await _call_tool(server, "web_fetch", {"url": url})

        assert fetch["status"] == 200
        assert fetch["title"] == "Example Page"
        assert "session_file" in fetch
        assert "text" not in fetch

    @pytest.mark.asyncio
    async def test_multiple_results(self):
        """복수 결과가 있는 검색 결과."""
        tavily_resp = _build_tavily_response([
            {"title": "Python Docs", "url": "https://python.org/docs", "content": "Python info.", "score": 0.9},
            {"title": "Rust Lang", "url": "https://rust-lang.org", "content": "Rust info.", "score": 0.8},
        ])

        with _patch_tavily(tavily_resp):
            server = _make_server()
            result = await _call_tool(server, "web_search", {"query": "python rust 2026"})

        assert result["count"] == 2
        urls = [r["url"] for r in result["results"]]
        assert "https://python.org/docs" in urls
        assert "https://rust-lang.org" in urls


# ===========================================================================
# 2. web_search 단위 테스트
# ===========================================================================

class TestWebSearch:
    """Tests for the web_search tool including error handling and URL cleanup."""

    @pytest.mark.asyncio
    async def test_no_results(self):
        """검색 결과가 없는 경우."""
        tavily_resp = _build_tavily_response([])

        with _patch_tavily(tavily_resp):
            server = _make_server()
            result = await _call_tool(server, "web_search", {"query": "nothing"})

        assert result["count"] == 0
        assert result["results"] == []

    @pytest.mark.asyncio
    async def test_api_error_returns_json(self):
        """Tavily API 에러 시 에러 JSON 반환."""
        with _patch_tavily_error(RuntimeError("API rate limit")):
            server = _make_server()
            result = await _call_tool(server, "web_search", {"query": "test"})

        assert result["error"] == "RuntimeError"
        assert "rate limit" in result["message"].lower()

    @pytest.mark.asyncio
    async def test_missing_api_key(self, _disable_cache):
        """TAVILY_API_KEY가 비어있으면 에러 반환."""
        mock_search_settings, _ = _disable_cache
        mock_search_settings.TAVILY_API_KEY = ""
        mock_search_settings.OPENAI_API_KEY = ""

        server = _make_server()
        result = await _call_tool(server, "web_search", {"query": "test"})

        assert result["error"] == "missing_api_key"

    @pytest.mark.asyncio
    async def test_utm_params_stripped(self):
        """UTM 트래킹 파라미터가 URL에서 제거되는지 확인."""
        url_with_utm = "https://example.com/page?utm_source=google&utm_medium=cpc&id=123"
        tavily_resp = _build_tavily_response([
            {"title": "Page", "url": url_with_utm, "content": "Result text.", "score": 0.9},
        ])

        with _patch_tavily(tavily_resp):
            server = _make_server()
            result = await _call_tool(server, "web_search", {"query": "utm test"})

        cleaned_url = result["results"][0]["url"]
        assert "utm_source" not in cleaned_url
        assert "utm_medium" not in cleaned_url
        assert "id=123" in cleaned_url

    @pytest.mark.asyncio
    async def test_empty_content(self):
        """Tavily가 content 없는 결과 반환 시 처리."""
        tavily_resp = _build_tavily_response([
            {"title": "Empty", "url": "https://example.com", "content": "", "score": 0.5},
        ])

        with _patch_tavily(tavily_resp):
            server = _make_server()
            result = await _call_tool(server, "web_search", {"query": "empty content test"})

        assert result["count"] == 1
        assert result["results"][0]["content"] == ""


# ===========================================================================
# 3. web_fetch 단위 테스트
# ===========================================================================

class TestWebFetch:
    """Tests for the web_fetch tool including SSRF, status codes, and content types."""

    @pytest.mark.asyncio
    async def test_success_html(self):
        """HTML 페이지 정상 fetch."""
        resp = _build_httpx_response(
            url="https://example.com/success",
            html="<html><head><title>Hello</title></head><body><p>World</p></body></html>",
        )
        server = _make_server()

        with _patch_fetch(resp):
            result = await _call_tool(server, "web_fetch", {"url": "https://example.com/success"})

        assert result["status"] == 200
        assert result["title"] == "Hello"
        assert not result["truncated"]

    @pytest.mark.asyncio
    async def test_ssrf_blocked(self):
        """SSRF 차단 시 blocked=True 반환."""
        server = _make_server()

        with _patch_fetch_error(SSRFError("Blocked: private IP")):
            result = await _call_tool(server, "web_fetch", {"url": "http://169.254.169.254/metadata"})

        assert result["blocked"] is True
        assert "private" in result["error"].lower()

    @pytest.mark.asyncio
    async def test_http_status_error(self):
        """HTTP 4xx/5xx HTTPStatusError 예외 처리."""
        server = _make_server()

        mock_response = MagicMock()
        mock_response.status_code = 403
        mock_response.reason_phrase = "Forbidden"

        with _patch_fetch_error(
            httpx.HTTPStatusError("Forbidden", request=MagicMock(), response=mock_response)
        ):
            result = await _call_tool(server, "web_fetch", {"url": "https://example.com/secret"})

        assert "403" in result["error"]

    @pytest.mark.asyncio
    async def test_timeout(self):
        """타임아웃 에러 처리."""
        server = _make_server()

        with _patch_fetch_error(httpx.TimeoutException("timed out")):
            result = await _call_tool(server, "web_fetch", {"url": "https://slow.com"})

        assert "timed out" in result["error"].lower()

    @pytest.mark.asyncio
    async def test_non_success_status(self):
        """is_success=False인 응답 처리 (서버가 200 외 코드 반환)."""
        resp = _build_httpx_response(
            url="https://example.com/500",
            status_code=500,
            is_success=False,
        )
        resp.reason_phrase = "Internal Server Error"
        server = _make_server()

        with _patch_fetch(resp):
            result = await _call_tool(server, "web_fetch", {"url": "https://example.com/500"})

        assert "500" in result["error"]
        assert result["status"] == 500

    @pytest.mark.asyncio
    async def test_pagination_truncation(self):
        """start_index + max_length로 pagination 동작 확인."""
        long_body = "A" * 200
        resp = _build_httpx_response(
            url="https://example.com/long",
            html=f"<html><body><p>{long_body}</p></body></html>",
        )
        server = _make_server()

        with _patch_fetch(resp):
            result = await _call_tool(server, "web_fetch", {
                "url": "https://example.com/long",
                "start_index": 50,
                "max_length": 100,
            })

        assert result["truncated"] is True
        assert result["length"] == 100

    @pytest.mark.asyncio
    async def test_json_content_type(self, tmp_path):
        """JSON content-type 응답 처리."""
        json_body = json.dumps({"key": "value", "nested": {"a": 1}})
        resp = _build_httpx_response(
            url="https://api.example.com/data",
            html=json_body,
            content_type="application/json",
        )
        server = _make_server()

        with _patch_fetch(resp), patch("src.tools.web.fetch.settings") as mock_s:
            mock_s.FILESYSTEM_CWD = str(tmp_path)
            mock_s.WEB_FETCH_MAX_LENGTH = 50000
            mock_s.WEB_FETCH_TIMEOUT = 30
            mock_s.WEB_FETCH_USER_AGENT = "test"
            mock_s.CACHE_ENABLED = False
            result = await _call_tool(server, "web_fetch", {"url": "https://api.example.com/data"})

        assert result["content_type"] == "application/json"
        assert "session_file" in result
        # Verify content was saved to local file
        with open(result["session_file"], encoding="utf-8") as f:
            assert "key" in f.read()

    @pytest.mark.asyncio
    async def test_generic_exception(self):
        """예상치 못한 예외 처리."""
        server = _make_server()

        with _patch_fetch_error(ConnectionError("DNS resolution failed")):
            result = await _call_tool(server, "web_fetch", {"url": "https://nonexistent.invalid"})

        assert "dns" in result["error"].lower()


# ===========================================================================
# 4. 캐시 동작
# ===========================================================================

class TestCaching:
    """캐시 테스트 — autouse _disable_cache를 오버라이드하여 캐시 활성화."""

    @pytest.mark.asyncio
    async def test_search_cache_hit(self, _disable_cache):
        """같은 쿼리 두 번 호출 시 두 번째는 캐시에서 반환."""
        mock_search_settings, _ = _disable_cache
        mock_search_settings.CACHE_ENABLED = True

        tavily_resp = _build_tavily_response([
            {"title": "Cached", "url": "https://example.com/cached", "content": "Cached text.", "score": 0.9},
        ])

        mock_fn = AsyncMock(return_value=tavily_resp)
        with patch("src.tools.web.tavily._search_tavily", mock_fn):
            server = _make_server()

            first = await _call_tool(server, "web_search", {"query": "cache test"})
            second = await _call_tool(server, "web_search", {"query": "cache test"})

        assert first["cached"] is False
        assert second["cached"] is True
        assert mock_fn.call_count == 1

    @pytest.mark.asyncio
    async def test_fetch_cache_hit(self, _disable_cache):
        """같은 URL 두 번 fetch 시 캐시 동작 확인."""
        _, mock_fetch_settings = _disable_cache
        mock_fetch_settings.CACHE_ENABLED = True

        resp = _build_httpx_response(url="https://example.com/cache-test")
        mock_guard = AsyncMock(return_value=resp)

        with patch("src.tools.web.fetch.fetch_with_ssrf_guard", mock_guard):
            server = _make_server()

            first = await _call_tool(server, "web_fetch", {"url": "https://example.com/cache-test"})
            second = await _call_tool(server, "web_fetch", {"url": "https://example.com/cache-test"})

        assert first["cached"] is False
        assert second["cached"] is True
        assert mock_guard.call_count == 1

    @pytest.mark.asyncio
    async def test_fetch_custom_headers_skip_cache(self, _disable_cache):
        """커스텀 헤더가 있으면 캐시를 우회해야 함."""
        _, mock_fetch_settings = _disable_cache
        mock_fetch_settings.CACHE_ENABLED = True

        resp = _build_httpx_response(url="https://example.com/auth")
        mock_guard = AsyncMock(return_value=resp)

        with patch("src.tools.web.fetch.fetch_with_ssrf_guard", mock_guard):
            server = _make_server()

            first = await _call_tool(server, "web_fetch", {
                "url": "https://example.com/auth",
                "headers": {"Authorization": "Bearer tok"},
            })
            second = await _call_tool(server, "web_fetch", {
                "url": "https://example.com/auth",
                "headers": {"Authorization": "Bearer tok"},
            })

        assert first["cached"] is False
        assert second["cached"] is False
        assert mock_guard.call_count == 2


# ===========================================================================
# 5. Firecrawl 폴백 통합
# ===========================================================================

class TestFirecrawlFallback:
    """Firecrawl fallback이 3곳에서 올바르게 동작하는지 검증."""

    @staticmethod
    def _firecrawl_result():
        """Build a mock Firecrawl ExtractedContent result for testing."""
        from src.tools.web.fetch_utils import ExtractedContent
        return ExtractedContent(
            title="Firecrawl Title",
            text="# Content from Firecrawl",
            extractor="firecrawl",
        )

    @pytest.mark.asyncio
    async def test_fallback_on_network_error(self, tmp_path):
        """네트워크 에러 시 Firecrawl fallback 동작."""
        server = _make_server()

        with _patch_fetch_error(httpx.ConnectError("Connection refused")), \
             patch("src.tools.web.fetch.fetch_firecrawl", new_callable=AsyncMock, return_value=self._firecrawl_result()), \
             patch("src.tools.web.fetch.settings") as mock_s:
            mock_s.FILESYSTEM_CWD = str(tmp_path)
            mock_s.WEB_FETCH_MAX_LENGTH = 50000
            mock_s.WEB_FETCH_TIMEOUT = 30
            mock_s.WEB_FETCH_USER_AGENT = "test"
            mock_s.CACHE_ENABLED = False
            result = await _call_tool(server, "web_fetch", {"url": "https://blocked.com"})

        assert result["extractor"] == "firecrawl"
        assert result["title"] == "Firecrawl Title"
        assert "session_file" in result

    @pytest.mark.asyncio
    async def test_fallback_on_http_500(self):
        """HTTP 500 에러 시 Firecrawl fallback 동작."""
        resp = _build_httpx_response(
            url="https://error.com",
            status_code=500,
            is_success=False,
        )
        resp.reason_phrase = "Internal Server Error"
        server = _make_server()

        with _patch_fetch(resp):
            with patch(
                "src.tools.web.fetch.fetch_firecrawl",
                new_callable=AsyncMock,
                return_value=self._firecrawl_result(),
            ):
                result = await _call_tool(server, "web_fetch", {"url": "https://error.com"})

        assert result["extractor"] == "firecrawl"

    @pytest.mark.asyncio
    async def test_fallback_on_empty_extraction(self, tmp_path):
        """Readability 추출이 비어있을 때 Firecrawl fallback 동작."""
        resp = _build_httpx_response(
            url="https://spa.com",
            html="<html><body></body></html>",  # Empty
        )
        server = _make_server()

        with _patch_fetch(resp), \
             patch("src.tools.web.fetch.fetch_firecrawl", new_callable=AsyncMock, return_value=self._firecrawl_result()), \
             patch("src.tools.web.fetch.settings") as mock_s:
            mock_s.FILESYSTEM_CWD = str(tmp_path)
            mock_s.WEB_FETCH_MAX_LENGTH = 50000
            mock_s.WEB_FETCH_TIMEOUT = 30
            mock_s.WEB_FETCH_USER_AGENT = "test"
            mock_s.CACHE_ENABLED = False
            result = await _call_tool(server, "web_fetch", {"url": "https://spa.com"})

        assert result["extractor"] == "firecrawl"
        assert "session_file" in result

    @pytest.mark.asyncio
    async def test_no_fallback_when_firecrawl_disabled(self):
        """Firecrawl이 None 반환하면 원래 에러 흐름."""
        resp = _build_httpx_response(
            url="https://error.com",
            status_code=403,
            is_success=False,
        )
        resp.reason_phrase = "Forbidden"
        server = _make_server()

        with _patch_fetch(resp):
            with patch(
                "src.tools.web.fetch.fetch_firecrawl",
                new_callable=AsyncMock,
                return_value=None,
            ):
                result = await _call_tool(server, "web_fetch", {"url": "https://error.com"})

        assert "403" in result["error"]
        assert result["status"] == 403


# ===========================================================================
# 6. Chain metadata 검증
# ===========================================================================

class TestChainMetadata:
    """web_search tool의 chain 메타데이터 구조 검증."""

    def test_no_chain(self):
        """web_search에 chain이 없어야 한다."""
        server = _make_server()
        tools = server._tool_manager._tools
        meta = tools["web_search"].meta or {}
        chain = meta.get("chain", [])
        assert len(chain) == 0
