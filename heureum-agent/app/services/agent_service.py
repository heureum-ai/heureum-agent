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
import json
import logging
import os
import re
import time
import uuid
from collections.abc import MutableMapping
from dataclasses import dataclass, replace
from typing import Any, Dict, List, Optional, Tuple

from app.config import settings
from app.models import AgentResponse, LLMResult, LLMResultType, Message, ToolCallInfo
from app.schemas.open_responses import (
    InputTokenDetails,
    MessageRole,
    OutputTokenDetails,
    Usage,
)
from app.services.compaction import (
    CompactionSettings,
    prune_context_messages,
    truncate_oversized_tool_results,
)
from app.services.compaction.summarizer import compact_history
from app.services.compaction.tokens import estimate_messages_tokens
from app.services.error import LLMErrorClassifier
from app.services.prompts.base import build_system_prompt
from app.services.prompts.compaction import COMPACTION_PREFIX
from app.services.prompts.evaluation import JUDGE_SYSTEM_PROMPT, JUDGE_USER_TEMPLATE
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_openai import ChatOpenAI
from pydantic import SecretStr

logger = logging.getLogger(__name__)

# Browser tools whose results contain page DOM that becomes stale when
# the agent navigates to a new page.  Only the most recent page snapshot
# matters; older ones are replaced with a short summary to save tokens.
_BROWSER_PAGE_TOOLS = frozenset({
    "browser_navigate",
    "browser_click",
    "browser_get_content",
    "browser_new_tab",
})

# Regex to extract the first Page/URL line from a browser tool result.
_PAGE_HEADER_RE = re.compile(
    r'^(?:Page:\s*"(?P<title>[^"]*)")?\s*(?:URL:\s*(?P<url>\S+))?',
    re.MULTILINE,
)


def _extract_page_header(content: str) -> str:
    """Extract a short 'Page: ... URL: ...' summary from browser tool output."""
    m = _PAGE_HEADER_RE.search(content)
    if m and (m.group("title") or m.group("url")):
        title = m.group("title") or ""
        url = m.group("url") or ""
        return f'Page: "{title}" URL: {url}'.strip()
    # Fallback: first line, truncated
    first_line = content.split("\n", 1)[0][:120]
    return first_line


def _is_browser_page_content(content: str) -> bool:
    """Check if content looks like a browser page DOM snapshot."""
    return content.startswith("Page:") or "[Interactive Elements]" in content[:500]


def _invalidate_stale_browser_results(lc_history: list) -> int:
    """Replace older browser page DOM results with short summaries.

    Walks the history backwards.  The most recent ToolMessage containing
    page content is kept intact; all older ones from browser page tools
    are replaced with a one-line summary.

    Returns the number of messages replaced.
    """
    replaced = 0
    seen_latest = False

    for i in range(len(lc_history) - 1, -1, -1):
        msg = lc_history[i]

        if isinstance(msg, ToolMessage):
            content = msg.content or ""
            if _is_browser_page_content(content):
                if not seen_latest:
                    seen_latest = True
                    continue
                # This is an older page snapshot — replace it
                summary = _extract_page_header(content)
                lc_history[i] = ToolMessage(
                    content=f"[Stale page snapshot replaced] {summary}",
                    tool_call_id=getattr(msg, "tool_call_id", "unknown"),
                )
                replaced += 1

        elif isinstance(msg, HumanMessage):
            # Synthetic tool results stored as HumanMessage:
            # "[Tool result: browser_click] Page: ..."
            content = msg.content or ""
            if content.startswith("[Tool result:"):
                # Strip prefix to check the actual tool output
                bracket_end = content.find("]")
                body = content[bracket_end + 1:].lstrip() if bracket_end > 0 else content
                if _is_browser_page_content(body):
                    if not seen_latest:
                        seen_latest = True
                        continue
                    summary = _extract_page_header(body)
                    lc_history[i] = HumanMessage(
                        content=f"[Stale page snapshot replaced] {summary}",
                    )
                    replaced += 1

    return replaced


def create_llm():
    """Create LLM instance based on AGENT_MODEL setting.

    Gemini routing:
      - GOOGLE_API_KEY set → Google AI Studio (simple API key auth)
      - Otherwise → Vertex AI (GCP service account / ADC)
    """
    model = settings.AGENT_MODEL
    if model.startswith("gemini"):
        thinking_budget = settings.AGENT_THINKING_BUDGET or None
        if settings.GOOGLE_API_KEY:
            return ChatGoogleGenerativeAI(
                model=model,
                google_api_key=settings.GOOGLE_API_KEY,
                temperature=settings.AGENT_TEMPERATURE,
                max_output_tokens=settings.AGENT_MAX_TOKENS,
                thinking_budget=thinking_budget,
            )
        # Vertex AI: ensure GOOGLE_APPLICATION_CREDENTIALS is visible to
        # google.auth.default() (pydantic-settings reads .env into its own
        # fields but does NOT export to os.environ).
        if settings.GOOGLE_APPLICATION_CREDENTIALS:
            os.environ.setdefault(
                "GOOGLE_APPLICATION_CREDENTIALS",
                settings.GOOGLE_APPLICATION_CREDENTIALS,
            )
        return ChatGoogleGenerativeAI(
            model=model,
            vertexai=True,
            project=settings.GOOGLE_CLOUD_PROJECT,
            location=settings.GOOGLE_CLOUD_LOCATION,
            temperature=settings.AGENT_TEMPERATURE,
            max_output_tokens=settings.AGENT_MAX_TOKENS,
            thinking_budget=thinking_budget,
        )
    else:
        return ChatOpenAI(
            api_key=SecretStr(settings.OPENAI_API_KEY),
            model=model,
            temperature=settings.AGENT_TEMPERATURE,
            max_completion_tokens=settings.AGENT_MAX_TOKENS,
        )


