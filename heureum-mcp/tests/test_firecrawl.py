# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for Firecrawl fallback content extraction."""

from unittest.mock import AsyncMock, MagicMock, patch

import httpx
import pytest
from src.tools.web.fetch import fetch_firecrawl

# ---------------------------------------------------------------------------
# Fixtures to reduce boilerplate
# ---------------------------------------------------------------------------


@pytest.fixture()
def firecrawl_settings():
    """Patch settings for Firecrawl enabled with API key."""
    with patch("src.tools.web.fetch.settings") as mock_settings:
        mock_settings.FIRECRAWL_ENABLED = True
        mock_settings.FIRECRAWL_API_KEY = "fc-test-key"
        mock_settings.FIRECRAWL_BASE_URL = "https://api.firecrawl.dev"
        mock_settings.FIRECRAWL_TIMEOUT = 30.0
        yield mock_settings


@pytest.fixture()
def mock_httpx_client():
    """Create a mock httpx.AsyncClient with async context manager support."""
    with patch("httpx.AsyncClient") as mock_cls:
        mock_client = AsyncMock()
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=None)
        mock_cls.return_value = mock_client
        yield mock_client


def _make_firecrawl_response(
    *,
    success: bool = True,
    markdown: str = "# Content",
    title: str = "Title",
    is_success: bool = True,
    status_code: int = 200,
) -> MagicMock:
    """Create a mock Firecrawl API response."""
    resp = MagicMock()
    resp.is_success = is_success
    resp.status_code = status_code
    resp.json.return_value = {
        "success": success,
        "data": {
            "markdown": markdown,
            "metadata": {"title": title, "sourceURL": "https://example.com"},
        },
    }
    return resp


# ---------------------------------------------------------------------------
# Guard conditions
# ---------------------------------------------------------------------------


class TestFirecrawlGuards:
    """Tests for Firecrawl guard conditions that prevent API calls."""

    @pytest.mark.asyncio
    async def test_returns_none_when_disabled(self):
        """Verify that fetch_firecrawl returns None when Firecrawl is disabled."""
        with patch("src.tools.web.fetch.settings") as mock_settings:
            mock_settings.FIRECRAWL_ENABLED = False
            mock_settings.FIRECRAWL_API_KEY = "key"
            assert await fetch_firecrawl("https://example.com") is None

    @pytest.mark.asyncio
    async def test_returns_none_when_no_api_key(self):
        """Verify that fetch_firecrawl returns None when the API key is empty."""
        with patch("src.tools.web.fetch.settings") as mock_settings:
            mock_settings.FIRECRAWL_ENABLED = True
            mock_settings.FIRECRAWL_API_KEY = ""
            assert await fetch_firecrawl("https://example.com") is None


# ---------------------------------------------------------------------------
# Successful extraction
# ---------------------------------------------------------------------------


class TestFirecrawlSuccess:
    """Tests for successful Firecrawl content extraction."""

    @pytest.mark.asyncio
    async def test_successful_extraction(self, firecrawl_settings, mock_httpx_client):
        """Verify that a successful Firecrawl response returns extracted content."""
        mock_httpx_client.post.return_value = _make_firecrawl_response(
            markdown="# Hello World\n\nThis is content.",
            title="Hello World",
        )
        result = await fetch_firecrawl("https://example.com")

        assert result is not None
        assert result.title == "Hello World"
        assert "# Hello World" in result.text
        assert result.extractor == "firecrawl"

    @pytest.mark.asyncio
    async def test_no_title_in_metadata(self, firecrawl_settings, mock_httpx_client):
        """Verify that missing metadata title results in None title."""
        resp = _make_firecrawl_response(markdown="content only")
        resp.json.return_value["data"]["metadata"] = {}
        mock_httpx_client.post.return_value = resp

        result = await fetch_firecrawl("https://example.com")
        assert result is not None
        assert result.title is None
        assert result.text == "content only"

    @pytest.mark.asyncio
    async def test_sends_correct_request(self, firecrawl_settings, mock_httpx_client):
        """Verify that the Firecrawl API request includes correct URL, format, and auth header."""
        firecrawl_settings.FIRECRAWL_API_KEY = "fc-my-secret-key"
        mock_httpx_client.post.return_value = _make_firecrawl_response()

        await fetch_firecrawl("https://example.com/page")

        mock_httpx_client.post.assert_called_once()
        call_args = mock_httpx_client.post.call_args
        assert "v1/scrape" in call_args[0][0]
        assert call_args[1]["json"]["url"] == "https://example.com/page"
        assert call_args[1]["json"]["formats"] == ["markdown"]
        assert call_args[1]["json"]["onlyMainContent"] is True
        assert "Bearer fc-my-secret-key" in call_args[1]["headers"]["Authorization"]


