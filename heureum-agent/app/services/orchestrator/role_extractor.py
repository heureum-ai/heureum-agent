# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
RoleExtractor — LLM determines which agent roles are needed for a task.

Adapted from auto_prompt's ``extract_required_agents`` pattern.
Uses structured output to get a typed list of DynamicAgentRole objects.
"""

import logging
from typing import List

from langchain_core.messages import HumanMessage, SystemMessage

from app.config import settings
from app.services.orchestrator.models import AgentRoleExtraction
from app.services.prompts.base import ROLE_EXTRACTION_PROMPT

logger = logging.getLogger(__name__)


class RoleExtractor:
    """Extracts the set of specialized agent roles needed for a task."""

    def __init__(self, llm) -> None:
        self._llm = llm

    async def extract(
        self,
        user_message: str,
        tool_names: List[str],
        skill_reference: str = "",
    ) -> AgentRoleExtraction:
        """Determine required agent roles via a single LLM call.

        Args:
            user_message: The user's task description.
            tool_names: Available tool names the agents can use.
            skill_reference: Optional skill catalog for reference (not binding).

        Returns:
            AgentRoleExtraction containing the list of roles and reasoning.

        Raises:
            Exception: Re-raised after logging; caller should fall back.
        """
        skill_section = ""
        if skill_reference:
            skill_section = (
                "\nThe following existing agent skill definitions are available as reference.\n"
                "You may use them as inspiration for role design, but you are NOT required to\n"
                "follow them. Create whatever roles best fit the task — these are just hints:\n\n"
                f"{skill_reference}\n"
            )

        prompt = ROLE_EXTRACTION_PROMPT.format(
            max_roles=settings.ORCHESTRATOR_MAX_ROLES,
            tool_names=", ".join(tool_names) if tool_names else "(none)",
            task=user_message,
            skill_reference_section=skill_section,
        )

        messages = [
            SystemMessage(content=prompt),
            HumanMessage(content=user_message),
        ]

        try:
            structured_llm = self._llm.with_structured_output(AgentRoleExtraction)
            result = await structured_llm.ainvoke(messages)

            # Enforce max roles limit
            if len(result.roles) > settings.ORCHESTRATOR_MAX_ROLES:
                result.roles = result.roles[: settings.ORCHESTRATOR_MAX_ROLES]

            logger.info(
                "Extracted %d roles: %s",
                len(result.roles),
                [r.role_type for r in result.roles],
            )
            return result
        except Exception:
            logger.warning("Role extraction LLM call failed", exc_info=True)
            raise
