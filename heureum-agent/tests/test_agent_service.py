# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for AgentService."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from app.models import LLMResultType, Message
from app.schemas.open_responses import MessageRole
# TOOL_SCHEMA_MAP removed — use inline schema dicts in tests
from app.config import settings
from app.services.prompts.compaction import COMPACTION_PREFIX
from app.services.agent_service import (
    AgentService,
    _strip_tool_messages,
)
from app.services.error import LLMErrorClassifier
from app.services.compaction.settings import CompactionSettings
from langchain_core.messages import AIMessage, HumanMessage, ToolMessage

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mock_response(text: str = "Hello!"):
    """Create a mock LLM response with the given text and no tool calls."""
    resp = MagicMock()
    resp.content = text
    resp.tool_calls = []
    return resp


def _mock_tool_call(name="bash", args=None, call_id="call_1"):
    """Create a mock LLM response containing a single tool call."""
    resp = MagicMock()
    resp.content = ""
    resp.tool_calls = [{"name": name, "args": args or {}, "id": call_id}]
    return resp


def _create_service(**kwargs) -> AgentService:
    """Instantiate an AgentService with a mocked LLM for unit testing."""
    mock_llm = AsyncMock()
    mock_llm.bind_tools = MagicMock(return_value=mock_llm)
    with patch("app.services.agent_service.create_llm", return_value=mock_llm):
        svc = AgentService(**kwargs)
        svc.llm = mock_llm
        return svc


# ---------------------------------------------------------------------------
# _is_context_overflow_error
# ---------------------------------------------------------------------------


class TestIsContextOverflowError:
    """Tests for the _is_context_overflow_error detection helper."""

    def test_context_length_exceeded(self):
        """Verify detection of maximum context length error messages."""
        assert (
            LLMErrorClassifier.is_context_overflow(
                Exception("This model's maximum context length is 128000 tokens")
            )
            is True
        )

    def test_too_many_tokens(self):
        """Verify detection of too many tokens error messages."""
        assert LLMErrorClassifier.is_context_overflow(Exception("too many tokens")) is True

    def test_content_too_large(self):
        """Verify detection of content_too_large error messages."""
        assert LLMErrorClassifier.is_context_overflow(Exception("content_too_large")) is True

    def test_max_tokens(self):
        """Verify detection of max_tokens exceeded error messages."""
        assert LLMErrorClassifier.is_context_overflow(Exception("max_tokens exceeded")) is True

    def test_prompt_too_long(self):
        """Verify detection of prompt is too long error messages."""
        assert LLMErrorClassifier.is_context_overflow(Exception("prompt is too long")) is True

    def test_input_too_long(self):
        """Verify detection of input too long for model error messages."""
        assert LLMErrorClassifier.is_context_overflow(Exception("input too long for model")) is True

    def test_string_too_long(self):
        """Verify detection of string too long error messages."""
        assert LLMErrorClassifier.is_context_overflow(Exception("string too long")) is True

    def test_unrelated_error(self):
        """Verify that unrelated errors are not classified as overflow."""
        assert LLMErrorClassifier.is_context_overflow(Exception("connection timeout")) is False


# ---------------------------------------------------------------------------
# _prepare_prompt_and_tools
# ---------------------------------------------------------------------------


class TestPreparePromptAndTools:
    """Tests for the unified prompt + tool resolution method."""

    _BASH_SCHEMA = {"type": "function", "function": {"name": "bash", "description": "Run", "parameters": {"type": "object"}}}
    _ASK_SCHEMA = {"type": "function", "function": {"name": "ask_question", "description": "Ask", "parameters": {"type": "object"}}}

    def test_prompt_without_instructions(self):
        """Verify prompt includes identity but omits instructions tag when none given."""
        svc = _create_service()
        prompt, tools = svc._prepare_prompt_and_tools()
        assert "<identity>" in prompt
        assert "<instructions>" not in prompt
        # Server-only tools are always included
        server_names = {t["function"]["name"] for t in tools}
        assert "manage_todo" in server_names

    def test_prompt_with_instructions(self):
        """Verify custom instructions are wrapped in instructions tags."""
        svc = _create_service()
        prompt, _ = svc._prepare_prompt_and_tools(instructions="Be concise.")
        assert "<instructions>" in prompt
        assert "Be concise." in prompt

    def test_client_tools_included(self):
        """Verify client-provided tool guides are included in the system prompt."""
        svc = _create_service()
        guides = ['<tool_guide name="bash">\nUse bash.\n</tool_guide>']
        prompt, _ = svc._prepare_prompt_and_tools(client_tool_prompts=guides)
        assert '<tool_guide name="bash">' in prompt

    def test_no_client_schemas_returns_server_only(self):
        """Verify no client schemas returns server-only tools."""
        svc = _create_service()
        _, tools = svc._prepare_prompt_and_tools()
        names = {t["function"]["name"] for t in tools}
        assert "manage_todo" in names
        assert "read_file" in names

    def test_client_schemas_returned(self):
        """Verify client schemas are passed through."""
        svc = _create_service()
        _, tools = svc._prepare_prompt_and_tools(
            client_tool_schemas=[self._BASH_SCHEMA, self._ASK_SCHEMA],
        )
        names = [s["function"]["name"] for s in tools]
        assert "bash" in names
        assert "ask_question" in names

    def test_mcp_tools_appended(self):
        """Verify MCP tool schemas are appended alongside client schemas."""
        mcp = [{"type": "function", "function": {"name": "mcp_tool"}}]
        svc = _create_service(mcp_tools=mcp)
        _, tools = svc._prepare_prompt_and_tools(
            client_tool_schemas=[self._BASH_SCHEMA],
        )
        names = [s["function"]["name"] for s in tools]
        assert "bash" in names
        assert "mcp_tool" in names

    def test_empty_schemas_no_mcp(self):
        """Verify an empty client schema list still includes server tools."""
        svc = _create_service()
        _, tools = svc._prepare_prompt_and_tools()
        names = {t["function"]["name"] for t in tools}
        # Server tools always present, no MCP
        assert "manage_todo" in names
        assert len(tools) > 0


