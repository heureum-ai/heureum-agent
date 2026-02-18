# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Heureum Agent - FastAPI + LangChain AI Agent Service
"""

from contextlib import asynccontextmanager
from typing import AsyncGenerator

from app.config import settings
from app.routers import agent
from app.routers.agent import create_response, generate_title
from fastapi import APIRouter, FastAPI
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    """Application lifespan manager.

    Args:
        app (FastAPI): The FastAPI application instance.

    Yields:
        None: Control is yielded to the application between startup
            and shutdown.
    """
    print("Starting Heureum Agent Service...")
    yield
    print("Shutting down Heureum Agent Service...")


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
