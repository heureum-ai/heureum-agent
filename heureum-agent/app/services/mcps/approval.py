# Copyright (c) 2026 Heureum AI. All rights reserved.

"""MCP approval-flow helpers."""

import json
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Set, Tuple

from app.config import ApprovalChoice
from langchain_core.messages import BaseMessage, ToolMessage

from app.models import ToolCallInfo


@dataclass
class ApprovalState:
    """Bundled mutable state for tool-approval bookkeeping."""

    approval_required_tools: Set[str] = field(default_factory=set)
    display_names: Dict[str, str] = field(default_factory=dict)
    pending_tool_calls: Dict[str, Dict[str, Any]] = field(default_factory=dict)
    auto_approved_tools: Dict[str, Set[str]] = field(default_factory=dict)

    def clear(self) -> None:
        """Reset discovery-time fields (called on cache invalidation)."""
        self.approval_required_tools.clear()
        self.display_names.clear()


def needs_approval(
    *,
    tool_name: str,
    session_id: str,
    state: ApprovalState,
) -> bool:
    """Check if a tool still requires approval for this session."""
    pending = state.approval_required_tools - state.auto_approved_tools.get(session_id, set())
    return tool_name in pending


def classify_tool_calls(
    *,
    tool_calls: List[ToolCallInfo],
    client_tool_names: Optional[Set[str]] = None,
) -> Tuple[List[ToolCallInfo], List[ToolCallInfo]]:
    """Classify tool calls into (client_calls, server_calls)."""
    names = client_tool_names or set()
    client_calls = [tc for tc in tool_calls if tc.name in names]
    server_calls = [tc for tc in tool_calls if tc.name not in names]
    return client_calls, server_calls


def format_approval_question(tool_calls: List[ToolCallInfo]) -> dict:
    """Build tool_approval arguments for waiting approvals."""
    if len(tool_calls) == 1:
        tool_call = tool_calls[0]
        question = f"Allow {tool_call.name}({json.dumps(tool_call.args, ensure_ascii=False)})?"
    else:
        lines = [
            f"  - {tool_call.name}({json.dumps(tool_call.args, ensure_ascii=False)})"
            for tool_call in tool_calls
        ]
        question = "Allow the following tool executions?\n" + "\n".join(lines)
    tool_name = tool_calls[0].name if tool_calls else "unknown"
    return {
        "question": question,
        "choices": ApprovalChoice.options(),
        "tool_name": tool_name,
    }


def extract_approval_answer(messages: List[BaseMessage], approval_call_id: str) -> Optional[str]:
    """Find the approval answer from incoming tool messages."""
    for message in messages:
        if isinstance(message, ToolMessage) and message.tool_call_id == approval_call_id:
            content = message.content or ""
            if content.startswith("User chose: "):
                return content[len("User chose: ") :]
            if content.startswith("User input: "):
                return content[len("User input: ") :]
            return content
    return None


def request_approval(
    *,
    server_calls: List[ToolCallInfo],
    session_id: str,
    usage: Any,
    input_messages: List[BaseMessage],
    assistant_lc_message: Any,
    remaining_chained: Optional[List[ToolCallInfo]],
    state: ApprovalState,
    gen_call_id: Callable[[], str],
) -> Dict[str, Any]:
    """Store pending state and return tool_approval payload."""
    approval_call_id = gen_call_id()
    approval_only = [
        tool_call
        for tool_call in server_calls
        if needs_approval(
            tool_name=tool_call.name,
            session_id=session_id,
            state=state,
        )
    ]
    state.pending_tool_calls[session_id] = {
        "approval_call_id": approval_call_id,
        "tool_calls": server_calls,
        "usage": usage,
        "input_messages": input_messages,
        "assistant_lc_message": assistant_lc_message,
        "remaining_chained": remaining_chained or [],
    }

    first_tool = approval_only[0] if approval_only else server_calls[0]
    display_name = state.display_names[first_tool.name]
    return {
        "approval_call_id": approval_call_id,
        "question": format_approval_question(approval_only),
        "display_name": display_name,
    }


def handle_approval_response(
    *,
    session_id: str,
    messages: List[BaseMessage],
    state: ApprovalState,
) -> Optional[Dict[str, Any]]:
    """Restore pending state and parse the approval answer."""
    pending = state.pending_tool_calls.pop(session_id, None)
    if not pending:
        return None

    answer = extract_approval_answer(messages, pending["approval_call_id"])
    if answer is None:
        state.pending_tool_calls[session_id] = pending
        return None

    filtered_messages = [
        message
        for message in messages
        if not (
            isinstance(message, ToolMessage) and message.tool_call_id == pending["approval_call_id"]
        )
    ]

    if answer in ApprovalChoice._value2member_map_:
        choice = ApprovalChoice(answer)
    else:
        choice = ApprovalChoice.DENY
    decision = choice.decision

    if choice is ApprovalChoice.ALWAYS_ALLOW:
        auto_set = state.auto_approved_tools.setdefault(session_id, set())
        for tool_call in pending["tool_calls"]:
            if tool_call.name in state.approval_required_tools:
                auto_set.add(tool_call.name)

    return {
        "decision": decision,
        "tool_calls": pending["tool_calls"],
        "filtered_messages": filtered_messages,
        "usage": pending["usage"],
        "input_messages": pending["input_messages"],
        "assistant_lc_message": pending.get("assistant_lc_message"),
        "remaining_chained": pending.get("remaining_chained", []),
    }


def clear_session_state(
    *,
    session_id: str,
    state: ApprovalState,
) -> None:
    """Clean up approval state for a session."""
    state.pending_tool_calls.pop(session_id, None)
    state.auto_approved_tools.pop(session_id, None)