def _strip_tool_messages(lc_messages: list) -> tuple[list, bool]:
    """Convert tool-related LangChain messages to plain text equivalents.

    Gemini thinking models may reject replayed AIMessage(tool_calls) +
    ToolMessage sequences with "Thought signature is not valid".  This
    helper converts them into plain AI/Human messages so the LLM can
    still see the context without triggering signature validation.
    """
    clean: list = []
    changed = False
    for msg in lc_messages:
        if isinstance(msg, AIMessage) and getattr(msg, "tool_calls", None):
            summary = ", ".join(
                f"{tc['name']}({tc.get('args', {})})" for tc in msg.tool_calls
            )
            clean.append(AIMessage(content=f"[Called: {summary}]"))
            changed = True
        elif isinstance(msg, ToolMessage):
            clean.append(HumanMessage(content=f"[Tool result]: {msg.content}"))
            changed = True
        else:
            clean.append(msg)
    return clean, changed


def _normalize_usage_metadata(usage: Optional[Dict[str, Any]]) -> Optional[Dict[str, int]]:
    """Normalize usage dict to LangChain ``usage_metadata`` shape."""
    if not usage:
        return None
    input_tokens = int(usage.get("input_tokens", 0) or 0)
    output_tokens = int(usage.get("output_tokens", 0) or 0)
    total_tokens = int(usage.get("total_tokens", input_tokens + output_tokens) or 0)
    return {
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
        "total_tokens": total_tokens,
    }


class _SessionMessageView(MutableMapping[str, List[Message]]):
    """Compatibility mapping exposing app ``Message`` histories.

    Internal canonical storage is ``AgentService._lc_sessions`` (LangChain
    messages). This adapter keeps existing call sites/tests that access
    ``service.sessions`` working while avoiding dual-write state.
    """

    def __init__(self, service: "AgentService") -> None:
        self._service = service

    def __getitem__(self, session_id: str) -> List[Message]:
        lc_history = self._service._lc_sessions[session_id]
        return [self._service._to_app_message(m) for m in lc_history]

    def __setitem__(self, session_id: str, history: List[Message]) -> None:
        self._service._lc_sessions[session_id] = [
            self._service._to_lc_message(m) for m in history
        ]

    def __delitem__(self, session_id: str) -> None:
        del self._service._lc_sessions[session_id]

    def __iter__(self):
        return iter(self._service._lc_sessions)

    def __len__(self) -> int:
        return len(self._service._lc_sessions)

    def get(self, session_id: str, default=None):
        if session_id in self._service._lc_sessions:
            return self[session_id]
        return default

    def pop(self, session_id: str, default=None):
        if session_id in self._service._lc_sessions:
            lc_history = self._service._lc_sessions.pop(session_id)
            return [self._service._to_app_message(m) for m in lc_history]
        return default


