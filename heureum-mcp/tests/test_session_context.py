# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for src.common.session_context."""

from unittest.mock import MagicMock

import pytest
from src.common.session_context import (
    SessionContext,
    extract_session_context,
    get_platform_client,
)

# ---------------------------------------------------------------------------
# extract_session_context
# ---------------------------------------------------------------------------


class TestExtractSessionContext:
    """Tests for extract_session_context()."""

    def _make_ctx(self, session_id=None, platform_api_url=None):
        """Build a mock FastMCP Context with request_context.meta."""
        meta = MagicMock()
        meta.session_id = session_id
        meta.platform_api_url = platform_api_url
        ctx = MagicMock()
        ctx.request_context.meta = meta
        return ctx

    def test_returns_session_context_when_both_fields_present(self):
        ctx = self._make_ctx(
            session_id="sess_123",
            platform_api_url="http://localhost:8001",
        )
        result = extract_session_context(ctx)
        assert result is not None
        assert result.session_id == "sess_123"
        assert result.platform_api_url == "http://localhost:8001"

    def test_returns_none_when_session_id_missing(self):
        ctx = self._make_ctx(session_id=None, platform_api_url="http://localhost:8001")
        assert extract_session_context(ctx) is None

    def test_returns_none_when_platform_api_url_missing(self):
        ctx = self._make_ctx(session_id="sess_123", platform_api_url=None)
        assert extract_session_context(ctx) is None

    def test_returns_none_when_both_missing(self):
        ctx = self._make_ctx(session_id=None, platform_api_url=None)
        assert extract_session_context(ctx) is None

    def test_returns_none_when_no_request_context(self):
        ctx = MagicMock(spec=[])  # no attributes
        assert extract_session_context(ctx) is None

    def test_returns_none_for_none_ctx(self):
        assert extract_session_context(None) is None

    def test_returns_none_when_meta_is_none(self):
        ctx = MagicMock()
        ctx.request_context.meta = None
        assert extract_session_context(ctx) is None

    def test_session_context_is_frozen(self):
        sc = SessionContext(session_id="a", platform_api_url="http://x")
        with pytest.raises(AttributeError):
            sc.session_id = "b"


# ---------------------------------------------------------------------------
# get_platform_client
# ---------------------------------------------------------------------------


class TestGetPlatformClient:
    """Tests for get_platform_client()."""

    def test_returns_platform_file_client(self):
        sc = SessionContext(session_id="sess_abc", platform_api_url="http://localhost:8001")
        client = get_platform_client(sc)

        from src.tools.filesystem.platform_ops import PlatformFileClient

        assert isinstance(client, PlatformFileClient)
        assert client._session_id == "sess_abc"
        assert "localhost:8001" in client._platform_api_url

    def test_shares_http_client_across_calls(self):
        sc1 = SessionContext(session_id="s1", platform_api_url="http://localhost:8001")
        sc2 = SessionContext(session_id="s2", platform_api_url="http://localhost:8001")
        c1 = get_platform_client(sc1)
        c2 = get_platform_client(sc2)
        # Both should share the same httpx.AsyncClient
        assert c1._http is c2._http
