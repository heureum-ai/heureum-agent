# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Middleware package — universal before/after interceptor system."""

from app.services.middleware.bridge import ToolHookBridgeMiddleware
from app.services.middleware.messages import MessageRegistry, MessageTemplate
from app.services.middleware.runner import MiddlewareBlocked, MiddlewareRunner
from app.services.middleware.types import (
    BeforeResult,
    CompactionEvent,
    Domain,
    MCPCallEvent,
    MCPDiscoverEvent,
    MessageInjectEvent,
    Middleware,
    MiddlewareContext,
    MiddlewareEvent,
    PromptBuildEvent,
    SkillExecuteEvent,
    ToolCallEvent,
)

__all__ = [
    "BeforeResult",
    "CompactionEvent",
    "Domain",
    "MCPCallEvent",
    "MCPDiscoverEvent",
    "MessageInjectEvent",
    "MessageRegistry",
    "MessageTemplate",
    "Middleware",
    "MiddlewareBlocked",
    "MiddlewareContext",
    "MiddlewareEvent",
    "MiddlewareRunner",
    "PromptBuildEvent",
    "SkillExecuteEvent",
    "ToolCallEvent",
    "ToolHookBridgeMiddleware",
]