# ---------------------------------------------------------------------------
# _call_llm
# ---------------------------------------------------------------------------


class TestCallLlm:
    """Tests for the low-level _call_llm invocation wrapper."""

    @pytest.mark.asyncio
    async def test_without_tools(self):
        """Verify LLM is invoked directly when no tools are provided."""
        svc = _create_service()
        svc.llm.ainvoke.return_value = _mock_response("hi")
        result = await svc._call_llm([MagicMock()], tools=[])
        svc.llm.ainvoke.assert_called_once()
        assert result.content == "hi"

    @pytest.mark.asyncio
    async def test_with_tools(self):
        """Verify LLM is bound with tools before invocation when tools are provided."""
        svc = _create_service()
        svc.llm.ainvoke.return_value = _mock_response("hi")
        _dummy_schema = {"type": "function", "function": {"name": "bash", "parameters": {"type": "object", "properties": {}}}}
        result = await svc._call_llm([MagicMock()], tools=[_dummy_schema])
        svc.llm.bind_tools.assert_called_once()
        assert result.content == "hi"


# ---------------------------------------------------------------------------
# Prompt reconstruction (_build_lc_messages)
# ---------------------------------------------------------------------------


class TestPromptReconstruction:
    """Tests for _build_lc_messages LangChain message list construction."""

    def test_system_prompt_always_first(self):
        """Verify the system prompt is always the first message."""
        svc = _create_service()
        lc_msgs = svc._build_lc_messages(
            [Message(role=MessageRole.USER, content="hi")],
            [Message(role=MessageRole.USER, content="hello")],
        )
        assert lc_msgs[0].type == "system"

    def test_no_inline_prompts(self):
        """Verify no hardcoded legacy tool prompts are injected."""
        svc = _create_service()
        lc_msgs = svc._build_lc_messages(
            [],
            [Message(role=MessageRole.USER, content="hi")],
        )
        system_content = lc_msgs[0].content
        assert "CRITICAL RULE" not in system_content
        assert "NEVER write a question mark" not in system_content
        # Server-side tool guides (todo, session_files, etc.) are always present;
        # client-specific guides are only injected when provided via client_tool_prompts.
        # Verify no client-tool-name-based injection happens by default.
        assert '<tool_guide name="bash">' not in system_content
        assert '<tool_guide name="ask_question">' not in system_content

    def test_compaction_summary_in_history(self):
        """Verify compaction summary is separated from the fresh system prompt."""
        svc = _create_service()
        history = [
            Message(role=MessageRole.SYSTEM, content=f"{COMPACTION_PREFIX}\nOld summary"),
            Message(role=MessageRole.USER, content="q"),
        ]
        lc_msgs = svc._build_lc_messages(history, [])

        # [0] = fresh system prompt, [1] = compaction summary, [2] = user
        assert COMPACTION_PREFIX not in lc_msgs[0].content
        assert COMPACTION_PREFIX in lc_msgs[1].content

    def test_instructions_appended(self):
        """Verify custom instructions appear in the system prompt with tags."""
        svc = _create_service()
        lc_msgs = svc._build_lc_messages(
            [],
            [Message(role=MessageRole.USER, content="hi")],
            instructions="Be concise.",
        )
        assert "Be concise." in lc_msgs[0].content
        assert "<instructions>" in lc_msgs[0].content

    def test_no_instructions_no_tag(self):
        """Verify no instructions tag when instructions are not provided."""
        svc = _create_service()
        lc_msgs = svc._build_lc_messages(
            [],
            [Message(role=MessageRole.USER, content="hi")],
        )
        assert "<instructions>" not in lc_msgs[0].content


