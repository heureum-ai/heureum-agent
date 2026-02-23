# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for src.common.session_context."""

from unittest.mock import MagicMock

import pytest
from src.common.session_context import (
    SessionContext,
    extract_session_context,
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
