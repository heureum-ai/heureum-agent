# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Agent loop engine — orchestrates the server-side agentic loop.

This package replaces the former single-file ``agent_loop.py``.
All public names are re-exported here for backward compatibility.
"""

from app.services.agent_loop.constants import SSE_HEADERS
from app.services.agent_loop.context import (
    LoopContext,
    _LoopStateBuilder,
    is_tool_error,
)
from app.services.agent_loop.controller import AgentLoopController
from app.services.agent_loop.runner import AgentLoopRunner
from app.services.subagent import _get_context as _get_subagent_context

_default = AgentLoopController()

__all__ = [
    "AgentLoopController",
    "AgentLoopRunner",
    "LoopContext",
    "SSE_HEADERS",
    "_LoopStateBuilder",
    "_default",
    "_get_subagent_context",
    "is_tool_error",
]


def __getattr__(name: str):
    """Backward-compat: expose controller attributes as module-level names."""
    _MAPPING = {
        "agent_service": lambda: _default.agent_service,
        "tool_controller": lambda: _default.tool_controller,
        "skill_controller": lambda: _default.skill_controller,
        "mcp_client": lambda: _default.mcp_client,
        "persist_controller": lambda: _default.persist_controller,
        "ensure_initialized": lambda: _default.ensure_initialized,
        "cleanup_stale_locks": lambda: _default.cleanup_stale_locks,
        "remove_session_lock": lambda: _default.remove_session_lock,
        "_get_loop_lock": lambda: _default.get_loop_lock,
        "execute_tool": lambda: _default.tool_exec.execute_tool,
        "_safe_execute_tool": lambda: _default.tool_exec.safe_execute_tool,
        "_execute_tool_calls_pipelined": lambda: _default.tool_exec.execute_tool_calls_pipelined,
        "handle_approval_continuation": lambda: _default.tool_exec.handle_approval_continuation,
        "resolve_tools": lambda: _default.tool_exec.resolve_tools,
    }
    if name in _MAPPING:
        return _MAPPING[name]()
    raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