# ---------------------------------------------------------------------------
# _try_overflow_recovery
# ---------------------------------------------------------------------------


class TestTryOverflowRecovery:
    """Tests for the context overflow recovery strategy selector."""

    @pytest.mark.asyncio
    async def test_compaction_first(self):
        """First overflow triggers _compact_session."""
        svc = _create_service()
        svc.llm.ainvoke.return_value = MagicMock(content="Summary")
        # Messages must be large enough that compaction actually reduces tokens
        svc.sessions["s1"] = [
            Message(role=MessageRole.USER, content="question one " * 50),
            Message(role=MessageRole.ASSISTANT, content="answer one " * 50),
            Message(role=MessageRole.USER, content="question two " * 50),
            Message(role=MessageRole.ASSISTANT, content="answer two " * 50),
        ]
        new_history, retries, ok, trunc = await svc._try_overflow_recovery("s1", 0)
        assert ok is True
        assert retries == 1
        assert trunc is False
        assert svc.sessions["s1"] == new_history

    @pytest.mark.asyncio
    async def test_truncation_fallback(self):
        """After settings.MAX_OVERFLOW_RETRIES, falls back to tool truncation."""
        svc = _create_service(
            compaction_settings=CompactionSettings(context_window_tokens=500),
        )
        svc.sessions["s1"] = [
            Message(role=MessageRole.USER, content="q"),
            Message(role=MessageRole.TOOL, content="x" * 100_000),
        ]
        new_history, retries, ok, trunc = await svc._try_overflow_recovery(
            "s1",
            settings.MAX_OVERFLOW_RETRIES,
        )
        assert ok is True
        assert retries == 0  # counter reset
        assert trunc is True  # truncation was attempted
        assert svc.sessions["s1"] == new_history

    @pytest.mark.asyncio
    async def test_all_exhausted(self):
        """If compaction exhausted and nothing to truncate, fails."""
        svc = _create_service()
        svc.sessions["s1"] = [
            Message(role=MessageRole.USER, content="small"),
            Message(role=MessageRole.ASSISTANT, content="small"),
        ]
        _, retries, ok, trunc = await svc._try_overflow_recovery(
            "s1",
            settings.MAX_OVERFLOW_RETRIES,
        )
        assert ok is False
        assert retries == settings.MAX_OVERFLOW_RETRIES


# ---------------------------------------------------------------------------
# _compact_session
# ---------------------------------------------------------------------------


class TestCompactSession:
    """Tests for session history compaction via _compact_session."""

    @pytest.mark.asyncio
    async def test_reduces_history(self):
        """Verify compaction reduces the number of messages in the session."""
        svc = _create_service()
        svc.llm.ainvoke.return_value = MagicMock(content="Summary")
        svc.sessions["s1"] = [
            Message(role=MessageRole.USER, content="q1"),
            Message(role=MessageRole.ASSISTANT, content="a1"),
            Message(role=MessageRole.USER, content="q2"),
            Message(role=MessageRole.ASSISTANT, content="a2"),
            Message(role=MessageRole.USER, content="q3"),
            Message(role=MessageRole.ASSISTANT, content="a3"),
        ]
        result = await svc._compact_session("s1")
        assert len(result) < 6
        assert svc.sessions["s1"] == result

    @pytest.mark.asyncio
    async def test_empty_session(self):
        """Verify compacting a nonexistent session returns an empty list."""
        svc = _create_service()
        result = await svc._compact_session("nope")
        assert result == []

    @pytest.mark.asyncio
    async def test_persists_to_sessions(self):
        """Verify compacted history is persisted back into the sessions dict."""
        svc = _create_service()
        svc.llm.ainvoke.return_value = MagicMock(content="Summary")
        svc.sessions["s1"] = [
            Message(role=MessageRole.USER, content="q"),
            Message(role=MessageRole.ASSISTANT, content="a"),
            Message(role=MessageRole.USER, content="q2"),
            Message(role=MessageRole.ASSISTANT, content="a2"),
        ]
        await svc._compact_session("s1")
        assert svc.sessions["s1"][0].role == MessageRole.SYSTEM


# ---------------------------------------------------------------------------
# process_messages
# ---------------------------------------------------------------------------


