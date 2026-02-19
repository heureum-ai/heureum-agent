# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
TeamExecutor — runs workflow batches, executing independent steps in parallel.

Each step runs a mini agent loop (LLM + tool calls) in its own sub-session.
Steps within a batch execute concurrently via ``asyncio.gather``.
Batches execute sequentially (each batch waits for the previous to finish).

Adapted from auto_prompt's ``_execute_workflow_step`` + ``_serialize_previous_results``,
extended with full tool-calling agent loops and SSE event emission.
"""

import asyncio
import logging
import time
from typing import Any, Callable, Coroutine, Dict, List, Optional

from langchain_core.messages import HumanMessage, SystemMessage

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
from app.services.prompts.base import STEP_EXECUTION_PROMPT

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
        todo_service=None,
        step_index_map: Optional[Dict[str, int]] = None,
        on_step_event: Optional[Callable] = None,
        trace_collector=None,
    ) -> None:
        """
        Args:
            llm: The LangChain LLM instance.
            agent_service: AgentService for session and history management.
            execute_tool: Async callable ``(name, args, session_id) -> str``.
            tool_names: All available tool names for tool schema resolution.
            parent_session_id: The parent conversation session ID.
            roles: The extracted agent roles for prompt building.
            todo_service: Optional TodoService for real-time step status updates.
            step_index_map: Optional mapping of step_name -> todo step index.
            on_step_event: Optional async callback for SSE events:
                ``(event_type, data_dict) -> None``.
            trace_collector: Optional TraceCollector for recording step traces.
        """
        self._llm = llm
        self._agent_service = agent_service
        self._execute_tool = execute_tool
        self._tool_names = tool_names
        self._parent_session_id = parent_session_id
        self._roles_map: Dict[str, DynamicAgentRole] = {r.role_type: r for r in roles}
        self._todo_service = todo_service
        self._step_index_map: Dict[str, int] = step_index_map or {}
        self._on_step_event = on_step_event
        self._trace_collector = trace_collector
        self._results: Dict[str, StepResult] = {}

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

    async def _execute_step(self, step: WorkflowStep) -> StepResult:
        """Execute a single step as a mini agent loop.

        Creates an isolated sub-session and runs an LLM + tool-call loop
        with a specialized system prompt for the step's assigned role.

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
        sub_session_id = f"orch_{self._parent_session_id}_{step.step_name}"
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

        # Determine which tools this agent can access
        step_tool_names = self._tool_names
        if role and role.tool_access:
            step_tool_names = [t for t in self._tool_names if t in role.tool_access]

        # Run mini agent loop
        tool_log: List[str] = []
        tool_call_traces: List[ToolCallTrace] = []
        llm_call_count = 0
        try:
            output, llm_call_count = await self._run_mini_loop(
                sub_session_id=sub_session_id,
                system_content=system_content,
                step_task=step.task,
                tool_names=step_tool_names,
                tool_log=tool_log,
                tool_call_traces=tool_call_traces,
            )
            result = StepResult(
                step_name=step.step_name,
                assigned_agent=step.assigned_agent,
                status=StepStatus.COMPLETED,
                output=output,
            )
        except Exception as e:
            logger.warning("Step %s mini-loop failed: %s", step.step_name, e)
            result = StepResult(
                step_name=step.step_name,
                assigned_agent=step.assigned_agent,
                status=StepStatus.FAILED,
                error=str(e),
            )

        step_ended = time.time()

        # Record step trace
        if self._trace_collector:
            output_preview = result.output[:300] if result.output else ""
            step_trace = StepTrace(
                step_name=step.step_name,
                assigned_agent=step.assigned_agent,
                status=result.status,
                started_at=step_started,
                ended_at=step_ended,
                duration_ms=round((step_ended - step_started) * 1000, 1),
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

    async def _run_mini_loop(
        self,
        sub_session_id: str,
        system_content: str,
        step_task: str,
        tool_names: List[str],
        tool_log: Optional[List[str]] = None,
        tool_call_traces: Optional[List[ToolCallTrace]] = None,
    ) -> tuple:
        """Run a mini agent loop: LLM -> (tool call -> LLM)* -> text response.

        Args:
            sub_session_id: Isolated session for this step.
            system_content: The system prompt for this step's agent.
            step_task: The task description to send as initial user message.
            tool_names: Tools available to this mini agent.
            tool_log: Optional list to append tool call summaries to.
            tool_call_traces: Optional list to append ToolCallTrace objects to.

        Returns:
            Tuple of (final_text, llm_call_count).
        """
        tools = self._agent_service._resolve_tool_schemas(tool_names) if tool_names else []

        lc_messages = [
            SystemMessage(content=system_content),
            HumanMessage(content=step_task),
        ]

        llm_call_count = 0

        for iteration in range(1, settings.MAX_ORCHESTRATOR_STEP_ITERATIONS + 1):
            try:
                llm_call_count += 1
                if tools:
                    response = await self._llm.bind_tools(tools).ainvoke(lc_messages)
                else:
                    response = await self._llm.ainvoke(lc_messages)
            except Exception as e:
                logger.warning(
                    "Mini-loop LLM call failed (iteration %d): %s", iteration, e
                )
                raise

            # If no tool calls, return the text
            if not getattr(response, "tool_calls", None):
                return self._agent_service._extract_text(response.content), llm_call_count

            # Process tool calls
            lc_messages.append(response)

            for tc in response.tool_calls:
                tc_name = tc["name"]
                tc_args = tc["args"]
                tc_id = tc["id"]

                tc_start = time.time()
                tc_error = None
                try:
                    tool_result = await self._execute_tool(tc_name, tc_args, sub_session_id)
                except Exception as e:
                    tool_result = f"Error executing tool '{tc_name}': {e}"
                    tc_error = str(e)
                tc_duration = time.time() - tc_start

                # Build summaries for logging
                args_summary = ", ".join(
                    f"{k}={repr(v)[:60]}" for k, v in tc_args.items()
                ) if isinstance(tc_args, dict) else str(tc_args)[:80]
                result_preview = tool_result[:120].replace("\n", " ")

                # Log tool call for TODO result
                if tool_log is not None:
                    tool_log.append(f"{tc_name}({args_summary}) → {result_preview}")

                # Record detailed trace
                if tool_call_traces is not None:
                    tool_call_traces.append(ToolCallTrace(
                        tool_name=tc_name,
                        args_summary=args_summary,
                        result_preview=result_preview,
                        duration_ms=round(tc_duration * 1000, 1),
                        error=tc_error,
                    ))

                from langchain_core.messages import ToolMessage
                lc_messages.append(ToolMessage(content=tool_result, tool_call_id=tc_id))

        # Max iterations reached — extract whatever text we have
        return (
            f"[Step reached max iterations ({settings.MAX_ORCHESTRATOR_STEP_ITERATIONS})]",
            llm_call_count,
        )

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
        if not self._todo_service or step_name not in self._step_index_map:
            return
        try:
            idx = self._step_index_map[step_name]
            await self._todo_service.update_step(
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
