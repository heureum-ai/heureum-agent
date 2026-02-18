# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for web_fetch session-save behaviour."""

import json
from unittest.mock import AsyncMock, patch

import pytest

from src.common.session_context import SessionContext
from src.tools.web.fetch import _make_session_path, _maybe_save_to_session


# ---------------------------------------------------------------------------
# _make_session_path
# ---------------------------------------------------------------------------


class TestMakeSessionPath:
    """Tests for _make_session_path()."""

    def test_basic_url(self):
        path = _make_session_path("https://example.com/article/hello-world")
        assert path.startswith("web_fetch/example.com/")
        assert path.endswith(".md")
        assert "article_hello-world" in path

    def test_root_url_uses_index(self):
        path = _make_session_path("https://example.com/")
        assert "index-" in path

    def test_long_path_truncated(self):
        long_url = "https://example.com/" + "a" * 100
        path = _make_session_path(long_url)
        # slug part should be at most 60 chars + hash
        slug = path.split("/")[-1]  # filename part
        assert len(slug) <= 70  # 60 + "-" + 4 hash + ".md"

    def test_different_urls_produce_different_hashes(self):
        p1 = _make_session_path("https://example.com/page1")
        p2 = _make_session_path("https://example.com/page2")
        assert p1 != p2


# ---------------------------------------------------------------------------
# _maybe_save_to_session
# ---------------------------------------------------------------------------


class TestMaybeSaveToSession:
    """Tests for _maybe_save_to_session()."""

    @pytest.fixture
    def session_ctx(self):
        return SessionContext(
            session_id="sess_test",
            platform_api_url="http://localhost:8001",
        )

    async def test_saves_locally_when_no_session_ctx(self, tmp_path):
        """Non-session mode: saves to local file and strips text."""
        with patch("src.tools.web.fetch.settings") as mock_settings:
            mock_settings.FILESYSTEM_CWD = str(tmp_path)
            result_json = json.dumps({"text": "hello", "url": "https://example.com"})
            out = await _maybe_save_to_session(result_json, "https://example.com", None)
            data = json.loads(out)
            assert "text" not in data
            assert "session_file" in data
            assert data["session_file"].startswith(str(tmp_path))

    async def test_returns_unchanged_when_error_in_result(self, session_ctx):
        result_json = json.dumps({"error": "timeout", "url": "https://example.com"})
        out = await _maybe_save_to_session(result_json, "https://example.com", session_ctx)
        assert out == result_json

    async def test_returns_unchanged_when_empty_text(self, session_ctx):
        result_json = json.dumps({"text": "", "url": "https://example.com"})
        out = await _maybe_save_to_session(result_json, "https://example.com", session_ctx)
        assert out == result_json

    @patch("src.tools.web.fetch.get_platform_client")
    async def test_saves_and_adds_session_file(self, mock_get_client, session_ctx):
        mock_client = AsyncMock()
        mock_get_client.return_value = mock_client

        result_json = json.dumps({
            "text": "Hello World content",
            "url": "https://example.com/article",
            "title": "Hello",
        })
        out = await _maybe_save_to_session(result_json, "https://example.com/article", session_ctx)
        data = json.loads(out)

        assert "session_file" in data
        assert data["session_file"].startswith("/session/web_fetch/")
        mock_client.write_file.assert_called_once()

    @patch("src.tools.web.fetch.get_platform_client")
    async def test_returns_original_on_write_failure(self, mock_get_client, session_ctx):
        mock_client = AsyncMock()
        mock_client.write_file.side_effect = RuntimeError("API down")
        mock_get_client.return_value = mock_client

        result_json = json.dumps({
            "text": "content",
            "url": "https://example.com",
        })
        out = await _maybe_save_to_session(result_json, "https://example.com", session_ctx)
        # Should return original without session_file (non-fatal)
        data = json.loads(out)
        assert "session_file" not in data
