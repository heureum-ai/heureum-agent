# Copyright (c) 2026 Heureum AI. All rights reserved.

"""MCP Server configuration."""
from pydantic import BaseModel
from pydantic_settings import BaseSettings, SettingsConfigDict


class ServerConfig(BaseModel):
    """Per-server configuration.

    Attributes:
        name (str): Unique identifier for the server.
        host (str): Hostname or IP address to bind to.
        port (int): Port number to listen on.
        transport (str): Transport protocol, either "sse" or "streamable-http".
    """

    name: str
    host: str = "0.0.0.0"
    port: int
    transport: str = "streamable-http"


class Settings(BaseSettings):
    """MCP Server settings.

    Attributes:
        SERVERS (dict[str, ServerConfig]): Map of server key to configuration.
        OPENAI_API_KEY (str): API key for OpenAI services.
        OPENAI_SEARCH_MODEL (str): Model name for OpenAI web search.
        WEB_FETCH_MAX_LENGTH (int): Maximum characters returned by web fetch.
        WEB_FETCH_TIMEOUT (float): Timeout in seconds for web fetch requests.
        WEB_FETCH_USER_AGENT (str): User-Agent header for web fetch requests.
        SSRF_PROTECTION_ENABLED (bool): Whether SSRF protection is active.
        CACHE_ENABLED (bool): Whether caching is enabled.
        CACHE_TTL (float): Cache time-to-live in seconds.
        CACHE_MAX_SIZE (int): Maximum number of cache entries.
        CONTENT_WRAPPING_ENABLED (bool): Whether content safety wrapping is active.
        FIRECRAWL_ENABLED (bool): Whether Firecrawl fallback is enabled.
        FIRECRAWL_API_KEY (str): API key for Firecrawl service.
        FIRECRAWL_BASE_URL (str): Base URL for the Firecrawl API.
        FIRECRAWL_TIMEOUT (float): Timeout in seconds for Firecrawl requests.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=True,
    )

    SERVERS: dict[str, ServerConfig] = {
        "web": ServerConfig(name="heureum-web", port=3001),
    }

    OPENAI_API_KEY: str = ""
    OPENAI_SEARCH_MODEL: str = "gpt-4o-mini-search-preview"

    TAVILY_API_KEY: str = ""

    WEB_FETCH_MAX_LENGTH: int = 50000
    WEB_FETCH_TIMEOUT: float = 30.0
    WEB_FETCH_USER_AGENT: str = "HeureumMCP/0.1"

    SSRF_PROTECTION_ENABLED: bool = True

    CACHE_ENABLED: bool = True
    CACHE_TTL: float = 900.0
    CACHE_MAX_SIZE: int = 100

    CONTENT_WRAPPING_ENABLED: bool = True

    FIRECRAWL_ENABLED: bool = False
    FIRECRAWL_API_KEY: str = ""
    FIRECRAWL_BASE_URL: str = "https://api.firecrawl.dev"
    FIRECRAWL_TIMEOUT: float = 30.0


settings = Settings()
