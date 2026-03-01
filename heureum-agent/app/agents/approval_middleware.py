# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Approval middleware — tool approval flow for DeepAgents v2 endpoint."""

from __future__ import annotations

import logging
from typing import Any, Dict, List, Tuple

from langgraph.types import Command

from app.config import ApprovalChoice

logger = logging.getLogger(__name__)

# Session → set of always-allowed tools
_session_always_allowed: dict[str, set[str]] = {}


def build_interrupt_on(
    approval_required_tools: set[str],
    session_id: str,
) -> dict[str, bool] | None:
    """Build the interrupt_on config for DeepAgents.

    Returns a dict mapping tool names to True (require approval) or None
    if no tools need approval. Tools in the session's always-allowed set
    are excluded.

    Args:
        approval_required_tools: Set of tool names that require approval.
        session_id: Current session ID (for always-allow tracking).

    Returns:
        Dict for create_deep_agent(interrupt_on=...) or None if empty.
    """
    always_allowed = _session_always_allowed.get(session_id, set())
    interrupt_on = {}
    for tool_name in approval_required_tools:
        if tool_name not in always_allowed:
            interrupt_on[tool_name] = True
    return interrupt_on if interrupt_on else None


def process_approval_decision(
    decision: str,
    tool_name: str,
    session_id: str,
    tool_output: str = "",
) -> Tuple[Command, bool]:
    """Process a user approval decision and return the LangGraph Command.

    Args:
        decision: One of "allow_once", "always_allow", "deny".
        tool_name: Name of the tool being approved/denied.
        session_id: Current session ID.
        tool_output: Pre-executed tool output (if available, for allow cases).

    Returns:
        Tuple of (Command to resume graph, whether_approved).
    """
    if decision == ApprovalChoice.ALWAYS_ALLOW.decision:
        # Add to session's always-allowed set
        _session_always_allowed.setdefault(session_id, set()).add(tool_name)
        logger.info("Always allowing tool '%s' for session %s", tool_name, session_id)
        # Resume with approved (graph will execute tool)
        return Command(resume={"decision": "approve", "output": tool_output}), True

    elif decision == ApprovalChoice.ALLOW_ONCE.decision:
        # Resume with approved
        return Command(resume={"decision": "approve", "output": tool_output}), True

    elif decision == ApprovalChoice.DENY.decision:
        # Resume with denied
        return Command(resume={"decision": "reject", "reason": "User denied tool execution."}), False

    else:
        # Unknown decision — treat as deny
        logger.warning("Unknown approval decision '%s', treating as deny", decision)
        return Command(resume={"decision": "reject", "reason": f"Unknown decision: {decision}"}), False


def build_client_tool_resume_command(
    tool_results: List[Dict[str, Any]],
) -> Command:
    """Build a LangGraph Command to resume after client tool execution.

    Args:
        tool_results: List of {call_id, output} dicts from the client.

    Returns:
        Command(resume=...) to resume the interrupted graph.
    """
    if not tool_results:
        return Command(resume={"output": ""})

    if len(tool_results) == 1:
        result = tool_results[0]
        return Command(resume={"output": result.get("output", ""), "call_id": result.get("call_id", "")})

    # Multiple tool results — resume with all of them
    return Command(resume=tool_results)


def clear_session_approval_state(session_id: str) -> None:
    """Clear all approval state for a session (on session delete)."""
    _session_always_allowed.pop(session_id, None)
    logger.debug("Cleared approval state for session %s", session_id)


def has_pending_interrupt(session_id: str, checkpointer: Any) -> bool:
    """Check if a session has a pending graph interrupt.

    Args:
        session_id: Session/thread ID.
        checkpointer: LangGraph MemorySaver checkpointer.

    Returns:
        True if the graph has a pending interrupt for this session.
    """
    try:
        config = {"configurable": {"thread_id": session_id}}
        checkpoint = checkpointer.get(config)
        if checkpoint is None:
            return False
        # Check if there are pending interrupts in the checkpoint metadata
        metadata = checkpoint.get("metadata") or {}
        return bool(metadata.get("interrupts"))
    except Exception:
        return False