class TestProcessMessages:
    """Tests for the main process_messages entry point."""

    @pytest.mark.asyncio
    async def test_basic(self):
        """Verify a basic user message produces a response with a session ID."""
        svc = _create_service()
        svc.llm.ainvoke.return_value = _mock_response("Hi there!")
        result = await svc.process_messages([Message(role=MessageRole.USER, content="hello")])
        assert result.message == "Hi there!"
        assert result.session_id is not None

    @pytest.mark.asyncio
    async def test_history_accumulates(self):
        """Verify subsequent messages in the same session accumulate history."""
        svc = _create_service()
        svc.llm.ainvoke.return_value = _mock_response("r1")
        r1 = await svc.process_messages([Message(role=MessageRole.USER, content="q1")])

        svc.llm.ainvoke.return_value = _mock_response("r2")
        await svc.process_messages(
            [Message(role=MessageRole.USER, content="q2")],
            session_id=r1.session_id,
        )
        assert len(svc.sessions[r1.session_id]) == 4  # q1, r1, q2, r2

    @pytest.mark.asyncio
    async def test_instructions_forwarded(self):
        """Verify custom instructions are forwarded into the system prompt."""
        svc = _create_service()
        svc.llm.ainvoke.return_value = _mock_response("ok")
        await svc.process_messages(
            [Message(role=MessageRole.USER, content="hi")],
            instructions="Answer in English.",
        )
        call_args = svc.llm.ainvoke.call_args[0][0]
        assert "Answer in English." in call_args[0].content

    @pytest.mark.asyncio
    async def test_empty_raises(self):
        """Verify that an empty message list raises ValueError."""
        svc = _create_service()
        with pytest.raises(ValueError, match="No messages"):
            await svc.process_messages([])

    @pytest.mark.asyncio
    async def test_history_reference_survives_compaction(self):
        """After overflow recovery replaces session list,
        process_messages still appends to the correct list."""
        svc = _create_service()
        overflow_raised = False

        async def side_effect(msgs):
            nonlocal overflow_raised
            if not overflow_raised:
                overflow_raised = True
                raise Exception("maximum context length exceeded")
            return _mock_response("ok")

        svc.llm.ainvoke.side_effect = side_effect
        svc.sessions["s1"] = [
            Message(role=MessageRole.USER, content="q1"),
            Message(role=MessageRole.ASSISTANT, content="a1"),
        ]
        await svc.process_messages(
            [Message(role=MessageRole.USER, content="q2")],
            session_id="s1",
        )
        # After compaction + response, history should contain new messages
        history = svc.sessions["s1"]
        assert history[-1].content == "ok"


# ---------------------------------------------------------------------------
# process_messages_with_tools
# ---------------------------------------------------------------------------


class TestProcessMessagesWithTools:
    """Tests for process_messages_with_tools tool-calling entry point."""

    @pytest.mark.asyncio
    async def test_text_response(self):
        """Verify a plain text LLM response is returned with type text."""
        svc = _create_service()
        svc.llm.ainvoke.return_value = _mock_response("answer")
        result = await svc.process_messages_with_tools(
            [Message(role=MessageRole.USER, content="hi")],
        )
        assert result.type == LLMResultType.TEXT
        assert result.text == "answer"

    @pytest.mark.asyncio
    async def test_tool_call_response(self):
        """Verify a tool call LLM response is returned with type tool_call."""
        svc = _create_service()
        svc.llm.ainvoke.return_value = _mock_tool_call(
            name="bash",
            args={"command": "ls"},
            call_id="c1",
        )
        result = await svc.process_messages_with_tools(
            [Message(role=MessageRole.USER, content="list files")],
        )
        assert result.type == LLMResultType.TOOL_CALL
        assert len(result.tool_calls) == 1
        tc = result.tool_calls[0]
        assert tc.name == "bash"
        assert tc.args == {"command": "ls"}
        assert tc.id == "c1"

    @pytest.mark.asyncio
    async def test_tool_call_no_history_update(self):
        """Tool calls don't update history until execution completes."""
        svc = _create_service()
        svc.llm.ainvoke.return_value = _mock_tool_call()
        result = await svc.process_messages_with_tools(
            [Message(role=MessageRole.USER, content="run ls")],
        )
        assert len(svc.sessions[result.session_id]) == 0

    @pytest.mark.asyncio
    async def test_instructions_with_tools(self):
        """Verify custom instructions are included in the prompt with tools."""
        svc = _create_service()
        svc.llm.ainvoke.return_value = _mock_response("done")
        await svc.process_messages_with_tools(
            [Message(role=MessageRole.USER, content="hi")],
            instructions="Be brief.",
        )
        call_args = svc.llm.ainvoke.call_args[0][0]
        assert "Be brief." in call_args[0].content


# ---------------------------------------------------------------------------
# Overflow recovery (via _invoke_with_recovery)
# ---------------------------------------------------------------------------


