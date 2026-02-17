# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Application configuration using pydantic-settings.
"""

from enum import Enum
from typing import List, Set

from pydantic_settings import BaseSettings, SettingsConfigDict


# ---------------------------------------------------------------------------
# Server-side tool sets (Client-Owns-Schema architecture)
#
# Client tools are defined by the client in each request (request.tools).
# Only server-side tools need to be known to the server.
# ---------------------------------------------------------------------------

# Session file tools — executed server-side via Platform API
SESSION_FILE_TOOLS: Set[str] = {
    "read_file",
    "write_file",
    "list_files",
    "delete_file",
}

# Agent-internal tools — executed server-side by the agent itself
AGENT_TOOLS: Set[str] = {"manage_todo", "manage_periodic_task", "notify_user"}


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
        MCP_SERVER_URL (str): URL of the MCP server.
        AGENT_MODEL (str): Model identifier for the agent LLM.
        AGENT_TEMPERATURE (float): Sampling temperature for the agent.
        AGENT_MAX_TOKENS (int): Maximum token limit for agent responses.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
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
    MCP_SERVER_URL: str = "http://localhost:8001"
    AGENT_MODEL: str = "gemini-3-flash-preview"
    AGENT_TEMPERATURE: float = 0.7
    AGENT_MAX_TOKENS: int = 2000

    # Agent loop
    MAX_AGENT_ITERATIONS: int = 50
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

    # MCP
    TOOL_CACHE_TTL: int = 300  # 5 minutes

    def get_cors_origins(self) -> List[str]:
        """Parse CORS origins as list.

        Returns:
            List[str]: A list of origin URL strings split from the
                comma-separated CORS_ORIGINS setting.
        """
        return [origin.strip() for origin in self.CORS_ORIGINS.split(",")]


settings = Settings()