# ---------------------------------------------------------------------------
# Failure scenarios → should all return None
# ---------------------------------------------------------------------------


class TestFirecrawlFailures:
    """Tests for Firecrawl failure scenarios that should all return None."""

    @pytest.mark.asyncio
    async def test_api_http_error(self, firecrawl_settings, mock_httpx_client):
        """Verify that an HTTP error response returns None."""
        mock_httpx_client.post.return_value = _make_firecrawl_response(
            is_success=False, status_code=500
        )
        assert await fetch_firecrawl("https://example.com") is None

    @pytest.mark.asyncio
    async def test_success_false(self, firecrawl_settings, mock_httpx_client):
        """Verify that a response with success=False returns None."""
        mock_httpx_client.post.return_value = _make_firecrawl_response(success=False)
        assert await fetch_firecrawl("https://example.com") is None

    @pytest.mark.asyncio
    async def test_empty_markdown(self, firecrawl_settings, mock_httpx_client):
        """Verify that an empty markdown response returns None."""
        mock_httpx_client.post.return_value = _make_firecrawl_response(markdown="")
        assert await fetch_firecrawl("https://example.com") is None

    @pytest.mark.asyncio
    async def test_network_error(self, firecrawl_settings, mock_httpx_client):
        """Verify that a network connection error returns None."""
        mock_httpx_client.post.side_effect = httpx.ConnectError("Connection refused")
        assert await fetch_firecrawl("https://example.com") is None

    @pytest.mark.asyncio
    async def test_timeout_error(self, firecrawl_settings, mock_httpx_client):
        """Verify that a read timeout error returns None."""
        mock_httpx_client.post.side_effect = httpx.ReadTimeout("timed out")
        assert await fetch_firecrawl("https://example.com") is None

    @pytest.mark.asyncio
    async def test_json_decode_error(self, firecrawl_settings, mock_httpx_client):
        """Verify that a JSON decode error returns None."""
        resp = MagicMock()
        resp.is_success = True
        resp.json.side_effect = ValueError("Invalid JSON")
        mock_httpx_client.post.return_value = resp
        assert await fetch_firecrawl("https://example.com") is None

    @pytest.mark.asyncio
    async def test_missing_data_key(self, firecrawl_settings, mock_httpx_client):
        """Verify that a response missing the data key returns None."""
        resp = MagicMock()
        resp.is_success = True
        resp.json.return_value = {"success": True}  # No "data" key
        mock_httpx_client.post.return_value = resp
        # data.get("markdown", "") → "" → returns None
        assert await fetch_firecrawl("https://example.com") is None

    @pytest.mark.asyncio
    async def test_missing_metadata_key(self, firecrawl_settings, mock_httpx_client):
        """Missing metadata should not crash, title should be None."""
        resp = MagicMock()
        resp.is_success = True
        resp.json.return_value = {
            "success": True,
            "data": {
                "markdown": "some content",
                # no metadata key
            },
        }
        mock_httpx_client.post.return_value = resp

        result = await fetch_firecrawl("https://example.com")
        assert result is not None
        assert result.title is None
        assert result.text == "some content"