class TestOverflowRecovery:
    """Tests for end-to-end overflow recovery during LLM invocation."""

    @pytest.mark.asyncio
    async def test_recovers_after_compaction(self):
        """Verify the service recovers from overflow by compacting and retrying."""
        svc = _create_service()
        overflow_raised = False

        async def side_effect(msgs):
            nonlocal overflow_raised
            if not overflow_raised:
                overflow_raised = True
                raise Exception("maximum context length exceeded")
            return _mock_response("recovered")

        svc.llm.ainvoke.side_effect = side_effect
        svc.sessions["s1"] = [
            Message(role=MessageRole.USER, content="q1"),
            Message(role=MessageRole.ASSISTANT, content="a1"),
            Message(role=MessageRole.USER, content="q2"),
            Message(role=MessageRole.ASSISTANT, content="a2"),
        ]
        result = await svc.process_messages(
            [Message(role=MessageRole.USER, content="q3")],
            session_id="s1",
        )
        assert result.message == "recovered"

    @pytest.mark.asyncio
    async def test_non_overflow_propagates(self):
        """Verify non-overflow exceptions propagate without recovery attempt."""
        svc = _create_service()
        svc.llm.ainvoke.side_effect = Exception("network timeout")
        with pytest.raises(Exception, match="network timeout"):
            await svc.process_messages([Message(role=MessageRole.USER, content="hi")])

    @pytest.mark.asyncio
    async def test_exhausted_raises(self):
        """When compaction + truncation can't help, error propagates."""
        svc = _create_service()
        svc.llm.ainvoke.side_effect = Exception("maximum context length exceeded")
        svc.sessions["s1"] = [
            Message(role=MessageRole.USER, content="q"),
            Message(role=MessageRole.ASSISTANT, content="a"),
        ]
        with pytest.raises(Exception, match="context length"):
            await svc.process_messages(
                [Message(role=MessageRole.USER, content="q2")],
                session_id="s1",
            )


class TestToolMessageFallback:
    """Tests for Gemini tool-message fallback behavior."""

    def test_strip_tool_messages_marks_changed(self):
        """AI tool call + ToolMessage are converted and marked as changed."""
        src = [
            AIMessage(content="", tool_calls=[{"name": "web_search", "args": {"query": "q"}, "id": "call_1"}]),
            ToolMessage(content="Error: failed", tool_call_id="call_1"),
            HumanMessage(content="next"),
        ]

        clean, changed = _strip_tool_messages(src)
        assert changed is True
        assert isinstance(clean[0], AIMessage)
        assert clean[0].tool_calls == []
        assert "[Called:" in clean[0].content
        assert isinstance(clean[1], HumanMessage)
        assert "[Tool result]:" in clean[1].content

    @pytest.mark.asyncio
    async def test_invoke_uses_clean_context_fallback(self):
        """When normal + no-tools retries fail, clean-context fallback is attempted."""
        svc = _create_service()
        sid = "s1"
        svc.sessions[sid] = [
            Message(
                role=MessageRole.ASSISTANT,
                content="",
                tool_calls=[{"name": "web_search", "args": {"query": "q"}, "id": "call_1"}],
            ),
            Message(
                role=MessageRole.TOOL,
                content="Error: network timeout",
                tool_call_id="call_1",
                tool_name="web_search",
            ),
        ]

        calls: list[tuple[list, list]] = []

        async def fake_call_llm(lc_messages, tools):
            calls.append((lc_messages, tools))
            if len(calls) < 3:
                raise Exception("INVALID_ARGUMENT")
            return _mock_response("Recovered from tool context")

        svc._call_llm = AsyncMock(side_effect=fake_call_llm)
        svc._maybe_proactive_compact = AsyncMock(return_value=None)

        bash_schema = {"type": "function", "function": {"name": "bash", "description": "Run", "parameters": {"type": "object"}}}
        resp = await svc._invoke_with_recovery(
            new_messages=[],
            session_id=sid,
            client_tool_schemas=[bash_schema],
        )

        assert resp.content == "Recovered from tool context"
        assert len(calls) == 3
        # 1st call: with tools bound, 2nd: no-tools fallback, 3rd: clean-context fallback
        assert calls[0][1] != []
        assert calls[1][1] == []
        assert calls[2][1] == []
        assert any(isinstance(m, HumanMessage) and "[Tool result]:" in m.content for m in calls[2][0])
        assert not any(isinstance(m, ToolMessage) for m in calls[2][0])

    @pytest.mark.asyncio
    async def test_thought_signature_skips_backoff_retries(self):
        """Thought-signature errors should skip exponential backoff retries."""
        svc = _create_service()
        sid = "s1"
        svc.sessions[sid] = [
            Message(
                role=MessageRole.ASSISTANT,
                content="",
                tool_calls=[{"name": "web_search", "args": {"query": "q"}, "id": "call_1"}],
            ),
            Message(
                role=MessageRole.TOOL,
                content="Error: failed",
                tool_call_id="call_1",
                tool_name="web_search",
            ),
        ]
        svc._maybe_proactive_compact = AsyncMock(return_value=None)

        calls: list[tuple[list, list]] = []

        async def fake_call_llm(lc_messages, tools):
            calls.append((lc_messages, tools))
            if len(calls) == 1:
                raise Exception("Unable to submit request because Thought signature is not valid")
            return _mock_response("ok")

        svc._call_llm = AsyncMock(side_effect=fake_call_llm)

        bash_schema = {"type": "function", "function": {"name": "bash", "description": "Run", "parameters": {"type": "object"}}}
        with patch("app.services.agent_service.asyncio.sleep", new=AsyncMock()) as sleep_mock:
            resp = await svc._invoke_with_recovery(
                new_messages=[],
                session_id=sid,
                client_tool_schemas=[bash_schema],
            )

        assert LLMErrorClassifier.is_thought_signature(Exception("Thought signature is not valid")) is True
        assert resp.content == "ok"
        assert len(calls) == 2  # initial tools-bound + immediate no-tools fallback
        sleep_mock.assert_not_awaited()


