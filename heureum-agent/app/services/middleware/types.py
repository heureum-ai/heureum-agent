# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Middleware types — ABC, domain events, and result dataclasses."""

from __future__ import annotations

import abc
import enum
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


@dataclass
class MiddlewareContext:
    """Shared context passed through the middleware chain."""

    session_id: str = ""
    extras: Dict[str, Any] = field(default_factory=dict)


class Domain(str, enum.Enum):
    """Intercept domains for the middleware system."""

    TOOL = "tool"
    PROMPT = "prompt"
    SKILL = "skill"
    MCP = "mcp"
    COMPACTION = "compaction"
    MESSAGE = "message"
    SUBAGENT = "subagent"


@dataclass
class MiddlewareEvent:
    """Base event for all middleware intercepts."""

    domain: Domain
    method: str
    context: MiddlewareContext


@dataclass
class BeforeResult:
    """Result returned by ``Middleware.before``.

    * ``blocked=True`` — short-circuits execution, returning ``reason``.
    * ``modified_args`` — dict of overridden keyword arguments (last writer wins).
    """

    blocked: bool = False
    reason: str = ""
    modified_args: Optional[Dict[str, Any]] = None


# --- Domain Events ---


@dataclass
class ToolCallEvent(MiddlewareEvent):
    """Event for tool execution (domain=TOOL, method="execute_tool")."""

    tool_name: str = ""
    params: Dict[str, Any] = field(default_factory=dict)
    result: Optional[str] = None  # after only
    error: Optional[str] = None  # after only

    def __init__(self, **kwargs: Any) -> None:
        kwargs.setdefault("domain", Domain.TOOL)
        kwargs.setdefault("method", "execute_tool")
        # Pop subclass-specific fields before passing to super
        self.tool_name = kwargs.pop("tool_name", "")
        self.params = kwargs.pop("params", {})
        self.result = kwargs.pop("result", None)
        self.error = kwargs.pop("error", None)
        super().__init__(**kwargs)


@dataclass
class PromptBuildEvent(MiddlewareEvent):
    """Event for prompt preparation (domain=PROMPT, method="prepare_prompt_and_tools")."""

    instructions: Optional[str] = None
    client_tool_prompts: Optional[List[str]] = None
    client_tool_schemas: Optional[List[dict]] = None
    state_prompts: Optional[List[str]] = None
    skills_prompt: Optional[str] = None
    prompt: Optional[str] = None  # after only
    tools: Optional[list] = None  # after only

    def __init__(self, **kwargs: Any) -> None:
        kwargs.setdefault("domain", Domain.PROMPT)
        kwargs.setdefault("method", "prepare_prompt_and_tools")
        self.instructions = kwargs.pop("instructions", None)
        self.client_tool_prompts = kwargs.pop("client_tool_prompts", None)
        self.client_tool_schemas = kwargs.pop("client_tool_schemas", None)
        self.state_prompts = kwargs.pop("state_prompts", None)
        self.skills_prompt = kwargs.pop("skills_prompt", None)
        self.prompt = kwargs.pop("prompt", None)
        self.tools = kwargs.pop("tools", None)
        super().__init__(**kwargs)


@dataclass
class SkillExecuteEvent(MiddlewareEvent):
    """Event for skill execution (domain=SKILL, method="execute_tool")."""

    tool_name: str = ""
    arguments: Dict[str, Any] = field(default_factory=dict)
    result: Optional[str] = None  # after only

    def __init__(self, **kwargs: Any) -> None:
        kwargs.setdefault("domain", Domain.SKILL)
        kwargs.setdefault("method", "execute_tool")
        self.tool_name = kwargs.pop("tool_name", "")
        self.arguments = kwargs.pop("arguments", {})
        self.result = kwargs.pop("result", None)
        super().__init__(**kwargs)


@dataclass
class MCPCallEvent(MiddlewareEvent):
    """Event for MCP tool call (domain=MCP, method="call_tool")."""

    tool_name: str = ""
    arguments: Dict[str, Any] = field(default_factory=dict)
    result: Optional[str] = None  # after only

    def __init__(self, **kwargs: Any) -> None:
        kwargs.setdefault("domain", Domain.MCP)
        kwargs.setdefault("method", "call_tool")
        self.tool_name = kwargs.pop("tool_name", "")
        self.arguments = kwargs.pop("arguments", {})
        self.result = kwargs.pop("result", None)
        super().__init__(**kwargs)


@dataclass
class MCPDiscoverEvent(MiddlewareEvent):
    """Event for MCP tool discovery (domain=MCP, method="discover_tools")."""

    discovered_tools: Optional[List[Dict[str, Any]]] = None  # after only

    def __init__(self, **kwargs: Any) -> None:
        kwargs.setdefault("domain", Domain.MCP)
        kwargs.setdefault("method", "discover_tools")
        self.discovered_tools = kwargs.pop("discovered_tools", None)
        super().__init__(**kwargs)


@dataclass
class CompactionEvent(MiddlewareEvent):
    """Event for session compaction (domain=COMPACTION, method="compact_session_history")."""

    message_count: int = 0
    compacted_count: Optional[int] = None  # after only

    def __init__(self, **kwargs: Any) -> None:
        kwargs.setdefault("domain", Domain.COMPACTION)
        kwargs.setdefault("method", "compact_session_history")
        self.message_count = kwargs.pop("message_count", 0)
        self.compacted_count = kwargs.pop("compacted_count", None)
        super().__init__(**kwargs)


@dataclass
class MessageInjectEvent(MiddlewareEvent):
    """Event fired when a message is resolved from the registry."""

    key: str = ""
    content: str = ""
    params: Dict[str, Any] = field(default_factory=dict)
    final_content: Optional[str] = None  # after only

    def __init__(self, **kwargs: Any) -> None:
        kwargs.setdefault("domain", Domain.MESSAGE)
        kwargs.setdefault("method", "resolve")
        self.key = kwargs.pop("key", "")
        self.content = kwargs.pop("content", "")
        self.params = kwargs.pop("params", {})
        self.final_content = kwargs.pop("final_content", None)
        super().__init__(**kwargs)


# --- ABC ---


class Middleware(abc.ABC):
    """Abstract base for all middleware implementations.

    Override ``before`` to block or modify args before execution.
    Override ``after`` to observe results (fire-and-forget).
    """

    @property
    def name(self) -> str:
        return self.__class__.__name__

    async def before(self, event: MiddlewareEvent) -> BeforeResult:
        """Called before the intercepted method.  Default: pass-through."""
        return BeforeResult()

    async def after(self, event: MiddlewareEvent) -> None:
        """Called after the intercepted method.  Default: no-op."""
        pass
