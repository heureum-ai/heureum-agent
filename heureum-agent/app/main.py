# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Heureum Agent - FastAPI + LangChain AI Agent Service
"""

import asyncio
import logging
import signal
import sys
from contextlib import asynccontextmanager
from typing import AsyncGenerator, Set

from app.config import settings
from app.routers import agent
from app.routers.agent import (
    create_response,
    generate_title,
    subagent_status,
)
from app.services.agent_loop import (
    agent_service,
    mcp_client,
    persist_controller,
)
from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

logging.basicConfig(
    level=logging.INFO,
    format="%(levelname)s %(name)s: %(message)s",
)
# Silence noisy third-party loggers
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("httpcore").setLevel(logging.WARNING)
logging.getLogger("hpack").setLevel(logging.WARNING)

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Graceful shutdown
# ---------------------------------------------------------------------------


class GracefulShutdown:
    """Manages graceful shutdown with active task draining."""

    def __init__(self) -> None:
        self.shutting_down: bool = False
        self.active_tasks: Set[asyncio.Task] = set()
        self._signal_count: int = 0

    def register(self) -> None:
        """Register signal handlers for SIGTERM/SIGINT."""
        loop = asyncio.get_event_loop()
        for sig in (signal.SIGTERM, signal.SIGINT):
            try:
                loop.add_signal_handler(sig, lambda s=sig: self._on_signal(s))
            except NotImplementedError:
                # Windows doesn't support add_signal_handler
                pass

    def _on_signal(self, sig: signal.Signals) -> None:
        """Handle shutdown signal."""
        self._signal_count += 1
        if self._signal_count == 1:
            logger.info("Received %s, starting graceful shutdown...", sig.name)
            self.shutting_down = True
            asyncio.ensure_future(self._drain())
        else:
            logger.warning("Received %s again, forcing exit.", sig.name)
            sys.exit(1)

    async def _drain(self, timeout: float = 30.0) -> None:
        """Wait for active tasks to complete, then cancel remaining."""
        if self.active_tasks:
            logger.info("Draining %d active task(s)...", len(self.active_tasks))
            done, pending = await asyncio.wait(self.active_tasks, timeout=timeout)
            for task in pending:
                task.cancel()
                try:
                    await task
                except (asyncio.CancelledError, Exception):
                    pass
            logger.info(
                "Drain complete: %d finished, %d cancelled",
                len(done),
                len(pending),
            )

    def track(self, task: asyncio.Task) -> None:
        """Track an active task for graceful shutdown."""
        self.active_tasks.add(task)
        task.add_done_callback(self.active_tasks.discard)


shutdown = GracefulShutdown()


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------


async def _on_shutdown() -> None:
    """Cleanup on application shutdown."""
    try:
        await agent_service.aclose()
        await mcp_client.close()
        if persist_controller:
            await persist_controller.close()
    except Exception:
        logger.warning("Error during shutdown cleanup", exc_info=True)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan manager."""
    logger.info("Starting Heureum Agent Service...")
    shutdown.register()
    # Sweep stale subagent runs from previous instance
    if persist_controller:
        swept = await persist_controller.sweep_stale_runs()
        if swept:
            logger.info("Swept %d stale subagent run(s) from DB", swept)
    yield
    logger.info("Shutting down Heureum Agent Service...")
    await _on_shutdown()


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Heureum Agent",
    description="AI Agent Service with FastAPI and LangChain",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.get_cors_origins(),
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(agent.router, prefix="/api/v1/agent", tags=["agent"])

open_responses_router = APIRouter()
open_responses_router.add_api_route(
    "/responses",
    create_response,
    methods=["POST"],
    response_model=None,
    tags=["open-responses"],
)
open_responses_router.add_api_route(
    "/title",
    generate_title,
    methods=["POST"],
    tags=["open-responses"],
)
open_responses_router.add_api_route(
    "/subagent/status/{session_id}",
    subagent_status,
    methods=["GET"],
    tags=["open-responses"],
)
app.include_router(open_responses_router, prefix="/v1")


class HealthResponse(BaseModel):
    """Health check response model.

    Attributes:
        status (str): Current service health status.
        version (str): Application version string.
    """

    status: str
    version: str


@app.get("/health", response_model=HealthResponse)
async def health_check() -> HealthResponse:
    """Health check endpoint.

    Returns:
        HealthResponse: Current service status and version.
    """
    return HealthResponse(status="healthy", version="0.1.0")


@app.get("/")
async def root() -> dict[str, str]:
    """Root endpoint.

    Returns:
        dict[str, str]: A mapping containing a welcome message and links
            to documentation and health endpoints.
    """
    return {
        "message": "Heureum Agent Service",
        "docs": "/docs",
        "health": "/health",
    }