# ---------------------------------------------------------------------------
# Truncation one-shot guard
# ---------------------------------------------------------------------------


class TestTruncationOneShot:
    """Tests for the one-shot truncation guard in overflow recovery."""

    @pytest.mark.asyncio
    async def test_truncation_blocked_on_second_attempt(self):
        """Truncation fallback runs at most once (one-shot guard)."""
        svc = _create_service(
            compaction_settings=CompactionSettings(context_window_tokens=500),
        )
        svc.sessions["s1"] = [
            Message(role=MessageRole.USER, content="q"),
            Message(role=MessageRole.TOOL, content="x" * 100_000),
        ]
        # First truncation attempt succeeds
        _, retries, ok, trunc = await svc._try_overflow_recovery(
            "s1",
            settings.MAX_OVERFLOW_RETRIES,
            truncation_attempted=False,
        )
        assert ok is True
        assert trunc is True

        # Second truncation attempt blocked
        _, _, ok2, _ = await svc._try_overflow_recovery(
            "s1",
            settings.MAX_OVERFLOW_RETRIES,
            truncation_attempted=True,
        )
        assert ok2 is False

    @pytest.mark.asyncio
    async def test_compaction_overflow_skips_to_truncation(self):
        """If compaction itself overflows, skip to truncation fallback."""
        svc = _create_service()
        svc.llm.ainvoke.side_effect = Exception("maximum context length exceeded")
        svc.sessions["s1"] = [
            Message(role=MessageRole.USER, content="q"),
            Message(role=MessageRole.ASSISTANT, content="a"),
        ]
        history, retries, ok, trunc = await svc._try_overflow_recovery("s1", 0)
        assert ok is True
        assert retries == settings.MAX_OVERFLOW_RETRIES  # skipped to truncation

    @pytest.mark.asyncio
    async def test_aggressive_truncation_in_fallback(self):
        """Fallback truncation uses more aggressive settings than Layer 1."""
        svc = _create_service(
            compaction_settings=CompactionSettings(
                context_window_tokens=128_000,
                max_tool_result_context_share=0.3,
                hard_max_tool_result_chars=400_000,
            ),
        )
        # Tool result that fits Layer 1 threshold (30% of 128k * 4 = 153,600 chars)
        # but exceeds fallback threshold (7.5% of 128k * 4 = 38,400 chars)
        tool_content = "x" * 50_000
        svc.sessions["s1"] = [
            Message(role=MessageRole.USER, content="q"),
            Message(role=MessageRole.TOOL, content=tool_content),
        ]
        _, retries, ok, trunc = await svc._try_overflow_recovery(
            "s1",
            settings.MAX_OVERFLOW_RETRIES,
            truncation_attempted=False,
        )
        assert ok is True
        assert trunc is True
        # Verify the tool result was actually truncated
        tool_msg = [m for m in svc.sessions["s1"] if m.role == MessageRole.TOOL][0]
        assert len(tool_msg.content) < len(tool_content)


# ---------------------------------------------------------------------------
# Multiple tool calls
# ---------------------------------------------------------------------------