class AgentService:
    """Service for managing AI agent interactions.

    Prompt architecture (per call):
      [SystemMessage]  <- build_system_prompt() + optional instructions
      [history...]     <- session history (may contain compaction summary)
      [new messages]   <- current request
    """

    def __init__(
        self,
        compaction_settings: Optional[CompactionSettings] = None,
        mcp_tools: Optional[List[Dict[str, Any]]] = None,
        skill_provider: Optional[Any] = None,
    ) -> None:
        """Initialize the AgentService.

        Args:
            compaction_settings (Optional[CompactionSettings]): Configuration
                for the 3-layer compaction pipeline. Uses defaults if None.
            mcp_tools (Optional[List[Dict[str, Any]]]): Pre-discovered MCP
                tool schemas. Typically set later via ``mcp_tools`` attribute.
            skill_provider (Optional[SkillProvider]): Skill registry instance
                for server-side tool schemas and guide prompts.
        """
        self._lc_sessions: dict[str, List[BaseMessage]] = {}
        self.sessions: MutableMapping[str, List[Message]] = _SessionMessageView(self)
        self._session_locks: dict[str, asyncio.Lock] = {}
        self._session_last_access: dict[str, float] = {}
        self.compaction_settings = compaction_settings or CompactionSettings()
        self.mcp_tools = mcp_tools
        self.skill_provider = skill_provider
        self.llm = create_llm()

    def _evict_session(self, session_id: str) -> None:
        """Remove all data associated with a session.

        Args:
            session_id (str): The session to evict.
        """
        self._lc_sessions.pop(session_id, None)
        self._session_locks.pop(session_id, None)
        self._session_last_access.pop(session_id, None)

    def _get_session_lock(self, session_id: str) -> asyncio.Lock:
        """Return the asyncio lock for a session, creating one if needed.

        Args:
            session_id (str): The session identifier.

        Returns:
            asyncio.Lock: The lock associated with the session.
        """
        return self._session_locks.setdefault(session_id, asyncio.Lock())

    def _get_last_input_tokens(self, session_id: str) -> Optional[int]:
        """Read input tokens from the latest assistant LangChain message."""
        for msg in reversed(self._lc_sessions.get(session_id, [])):
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

    async def _rehydrate_session(self, session_id: str) -> Optional[List[BaseMessage]]:
        """Rehydrate a session's message history from the Platform DB.

        Called when a known session_id is not found in the in-memory cache
        (e.g. after server restart or when a request is routed to a different
        instance in a multi-instance deployment).

        Expected flow:
          1. Call Platform API: GET /api/v1/messages/?session_id={session_id}
          2. Convert stored records back into List[BaseMessage]
          3. If a compaction summary exists, use it instead of the full history
             to avoid re-triggering context overflow
          4. Return the rehydrated history (caller populates self.sessions)

        Compaction-aware rehydration (mirrors OpenClaw pattern):
          - OpenClaw stores compaction summaries inline in the transcript and
            tracks ``compactionCount`` in session metadata.
          - Platform DB should store compaction events similarly — when Agent
            compacts a session, the summary should be persisted to Platform
            (via POST /api/v1/compaction-events/) alongside the IDs of
            messages that were summarized.
          - On rehydration, Platform should return the **compacted** view:
            [compaction_summary_msg] + [messages after firstKeptEntryId]
          - If no compaction has occurred, return all messages.

        Args:
            session_id (str): The session to rehydrate from Platform DB.

        Returns:
            Optional[List[BaseMessage]]: The rehydrated message list, or None
                if the session does not exist in the Platform DB.

        TODO:
            - Implement Platform API client (httpx call to platform service)
            - Map Platform Message records to LangChain BaseMessage
            - Handle compaction entries (type="compaction" in Platform DB)
            - Add error handling for Platform unavailability (graceful fallback)
            - Notify Platform after compaction runs (_compact_session) so
              compaction state is persisted and survives Agent restart
        """
        return None

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
        if session_id and session_id in self._lc_sessions:
            self._session_last_access[session_id] = time.time()
            return session_id, self._lc_sessions[session_id]

        # Cache miss — attempt rehydration from Platform DB
        if session_id:
            try:
                rehydrated = await self._rehydrate_session(session_id)
                if rehydrated is not None:
                    self._lc_sessions[session_id] = rehydrated
                    self._session_last_access[session_id] = time.time()
                    logger.info(
                        "Rehydrated session %s (%d messages)", session_id, len(rehydrated),
                    )
                    return session_id, self._lc_sessions[session_id]
            except Exception:
                logger.warning(
                    "Failed to rehydrate session %s, starting fresh", session_id, exc_info=True,
                )

        new_session_id = session_id or str(uuid.uuid4())
        self._lc_sessions[new_session_id] = []
        self._session_last_access[new_session_id] = time.time()
        return new_session_id, self._lc_sessions[new_session_id]

    def _is_session_locked(self, session_id: str) -> bool:
        """Check if a session's lock is currently held (in-use).

        Args:
            session_id (str): The session identifier to check.

        Returns:
            bool: True if the session lock is currently acquired.
        """
        lock = self._session_locks.get(session_id)
        return lock is not None and lock.locked()

    def _cleanup_stale_sessions(self) -> None:
        """Remove sessions older than TTL and evict oldest if over settings.MAX_SESSIONS.

        Safety: never evicts sessions with an active lock (currently in-use).
        """
        now = time.time()
        expired = [
            sid
            for sid, ts in self._session_last_access.items()
            if now - ts > settings.SESSION_TTL_SECONDS and not self._is_session_locked(sid)
        ]
        for sid in expired:
            self._evict_session(sid)
        if expired:
            logger.info("Evicted %d expired session(s)", len(expired))

        if len(self._lc_sessions) > settings.MAX_SESSIONS:
            evictable = [
                (sid, ts)
                for sid, ts in self._session_last_access.items()
                if not self._is_session_locked(sid)
            ]
            evictable.sort(key=lambda item: item[1])
            to_evict = len(self._lc_sessions) - settings.MAX_SESSIONS
            for sid, _ in evictable[:to_evict]:
                self._evict_session(sid)
            logger.info(
                "Evicted %d session(s) over settings.MAX_SESSIONS limit", min(to_evict, len(evictable))
            )

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
        self._cleanup_stale_sessions()
        session_id, _ = await self._get_or_create_session(session_id)
        return session_id

    @staticmethod
    def _to_lc_message(msg: Any) -> BaseMessage:
        """Convert app Message -> LangChain message.

        Args:
            msg (Message): The application-level message to convert.

        Returns:
            BaseMessage: The corresponding LangChain message instance.
        """
        if isinstance(msg, BaseMessage):
            return msg
        if msg.role == MessageRole.USER:
            return HumanMessage(content=msg.content)
        if msg.role == MessageRole.ASSISTANT:
            usage = _normalize_usage_metadata(msg.usage)
            return AIMessage(
                content=msg.content,
                tool_calls=msg.tool_calls or [],
                usage_metadata=usage,  # type: ignore[arg-type]
            )
        if msg.role == MessageRole.SYSTEM:
            return SystemMessage(content=msg.content)
        if msg.role == MessageRole.TOOL:
            return ToolMessage(
                content=msg.content,
                tool_call_id=msg.tool_call_id or "unknown",
            )
        return HumanMessage(content=msg.content)

    @staticmethod
    def _to_app_message(msg: BaseMessage) -> Message:
        """Convert LangChain message -> app Message."""
        if isinstance(msg, HumanMessage):
            text = AgentService._extract_text(msg.content)
            if text.startswith("[Tool result:"):
                close = text.find("]")
                label = text[len("[Tool result:"):close].strip() if close > 0 else None
                body = text[close + 1:].lstrip() if close > 0 else text
                return Message(
                    role=MessageRole.TOOL,
                    content=body,
                    tool_name=label or None,
                )
            return Message(role=MessageRole.USER, content=text)
        if isinstance(msg, AIMessage):
            tc = getattr(msg, "tool_calls", None) or None
            if not tc:
                tc = getattr(msg, "additional_kwargs", {}).get("synthetic_tool_calls")
            usage = getattr(msg, "usage_metadata", None)
            usage_dict = dict(usage) if isinstance(usage, dict) else None
            if usage_dict is None:
                usage_dict = getattr(msg, "additional_kwargs", {}).get("synthetic_usage")
            return Message(
                role=MessageRole.ASSISTANT,
                content=AgentService._extract_text(msg.content),
                tool_calls=tc,
                usage=usage_dict,
            )
        if isinstance(msg, SystemMessage):
            return Message(role=MessageRole.SYSTEM, content=AgentService._extract_text(msg.content))
        if isinstance(msg, ToolMessage):
            return Message(
                role=MessageRole.TOOL,
                content=AgentService._extract_text(msg.content),
                tool_call_id=getattr(msg, "tool_call_id", None),
            )
        return Message(
            role=MessageRole.USER,
            content=AgentService._extract_text(getattr(msg, "content", "")),
        )

    def _ensure_lc_session(self, session_id: str) -> None:
        """Ensure an LC history list exists for a session."""
        if session_id in self._lc_sessions:
            return
        self._lc_sessions[session_id] = []

    @staticmethod
    def _extract_text(content: Any) -> str:
        """Extract plain text from LLM response content.

        Args:
            content (Any): Raw content from an LLM response (str, list, or
                other type).

        Returns:
            str: The concatenated text representation.
        """
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            return " ".join(
                item if isinstance(item, str) else item.get("text", "")
                for item in content
                if isinstance(item, (str, dict))
            )
        return str(content)

    @staticmethod
    def _extract_usage(response) -> Usage:
        """Extract token usage from LLM response.

        Args:
            response: The LLM response (AIMessage).

        Returns:
            Usage: Token usage statistics including cached token details.
        """
        meta = getattr(response, "usage_metadata", None) or {}
        input_details = meta.get("input_token_details") or {}
        output_details = meta.get("output_token_details") or {}
        return Usage(
            input_tokens=meta.get("input_tokens", 0),
            output_tokens=meta.get("output_tokens", 0),
            total_tokens=meta.get("total_tokens", 0),
            input_tokens_details=InputTokenDetails(
                cached_tokens=input_details.get("cache_read", 0),
            ),
            output_tokens_details=OutputTokenDetails(
                reasoning_tokens=output_details.get("reasoning", 0),
            ),
        )

    @staticmethod
    def _preview_text(content: Any, limit: int = 220) -> str:
        """Render message content as a short single-line preview."""
        text = AgentService._extract_text(content).replace("\n", "\\n")
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

            if isinstance(msg, SystemMessage):
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

    def _log_pre_llm_history(
        self,
        *,
        stage: str,
        session_id: str,
        lc_messages: list[BaseMessage],
        tools: list,
    ) -> None:
        """Log message history right before each LLM invocation."""
        try:
            payload = self._serialize_lc_history_for_log(lc_messages)
            logger.warning(
                "LLM_PRECALL_HISTORY stage=%s session=%s tool_schema_count=%d message_count=%d payload=%s",
                stage,
                session_id,
                len(tools),
                len(lc_messages),
                payload,
            )
        except Exception:
            logger.warning(
                "LLM_PRECALL_HISTORY stage=%s session=%s failed to serialize",
                stage,
                session_id,
                exc_info=True,
            )

    def _prepare_prompt_and_tools(
        self,
        instructions: Optional[str] = None,
        client_tool_prompts: Optional[List[str]] = None,
        client_tool_schemas: Optional[List[dict]] = None,
        state_prompts: Optional[List[str]] = None,
    ) -> tuple:
        """Build system prompt and resolve tool schemas together.

        Centralises prompt and tool-binding decisions so that future
        dynamic-prompting logic (e.g. tool filtering, conditional guides)
        can live in one place.

        Args:
            instructions (Optional[str]): Extra instructions to append
                inside an ``<instructions>`` XML block.
            client_tool_prompts (Optional[List[str]]): Guide texts from
                clients for inclusion in the system prompt.
            client_tool_schemas (Optional[List[dict]]): Client-provided
                OpenAI-format tool schemas.
            state_prompts (Optional[List[str]]): Per-turn runtime state
                prompts from skills (wrapped inside ``<session_state>``).

        Returns:
            tuple[str, list]: (system_prompt, tool_schemas_for_bind_tools).
        """
        # Build the set of client-provided tool names for skill filtering
        client_tool_names: set[str] = set()
        for s in client_tool_schemas or []:
            func = s.get("function")
            if isinstance(func, dict) and "name" in func:
                client_tool_names.add(func["name"])
        if self.mcp_tools:
            for s in self.mcp_tools:
                func = s.get("function")
                if isinstance(func, dict) and "name" in func:
                    client_tool_names.add(func["name"])

        if self.skill_provider:
            server_tool_prompts = self.skill_provider.get_active_guide_prompts(client_tool_names)
            server_tool_schemas = self.skill_provider.get_active_tool_schemas(client_tool_names)
        else:
            server_tool_prompts = []
            server_tool_schemas = []

        prompt = build_system_prompt(
            server_tool_prompts=server_tool_prompts,
            client_tool_prompts=client_tool_prompts,
            instructions=instructions,
            state_prompts=state_prompts,
        )

        tools = list(client_tool_schemas or [])
        tools.extend(server_tool_schemas)
        if self.mcp_tools:
            tools.extend(self.mcp_tools)

        return prompt, tools

    def _build_lc_messages(
        self,
        history: List[Message],
        new_messages: List[Message],
        instructions: Optional[str] = None,
        client_tool_prompts: Optional[List[str]] = None,
        state_prompts: Optional[List[str]] = None,
    ) -> list:
        """Build LangChain message list: [system] + [history] + [new].

        The system prompt is never stored in history -- always rebuilt fresh
        so tool availability and instructions stay current.

        Args:
            history (List[Message]): Previously stored session messages.
            new_messages (List[Message]): Messages from the current request.
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
        lc_messages = [SystemMessage(content=prompt)]
        lc_messages.extend(self._to_lc_message(msg) for msg in history)
        lc_messages.extend(self._to_lc_message(msg) for msg in new_messages)
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

    async def _compact_session(self, session_id: str) -> List[Message]:
        """Run 3-layer compaction on a session and persist the result.

        truncation -> pruning -> LLM summarization

        Preserves original LangChain messages for the kept tail to retain
        provider metadata (e.g. Gemini thought signatures).

        Args:
            session_id (str): The session whose history should be compacted.

        Returns:
            List[Message]: The compacted history (also saved to
                ``self.sessions``).
        """
        history = self.get_history(session_id)
        original_lc = list(self._lc_sessions.get(session_id, []))
        s = self.compaction_settings

        history, truncated = truncate_oversized_tool_results(history, s)
        if truncated:
            logger.info("Layer 1: truncated %d tool result(s)", truncated)

        history = prune_context_messages(history, s)
        history = await compact_history(history, self.llm, s)

        # Rebuild LC messages, reusing originals for the kept tail to
        # preserve provider metadata (Gemini thought signatures, etc.).
        # The compacted history starts with a [compaction] summary system
        # message, followed by the kept tail from the original history.
        lc_result: List[BaseMessage] = []
        original_len = len(original_lc)
        kept_tail_len = 0
        for msg in history:
            if msg.role == MessageRole.SYSTEM and msg.content.startswith(COMPACTION_PREFIX):
                lc_result.append(self._to_lc_message(msg))
            else:
                kept_tail_len += 1

        # The kept tail is the last N messages from the original LC history.
        if kept_tail_len > 0 and kept_tail_len <= original_len:
            lc_result.extend(original_lc[original_len - kept_tail_len:])
        else:
            # Fallback: convert all non-summary messages
            for msg in history:
                if not (msg.role == MessageRole.SYSTEM and msg.content.startswith(COMPACTION_PREFIX)):
                    lc_result.append(self._to_lc_message(msg))

        self._lc_sessions[session_id] = lc_result
        return history

    async def _try_overflow_recovery(
        self,
        session_id: str,
        overflow_retries: int,
        truncation_attempted: bool = False,
    ) -> Tuple[List[Message], int, bool, bool]:
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
            Tuple[List[Message], int, bool, bool]: A tuple of
                (recovered_history, updated_overflow_retries, succeeded,
                truncation_attempted).
        """
        if overflow_retries < settings.MAX_OVERFLOW_RETRIES:
            logger.warning(
                "Context overflow (attempt %d/%d), compacting...",
                overflow_retries + 1,
                settings.MAX_OVERFLOW_RETRIES,
            )
            before_tokens = estimate_messages_tokens(
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
            after_tokens = estimate_messages_tokens(history)
            if after_tokens >= before_tokens:
                logger.warning(
                    "Compaction did not reduce size (%d → %d tokens), "
                    "skipping to truncation fallback",
                    before_tokens,
                    after_tokens,
                )
                return history, settings.MAX_OVERFLOW_RETRIES, True, truncation_attempted
            return history, overflow_retries + 1, True, truncation_attempted

        if truncation_attempted:
            logger.error("Truncation already attempted once; giving up")
            return self.get_history(session_id), overflow_retries, False, True

        history = self.get_history(session_id)
        # 1/4 of normal thresholds to truncate further than Layer 1
        aggressive_settings = replace(
            self.compaction_settings,
            max_tool_result_context_share=self.compaction_settings.max_tool_result_context_share
            / 4,
            hard_max_tool_result_chars=min(
                self.compaction_settings.hard_max_tool_result_chars // 4,
                50_000,
            ),
        )
        history, truncated = truncate_oversized_tool_results(
            history,
            aggressive_settings,
        )
        self._lc_sessions[session_id] = [self._to_lc_message(m) for m in history]
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
        new_messages: List[Message],
    ) -> None:
        """Compact the session proactively if context usage ratio is high.

        Uses actual ``input_tokens`` from the last assistant message in
        history when available (post-turn check). Falls back to tiktoken
        estimation on the first call when no usage data exists yet.

        Args:
            session_id (str): The session to check.
            new_messages (List[Message]): Pending messages for the next call.
        """
        ctx_tokens = self.compaction_settings.context_window_tokens
        last_tokens = self._get_last_input_tokens(session_id)
        if last_tokens is not None:
            ratio = last_tokens / ctx_tokens if ctx_tokens > 0 else 0.0
        else:
            session_history = self.get_history(session_id)
            est_tokens = estimate_messages_tokens(session_history + new_messages)
            ratio = est_tokens / ctx_tokens if ctx_tokens > 0 else 0.0
        if ratio >= self.compaction_settings.proactive_pruning_ratio:
            logger.info(
                "Proactive pruning triggered (ratio %.2f >= %.2f)",
                ratio,
                self.compaction_settings.proactive_pruning_ratio,
            )
            await self._compact_session(session_id)

    async def _invoke_with_recovery(
        self,
        new_messages: List[Message],
        session_id: str,
        instructions: Optional[str] = None,
        client_tool_schemas: Optional[List[dict]] = None,
        client_tool_prompts: Optional[List[str]] = None,
        state_prompts: Optional[List[str]] = None,
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
            state_prompts (Optional[List[str]]): Per-turn runtime state
                prompts from skills.

        Returns:
            AIMessage: The successful LLM response.

        Raises:
            ValueError: If the context window is below the hard minimum.
            Exception: Re-raised if the error is not a context overflow or
                recovery is exhausted.
        """
        ctx_tokens = self.compaction_settings.context_window_tokens
        if ctx_tokens < settings.CONTEXT_WINDOW_HARD_MIN_TOKENS:
            raise ValueError(
                f"Context window too small: {ctx_tokens} tokens "
                f"(minimum {settings.CONTEXT_WINDOW_HARD_MIN_TOKENS})"
            )

        prompt, tools = self._prepare_prompt_and_tools(
            instructions=instructions,
            client_tool_prompts=client_tool_prompts,
            client_tool_schemas=client_tool_schemas,
            state_prompts=state_prompts,
        )
        lc_new_messages = [self._to_lc_message(msg) for msg in new_messages]
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
            lc_messages = [SystemMessage(content=prompt)]
            lc_messages.extend(self._lc_sessions.get(session_id, []))
            lc_messages.extend(lc_new_messages)
            try:
                self._log_pre_llm_history(
                    stage="primary",
                    session_id=session_id,
                    lc_messages=lc_messages,
                    tools=tools,
                )
                return await self._call_llm(lc_messages, tools)
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

                if LLMErrorClassifier.is_retryable(e) and not LLMErrorClassifier.is_thought_signature(e) and llm_retries < settings.MAX_LLM_RETRIES:
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
                        "LLM call failed with tools bound; retrying without tools: %s", e,
                    )
                    try:
                        self._log_pre_llm_history(
                            stage="fallback_no_tools",
                            session_id=session_id,
                            lc_messages=lc_messages,
                            tools=[],
                        )
                        return await self._call_llm(lc_messages, [])
                    except Exception as fallback_err:
                        logger.warning("No-tools fallback also failed: %s", fallback_err)

                # Fallback 2: strip tool messages from history to avoid
                # Gemini "Thought signature" issues caused by replaying
                # AIMessage(tool_calls) + ToolMessage sequences.
                clean, changed = _strip_tool_messages(lc_messages)
                if changed:
                    logger.warning("Retrying with tool messages stripped from history")
                    try:
                        self._log_pre_llm_history(
                            stage="fallback_stripped_tool_messages",
                            session_id=session_id,
                            lc_messages=clean,
                            tools=[],
                        )
                        return await self._call_llm(clean, [])
                    except Exception as clean_err:
                        logger.warning("Clean-context fallback also failed: %s", clean_err)

                raise

    def _append_to_history(
        self,
        session_id: str,
        messages: List[Message],
        response_text: str,
        usage: Optional[Dict[str, Any]] = None,
        assistant_lc_message: Optional[BaseMessage] = None,
    ) -> None:
        """Persist user messages + assistant response to session history.

        Args:
            session_id (str): The target session.
            messages (List[Message]): User/tool messages to append.
            response_text (str): The assistant's text response to append.
            usage (Optional[Dict[str, Any]]): Token usage for this LLM call.
        """
        self._ensure_lc_session(session_id)
        lc_history = self._lc_sessions[session_id]
        lc_history.extend(self._to_lc_message(msg) for msg in messages)
        if assistant_lc_message is not None:
            lc_history.append(assistant_lc_message)
            return
        usage_metadata = usage or None
        usage_metadata = _normalize_usage_metadata(usage)
        lc_history.append(
            AIMessage(
                content=response_text,
                usage_metadata=usage_metadata,  # type: ignore[arg-type]
            )
        )

    def get_history(self, session_id: str) -> List[Message]:
        """Return app-level view of session history (empty list if not found)."""
        return [self._to_app_message(m) for m in self._lc_sessions.get(session_id, [])]

    async def append_tool_interaction(
        self,
        session_id: str,
        messages: List[Message],
        tool_calls: List[Dict[str, Any]],
        tool_results: List[Message],
        usage: Optional[Dict[str, Any]] = None,
        assistant_lc_message: Optional[BaseMessage] = None,
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
            messages (List[Message]): User messages preceding the tool calls.
            tool_calls (List[Dict[str, Any]]): Tool call dicts from the LLM
                response (each with ``name``, ``args``, ``id``).
            tool_results (List[Message]): Tool result messages to append.
            usage (Optional[Dict[str, Any]]): Token usage for this LLM call.
            assistant_lc_message (Optional[BaseMessage]): The original LLM
                AIMessage.  When provided, stored as-is to preserve provider
                metadata (e.g. Gemini thought signatures).
        """
        async with self._get_session_lock(session_id):
            self._ensure_lc_session(session_id)
            lc_history = self._lc_sessions[session_id]
            # Prevent eviction during long-running agentic loops
            self._session_last_access[session_id] = time.time()

            # Check if any new tool result contains a fresh page snapshot.
            has_new_page = any(
                _is_browser_page_content(tr.content)
                for tr in tool_results
                if tr.tool_name in _BROWSER_PAGE_TOOLS or _is_browser_page_content(tr.content)
            )

            lc_history.extend(self._to_lc_message(msg) for msg in messages)
            if assistant_lc_message is not None:
                lc_history.append(assistant_lc_message)
                lc_history.extend(self._to_lc_message(msg) for msg in tool_results)
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
                            "synthetic_usage": _normalize_usage_metadata(usage),
                        },
                    )
                )
                for tr in tool_results:
                    lc_history.append(
                        ToolMessage(
                            content=tr.content,
                            tool_call_id=tr.tool_call_id or "synthetic",
                        )
                    )

            # Invalidate stale browser page snapshots now that the new
            # results (including the latest page) are in history.
            if has_new_page:
                n = _invalidate_stale_browser_results(lc_history)
                if n:
                    logger.info("Invalidated %d stale browser page snapshot(s)", n)

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
        lc_history = self._lc_sessions.get(session_id, [])
        for i, h in enumerate(lc_history):
            if isinstance(h, ToolMessage) and getattr(h, "tool_call_id", None) == tool_call_id:
                lc_history[i] = ToolMessage(content=output, tool_call_id=tool_call_id)
                matched = True
                break
        return matched

    async def process_messages(
        self,
        messages: List[Message],
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
            response_text = self._extract_text(response.content)
            usage = self._extract_usage(response)
            self._append_to_history(
                session_id,
                messages,
                response_text,
                usage=usage.model_dump(),
                assistant_lc_message=response,
            )

        return AgentResponse(message=response_text, session_id=session_id, usage=usage)

    async def process_messages_with_tools(
        self,
        messages: List[Message],
        session_id: Optional[str] = None,
        instructions: Optional[str] = None,
        client_tool_schemas: Optional[List[dict]] = None,
        client_tool_prompts: Optional[List[str]] = None,
        state_prompts: Optional[List[str]] = None,
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
            state_prompts (Optional[List[str]]): Per-turn runtime state
                prompts from skills.

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
                state_prompts=state_prompts,
            )

            usage = self._extract_usage(response)

            if response.tool_calls:
                return LLMResult(
                    type=LLMResultType.TOOL_CALL,
                    tool_calls=[
                        ToolCallInfo(name=tc["name"], args=tc["args"], id=tc["id"])
                        for tc in response.tool_calls
                    ],
                    assistant_lc_message=response,
                    session_id=session_id,
                    usage=usage,
                )

            response_text = self._extract_text(response.content)
            self._append_to_history(
                session_id,
                messages,
                response_text,
                usage=usage.model_dump(),
                assistant_lc_message=response,
            )

            return LLMResult(
                type=LLMResultType.TEXT,
                text=response_text,
                session_id=session_id,
                usage=usage,
            )

    async def stream_messages_with_tools(
        self,
        messages: List[Message],
        session_id: Optional[str] = None,
        instructions: Optional[str] = None,
        client_tool_schemas: Optional[List[dict]] = None,
        client_tool_prompts: Optional[List[str]] = None,
        state_prompts: Optional[List[str]] = None,
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
            state_prompts (Optional[List[str]]): Per-turn runtime state
                prompts from skills.

        Yields:
            AIMessageChunk: Incremental response chunks.
        """
        session_id = await self._ensure_session(session_id)
        prompt, tools = self._prepare_prompt_and_tools(
            instructions=instructions,
            client_tool_prompts=client_tool_prompts,
            client_tool_schemas=client_tool_schemas,
            state_prompts=state_prompts,
        )
        lc_new = [self._to_lc_message(msg) for msg in messages]
        overflow_retries = 0
        truncation_attempted = False

        await self._maybe_proactive_compact(session_id, messages)

        while True:
            self._ensure_lc_session(session_id)
            lc_messages = [SystemMessage(content=prompt)]
            lc_messages.extend(self._lc_sessions.get(session_id, []))
            lc_messages.extend(lc_new)

            try:
                self._log_pre_llm_history(
                    stage="stream_primary",
                    session_id=session_id,
                    lc_messages=lc_messages,
                    tools=tools,
                )
                async for chunk in self._call_llm_stream(lc_messages, tools):
                    yield chunk
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


# ---------------------------------------------------------------------------
# LLM-as-judge response quality evaluation
# ---------------------------------------------------------------------------


@dataclass
class JudgeResult:
    """Result of the LLM-as-judge evaluation."""

    passed: bool
    guidance: Optional[str] = None


def build_tool_context(output_items: list, limit: int = 10) -> str:
    """Build a tool execution summary string from output_items.

    Pairs FunctionToolCall with FunctionToolResult to show tool name,
    arguments summary, and success/failure status.
    """
    from app.schemas.open_responses import FunctionToolCall, FunctionToolResult

    call_info: dict[str, tuple[str, str]] = {}
    result_info: dict[str, str] = {}

    for item in output_items:
        if isinstance(item, FunctionToolCall) and item.call_id:
            args_str = item.arguments if isinstance(item.arguments, str) else json.dumps(item.arguments)
            if len(args_str) > 80:
                args_str = args_str[:77] + "..."
            call_info[item.call_id] = (item.name, args_str)
        elif isinstance(item, FunctionToolResult) and item.call_id:
            result_info[item.call_id] = item.output or ""

    if not call_info:
        return "(no tools used)"

    lines = ["Tools used:"]
    entries = list(call_info.items())[-limit:]
    for i, (call_id, (name, args_summary)) in enumerate(entries, 1):
        output = result_info.get(call_id, "")
        failed = (
            "Error executing tool '" in output
            or "[EMPTY_RESULT]" in output
            or output.startswith("Error:")
        )
        status = "FAILED: " + output[:100] if failed else "ok"
        lines.append(f"{i}. {name}({args_summary}) -> {status}")

    return "\n".join(lines)


async def judge_response(
    llm,
    user_query: str,
    response_text: str,
    tool_context: str,
) -> JudgeResult:
    """Evaluate response quality using LLM-as-judge."""
    prompt_text = JUDGE_USER_TEMPLATE.format(
        user_query=user_query,
        tool_context=tool_context,
        response_text=response_text,
    )

    messages = [
        SystemMessage(content=JUDGE_SYSTEM_PROMPT),
        HumanMessage(content=prompt_text),
    ]

    try:
        response = await llm.ainvoke(messages)
        return _parse_judge_response(response)
    except Exception:
        logger.warning("Judge LLM call failed, passing by default", exc_info=True)
        return JudgeResult(passed=True)


def _parse_judge_response(response) -> JudgeResult:
    """Parse the judge LLM response into a JudgeResult.

    Falls back to passed=True on any parse error (safe default).
    """
    content = response.content if hasattr(response, "content") else str(response)
    if not content or not content.strip():
        return JudgeResult(passed=True)

    try:
        data = json.loads(content.strip())
        passed = bool(data.get("pass", True))
        guidance = data.get("guidance")
        if guidance and isinstance(guidance, str) and guidance.lower() == "null":
            guidance = None
        return JudgeResult(passed=passed, guidance=guidance)
    except (json.JSONDecodeError, AttributeError, TypeError):
        logger.warning("Judge response parse failed, passing by default: %s", content[:200])
        return JudgeResult(passed=True)
