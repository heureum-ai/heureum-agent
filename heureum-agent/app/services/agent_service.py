# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Agent service — building blocks for the agentic loop.

The agentic loop itself lives in the router layer (routers/agent.py).
This service provides single-call LLM invocation with:
  1. Inline system prompts → build_system_prompt() from prompts/base.py
  2. 3-layer compaction pipeline (truncation → pruning → LLM summarization)
  3. Overflow recovery (compaction → tool truncation fallback, OpenClaw pattern)
  4. Proper ToolMessage support for tool result round-trips
  5. Open Responses instructions field support
"""

import asyncio
import logging
import time
import uuid
from typing import Any, Dict, List, Optional, Set, Tuple

from app.config import settings
from app.models import AgentResponse, LLMResult, LLMResultType, ToolCallInfo
from app.schemas.open_responses import Usage
from app.services.messages import MessageController
from app.services.compaction import CompactionController
from app.services.error import LLMErrorClassifier
from app.services.providers import (
    LLMController,
    MultiProviderLLM,
    is_failover_error,
    resolve_candidates,
    run_with_model_fallback,
)
from app.services.prompts import PromptController
from app.services.mcps import MCPToolController
from app.services.skills import SkillController
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage as LCSystemMessage,
    ToolMessage,
)

logger = logging.getLogger(__name__)


class AgentService:
    """Service for managing AI agent interactions.

    Prompt architecture (per call):
      [SystemMessage]  <- build_system_prompt() + optional instructions
      [history...]     <- session history (may contain compaction summary)
      [new messages]   <- current request
    """

    def __init__(
        self,
        compaction_controller: CompactionController | None = None,
        mcp_tools: Optional[List[Dict[str, Any]]] = None,
        skill_provider: Optional[Any] = None,
        message_controller: MessageController | None = None,
        llm_controller: LLMController | None = None,
    ) -> None:
        """Initialize the AgentService.

        Args:
            compaction_controller (CompactionController | None):
                Compaction-domain controller override.
            mcp_tools (Optional[List[Dict[str, Any]]]): Pre-discovered MCP
                tool schemas. Typically set later via ``mcp_tools`` attribute.
            skill_provider (Optional[SkillController]): Skill registry instance
                for server-side tool schemas and guide prompts.
            message_controller (MessageController | None):
                Message-domain composition root override.
            llm_controller (LLMController | None):
                Provider-domain LLM controller override.
        """
        self.message_controller = message_controller or MessageController()
        self.sessions = self.message_controller.session_state_controller.sessions
        self.compaction_controller = compaction_controller or CompactionController()
        self.mcp_tool_controller = MCPToolController(mcp_tools)
        self.skill_provider: SkillController | None = skill_provider
        self.prompt_controller = PromptController(
            skill_provider=skill_provider,
            mcp_tool_controller=self.mcp_tool_controller,
        )
        self.llm_controller = llm_controller or LLMController()
        self.llm = self.llm_controller.create_primary()

        # Model fallback infrastructure
        self._fallback_candidates = resolve_candidates(
            primary_spec=settings.get_model_fallback_primary(),
            fallback_chain=settings.get_model_fallback_chain(),
        )
        self._multi_provider = MultiProviderLLM()
        # Pre-seed primary candidate with self.llm so fallback reuses it
        if self._fallback_candidates:
            self._multi_provider._cache[self._fallback_candidates[0].spec] = self.llm

        self._platform_message_history_client = (
            self.message_controller.create_platform_message_history_client(
                settings.PLATFORM_API_URL
            )
        )

        # Middleware runner — injected by AgentLoopController after construction
        self.middleware_runner: Any = None

    # ------------------------------------------------------------------
    # Facade properties — shorten deep property chains
    # ------------------------------------------------------------------

    @property
    def _sessions(self) -> dict:
        """Shortcut to LangChain session storage."""
        return self.message_controller.session_state_controller.sessions

    def _lc_history(self, session_id: str) -> list:
        """Return the LC history list for a session (empty list if absent)."""
        return self._sessions.get(session_id, [])

    @property
    def _normalize(self):
        """Shortcut to MessageNormalizeController."""
        return self.message_controller.message_normalize_controller

    @property
    def responses(self):
        """Shortcut to ResponseMessageController."""
        return self.message_controller.response_message_controller

    @property
    def history(self):
        """Shortcut to HistoryMessageController."""
        return self.message_controller.history_message_controller

    def extract_lc_text(self, content: Any) -> str:
        """Extract plain text from message content (str, list, or LangChain message).

        Public facade for the internal ``_normalize.extract_lc_text()`` method.
        """
        return self._normalize.extract_lc_text(content)

    def remove_session(self, session_id: str) -> bool:
        """Remove all data associated with a session.

        Args:
            session_id (str): The session to evict.

        Returns:
            bool: True if the session existed before eviction.
        """
        existed = session_id in self._sessions
        self.message_controller.session_state_controller.remove_session(session_id)
        return existed

    def _get_session_lock(self, session_id: str) -> asyncio.Lock:
        """Return the asyncio lock for a session, creating one if needed.

        Args:
            session_id (str): The session identifier.

        Returns:
            asyncio.Lock: The lock associated with the session.
        """
        return self.message_controller.session_state_controller.get_session_lock(session_id)

    def _get_last_input_tokens(self, session_id: str) -> Optional[int]:
        """Read input tokens from the latest assistant LangChain message."""
        for msg in reversed(self._sessions.get(session_id, [])):
            if not isinstance(msg, AIMessage):
                continue

            usage = getattr(msg, "usage_metadata", None) or {}
            if usage.get("input_tokens") is not None:
                return int(usage["input_tokens"])

            token_usage = getattr(msg, "response_metadata", {}).get("token_usage", {})
            if token_usage.get("prompt_tokens") is not None:
                return int(token_usage["prompt_tokens"])
            if token_usage.get("input_tokens") is not None:
                return int(token_usage["input_tokens"])
        return None

    async def generate_title(self, conversation: str) -> str:
        """Generate a short title for a conversation using the LLM.

        Args:
            conversation: Formatted conversation text.

        Returns:
            Title string (max 60 chars).

        Raises:
            Exception: Propagated from LLM call (caller should handle).
        """
        prompt = HumanMessage(
            content=(
                "Generate a very short title (max 6 words) for this conversation. "
                "Return ONLY the title, no quotes or punctuation.\n\n"
                f"{conversation}"
            )
        )
        result = await self.llm.ainvoke([prompt])
        title = result.content.strip().strip("\"'")
        if len(title) > 60:
            title = title[:57] + "..."
        return title

    async def aclose(self) -> None:
        """Close external clients. Called during application shutdown."""
        await self._platform_message_history_client.aclose()

    async def _get_or_create_session(
        self, session_id: Optional[str]
    ) -> tuple[str, List[BaseMessage]]:
        """Retrieve an existing session, rehydrate from Platform DB, or create new.

        Flow:
          1. In-memory cache hit → return immediately
          2. Cache miss with known session_id → attempt rehydration from Platform DB
          3. Rehydration miss or no session_id → create empty session

        Args:
            session_id (Optional[str]): Desired session ID, or None to
                auto-generate one.

        Returns:
            tuple[str, List[BaseMessage]]: A (session_id, history) pair.
        """
        if session_id and session_id in self._sessions:
            self.message_controller.session_state_controller.last_access[session_id] = time.time()
            return session_id, self._sessions[session_id]

        # Cache miss — attempt rehydration from Platform DB
        if session_id:
            try:
                rehydrated = (
                    await self.message_controller.message_rehydration_controller.rehydrate_session(
                        client=self._platform_message_history_client,
                        session_id=session_id,
                    )
                )
                if rehydrated is not None:
                    self._sessions[session_id] = rehydrated
                    self.message_controller.session_state_controller.last_access[session_id] = (
                        time.time()
                    )
                    logger.info(
                        "Rehydrated session %s (%d messages)",
                        session_id,
                        len(rehydrated),
                    )
                    return session_id, self._sessions[session_id]
            except Exception:
                logger.warning(
                    "Failed to rehydrate session %s, starting fresh",
                    session_id,
                    exc_info=True,
                )

        new_session_id = session_id or str(uuid.uuid4())
        self._sessions[new_session_id] = []
        self.message_controller.session_state_controller.last_access[new_session_id] = time.time()
        return new_session_id, self._sessions[new_session_id]

    def _is_session_locked(self, session_id: str) -> bool:
        """Check if a session's lock is currently held (in-use).

        Args:
            session_id (str): The session identifier to check.

        Returns:
            bool: True if the session lock is currently acquired.
        """
        return self.message_controller.session_state_controller.is_session_locked(session_id)

    def cleanup_stale_sessions(self) -> tuple[int, int]:
        """Remove sessions older than TTL and evict oldest if over settings.MAX_SESSIONS.

        Safety: never evicts sessions with an active lock (currently in-use).
        """
        expired_count, overflow_evicted_count = (
            self.message_controller.session_state_controller.cleanup_stale_sessions(
                ttl_seconds=settings.SESSION_TTL_SECONDS,
                max_sessions=settings.MAX_SESSIONS,
            )
        )
        if expired_count:
            logger.info("Evicted %d expired session(s)", expired_count)
        if overflow_evicted_count:
            logger.info(
                "Evicted %d session(s) over settings.MAX_SESSIONS limit",
                overflow_evicted_count,
            )
        return expired_count, overflow_evicted_count

    async def _ensure_session(
        self,
        session_id: Optional[str],
    ) -> str:
        """Ensure session exists, cleaning up stale sessions first.

        Args:
            session_id (Optional[str]): Desired session ID, or None to
                auto-generate.

        Returns:
            str: The resolved session ID.
        """
        self.cleanup_stale_sessions()
        session_id, _ = await self._get_or_create_session(session_id)
        return session_id

    def _ensure_lc_session(self, session_id: str) -> None:
        """Ensure an LC history list exists for a session."""
        self.message_controller.session_state_controller.ensure_session(session_id)

    def extract_usage(self, response) -> Usage:
        """Extract token usage from LLM response.

        Compatibility wrapper delegating to ``_normalize._extract_usage``.

        Args:
            response: The LLM response (AIMessage).

        Returns:
            Usage: Token usage statistics including cached token details.
        """
        return self._normalize._extract_usage(response)

    def _preview_text(self, content: Any, limit: int = 220) -> str:
        """Render message content as a short single-line preview."""
        text = self._normalize.extract_lc_text(content).replace("\n", "\\n")
        if len(text) <= limit:
            return text
        return f"{text[:limit]}...(truncated {len(text) - limit} chars)"

    @staticmethod
    def _summarize_tool_calls(tool_calls: Any) -> list[dict[str, Any]]:
        """Return compact tool-call metadata for logs."""
        if not isinstance(tool_calls, list):
            return []
        summaries: list[dict[str, Any]] = []
        for call in tool_calls:
            if not isinstance(call, dict):
                summaries.append({"raw_type": type(call).__name__})
                continue
            args = call.get("args")
            if isinstance(args, dict):
                args_shape = sorted(args.keys())
            else:
                args_shape = type(args).__name__
            summaries.append(
                {
                    "id": call.get("id"),
                    "name": call.get("name"),
                    "args_shape": args_shape,
                }
            )
        return summaries

    def _serialize_lc_history_for_log(self, lc_messages: list[BaseMessage]) -> list[dict[str, Any]]:
        """Serialize LC messages into a compact debug-friendly structure."""
        serialized: list[dict[str, Any]] = []
        for i, msg in enumerate(lc_messages):
            item: dict[str, Any] = {
                "idx": i,
                "type": msg.__class__.__name__,
                "content_preview": self._preview_text(getattr(msg, "content", "")),
            }

            if isinstance(msg, LCSystemMessage):
                item["role"] = "system"
            elif isinstance(msg, HumanMessage):
                item["role"] = "user"
            elif isinstance(msg, ToolMessage):
                item["role"] = "tool"
                item["tool_call_id"] = getattr(msg, "tool_call_id", None)
                item["status"] = getattr(msg, "status", None)
            elif isinstance(msg, AIMessage):
                item["role"] = "assistant"
                tool_calls = getattr(msg, "tool_calls", None) or []
                if tool_calls:
                    item["tool_calls"] = self._summarize_tool_calls(tool_calls)
                invalid_calls = getattr(msg, "invalid_tool_calls", None) or []
                if invalid_calls:
                    item["invalid_tool_calls_count"] = len(invalid_calls)
                usage = getattr(msg, "usage_metadata", None)
                if isinstance(usage, dict):
                    item["usage"] = {
                        "input_tokens": usage.get("input_tokens"),
                        "output_tokens": usage.get("output_tokens"),
                        "total_tokens": usage.get("total_tokens"),
                    }

            additional_kwargs = getattr(msg, "additional_kwargs", None)
            if isinstance(additional_kwargs, dict) and additional_kwargs:
                item["additional_kwargs_keys"] = sorted(additional_kwargs.keys())
                if (
                    "tool_calls" in additional_kwargs
                    and "tool_calls" not in item
                    and isinstance(additional_kwargs.get("tool_calls"), list)
                ):
                    item["raw_tool_calls_count"] = len(additional_kwargs["tool_calls"])

            response_metadata = getattr(msg, "response_metadata", None)
            if isinstance(response_metadata, dict) and response_metadata:
                item["response_metadata_keys"] = sorted(response_metadata.keys())

            serialized.append(item)
        return serialized

    def _log_pre_llm(
        self,
        *,
        stage: str,
        session_id: str,
        lc_messages: list[BaseMessage],
        new_message_count: int,
        tools: list,
    ) -> float:
        """Log summary before LLM invocation. Returns start time for latency calc."""
        start = time.monotonic()
        try:
            logger.info(
                "LLM_REQUEST stage=%s session=%s history_len=%d new_msg_count=%d tool_count=%d",
                stage,
                session_id,
                len(lc_messages) - new_message_count - 1,  # exclude system prompt + new
                new_message_count,
                len(tools),
            )
            if logger.isEnabledFor(logging.DEBUG):
                # Only serialize the new messages (tail), not the full history
                tail = lc_messages[-new_message_count:] if new_message_count > 0 else []
                payload = self._serialize_lc_history_for_log(tail)
                logger.debug(
                    "LLM_REQUEST_DETAIL stage=%s session=%s new_messages=%s",
                    stage,
                    session_id,
                    payload,
                )
        except Exception:
            logger.debug(
                "LLM_REQUEST stage=%s session=%s failed to serialize",
                stage,
                session_id,
                exc_info=True,
            )
        return start

    def _log_post_llm(
        self,
        *,
        stage: str,
        session_id: str,
        response: Any,
        start_time: float,
    ) -> None:
        """Log LLM response summary after call completes."""
        latency = time.monotonic() - start_time
        try:
            tool_calls = getattr(response, "tool_calls", None) or []
            tool_names = [tc.get("name", "?") if isinstance(tc, dict) else "?" for tc in tool_calls]
            usage = getattr(response, "usage_metadata", None)
            usage_summary = {}
            if isinstance(usage, dict):
                usage_summary = {
                    "in": usage.get("input_tokens", 0),
                    "out": usage.get("output_tokens", 0),
                    "total": usage.get("total_tokens", 0),
                }
            stop_reason = "tool_use" if tool_names else "end_turn"
            logger.info(
                "LLM_RESPONSE stage=%s session=%s latency=%.2fs stop=%s tokens=%s tool_calls=%s",
                stage,
                session_id,
                latency,
                stop_reason,
                usage_summary or "-",
                tool_names or "-",
            )
            if logger.isEnabledFor(logging.DEBUG):
                preview = self._preview_text(getattr(response, "content", ""))
                logger.debug(
                    "LLM_RESPONSE_DETAIL stage=%s session=%s preview=%s",
                    stage,
                    session_id,
                    preview,
                )
        except Exception:
            logger.debug(
                "LLM_RESPONSE stage=%s session=%s failed to serialize (latency=%.2fs)",
                stage,
                session_id,
                latency,
                exc_info=True,
            )

    def _prepare_prompt_and_tools(
        self,
        instructions: Optional[str] = None,
        client_tool_prompts: Optional[List[str]] = None,
        client_tool_schemas: Optional[List[dict]] = None,
        client_tool_names: Optional[Set[str]] = None,
        state_prompts: Optional[List[str]] = None,
        skills_prompt: Optional[str] = None,
        skills_snapshot: Any = None,
        active_tool_names: Optional[Set[str]] = None,
        is_subagent: bool = False,
    ) -> tuple:
        """Build system prompt and resolve tool schemas together.

        Delegates to :class:`PromptController` for the actual assembly.

        Args:
            instructions (Optional[str]): Extra instructions to append
                inside an ``<instructions>`` XML block.
            client_tool_prompts (Optional[List[str]]): Guide texts from
                clients for inclusion in the system prompt.
            client_tool_schemas (Optional[List[dict]]): Client-provided
                OpenAI-format tool schemas.
            client_tool_names (Optional[Set[str]]): Client-side tool names
                available in this turn.
            state_prompts (Optional[List[str]]): Per-turn runtime state
                prompts from skills (wrapped inside ``<session_state>``).
            skills_prompt (Optional[str]): Pre-built ``<available_skills>``
                block from a client skills snapshot.
            skills_snapshot: Full snapshot payload for tool filtering.
            active_tool_names: Progressive skill activation filter set.

        Returns:
            tuple[str, list]: (system_prompt, tool_schemas_for_bind_tools).
        """
        return self.prompt_controller.prepare_prompt_and_tools(
            instructions=instructions,
            client_tool_prompts=client_tool_prompts,
            client_tool_schemas=client_tool_schemas,
            client_tool_names=client_tool_names,
            state_prompts=state_prompts,
            skills_prompt=skills_prompt,
            skills_snapshot=skills_snapshot,
            active_tool_names=active_tool_names,
            is_subagent=is_subagent,
        )

    def _build_lc_messages(
        self,
        history: List[BaseMessage],
        new_messages: List[BaseMessage],
        instructions: Optional[str] = None,
        client_tool_prompts: Optional[List[str]] = None,
        state_prompts: Optional[List[str]] = None,
    ) -> list:
        """Build LangChain message list: [system] + [history] + [new].

        The system prompt is never stored in history -- always rebuilt fresh
        so tool availability and instructions stay current.

        Args:
            history (List[BaseMessage]): Previously stored session messages.
            new_messages (List[BaseMessage]): Messages from the current request.
            instructions (Optional[str]): Extra instructions for the prompt.
            client_tool_prompts (Optional[List[str]]): Guide texts from
                clients for inclusion in the system prompt.
            state_prompts (Optional[List[str]]): Per-turn runtime state
                prompts from skills.

        Returns:
            list: Ordered list of LangChain message objects.
        """
        prompt, _ = self._prepare_prompt_and_tools(
            instructions=instructions,
            client_tool_prompts=client_tool_prompts,
            state_prompts=state_prompts,
        )
        lc_messages = [LCSystemMessage(content=prompt)]
        lc_messages.extend(history)
        lc_messages.extend(new_messages)
        return lc_messages

    async def _call_llm(self, lc_messages: list, tools: list):
        """Invoke LLM, optionally with tool binding.

        Args:
            lc_messages (list): LangChain message objects forming the prompt.
            tools (list): Tool schemas to bind. If empty, no tool binding.

        Returns:
            AIMessage: The LLM response.
        """
        if tools:
            return await self.llm.bind_tools(tools).ainvoke(lc_messages)
        return await self.llm.ainvoke(lc_messages)

    async def _call_llm_stream(self, lc_messages: list, tools: list):
        """Stream LLM response chunks, optionally with tool binding.

        Args:
            lc_messages: LangChain message objects forming the prompt.
            tools: Tool schemas to bind. If empty, no tool binding.

        Yields:
            AIMessageChunk: Incremental response chunks from the LLM.
        """
        if tools:
            async for chunk in self.llm.bind_tools(tools).astream(lc_messages):
                yield chunk
        else:
            async for chunk in self.llm.astream(lc_messages):
                yield chunk

    async def _compact_session(self, session_id: str) -> List[BaseMessage]:
        """Run 3-layer compaction on a session and persist the result.

        truncation -> pruning -> LLM summarization

        Preserves original LangChain messages for the kept tail to retain
        provider metadata (e.g. Gemini thought signatures).

        Args:
            session_id (str): The session whose history should be compacted.

        Returns:
            List[BaseMessage]: The compacted history (also saved to
                ``self.sessions``).
        """
        from app.services.middleware.types import CompactionEvent, MiddlewareContext

        history = self.get_history(session_id)
        original_lc = list(self._sessions.get(session_id, []))

        mw = self.middleware_runner
        event = None
        if mw:
            ctx = MiddlewareContext(session_id=session_id)
            event = CompactionEvent(context=ctx, message_count=len(history))
            before = await mw.run_before(event)
            if before.blocked:
                logger.info("Compaction blocked by middleware: %s", before.reason)
                return history

        compacted_history, compacted_lc = await self.compaction_controller.compact_session_history(
            history=history,
            original_lc=original_lc,
            llm=self.llm,
        )
        self._sessions[session_id] = compacted_lc

        if mw and event:
            event.compacted_count = len(compacted_history)
            await mw.run_after(event)

        return compacted_history

    async def _try_overflow_recovery(
        self,
        session_id: str,
        overflow_retries: int,
        truncation_attempted: bool = False,
    ) -> Tuple[List[BaseMessage], int, bool, bool]:
        """Attempt to recover from context overflow.

        Strategy (follows OpenClaw pattern):
          1. _compact_session (up to settings.MAX_OVERFLOW_RETRIES times)
          2. Tool result truncation as fallback (one-shot, matching
             OpenClaw's toolResultTruncationAttempted guard)

        Args:
            session_id (str): Session to recover.
            overflow_retries (int): Number of retries already attempted.
            truncation_attempted (bool): Whether aggressive truncation has
                already been tried.

        Returns:
            Tuple[List[BaseMessage], int, bool, bool]: A tuple of
                (recovered_history, updated_overflow_retries, succeeded,
                truncation_attempted).
        """
        if overflow_retries < settings.MAX_OVERFLOW_RETRIES:
            logger.warning(
                "Context overflow (attempt %d/%d), compacting...",
                overflow_retries + 1,
                settings.MAX_OVERFLOW_RETRIES,
            )
            before_tokens = self.compaction_controller.estimate_messages_tokens(
                self.get_history(session_id),
            )
            try:
                history = await self._compact_session(session_id)
            except Exception as compact_err:
                if LLMErrorClassifier.is_context_overflow(compact_err):
                    logger.warning("Compaction itself overflowed, skipping to truncation")
                    return (
                        self.get_history(session_id),
                        settings.MAX_OVERFLOW_RETRIES,
                        True,
                        truncation_attempted,
                    )
                raise
            after_tokens = self.compaction_controller.estimate_messages_tokens(history)
            if after_tokens >= before_tokens:
                logger.warning(
                    "Compaction did not reduce size (%d → %d tokens), "
                    "skipping to truncation fallback",
                    before_tokens,
                    after_tokens,
                )
                return (
                    history,
                    settings.MAX_OVERFLOW_RETRIES,
                    True,
                    truncation_attempted,
                )
            return history, overflow_retries + 1, True, truncation_attempted

        if truncation_attempted:
            logger.error("Truncation already attempted once; giving up")
            return self.get_history(session_id), overflow_retries, False, True

        history = self.get_history(session_id)
        # 1/4 of normal thresholds to truncate further than Layer 1
        history, truncated = self.compaction_controller.truncate_aggressive(history)
        self._sessions[session_id] = history
        truncation_attempted = True
        if truncated:
            logger.info(
                "Truncated %d tool result(s) after compaction exhausted; resetting retry counter",
                truncated,
            )
            return history, 0, True, truncation_attempted

        logger.error("All overflow recovery strategies exhausted")
        return history, overflow_retries, False, truncation_attempted

    async def _maybe_proactive_compact(
        self,
        session_id: str,
        new_messages: List[BaseMessage],
    ) -> None:
        """Compact the session proactively if context usage ratio is high.

        Uses actual ``input_tokens`` from the last assistant message in
        history when available (post-turn check). Falls back to tiktoken
        estimation on the first call when no usage data exists yet.

        Args:
            session_id (str): The session to check.
            new_messages (List[Message]): Pending messages for the next call.
        """
        compaction_settings = self.compaction_controller.settings
        ctx_tokens = compaction_settings.context_window_tokens
        last_tokens = self._get_last_input_tokens(session_id)
        if last_tokens is not None:
            ratio = last_tokens / ctx_tokens if ctx_tokens > 0 else 0.0
        else:
            session_history = self.get_history(session_id)
            est_tokens = self.compaction_controller.estimate_messages_tokens(
                session_history + new_messages
            )
            ratio = est_tokens / ctx_tokens if ctx_tokens > 0 else 0.0
        if ratio >= compaction_settings.proactive_pruning_ratio:
            logger.info(
                "Proactive pruning triggered (ratio %.2f >= %.2f)",
                ratio,
                compaction_settings.proactive_pruning_ratio,
            )
            await self._compact_session(session_id)

    async def _invoke_with_recovery(
        self,
        new_messages: List[BaseMessage],
        session_id: str,
        instructions: Optional[str] = None,
        client_tool_schemas: Optional[List[dict]] = None,
        client_tool_prompts: Optional[List[str]] = None,
        client_tool_names: Optional[Set[str]] = None,
        state_prompts: Optional[List[str]] = None,
        skills_prompt: Optional[str] = None,
        skills_snapshot: Any = None,
        active_tool_names: Optional[Set[str]] = None,
        is_subagent: bool = False,
    ):
        """Single LLM call with overflow recovery and transient error retry.

        Uses while-True with explicit exit conditions (OpenClaw pattern):
          - Success -> return response
          - Context overflow -> compact & retry
          - Retryable error (5xx, rate limit, etc.) -> backoff & retry
          - Non-recoverable error -> raise

        Args:
            new_messages (List[Message]): Messages for the current request.
            session_id (str): Active session identifier.
            instructions (Optional[str]): Extra instructions for the prompt.
            client_tool_schemas (Optional[List[dict]]): Client-provided tool
                schemas.
            client_tool_prompts (Optional[List[str]]): Guide texts from
                clients for the system prompt.
            client_tool_names (Optional[Set[str]]): Client-side tool names
                available in this turn.
            state_prompts (Optional[List[str]]): Per-turn runtime state
                prompts from skills.
            skills_snapshot: Full snapshot payload for skill filtering.

        Returns:
            AIMessage: The successful LLM response.

        Raises:
            ValueError: If the context window is below the hard minimum.
            Exception: Re-raised if the error is not a context overflow or
                recovery is exhausted.
        """
        ctx_tokens = self.compaction_controller.settings.context_window_tokens
        if ctx_tokens < settings.CONTEXT_WINDOW_HARD_MIN_TOKENS:
            raise ValueError(
                f"Context window too small: {ctx_tokens} tokens "
                f"(minimum {settings.CONTEXT_WINDOW_HARD_MIN_TOKENS})"
            )

        prompt, tools = self._prepare_prompt_and_tools(
            instructions=instructions,
            client_tool_prompts=client_tool_prompts,
            client_tool_schemas=client_tool_schemas,
            client_tool_names=client_tool_names,
            state_prompts=state_prompts,
            skills_prompt=skills_prompt,
            skills_snapshot=skills_snapshot,
            active_tool_names=active_tool_names,
            is_subagent=is_subagent,
        )
        lc_new_messages = list(new_messages)
        overflow_retries = 0
        truncation_attempted = False
        proactive_done = False
        llm_retries = 0

        while True:
            # Proactive pruning: compact before the LLM call when context
            # usage is high, avoiding a wasted overflow round-trip.
            if not proactive_done:
                await self._maybe_proactive_compact(session_id, new_messages)
                proactive_done = True

            self._ensure_lc_session(session_id)
            lc_messages = [LCSystemMessage(content=prompt)]
            lc_messages.extend(self._sessions.get(session_id, []))
            lc_messages.extend(lc_new_messages)
            lc_messages = self._normalize.strip_tool_call_narration(lc_messages)
            try:
                _t = self._log_pre_llm(
                    stage="primary",
                    session_id=session_id,
                    lc_messages=lc_messages,
                    new_message_count=len(lc_new_messages),
                    tools=tools,
                )
                result = await self._call_llm(lc_messages, tools)
                self._log_post_llm(stage="primary", session_id=session_id, response=result, start_time=_t)
                return result
            except Exception as e:
                if LLMErrorClassifier.is_context_overflow(e):
                    (
                        _,
                        overflow_retries,
                        recovered,
                        truncation_attempted,
                    ) = await self._try_overflow_recovery(
                        session_id,
                        overflow_retries,
                        truncation_attempted,
                    )
                    if not recovered:
                        raise
                    continue

                if (
                    LLMErrorClassifier.is_retryable(e)
                    and not LLMErrorClassifier.is_thought_signature(e)
                    and llm_retries < settings.MAX_LLM_RETRIES
                ):
                    llm_retries += 1
                    delay = settings.LLM_RETRY_BASE_DELAY * (2 ** (llm_retries - 1))
                    logger.warning(
                        "Retryable LLM error (attempt %d/%d), retrying in %.1fs: %s",
                        llm_retries,
                        settings.MAX_LLM_RETRIES,
                        delay,
                        e,
                    )
                    await asyncio.sleep(delay)
                    continue

                # Fallback 1: retry without tools (same history).
                if tools:
                    logger.warning(
                        "LLM call failed with tools bound; retrying without tools: %s",
                        e,
                    )
                    try:
                        _t = self._log_pre_llm(
                            stage="fallback_no_tools",
                            session_id=session_id,
                            lc_messages=lc_messages,
                            new_message_count=len(lc_new_messages),
                            tools=[],
                        )
                        result = await self._call_llm(lc_messages, [])
                        self._log_post_llm(stage="fallback_no_tools", session_id=session_id, response=result, start_time=_t)
                        return result
                    except Exception as fallback_err:
                        logger.warning("No-tools fallback also failed: %s", fallback_err)

                # Fallback 2: strip tool messages from history to avoid
                # Gemini "Thought signature" issues caused by replaying
                # AIMessage(tool_calls) + ToolMessage sequences.
                clean, changed = self._normalize.strip_tool_messages(lc_messages)
                if changed:
                    logger.warning("Retrying with tool messages stripped from history")
                    try:
                        _t = self._log_pre_llm(
                            stage="fallback_stripped",
                            session_id=session_id,
                            lc_messages=clean,
                            new_message_count=len(lc_new_messages),
                            tools=[],
                        )
                        result = await self._call_llm(clean, [])
                        self._log_post_llm(stage="fallback_stripped", session_id=session_id, response=result, start_time=_t)
                        return result
                    except Exception as clean_err:
                        logger.warning("Clean-context fallback also failed: %s", clean_err)

                # Fallback 3: model failover to alternative providers
                if len(self._fallback_candidates) > 1:
                    if is_failover_error(e):
                        logger.warning("Trying model fallback after primary failure: %s", e)

                        async def _call_fn(llm):
                            if tools:
                                return await llm.bind_tools(tools).ainvoke(lc_messages)
                            return await llm.ainvoke(lc_messages)

                        try:
                            fb_result = await run_with_model_fallback(
                                candidates=self._fallback_candidates[1:],
                                call_fn=_call_fn,
                                multi_provider=self._multi_provider,
                            )
                            return fb_result.value
                        except Exception as fb_err:
                            logger.warning("All model fallbacks failed: %s", fb_err)

                raise

    def append_to_history(
        self,
        session_id: str,
        messages: List[BaseMessage],
        response_text: str,
        usage: Optional[Dict[str, Any]] = None,
        assistant_lc_message: Optional[BaseMessage] = None,
    ) -> None:
        """Persist user messages + assistant response to session history.

        Args:
            session_id (str): The target session.
            messages (List[BaseMessage]): User/tool messages to append.
            response_text (str): The assistant's text response to append.
            usage (Optional[Dict[str, Any]]): Token usage for this LLM call.
        """
        self._ensure_lc_session(session_id)
        lc_history = self._sessions[session_id]
        lc_history.extend(messages)
        if assistant_lc_message is not None:
            lc_history.append(assistant_lc_message)
            return
        usage_metadata = self._normalize.normalize_usage_metadata(usage)
        lc_history.append(
            AIMessage(
                content=response_text,
                usage_metadata=usage_metadata,  # type: ignore[arg-type]
            )
        )

    def get_history(self, session_id: str) -> List[BaseMessage]:
        """Return session history (empty list if not found)."""
        return list(self._sessions.get(session_id, []))

    async def append_tool_interaction(
        self,
        session_id: str,
        messages: List[BaseMessage],
        tool_calls: List[Dict[str, Any]],
        tool_results: List[BaseMessage],
        usage: Optional[Dict[str, Any]] = None,
        assistant_lc_message: Optional[BaseMessage] = None,
        snapshot_tools: Optional[frozenset] = None,
    ) -> None:
        """Persist user messages + assistant tool calls + tool results to history.

        When ``assistant_lc_message`` is provided (the original LLM response),
        stores it directly with proper ToolMessage objects.  This preserves
        Gemini thought-signature metadata so the next LLM call passes
        validation.

        Without the original message, falls back to synthetic plain-text
        representations to avoid signature errors.

        Args:
            session_id (str): The target session.
            messages (List[BaseMessage]): User messages preceding the tool calls.
            tool_calls (List[Dict[str, Any]]): Tool call dicts from the LLM
                response (each with ``name``, ``args``, ``id``).
            tool_results (List[BaseMessage]): Tool result messages to append.
            usage (Optional[Dict[str, Any]]): Token usage for this LLM call.
            assistant_lc_message (Optional[BaseMessage]): The original LLM
                AIMessage.  When provided, stored as-is to preserve provider
                metadata (e.g. Gemini thought signatures).
            snapshot_tools: Dynamic set of tool names whose output is
                subject to stale-snapshot invalidation (from client
                ``tool_meta.snapshot``).
        """
        _page_tools: frozenset = snapshot_tools or frozenset()

        async with self._get_session_lock(session_id):
            self._ensure_lc_session(session_id)
            lc_history = self._sessions[session_id]
            # Prevent eviction during long-running agentic loops
            self.message_controller.session_state_controller.last_access[session_id] = time.time()

            # Check if any new tool result contains a fresh page snapshot.
            has_new_page = any(
                self._normalize.is_snapshot_content(self._normalize.extract_lc_text(tr.content))
                for tr in tool_results
                if isinstance(tr, ToolMessage)
                and (
                    (tr.name or "") in _page_tools
                    or self._normalize.is_snapshot_content(
                        self._normalize.extract_lc_text(tr.content)
                    )
                )
            )

            lc_history.extend(messages)
            if assistant_lc_message is not None:
                lc_history.append(assistant_lc_message)
                lc_history.extend(tool_results)
            else:
                # Synthetic fallback: when the original AIMessage is not
                # available (e.g. chain follow-ups), store tool interactions
                # as plain messages.  Use minimal, non-echoable content to
                # prevent the LLM from reproducing it in its next response.
                lc_history.append(
                    AIMessage(
                        content="",
                        additional_kwargs={
                            "synthetic_tool_calls": tool_calls,
                            "synthetic_usage": self._normalize.normalize_usage_metadata(usage),
                        },
                    )
                )
                for tr in tool_results:
                    if isinstance(tr, ToolMessage):
                        lc_history.append(tr)
                    else:
                        lc_history.append(
                            ToolMessage(
                                content=self._normalize.extract_lc_text(tr.content),
                                tool_call_id=getattr(tr, "tool_call_id", "synthetic"),
                            )
                        )

            # Invalidate stale page snapshots now that the new
            # results (including the latest page) are in history.
            if has_new_page:
                n = self._normalize.invalidate_stale_snapshots(lc_history)
                if n:
                    logger.info("Invalidated %d stale page snapshot(s)", n)

    def replace_tool_result(
        self,
        session_id: str,
        tool_call_id: str,
        output: str,
        tool_name: Optional[str] = None,
    ) -> bool:
        """Replace a placeholder tool result in LC history."""
        matched = False

        self._ensure_lc_session(session_id)
        lc_history = self._sessions.get(session_id, [])
        for i, h in enumerate(lc_history):
            if isinstance(h, ToolMessage) and getattr(h, "tool_call_id", None) == tool_call_id:
                lc_history[i] = ToolMessage(content=output, tool_call_id=tool_call_id)
                matched = True
                break
        return matched

    async def process_messages(
        self,
        messages: List[BaseMessage],
        session_id: Optional[str] = None,
        instructions: Optional[str] = None,
    ) -> AgentResponse:
        """Process messages without tool calling.

        Args:
            messages (List[Message]): Input messages to send to the LLM.
            session_id (Optional[str]): Session ID for history tracking.
                A new session is created if None or unknown.
            instructions (Optional[str]): Extra instructions appended to
                the system prompt.

        Returns:
            AgentResponse: The assistant's text response and session ID.

        Raises:
            ValueError: If ``messages`` is empty.
        """
        session_id = await self._ensure_session(session_id)
        if not messages and not self.get_history(session_id):
            raise ValueError("No messages provided")

        async with self._get_session_lock(session_id):
            response = await self._invoke_with_recovery(
                messages,
                session_id,
                instructions=instructions,
            )
            normalized = self._normalize.normalize_llm_response(response)
            self.append_to_history(
                session_id,
                messages,
                normalized.text,
                usage=normalized.usage.model_dump(),
                assistant_lc_message=normalized.raw_message,
            )

        return AgentResponse(
            message=normalized.text,
            session_id=session_id,
            usage=normalized.usage,
            reasoning=normalized.reasoning or None,
        )

    async def process_messages_with_tools(
        self,
        messages: List[BaseMessage],
        session_id: Optional[str] = None,
        instructions: Optional[str] = None,
        client_tool_schemas: Optional[List[dict]] = None,
        client_tool_prompts: Optional[List[str]] = None,
        client_tool_names: Optional[Set[str]] = None,
        state_prompts: Optional[List[str]] = None,
        skills_prompt: Optional[str] = None,
        skills_snapshot: Any = None,
        active_tool_names: Optional[Set[str]] = None,
        is_subagent: bool = False,
    ) -> LLMResult:
        """Process messages with tool calling (single LLM call).

        Args:
            messages (List[Message]): Input messages to send to the LLM.
            session_id (Optional[str]): Session ID for history tracking.
                A new session is created if None or unknown.
            instructions (Optional[str]): Extra instructions appended to
                the system prompt.
            client_tool_schemas (Optional[List[dict]]): Client-provided
                OpenAI-format tool schemas. MCP tools are appended
                automatically.
            client_tool_prompts (Optional[List[str]]): Guide texts from
                clients for the system prompt.
            client_tool_names (Optional[Set[str]]): Client-side tool names
                available in this turn.
            state_prompts (Optional[List[str]]): Per-turn runtime state
                prompts from skills.
            skills_snapshot: Full snapshot payload for skill filtering.

        Returns:
            LLMResult: A text result or tool call result with usage.
        """
        session_id = await self._ensure_session(session_id)

        async with self._get_session_lock(session_id):
            response = await self._invoke_with_recovery(
                messages,
                session_id,
                instructions=instructions,
                client_tool_schemas=client_tool_schemas,
                client_tool_prompts=client_tool_prompts,
                client_tool_names=client_tool_names,
                state_prompts=state_prompts,
                skills_prompt=skills_prompt,
                skills_snapshot=skills_snapshot,
                active_tool_names=active_tool_names,
                is_subagent=is_subagent,
            )

            normalized = self._normalize.normalize_llm_response(response)

            if normalized.tool_calls:
                return LLMResult(
                    type=LLMResultType.TOOL_CALL,
                    tool_calls=[
                        ToolCallInfo(name=tc["name"], args=tc["args"], id=tc["id"])
                        for tc in normalized.tool_calls
                    ],
                    assistant_lc_message=normalized.raw_message,
                    session_id=session_id,
                    usage=normalized.usage,
                )

            self.append_to_history(
                session_id,
                messages,
                normalized.text,
                usage=normalized.usage.model_dump(),
                assistant_lc_message=normalized.raw_message,
            )

            return LLMResult(
                type=LLMResultType.TEXT,
                text=normalized.text,
                session_id=session_id,
                usage=normalized.usage,
                reasoning=normalized.reasoning or None,
            )

    async def stream_messages_with_tools(
        self,
        messages: List[BaseMessage],
        session_id: Optional[str] = None,
        instructions: Optional[str] = None,
        client_tool_schemas: Optional[List[dict]] = None,
        client_tool_prompts: Optional[List[str]] = None,
        client_tool_names: Optional[Set[str]] = None,
        state_prompts: Optional[List[str]] = None,
        skills_prompt: Optional[str] = None,
        skills_snapshot: Any = None,
        active_tool_names: Optional[Set[str]] = None,
    ):
        """Stream LLM response with overflow recovery. Yields AIMessageChunk.

        Unlike process_messages_with_tools, does NOT persist to history.
        Caller must handle history persistence after consuming all chunks.

        Args:
            messages: Input messages for the current request.
            session_id: Session ID for history tracking.
            instructions: Extra instructions for the system prompt.
            client_tool_schemas (Optional[List[dict]]): Client-provided
                OpenAI-format tool schemas. MCP tools are appended
                automatically.
            client_tool_prompts (Optional[List[str]]): Guide texts from
                clients for the system prompt.
            client_tool_names (Optional[Set[str]]): Client-side tool names
                available in this turn.
            state_prompts (Optional[List[str]]): Per-turn runtime state
                prompts from skills.
            skills_snapshot: Full snapshot payload for skill filtering.

        Yields:
            AIMessageChunk: Incremental response chunks.
        """
        session_id = await self._ensure_session(session_id)
        prompt, tools = self._prepare_prompt_and_tools(
            instructions=instructions,
            client_tool_prompts=client_tool_prompts,
            client_tool_schemas=client_tool_schemas,
            client_tool_names=client_tool_names,
            state_prompts=state_prompts,
            skills_prompt=skills_prompt,
            skills_snapshot=skills_snapshot,
            active_tool_names=active_tool_names,
        )
        lc_new = list(messages)
        overflow_retries = 0
        truncation_attempted = False

        await self._maybe_proactive_compact(session_id, messages)

        while True:
            self._ensure_lc_session(session_id)
            lc_messages = [LCSystemMessage(content=prompt)]
            lc_messages.extend(self._sessions.get(session_id, []))
            lc_messages.extend(lc_new)
            lc_messages = self._normalize.strip_tool_call_narration(lc_messages)

            try:
                _t = self._log_pre_llm(
                    stage="stream",
                    session_id=session_id,
                    lc_messages=lc_messages,
                    new_message_count=len(lc_new),
                    tools=tools,
                )
                async for chunk in self._call_llm_stream(lc_messages, tools):
                    yield chunk
                logger.info(
                    "LLM_RESPONSE stage=stream session=%s latency=%.2fs (stream_end)",
                    session_id,
                    time.monotonic() - _t,
                )
                return
            except Exception as e:
                if LLMErrorClassifier.is_context_overflow(e):
                    (
                        _,
                        overflow_retries,
                        recovered,
                        truncation_attempted,
                    ) = await self._try_overflow_recovery(
                        session_id, overflow_retries, truncation_attempted
                    )
                    if recovered:
                        continue
                raise