class TestMultipleToolCalls:
    """Tests for handling multiple tool calls in a single LLM response."""

    @pytest.mark.asyncio
    async def test_returns_all_tool_calls(self):
        """process_messages_with_tools returns all tool calls, not just first."""
        svc = _create_service()
        resp = MagicMock()
        resp.content = ""
        resp.tool_calls = [
            {"name": "bash", "args": {"command": "ls"}, "id": "c1"},
            {"name": "bash", "args": {"command": "pwd"}, "id": "c2"},
        ]
        svc.llm.ainvoke.return_value = resp
        result = await svc.process_messages_with_tools(
            [Message(role=MessageRole.USER, content="run both")],
        )
        assert result.type == LLMResultType.TOOL_CALL
        assert len(result.tool_calls) == 2
        assert result.tool_calls[0].id == "c1"
        assert result.tool_calls[1].id == "c2"


# ---------------------------------------------------------------------------
# Session TTL / eviction
# ---------------------------------------------------------------------------


class TestSessionEviction:
    """Tests for session TTL expiration and max-sessions eviction."""

    def test_stale_sessions_evicted(self):
        """Sessions older than TTL are removed."""
        import time as _time

        svc = _create_service()
        svc.sessions["old"] = [Message(role=MessageRole.USER, content="hi")]
        svc._session_last_access["old"] = _time.time() - settings.SESSION_TTL_SECONDS - 1
        svc.sessions["new"] = [Message(role=MessageRole.USER, content="hi")]
        svc._session_last_access["new"] = _time.time()

        svc._cleanup_stale_sessions()
        assert "old" not in svc.sessions
        assert "new" in svc.sessions

    def test_max_sessions_evicts_oldest(self):
        """When over settings.MAX_SESSIONS, oldest sessions are evicted."""
        import time as _time

        svc = _create_service()
        # Create settings.MAX_SESSIONS + 5 sessions
        for i in range(settings.MAX_SESSIONS + 5):
            sid = f"s{i}"
            svc.sessions[sid] = []
            svc._session_last_access[sid] = _time.time() + i

        svc._cleanup_stale_sessions()
        assert len(svc.sessions) == settings.MAX_SESSIONS

    def test_locked_session_not_evicted_by_ttl(self):
        """Sessions with active locks are never evicted, even if expired."""
        import asyncio
        import time as _time

        svc = _create_service()
        svc.sessions["locked"] = [Message(role=MessageRole.USER, content="hi")]
        svc._session_last_access["locked"] = _time.time() - settings.SESSION_TTL_SECONDS - 100

        # Simulate an active lock
        lock = asyncio.Lock()
        lock._locked = True  # Force locked state for testing
        svc._session_locks["locked"] = lock

        svc._cleanup_stale_sessions()
        assert "locked" in svc.sessions  # not evicted

    def test_locked_session_not_evicted_by_max(self):
        """Locked sessions are skipped during settings.MAX_SESSIONS eviction."""
        import asyncio
        import time as _time

        svc = _create_service()
        # Create settings.MAX_SESSIONS + 1 sessions; make the oldest one locked
        for i in range(settings.MAX_SESSIONS + 1):
            sid = f"s{i}"
            svc.sessions[sid] = []
            svc._session_last_access[sid] = _time.time() + i

        # Lock the oldest session
        lock = asyncio.Lock()
        lock._locked = True
        svc._session_locks["s0"] = lock

        svc._cleanup_stale_sessions()
        assert "s0" in svc.sessions  # locked, not evicted


# ---------------------------------------------------------------------------
# append_tool_interaction (batch)
# ---------------------------------------------------------------------------


class TestAppendToolInteractionBatch:
    """Tests for batch append_tool_interaction with multiple tool calls."""

    @pytest.mark.asyncio
    async def test_multiple_tool_calls_and_results(self):
        """append_tool_interaction persists multiple tool calls + results."""
        svc = _create_service()
        svc.sessions["s1"] = []
        tool_calls = [
            {"name": "bash", "args": {"command": "ls"}, "id": "c1"},
            {"name": "bash", "args": {"command": "pwd"}, "id": "c2"},
        ]
        tool_results = [
            Message(role=MessageRole.TOOL, content="file.txt", tool_call_id="c1"),
            Message(role=MessageRole.TOOL, content="/home", tool_call_id="c2"),
        ]
        await svc.append_tool_interaction(
            "s1",
            [Message(role=MessageRole.USER, content="run both")],
            tool_calls,
            tool_results,
        )
        history = svc.sessions["s1"]
        assert len(history) == 4  # user + assistant + 2 tool results
        assert history[0].role == MessageRole.USER
        assert history[1].role == MessageRole.ASSISTANT
        assert history[1].tool_calls == tool_calls
        assert history[2].role == MessageRole.TOOL
        assert history[3].role == MessageRole.TOOL


# ---------------------------------------------------------------------------
# Actual-usage-based proactive compaction
# ---------------------------------------------------------------------------


