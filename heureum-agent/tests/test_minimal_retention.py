# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for context-window minimal retention (flush_turn_tool_results)."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.config import settings
from app.services.agent_service import AgentService
from app.services.messages import MessageController
from app.services.skills import SkillController
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _create_service(**kwargs) -> AgentService:
    """Instantiate an AgentService with a mocked LLM for unit testing."""
    if "skill_provider" not in kwargs:
        kwargs["skill_provider"] = SkillController()
    mock_llm = AsyncMock()
    mock_llm.bind_tools = MagicMock(return_value=mock_llm)
    with patch("app.services.agent_service.LLMController.create_primary", return_value=mock_llm):
        svc = AgentService(**kwargs)
        svc.llm = mock_llm
        return svc


def _seed_history(svc: AgentService, session_id: str):
    """Populate a session with a typical tool-loop history.

    Layout: HumanMessage -> AIMessage(tool_calls) -> ToolMessage -> AIMessage(text)
    """
    svc._sessions[session_id] = [
        HumanMessage(content="What is 2+2?"),
        AIMessage(
            content="",
            tool_calls=[{"name": "calculator", "args": {"expr": "2+2"}, "id": "tc1"}],
        ),
        ToolMessage(content="4", tool_call_id="tc1", name="calculator"),
        AIMessage(content="The answer is 4."),
    ]


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


class TestFlushTurnToolResults:
    """Tests for AgentService.flush_turn_tool_results."""

    @pytest.mark.asyncio
    async def test_flush_strips_tool_messages(self):
        """AIMessage(tool_calls) + ToolMessage removed; HumanMessage + AIMessage(text) kept."""
        svc = _create_service()
        sid = "test-session-flush"
        _seed_history(svc, sid)

        with patch.object(settings, "CONTEXT_MINIMAL_RETENTION_ENABLED", True):
            changed = await svc.flush_turn_tool_results(sid)

        assert changed is True
        history = svc._sessions[sid]
        assert len(history) == 2
        assert isinstance(history[0], HumanMessage)
        assert isinstance(history[1], AIMessage)
        assert history[1].content == "The answer is 4."
        # No tool_calls on remaining AIMessage
        assert not history[1].tool_calls

    @pytest.mark.asyncio
    async def test_flush_noop_when_flag_disabled(self):
        """No change when the feature flag is off."""
        svc = _create_service()
        sid = "test-session-noop"
        _seed_history(svc, sid)

        with patch.object(settings, "CONTEXT_MINIMAL_RETENTION_ENABLED", False):
            changed = await svc.flush_turn_tool_results(sid)

        assert changed is False
        assert len(svc._sessions[sid]) == 4  # all messages intact

    @pytest.mark.asyncio
    async def test_flush_idempotent(self):
        """Calling flush twice produces the same result."""
        svc = _create_service()
        sid = "test-session-idempotent"
        _seed_history(svc, sid)

        with patch.object(settings, "CONTEXT_MINIMAL_RETENTION_ENABLED", True):
            first = await svc.flush_turn_tool_results(sid)
            second = await svc.flush_turn_tool_results(sid)

        assert first is True
        assert second is False  # no-op on second call
        history = svc._sessions[sid]
        assert len(history) == 2

    @pytest.mark.asyncio
    async def test_rehydration_strips_tools_when_enabled(self):
        """Rehydration path strips tool messages when flag is enabled."""
        svc = _create_service()
        sid = "test-session-rehydrate"

        rehydrated_data = [
            HumanMessage(content="hello"),
            AIMessage(
                content="",
                tool_calls=[{"name": "search", "args": {}, "id": "tc2"}],
            ),
            ToolMessage(content="result", tool_call_id="tc2", name="search"),
            AIMessage(content="Here is the answer."),
        ]

        mock_rehydrator = AsyncMock()
        mock_rehydrator.rehydrate_session = AsyncMock(return_value=rehydrated_data)
        svc.message_controller.message_rehydration_controller = mock_rehydrator

        with patch.object(settings, "CONTEXT_MINIMAL_RETENTION_ENABLED", True):
            result_sid, history = await svc._get_or_create_session(sid)

        assert result_sid == sid
        # Tool messages should be stripped
        assert len(history) == 2
        assert isinstance(history[0], HumanMessage)
        assert isinstance(history[1], AIMessage)
        assert history[1].content == "Here is the answer."

    @pytest.mark.asyncio
    async def test_rehydration_preserves_tools_when_disabled(self):
        """Rehydration path keeps all messages when flag is off."""
        svc = _create_service()
        sid = "test-session-rehydrate-off"

        rehydrated_data = [
            HumanMessage(content="hello"),
            AIMessage(
                content="",
                tool_calls=[{"name": "search", "args": {}, "id": "tc3"}],
            ),
            ToolMessage(content="result", tool_call_id="tc3", name="search"),
            AIMessage(content="Here is the answer."),
        ]

        mock_rehydrator = AsyncMock()
        mock_rehydrator.rehydrate_session = AsyncMock(return_value=rehydrated_data)
        svc.message_controller.message_rehydration_controller = mock_rehydrator

        with patch.object(settings, "CONTEXT_MINIMAL_RETENTION_ENABLED", False):
            result_sid, history = await svc._get_or_create_session(sid)

        assert result_sid == sid
        assert len(history) == 4  # all messages preserved
