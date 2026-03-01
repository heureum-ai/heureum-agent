# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Agent service — session management and LLM helpers for v2 agentic loop.

Provides:
  1. Session management (get/remove/cleanup)
  2. Title generation via LLM
  3. Response/history helpers (facades over MessageController)
  4. Direct LLM access (self.llm) for classify_request and generate_title
"""

import logging
import time
import uuid
from typing import Any, Dict, List, Optional

from app.config import settings
from app.schemas.open_responses import Usage
from app.services.messages import MessageController
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


def _create_agent_llm() -> Any:
    """Create a LangChain LLM instance from application settings."""
    model = settings.AGENT_MODEL
    if model.startswith("gemini"):
        from langchain_google_genai import ChatGoogleGenerativeAI
        import os

        thinking_budget = settings.AGENT_THINKING_BUDGET or None
        include_thoughts = True if thinking_budget else None
        if settings.GOOGLE_API_KEY:
            return ChatGoogleGenerativeAI(
                model=model,
                google_api_key=settings.GOOGLE_API_KEY,
                temperature=settings.AGENT_TEMPERATURE,
                max_output_tokens=settings.AGENT_MAX_TOKENS,
                thinking_budget=thinking_budget,
                include_thoughts=include_thoughts,
            )
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
            include_thoughts=include_thoughts,
        )
    else:
        from langchain_openai import ChatOpenAI
        from pydantic import SecretStr

        return ChatOpenAI(
            api_key=SecretStr(settings.OPENAI_API_KEY),
            model=model,
            temperature=settings.AGENT_TEMPERATURE,
            max_completion_tokens=settings.AGENT_MAX_TOKENS,
        )


class AgentService:
    """Service for managing AI agent sessions and providing LLM helpers.

    Provides session management, title generation, and response helpers
    for the v2 DeepAgents-based agentic loop.
    """

    def __init__(
        self,
        mcp_tools: Optional[List[Dict[str, Any]]] = None,
        skill_provider: Optional[Any] = None,
        message_controller: MessageController | None = None,
    ) -> None:
        self.message_controller = message_controller or MessageController()
        self.sessions = self.message_controller.session_state_controller.sessions
        self.mcp_tool_controller = MCPToolController(mcp_tools)
        self.skill_provider: SkillController | None = skill_provider
        self.llm = _create_agent_llm()

        self._platform_message_history_client = (
            self.message_controller.create_platform_message_history_client(
                settings.PLATFORM_API_URL
            )
        )

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
        """Extract plain text from message content (str, list, or LangChain message)."""
        return self._normalize.extract_lc_text(content)

    def remove_session(self, session_id: str) -> bool:
        """Remove all data associated with a session."""
        existed = session_id in self._sessions
        self.message_controller.session_state_controller.remove_session(session_id)
        return existed

    def _get_session_lock(self, session_id: str):
        """Return the asyncio lock for a session."""
        return self.message_controller.session_state_controller.get_session_lock(session_id)

    async def generate_title(self, conversation: str) -> str:
        """Generate a short title for a conversation using the LLM."""
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
        """Retrieve an existing session, rehydrate from Platform DB, or create new."""
        if session_id and session_id in self._sessions:
            self.message_controller.session_state_controller.last_access[session_id] = time.time()
            return session_id, self._sessions[session_id]

        if session_id:
            try:
                rehydrated = (
                    await self.message_controller.message_rehydration_controller.rehydrate_session(
                        client=self._platform_message_history_client,
                        session_id=session_id,
                    )
                )
                if rehydrated is not None:
                    if settings.CONTEXT_MINIMAL_RETENTION_ENABLED:
                        rehydrated, _ = self._normalize.strip_tool_messages(rehydrated)
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
        """Check if a session's lock is currently held."""
        return self.message_controller.session_state_controller.is_session_locked(session_id)

    def cleanup_stale_sessions(self) -> tuple[int, int]:
        """Remove sessions older than TTL and evict oldest if over settings.MAX_SESSIONS."""
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

    def _ensure_lc_session(self, session_id: str) -> None:
        """Ensure an LC history list exists for a session."""
        self.message_controller.session_state_controller.ensure_session(session_id)

    def get_history(self, session_id: str) -> List[BaseMessage]:
        """Return session history (empty list if not found)."""
        return list(self._sessions.get(session_id, []))


# Module-level singleton for direct import by routers and other modules
agent_service = AgentService()
