# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Synthesizer — combines all step results into a single coherent response.

Adapted from auto_prompt's ``_synthesize_final_summary``.
Provides both blocking and streaming variants.
"""

import logging
from typing import AsyncIterator, List

from langchain_core.messages import HumanMessage, SystemMessage

from app.services.orchestrator.models import StepResult, StepStatus
from app.services.prompts.base import SYNTHESIS_PROMPT

logger = logging.getLogger(__name__)


class Synthesizer:
    """Synthesizes step results into a unified final response."""

    def __init__(self, llm) -> None:
        self._llm = llm

    async def synthesize(
        self,
        user_message: str,
        step_results: List[StepResult],
    ) -> str:
        """Combine step outputs into a single response.

        Args:
            user_message: The original user request.
            step_results: Results from all executed steps.

        Returns:
            The synthesized final answer text.
        """
        messages = self._build_messages(user_message, step_results)

        try:
            response = await self._llm.ainvoke(messages)
            text = response.content
            if isinstance(text, list):
                text = " ".join(
                    item if isinstance(item, str) else item.get("text", "")
                    for item in text
                    if isinstance(item, (str, dict))
                )
            return text
        except Exception:
            logger.warning("Synthesis LLM call failed, falling back to concatenation", exc_info=True)
            return self._fallback_concatenate(step_results)

    async def stream_synthesize(
        self,
        user_message: str,
        step_results: List[StepResult],
    ) -> AsyncIterator[str]:
        """Stream the synthesized response token by token.

        Args:
            user_message: The original user request.
            step_results: Results from all executed steps.

        Yields:
            Text chunks as they are generated.
        """
        messages = self._build_messages(user_message, step_results)

        try:
            async for chunk in self._llm.astream(messages):
                content = chunk.content
                if isinstance(content, str) and content:
                    yield content
                elif isinstance(content, list):
                    text = " ".join(
                        item if isinstance(item, str) else item.get("text", "")
                        for item in content
                        if isinstance(item, (str, dict))
                    )
                    if text:
                        yield text
        except Exception:
            logger.warning("Streaming synthesis failed, yielding fallback", exc_info=True)
            yield self._fallback_concatenate(step_results)

    def _build_messages(self, user_message: str, step_results: List[StepResult]) -> list:
        """Build LLM messages for synthesis."""
        step_outputs = self._format_step_outputs(step_results)
        self._last_synthesis_input = step_outputs
        prompt = SYNTHESIS_PROMPT.format(
            user_message=user_message,
            step_outputs=step_outputs,
        )
        return [
            SystemMessage(content=prompt),
            HumanMessage(content=f"Please synthesize the above results into a final response for: {user_message}"),
        ]

    def get_last_synthesis_input(self) -> str:
        """Return the formatted step outputs that were sent to the synthesis LLM."""
        return getattr(self, "_last_synthesis_input", "")

    @staticmethod
    def _format_step_outputs(step_results: List[StepResult]) -> str:
        """Format step results for inclusion in the synthesis prompt."""
        sections = []
        for sr in step_results:
            if sr.status == StepStatus.COMPLETED:
                sections.append(
                    f"### {sr.step_name} (agent: {sr.assigned_agent}) - Completed\n{sr.output}"
                )
            elif sr.status == StepStatus.FAILED:
                sections.append(
                    f"### {sr.step_name} (agent: {sr.assigned_agent}) - Failed\nError: {sr.error}"
                )
            elif sr.status == StepStatus.SKIPPED:
                sections.append(
                    f"### {sr.step_name} (agent: {sr.assigned_agent}) - Skipped\nReason: {sr.error}"
                )
        return "\n\n".join(sections) if sections else "(no step outputs)"

    @staticmethod
    def _fallback_concatenate(step_results: List[StepResult]) -> str:
        """Simple concatenation fallback when synthesis LLM call fails."""
        parts = []
        for sr in step_results:
            if sr.status == StepStatus.COMPLETED and sr.output:
                parts.append(f"**{sr.step_name}**:\n{sr.output}")
            elif sr.status == StepStatus.FAILED:
                parts.append(f"**{sr.step_name}** (failed): {sr.error}")
        return "\n\n---\n\n".join(parts) if parts else "No results available."