class TestActualUsageBasedCompaction:
    """Tests for actual-usage-based (post-turn) proactive compaction.

    The service reads input_tokens from the last assistant message's usage
    in session history, falling back to tiktoken estimation on first call.
    """

    @pytest.mark.asyncio
    async def test_post_turn_trigger_from_history_usage(self):
        """When history has an assistant message with high input_tokens, compaction triggers."""
        svc = _create_service(
            compaction_settings=CompactionSettings(
                context_window_tokens=100_000,
                proactive_pruning_ratio=0.7,
            ),
        )
        sid = "s1"
        svc.sessions[sid] = [
            Message(role=MessageRole.USER, content="q1"),
            Message(
                role=MessageRole.ASSISTANT,
                content="a1",
                usage={"input_tokens": 80_000, "output_tokens": 50, "total_tokens": 80_050},
            ),
            Message(role=MessageRole.USER, content="q2"),
            Message(
                role=MessageRole.ASSISTANT,
                content="a2",
                usage={"input_tokens": 80_000, "output_tokens": 50, "total_tokens": 80_050},
            ),
        ]

        # LLM returns a summary for compaction, then a normal response
        svc.llm.ainvoke.side_effect = [
            MagicMock(content="Summary"),  # compaction call
            _mock_response("done"),  # actual call
        ]

        result = await svc.process_messages(
            [Message(role=MessageRole.USER, content="q3")],
            session_id=sid,
        )
        assert result.message == "done"
        # Compaction was called (LLM invoked twice: compaction summary + response)
        assert svc.llm.ainvoke.call_count == 2

    @pytest.mark.asyncio
    async def test_post_turn_no_trigger_when_ratio_low(self):
        """When history usage ratio is below threshold, no compaction."""
        svc = _create_service(
            compaction_settings=CompactionSettings(
                context_window_tokens=100_000,
                proactive_pruning_ratio=0.7,
            ),
        )
        sid = "s1"
        svc.sessions[sid] = [
            Message(role=MessageRole.USER, content="q1"),
            Message(
                role=MessageRole.ASSISTANT,
                content="a1",
                usage={"input_tokens": 30_000, "output_tokens": 50, "total_tokens": 30_050},
            ),
        ]

        svc.llm.ainvoke.return_value = _mock_response("ok")

        result = await svc.process_messages(
            [Message(role=MessageRole.USER, content="q2")],
            session_id=sid,
        )
        assert result.message == "ok"
        # Only one LLM call (no compaction)
        assert svc.llm.ainvoke.call_count == 1

    @pytest.mark.asyncio
    async def test_first_call_fallback_uses_tiktoken(self):
        """When no assistant with usage exists in history, tiktoken estimation is used."""
        svc = _create_service(
            compaction_settings=CompactionSettings(
                context_window_tokens=100_000,
                proactive_pruning_ratio=0.7,
            ),
        )
        sid = "s1"
        svc.sessions[sid] = []
        # Empty history — no usage data available, falls back to tiktoken

        svc.llm.ainvoke.return_value = _mock_response("hello")

        result = await svc.process_messages(
            [Message(role=MessageRole.USER, content="hi")],
            session_id=sid,
        )
        assert result.message == "hello"
        # Only one LLM call (small message, tiktoken well below threshold)
        assert svc.llm.ainvoke.call_count == 1

    def test_get_last_input_tokens_reads_history(self):
        """_get_last_input_tokens returns input_tokens from last assistant with usage."""
        svc = _create_service()
        svc.sessions["s1"] = [
            Message(role=MessageRole.USER, content="q1"),
            Message(
                role=MessageRole.ASSISTANT,
                content="a1",
                usage={"input_tokens": 100},
            ),
            Message(role=MessageRole.USER, content="q2"),
            Message(
                role=MessageRole.ASSISTANT,
                content="a2",
                usage={"input_tokens": 420},
            ),
        ]
        assert svc._get_last_input_tokens("s1") == 420

    def test_get_last_input_tokens_empty_history(self):
        """_get_last_input_tokens returns None when no usage in history."""
        svc = _create_service()
        svc.sessions["s1"] = []
        assert svc._get_last_input_tokens("s1") is None

    def test_get_last_input_tokens_no_usage(self):
        """_get_last_input_tokens returns None when assistant has no usage."""
        svc = _create_service()
        svc.sessions["s1"] = [
            Message(role=MessageRole.USER, content="q"),
            Message(role=MessageRole.ASSISTANT, content="a"),
        ]
        assert svc._get_last_input_tokens("s1") is None

    def test_get_last_input_tokens_missing_session(self):
        """_get_last_input_tokens returns None for unknown session."""
        svc = _create_service()
        assert svc._get_last_input_tokens("nonexistent") is None
