# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
LLM-as-judge quality evaluation skill.
"""

import json
import logging
from dataclasses import dataclass
from typing import Any, Optional

from langchain_core.messages import HumanMessage, SystemMessage

from app.schemas.open_responses import FunctionToolCall, FunctionToolResult

logger = logging.getLogger(__name__)

JUDGE_SYSTEM_PROMPT = """You are a strict but fair quality judge for an AI assistant's response.
Evaluate whether the response adequately addresses the user's request based on the context provided.

Fail the response if:
- The assistant gave up after tool errors without trying alternative paths or tools.
- The response is empty, excessively brief, or merely asks the user to retry/clarify without attempting to solve the problem.
- The assistant claims it "couldn't find", "failed", or "lacks access" without demonstrating it exhausted all reasonable alternatives.
- The assistant is stuck in a repetitive loop of the same failed actions.

Pass the response if:
- It directly and substantively answers the user's question or completes the requested task.
- It acknowledges a genuine limitation ONLY AFTER clearly demonstrating multiple attempted approaches.
- It is a natural conversational response to a greeting or simple non-actionable statement.
"""

EVALUATE_TOOL_SCHEMA = {
    "type": "function",
    "function": {
        "name": "submit_evaluation",
        "description": "Submit the evaluation result for the AI assistant's response.",
        "parameters": {
            "type": "object",
            "properties": {
                "passed": {
                    "type": "boolean",
                    "description": "True if the response passes quality checks, False if the agent gave up too easily or got stuck.",
                },
                "guidance": {
                    "type": "string",
                    "description": "If passed is False, provide specific guidance on how the agent should retry (e.g., 'Try searching with grep instead of guessing paths').",
                },
            },
            "required": ["passed"],
        },
    },
}


@dataclass
class JudgeResult:
    """Result of the LLM-as-judge evaluation."""

    passed: bool
    guidance: Optional[str] = None


class EvaluateSkill:
    """Quality Evaluation Skill based on LLM-as-a-judge."""

    name = "evaluate_task"
    tool_schemas = []

    async def evaluate_response(
        self,
        user_query: str,
        response_text: str,
        output_items: list,
        llm: Any,
    ) -> JudgeResult:
        """Evaluate response quality using LLM-as-judge with forced tool calling."""
        tool_context = self._build_tool_context(output_items)

        prompt_text = (
            f"User query: {user_query}\n\n"
            f"Tool context:\n{tool_context}\n\n"
            f"Assistant response:\n{response_text}"
        )

        messages = [
            SystemMessage(content=JUDGE_SYSTEM_PROMPT),
            HumanMessage(content=prompt_text),
        ]

        try:
            llm_with_tools = llm.bind_tools([EVALUATE_TOOL_SCHEMA], tool_choice="submit_evaluation")
            response = await llm_with_tools.ainvoke(messages)

            if hasattr(response, "tool_calls") and response.tool_calls:
                args = response.tool_calls[0].get("args", {})
                passed = bool(args.get("passed", True))
                guidance = args.get("guidance")
                # Handle null guidance string
                if guidance and isinstance(guidance, str) and guidance.lower() == "null":
                    guidance = None
                return JudgeResult(passed=passed, guidance=guidance)

            return JudgeResult(passed=True, guidance=None)
        except Exception:
            logger.warning("Judge LLM call failed, passing by default", exc_info=True)
            return JudgeResult(passed=True, guidance=None)

    @staticmethod
    def _build_tool_context(output_items: list, limit: int = 10) -> str:
        """Build a tool execution summary string from output_items.

        Pairs FunctionToolCall with FunctionToolResult to show tool name,
        arguments summary, and success/failure status.
        """
        call_info: dict[str, tuple[str, str]] = {}
        result_info: dict[str, str] = {}

        for item in output_items:
            if isinstance(item, FunctionToolCall) and item.call_id:
                args_str = (
                    item.arguments
                    if isinstance(item.arguments, str)
                    else json.dumps(item.arguments)
                )
                if len(args_str) > 80:
                    args_str = args_str[:77] + "..."
                call_info[item.call_id] = (item.name, args_str)
            elif isinstance(item, FunctionToolResult) and item.call_id:
                result_info[item.call_id] = item.output or ""

        if not call_info:
            return "(no tools used)"

        lines = ["Tools used:"]
        entries = list(call_info.items())[-limit:]
        for i, (call_id, (name, args_summary)) in enumerate(entries, 1):
            output = result_info.get(call_id, "")
            failed = (
                "Error executing tool '" in output
                or "[EMPTY_RESULT]" in output
                or output.startswith("Error:")
                or output.startswith("Error calling ")
            )
            status = "FAILED: " + output[:100] if failed else "ok"
            lines.append(f"{i}. {name}({args_summary}) -> {status}")

        return "\n".join(lines)
