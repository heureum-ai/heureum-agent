# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Data types and state helpers for the agent loop."""

from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Set

from langchain_core.messages import BaseMessage

from app.schemas.open_responses import (
    FunctionToolCall,
    FunctionToolResult,
    ResponseRequest,
    Usage,
)


@dataclass
class LoopContext:
    request: ResponseRequest
    created_at: int
    session_id: str
    model: str
    messages: List[BaseMessage]
    tool_names: List[str]
    client_tool_schemas: List[dict] = field(default_factory=list)
    client_tool_names: Set[str] = field(default_factory=set)
    client_tool_prompts: List[str] = field(default_factory=list)
    display_names: Dict[str, str] = field(default_factory=dict)
    skills_prompt: Optional[str] = None
    total_usage: Usage = field(default_factory=Usage.zero)
    tool_call_count: int = 0
    output_items: list = field(default_factory=list)
    plan_retry_count: int = 0
    # Real-time persist tracking
    response_id: Optional[str] = None  # Platform Response PK
    msg_seq: int = 0
    # AgentLoopController instance (injected at creation time)
    ctrl: Optional[Any] = None


def is_tool_error(output: str) -> bool:
    """Detect tool execution failure from output string."""
    if not output:
        return False
    return (
        "Error executing tool '" in output
        or "[EMPTY_RESULT]" in output
        or output.startswith("Error:")
        or output.startswith("Error calling ")
    )


@dataclass
class _ToolCallRecord:
    """A single tool call with its success/failure status."""

    name: str
    succeeded: bool


class _LoopStateBuilder:
    """Builds a <loop_progress> XML block for LLM loop-state awareness."""

    @staticmethod
    def _extract_recent_tools(output_items: list, limit: int = 5) -> list[_ToolCallRecord]:
        """Extract recent tool call records from output items.

        Walks backwards through output_items pairing FunctionToolCall with
        its FunctionToolResult to determine success/failure.
        """
        records: list[_ToolCallRecord] = []
        # Build call_id -> name mapping and result mapping
        call_names: dict[str, str] = {}
        result_status: dict[str, bool] = {}

        for item in output_items:
            if isinstance(item, FunctionToolCall) and item.call_id:
                call_names[item.call_id] = item.name
            elif isinstance(item, FunctionToolResult) and item.call_id:
                output = item.output or ""
                failed = is_tool_error(output)
                result_status[item.call_id] = not failed

        # Collect in order, take last N
        for item in output_items:
            if isinstance(item, FunctionToolCall) and item.call_id:
                succeeded = result_status.get(item.call_id, True)
                records.append(_ToolCallRecord(name=item.name, succeeded=succeeded))

        return records[-limit:]

    @staticmethod
    def build(
        iteration: int,
        max_iterations: int,
        tool_call_count: int,
        output_items: list,
        total_usage: "Usage",
    ) -> str:
        """Build the <loop_progress> XML string for system prompt injection."""
        recent = _LoopStateBuilder._extract_recent_tools(output_items)

        lines = ["<loop_progress>"]
        lines.append(f"  iteration: {iteration}/{max_iterations}")
        lines.append(f"  tools_called: {tool_call_count}")

        if recent:
            lines.append("  recent_tools:")
            for rec in recent:
                status = "ok" if rec.succeeded else "FAILED"
                lines.append(f"    - {rec.name}: {status}")

        lines.append(
            f"  tokens_used: in={total_usage.input_tokens} out={total_usage.output_tokens}"
        )

        remaining = max_iterations - iteration
        if remaining <= 5:
            lines.append(
                f"  warning: only {remaining} iteration(s) remaining, prioritize completing the task"
            )
        if tool_call_count > 20:
            lines.append(
                "  note: high tool call count, consider whether you are making efficient progress"
            )

        if iteration == 1 and tool_call_count == 0:
            lines.append(
                "  reminder: for multi-step tasks, create a plan with manage_todo before executing"
            )

        lines.append("</loop_progress>")
        return "\n".join(lines)
