# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Shared test fixtures for heureum-agent test suite."""

from unittest.mock import AsyncMock, MagicMock

import pytest
from app.schemas.open_responses import (
    AssistantMessageItem,
    InputTokenDetails,
    ItemStatus,
    MessageRole,
    OutputTextContent,
    OutputTokenDetails,
    ResponseObject,
    ResponseStatus,
    Usage as SchemaUsage,
)


# ---------------------------------------------------------------------------
# LLM response mocking helpers
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_openai_response():
    """Factory fixture for creating mock ChatOpenAI responses."""

    def _factory(
        text: str = "Hello!",
        tool_calls: list | None = None,
    ) -> MagicMock:
        resp = MagicMock()
        resp.content = text
        resp.tool_calls = tool_calls or []
        resp.usage_metadata = {
            "input_tokens": 10,
            "output_tokens": 5,
            "total_tokens": 15,
            "input_token_details": {"cache_read": 0},
            "output_token_details": {"reasoning": 0},
        }
        return resp

    return _factory


# ---------------------------------------------------------------------------
# MCP client mock
# ---------------------------------------------------------------------------


@pytest.fixture
def mock_mcp_client():
    """Fixture providing a mocked MCPClientController."""
    client = AsyncMock()
    client.discover_tools = AsyncMock(return_value=[])
    client.call_tool = AsyncMock(return_value="tool result")
    client.is_server_tool = MagicMock(return_value=False)
    client.invalidate_cache = MagicMock()
    client.close = AsyncMock()
    client.server_tool_names = set()
    return client


# ---------------------------------------------------------------------------
# ResponseObject factory
# ---------------------------------------------------------------------------


@pytest.fixture
def sample_response_object():
    """Factory fixture for creating ResponseObject instances."""

    def _factory(
        output_text: str = "response text",
        status: ResponseStatus = ResponseStatus.COMPLETED,
        model: str = "gpt-4o-mini",
        session_id: str = "test_session",
    ) -> ResponseObject:
        return ResponseObject(
            id="resp_test123",
            created_at=1700000000,
            completed_at=1700000001,
            model=model,
            status=status,
            output=[
                AssistantMessageItem(
                    id="msg_test123",
                    role=MessageRole.ASSISTANT,
                    status=ItemStatus.COMPLETED,
                    content=[OutputTextContent(text=output_text)],
                )
            ],
            usage=SchemaUsage.zero(),
            metadata={"session_id": session_id},
        )

    return _factory


# ---------------------------------------------------------------------------
# Schema Usage factory
# ---------------------------------------------------------------------------


@pytest.fixture
def sample_usage():
    """Factory fixture for creating Usage instances."""

    def _factory(
        input_tokens: int = 100,
        output_tokens: int = 50,
        total_tokens: int = 150,
    ) -> SchemaUsage:
        return SchemaUsage(
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            total_tokens=total_tokens,
            input_tokens_details=InputTokenDetails(),
            output_tokens_details=OutputTokenDetails(),
        )

    return _factory
