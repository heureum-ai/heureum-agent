# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
TeamExecutor — runs workflow batches, executing independent steps in parallel.

Each step spawns an independent sub-agent via the subagent infrastructure
(``app.services.subagent``), giving every step a fully isolated
``AgentService`` instance with proper tool resolution and session management.
Steps within a batch execute concurrently via ``asyncio.gather``.
Batches execute sequentially (each batch waits for the previous to finish).
"""

import asyncio
import logging
import time
from typing import Any, Callable, Coroutine, Dict, List, Optional

from app.config import settings
from app.services.orchestrator.models import (
    DataFlowEdge,
    DynamicAgentRole,
    StepResult,
    StepStatus,
    StepTrace,
    TeamBatch,
    ToolCallTrace,
    WorkflowStep,
)
from app.services.orchestrator.result_store import AgentResultStore
from app.services.prompts.base import STEP_EXECUTION_PROMPT
from app.services.subagent import (
    SpawnRequest,
    clear_session_step_context,
    get_registry,
    set_session_step_context,
    spawn_subagent,
)

logger = logging.getLogger(__name__)

# Type alias for the tool executor callback passed from the router layer
ToolExecutorFn = Callable[[str, Dict[str, Any], str], Coroutine[Any, Any, str]]


class TeamExecutor:
    """Executes workflow batches with parallel step execution within each batch."""

    def __init__(
        self,
        llm,
        agent_service,
        execute_tool: ToolExecutorFn,
        tool_names: List[str],
        parent_session_id: str,
        roles: List[DynamicAgentRole],
        plan_skill=None,
        step_index_map: Optional[Dict[str, int]] = None,
        on_step_event: Optional[Callable] = None,
        trace_collector=None,
        result_store: Optional[AgentResultStore] = None,
    ) -> None:
        """
        Args:
            llm: The LangChain LLM instance.
            agent_service: AgentService for session and history management.
            execute_tool: Async callable ``(name, args, session_id) -> str``.
            tool_names: All available tool names for tool schema resolution.
            parent_session_id: The parent conversation session ID.
            roles: The extracted agent roles for prompt building.
            plan_skill: Optional PlanSkill for real-time step status updates.
            step_index_map: Optional mapping of step_name -> todo step index.
            on_step_event: Optional async callback for SSE events:
                ``(event_type, data_dict) -> None``.
            trace_collector: Optional TraceCollector for recording step traces.
            result_store: Optional AgentResultStore for filesystem persistence.
        """
        self._llm = llm
        self._agent_service = agent_service
        self._execute_tool = execute_tool
        self._tool_names = tool_names
        self._parent_session_id = parent_session_id
        self._roles_map: Dict[str, DynamicAgentRole] = {r.role_type: r for r in roles}
        self._plan_skill = plan_skill
        self._step_index_map: Dict[str, int] = step_index_map or {}
        self._on_step_event = on_step_event
        self._trace_collector = trace_collector
        self._result_store = result_store
        self._results: Dict[str, StepResult] = {}
        self._child_session_ids: List[str] = []

    async def execute_all_batches(self, batches: List[TeamBatch]) -> List[StepResult]:
        """Execute all batches sequentially, steps within each batch in parallel.

        Args:
            batches: Ordered list of TeamBatch objects.

        Returns:
            List of StepResult for all steps across all batches.
        """
        for batch in batches:
            tasks = [self._execute_step(step) for step in batch.steps]
            batch_results = await asyncio.gather(*tasks, return_exceptions=True)

            for step, result in zip(batch.steps, batch_results):
                if isinstance(result, Exception):
                    sr = StepResult(
                        step_name=step.step_name,
                        assigned_agent=step.assigned_agent,
                        status=StepStatus.FAILED,
                        error=str(result),
                    )
                    self._results[step.step_name] = sr
                    logger.warning("Step %s failed with exception: %s", step.step_name, result)
                else:
                    self._results[step.step_name] = result

        return list(self._results.values())

    def cleanup_registry(self) -> None:
        """Deferred cleanup of all spawned subagent registry records.

        Called after execution completes and frontend polling has had time
        to observe the final states of all child sessions.
        """
        registry = get_registry()
        for sid in self._child_session_ids:
            registry.cleanup(sid)
        self._child_session_ids.clear()

    async def _execute_step(self, step: WorkflowStep) -> StepResult:
        """Execute a single step by spawning an independent sub-agent.

        Each step gets a fully isolated ``AgentService`` instance via
        ``spawn_subagent(orchestrator_mode=True)``, with its own session,
        tool resolution, and agent loop.

        Args:
            step: The workflow step to execute.

        Returns:
            StepResult with the step's output or error.
        """
        # Check if any dependency failed — skip if so
        for dep_name in step.depends_on:
            dep_result = self._results.get(dep_name)
            if dep_result and dep_result.status in (StepStatus.FAILED, StepStatus.SKIPPED):
                logger.info("Skipping step %s: dependency %s is %s", step.step_name, dep_name, dep_result.status)
                return StepResult(
                    step_name=step.step_name,
                    assigned_agent=step.assigned_agent,
                    status=StepStatus.SKIPPED,
                    error=f"Dependency '{dep_name}' {dep_result.status.value}",
                )

        # Mark TODO step as in_progress
        await self._update_todo_step(step.step_name, "in_progress")

        await self._emit_event("response.orchestration.step_started", {
            "step_name": step.step_name,
            "assigned_agent": step.assigned_agent,
            "task": step.task,
        })

        step_started = time.time()
        role = self._roles_map.get(step.assigned_agent)

        # Build context from dependencies
        context_section = self._serialize_context(step)

        # Record data flow edges for each dependency
        if self._trace_collector and step.depends_on:
            for dep_name in step.depends_on:
                dep_result = self._results.get(dep_name)
                if dep_result and dep_result.output:
                    self._trace_collector.add_data_flow_edge(DataFlowEdge(
                        source_step=dep_name,
                        source_agent=dep_result.assigned_agent,
                        target_step=step.step_name,
                        target_agent=step.assigned_agent,
                        data_preview=dep_result.output[:200],
                        data_size=len(dep_result.output),
                        status=dep_result.status.value,
                    ))
                elif dep_result and dep_result.status == StepStatus.FAILED:
                    self._trace_collector.add_data_flow_edge(DataFlowEdge(
                        source_step=dep_name,
                        source_agent=dep_result.assigned_agent,
                        target_step=step.step_name,
                        target_agent=step.assigned_agent,
                        data_preview=f"Error: {dep_result.error or 'unknown'}",
                        data_size=0,
                        status="failed",
                    ))

        # Build constraints section
        constraints_section = ""
        if role and role.constraints:
            constraints_section = "Constraints:\n" + "\n".join(f"- {c}" for c in role.constraints)

        # Build specialized system prompt
        system_content = STEP_EXECUTION_PROMPT.format(
            role_type=step.assigned_agent,
            objective=role.objective if role else step.task,
            constraints_section=constraints_section,
            step_task=step.task,
            context_section=context_section,
        )

        # Persist the system prompt to filesystem
        if self._result_store:
            self._result_store.save_step_prompt(step.step_name, system_content)

        # Determine which tools this agent can access
        step_tool_names = self._tool_names
        if role and role.tool_access:
            step_tool_names = [t for t in self._tool_names if t in role.tool_access]

        # Ensure sessions_spawn is always available for supervisor delegation
        if "sessions_spawn" in self._tool_names and "sessions_spawn" not in step_tool_names:
            step_tool_names = step_tool_names + ["sessions_spawn"]

        # Spawn an independent sub-agent for step execution
        tool_log: List[str] = []
        tool_call_traces: List[ToolCallTrace] = []
        llm_call_count = 0
        try:
            spawn_request = SpawnRequest(
                parent_session_id=self._parent_session_id,
                task=step.task,
                tools=step_tool_names if step_tool_names else None,
                cleanup="delete",
                announce=False,
                system_prompt=system_content,
                orchestrator_mode=True,
                max_iterations=settings.MAX_ORCHESTRATOR_STEP_ITERATIONS,
                step_name=step.step_name,
            )
            spawn_result = await spawn_subagent(spawn_request)
            if spawn_result.status != "accepted":
                raise RuntimeError(f"Failed to spawn step agent: {spawn_result.message}")

            # Register step context so sub-sub-agents can persist to filesystem
            if self._result_store:
                set_session_step_context(
                    spawn_result.child_session_id, step.step_name, self._result_store,
                )

            # Wait for the sub-agent to complete
            record = get_registry().get(spawn_result.child_session_id)
            if record and record.asyncio_task:
                await record.asyncio_task

            # Read result from registry
            record = get_registry().get(spawn_result.child_session_id)
            if not record:
                raise RuntimeError("Sub-agent record lost after execution")

            llm_call_count = record.current_iteration

            # Convert progress_log to tool traces
            for ps in record.progress_log:
                duration = ((ps.completed_at or time.time()) - ps.started_at) * 1000
                tool_call_traces.append(ToolCallTrace(
                    tool_name=ps.tool_name,
                    args_summary=ps.detail,
                    result_preview="",
                    duration_ms=round(duration, 1),
                    error=None if ps.status != "failed" else "Tool call failed",
                ))
                tool_log.append(f"{ps.tool_name}({ps.detail}) → [{ps.status}]")

            if record.status == "completed":
                output = record.result_summary
            elif record.status == "timeout":
                raise RuntimeError(
                    f"Step timed out after {settings.SUBAGENT_TIMEOUT_SECONDS}s"
                )
            else:
                raise RuntimeError(
                    record.result_summary or f"Step failed: {record.status}"
                )

            # Track child session for deferred cleanup (keeps registry records
            # alive so frontend subagent polling can discover them).
            self._child_session_ids.append(spawn_result.child_session_id)
            clear_session_step_context(spawn_result.child_session_id)

            result = StepResult(
                step_name=step.step_name,
                assigned_agent=step.assigned_agent,
                status=StepStatus.COMPLETED,
                output=output,
            )
        except Exception as e:
            logger.warning("Step %s execution failed: %s", step.step_name, e)
            result = StepResult(
                step_name=step.step_name,
                assigned_agent=step.assigned_agent,
                status=StepStatus.FAILED,
                error=str(e),
            )

        step_ended = time.time()
        duration_ms = round((step_ended - step_started) * 1000, 1)

        # Persist step result to filesystem
        if self._result_store:
            self._result_store.save_step_result(step.step_name, result, duration_ms, task=step.task)

        # Record step trace
        if self._trace_collector:
            output_preview = result.output[:300] if result.output else ""
            step_trace = StepTrace(
                step_name=step.step_name,
                assigned_agent=step.assigned_agent,
                status=result.status,
                started_at=step_started,
                ended_at=step_ended,
                duration_ms=duration_ms,
                llm_call_count=llm_call_count,
                tool_calls=tool_call_traces,
                system_prompt=system_content,
                context_received=context_section,
                full_output=result.output or "",
                output_preview=output_preview,
                error=result.error,
            )
            self._trace_collector.add_step_trace(step_trace)

        # Mark TODO step as completed/failed with detailed result
        todo_status = "completed" if result.status == StepStatus.COMPLETED else "failed"
        todo_result = self._build_todo_result(result, tool_log)
        await self._update_todo_step(step.step_name, todo_status, todo_result)

        await self._emit_event("response.orchestration.step_completed", {
            "step_name": step.step_name,
            "status": result.status.value,
            "output_preview": result.output[:200] if result.output else "",
            "error": result.error,
        })

        return result

    def _serialize_context(self, step: WorkflowStep) -> str:
        """Build context string from dependency step results.

        Args:
            step: The current step whose dependencies to serialize.

        Returns:
            Formatted context string, or empty if no dependencies.
        """
        if not step.depends_on:
            return ""

        sections = []
        for dep_name in step.depends_on:
            dep_result = self._results.get(dep_name)
            if not dep_result:
                continue
            if dep_result.status == StepStatus.COMPLETED and dep_result.output:
                sections.append(
                    f"<context from=\"{dep_name}\" agent=\"{dep_result.assigned_agent}\">\n"
                    f"{dep_result.output}\n"
                    f"</context>"
                )
            elif dep_result.status == StepStatus.FAILED:
                sections.append(
                    f"<context from=\"{dep_name}\" status=\"failed\">\n"
                    f"Error: {dep_result.error}\n"
                    f"</context>"
                )

        if not sections:
            return ""

        return "Results from previous steps:\n" + "\n\n".join(sections)

    @staticmethod
    def _build_todo_result(result: StepResult, tool_log: List[str]) -> str:
        """Build a detailed TODO result string including tool call history.

        Args:
            result: The step execution result.
            tool_log: List of tool call summary strings.

        Returns:
            Formatted result string for the TODO step.
        """
        parts: List[str] = []

        # Tool calls used
        if tool_log:
            parts.append("Tools used:")
            for entry in tool_log:
                parts.append(f"  - {entry}")

        # Agent output
        if result.output:
            output_text = result.output.strip()
            if len(output_text) > 500:
                output_text = output_text[:500] + "..."
            parts.append(f"Result: {output_text}")
        elif result.error:
            parts.append(f"Error: {result.error}")

        return "\n".join(parts) if parts else (result.error or "")

    async def _update_todo_step(
        self, step_name: str, status: str, result: Optional[str] = None
    ) -> None:
        """Update TODO step status via the step_name -> index mapping."""
        if not self._plan_skill or step_name not in self._step_index_map:
            return
        try:
            idx = self._step_index_map[step_name]
            await self._plan_skill.update_step(
                self._parent_session_id, idx, status, result
            )
        except Exception:
            logger.debug("TODO step update failed for %s", step_name, exc_info=True)

    async def _emit_event(self, event_type: str, data: dict) -> None:
        """Emit an SSE event via the callback, if set."""
        if self._on_step_event:
            try:
                await self._on_step_event(event_type, data)
            except Exception:
                logger.debug("Step event emission failed", exc_info=True)
