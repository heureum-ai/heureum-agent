# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Application configuration using pydantic-settings.
"""

from enum import Enum
from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict


class ApprovalChoice(str, Enum):
    """User approval options for tool execution.

    ``value``    – UI display label sent to the client (e.g. "Allow Once").
    ``decision`` – internal key used in the approval result dict.
    """

    ALLOW_ONCE = "Allow Once"
    ALWAYS_ALLOW = "Always Allow"
    DENY = "Deny"

    @property
    def decision(self) -> str:
        """Snake-case key used internally (e.g. ``"allow_once"``)."""
        return self.name.lower()

    @property
    def description(self) -> str:
        """Short explanation of what this approval choice does."""
        descriptions = {
            "ALLOW_ONCE": "Permit this single tool execution",
            "ALWAYS_ALLOW": "Automatically allow this tool for the rest of the session",
            "DENY": "Reject this tool execution",
        }
        return descriptions[self.name]

    @classmethod
    def options(cls) -> list[dict]:
        """Choice objects with label and description for all choices."""
        return [{"label": choice.value, "description": choice.description} for choice in cls]


class Settings(BaseSettings):
    """Application settings.

    Attributes:
        APP_NAME (str): Display name of the application.
        DEBUG (bool): Whether to enable debug mode.
        OPENAI_API_KEY (str): OpenAI API key for LLM calls.
        CORS_ORIGINS (str): Comma-separated list of allowed CORS origins.
        LANGCHAIN_TRACING_V2 (bool): Whether to enable LangChain tracing.
        LANGCHAIN_API_KEY (str): API key for LangChain/LangSmith.
        PLATFORM_API_URL (str): URL of the MCP server (used for session files, notifications, periodic tasks).
        MCP_SERVER_URLS (str): Comma-separated MCP server URLs for tool discovery.
        AGENT_MODEL (str): Model identifier for the agent LLM.
        AGENT_TEMPERATURE (float): Sampling temperature for the agent.
        AGENT_MAX_TOKENS (int): Maximum token limit for agent responses.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
        extra="ignore",
    )

    APP_NAME: str = "Heureum Agent"
    DEBUG: bool = False
    OPENAI_API_KEY: str = ""

    # Google Gemini
    GOOGLE_API_KEY: str = ""  # Google AI Studio (simple)

    # Google Cloud / Vertex AI (alternative to GOOGLE_API_KEY)
    GOOGLE_CLOUD_PROJECT: str = ""
    GOOGLE_CLOUD_LOCATION: str = ""
    GOOGLE_APPLICATION_CREDENTIALS: str = ""

    CORS_ORIGINS: str = "http://localhost:3000,http://localhost:5173,http://localhost:8001"
    LANGCHAIN_TRACING_V2: bool = False
    LANGCHAIN_API_KEY: str = ""
    PLATFORM_API_URL: str = "http://localhost:8001"
    MCP_SERVER_URLS: str = "http://localhost:3001"
    AGENT_MODEL: str = "gemini-3-flash-preview"
    AGENT_TEMPERATURE: float = 0.7
    AGENT_MAX_TOKENS: int = 32768
    AGENT_THINKING_BUDGET: int = 1024  # Gemini 2.5: thinking token budget (0 = disabled)

    # Agent loop
    MAX_AGENT_ITERATIONS: int = 30  # reduced from 50 to limit token costs
    MAX_CHAIN_DEPTH: int = 10  # max consecutive chain steps without returning to LLM

    # Session
    SESSION_TTL_SECONDS: int = 3600  # 1 hour
    MAX_SESSIONS: int = 1000

    # Context overflow
    MAX_OVERFLOW_RETRIES: int = 3
    CONTEXT_WINDOW_HARD_MIN_TOKENS: int = 16_000

    # LLM retry (transient / retryable errors)
    MAX_LLM_RETRIES: int = 2
    LLM_RETRY_BASE_DELAY: float = 1.0  # seconds, doubles each retry

    # Plan retry (text-only responses while plan has unfinished steps)
    MAX_PLAN_RETRIES: int = 1  # original + 1 retry to prevent sub-agent tree amplification

    # MCP
    TOOL_CACHE_TTL: int = 300  # 5 minutes
    MCP_CONNECT_MAX_RETRIES: int = 2
    MCP_CONNECT_RETRY_DELAY: float = 1.0  # seconds, doubles each retry

    # Tool loop detection
    LOOP_DETECTION_ENABLED: bool = True
    LOOP_DETECTION_HISTORY_SIZE: int = 30
    LOOP_DETECTION_WARNING_THRESHOLD: int = 10
    LOOP_DETECTION_CRITICAL_THRESHOLD: int = 20
    LOOP_DETECTION_CIRCUIT_BREAKER_THRESHOLD: int = 30

    # Model fallback
    MODEL_FALLBACK_PRIMARY: str = ""  # empty → inferred from AGENT_MODEL
    MODEL_FALLBACK_CHAIN: str = ""  # comma-separated "provider/model" specs
    MODEL_FALLBACK_COOLDOWN_BASE_SECONDS: int = 60
    MODEL_FALLBACK_COOLDOWN_MAX_SECONDS: int = 3600
    ANTHROPIC_API_KEY: str = ""

    # Sub-agent
    SUBAGENT_MAX_SPAWN_DEPTH: int = 2
    SUBAGENT_MAX_CHILDREN: int = 5
    SUBAGENT_MAX_TOTAL: int = 15  # global cap per root session
    SUBAGENT_TIMEOUT_SECONDS: int = 300
    SUBAGENT_MAX_ITERATIONS: int = 30
    SUBAGENT_MAX_SKILLS: int = 2  # max skills per sub-agent spawn

    # Subagent context compaction
    SUBAGENT_MAX_HISTORY_SIZE: int = 16
    SUBAGENT_POLL_THROTTLE_THRESHOLD: int = 5
    SUBAGENT_POLL_THROTTLE_DELAY: float = 2.0
    SUBAGENT_STATUS_TASK_MAXLEN: int = 200
    SUBAGENT_STATUS_RESULT_MAXLEN: int = 500

    # Context retention
    CONTEXT_MINIMAL_RETENTION_ENABLED: bool = False

    def get_cors_origins(self) -> List[str]:
        """Parse CORS origins as list.

        Returns:
            List[str]: A list of origin URL strings split from the
                comma-separated CORS_ORIGINS setting.
        """
        return [origin.strip() for origin in self.CORS_ORIGINS.split(",")]

    def get_mcp_server_urls(self) -> List[str]:
        """Parse MCP server URLs as list.

        Returns:
            List[str]: A list of MCP server URLs for tool discovery.
        """
        return [url.strip() for url in self.MCP_SERVER_URLS.split(",") if url.strip()]

    def get_model_fallback_primary(self) -> str:
        """Infer 'provider/model' from AGENT_MODEL if not explicitly set."""
        if self.MODEL_FALLBACK_PRIMARY:
            return self.MODEL_FALLBACK_PRIMARY
        model = self.AGENT_MODEL
        if model.startswith("gemini"):
            return f"google/{model}"
        if model.startswith(("gpt-", "o1", "o3", "o4")):
            return f"openai/{model}"
        if model.startswith("claude"):
            return f"anthropic/{model}"
        return f"openai/{model}"

    def get_model_fallback_chain(self) -> List[str]:
        """Parse MODEL_FALLBACK_CHAIN as comma-separated list."""
        return [s.strip() for s in self.MODEL_FALLBACK_CHAIN.split(",") if s.strip()]


settings = Settings()
