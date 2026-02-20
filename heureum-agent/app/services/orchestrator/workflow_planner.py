# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
WorkflowPlanner — LLM creates an execution plan with dependency graph,
then Kahn's algorithm groups independent steps into parallel batches.

Adapted from auto_prompt's WorkflowPlanAgent + new TeamBatch grouping.
"""

import logging
from collections import deque
from typing import Dict, List, Set

from langchain_core.messages import HumanMessage, SystemMessage

from app.config import settings
from app.services.orchestrator.models import (
    DynamicAgentRole,
    TeamBatch,
    WorkflowExecutionPlan,
    WorkflowStep,
)
from app.services.prompts.base import WORKFLOW_PLANNING_PROMPT

logger = logging.getLogger(__name__)


class WorkflowPlanner:
    """Plans workflow steps with dependencies and groups them into parallel batches."""

    def __init__(self, llm) -> None:
        self._llm = llm

    async def plan(
        self,
        user_message: str,
        roles: List[DynamicAgentRole],
    ) -> WorkflowExecutionPlan:
        """Generate a workflow execution plan via LLM.

        Args:
            user_message: The user's task description.
            roles: The extracted agent roles available for assignment.

        Returns:
            WorkflowExecutionPlan with ordered steps and dependency graph.

        Raises:
            Exception: Re-raised after logging; caller should fall back.
        """
        roles_desc = "\n".join(
            f"- {r.role_type}: {r.objective} (tools: {', '.join(r.tool_access) or 'none'})"
            for r in roles
        )

        prompt = WORKFLOW_PLANNING_PROMPT.format(
            min_steps=len(roles),
            max_steps=settings.ORCHESTRATOR_MAX_STEPS,
            roles_description=roles_desc,
            task=user_message,
        )

        messages = [
            SystemMessage(content=prompt),
            HumanMessage(content=user_message),
        ]

        try:
            structured_llm = self._llm.with_structured_output(WorkflowExecutionPlan)
            result = await structured_llm.ainvoke(messages)

            # Enforce max steps
            if len(result.steps) > settings.ORCHESTRATOR_MAX_STEPS:
                result.steps = result.steps[: settings.ORCHESTRATOR_MAX_STEPS]

            # Validate: remove dangling depends_on references
            valid_names: Set[str] = {s.step_name for s in result.steps}
            for step in result.steps:
                step.depends_on = [d for d in step.depends_on if d in valid_names]

            logger.info(
                "Planned %d workflow steps: %s",
                len(result.steps),
                [s.step_name for s in result.steps],
            )
            return result
        except Exception:
            logger.warning("Workflow planning LLM call failed", exc_info=True)
            raise

    @staticmethod
    def build_team_batches(steps: List[WorkflowStep]) -> List[TeamBatch]:
        """Group workflow steps into parallel batches using Kahn's algorithm.

        Steps with no unsatisfied dependencies go into the same batch.
        Within each batch, all steps can execute concurrently.

        Args:
            steps: Ordered list of workflow steps with depends_on edges.

        Returns:
            List of TeamBatch objects in execution order.

        Raises:
            ValueError: If a dependency cycle is detected.
        """
        if not steps:
            return []

        step_map: Dict[str, WorkflowStep] = {s.step_name: s for s in steps}
        valid_names: Set[str] = set(step_map.keys())

        # Build adjacency and in-degree
        in_degree: Dict[str, int] = {name: 0 for name in valid_names}
        dependents: Dict[str, List[str]] = {name: [] for name in valid_names}

        for step in steps:
            for dep in step.depends_on:
                if dep in valid_names:
                    in_degree[step.step_name] += 1
                    dependents[dep].append(step.step_name)

        # Kahn's algorithm — group by levels
        queue: deque[str] = deque(
            name for name, deg in in_degree.items() if deg == 0
        )
        batches: List[TeamBatch] = []
        processed: Set[str] = set()

        while queue:
            # All items currently in the queue form one parallel batch
            current_batch_names: List[str] = list(queue)
            queue.clear()

            batch_steps = [step_map[name] for name in current_batch_names]
            batches.append(TeamBatch(batch_index=len(batches), steps=batch_steps))
            processed.update(current_batch_names)

            for name in current_batch_names:
                for dep_name in dependents[name]:
                    in_degree[dep_name] -= 1
                    if in_degree[dep_name] == 0:
                        queue.append(dep_name)

        if len(processed) != len(valid_names):
            unprocessed = valid_names - processed
            raise ValueError(f"Dependency cycle detected among steps: {unprocessed}")

        logger.info(
            "Built %d team batches: %s",
            len(batches),
            [[s.step_name for s in b.steps] for b in batches],
        )
        return batches
