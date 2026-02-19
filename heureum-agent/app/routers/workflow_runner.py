# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Workflow pipeline runner.

Runs the full multi-agent orchestration pipeline triggered when
``manage_todo(action="create")`` returns a workflow signal:
  task
  -> RoleExtractor
  -> WorkflowPlanner + build_team_batches
  -> TodoService._create_orchestrated
  -> TeamExecutor.execute_all_batches
  -> Synthesizer.synthesize / stream_synthesize
  -> TraceCollector.persist

Provides both ``run()`` (non-streaming) and ``stream_events()`` (SSE)
interfaces for integration with the agent loop.
"""

import json
import logging
import time
from typing import Any, Callable, Coroutine, Dict, List, Optional

from app.config import settings
from app.services.orchestrator import (
    RoleExtractor,
    Synthesizer,
    TeamExecutor,
    WorkflowPlanner,
)
from app.services.orchestrator.trace import TraceCollector

logger = logging.getLogger(__name__)

# Type alias matching team_executor.py
ToolExecutorFn = Callable[[str, Dict[str, Any], str], Coroutine[Any, Any, str]]


def _sse_event(event: dict) -> str:
    """Format a dict as an SSE data line."""
    return f"data: {json.dumps(event)}\n\n"


class WorkflowRunner:
    """Runs the full workflow orchestration pipeline for a single task.

    Args:
        llm: The LangChain LLM instance.
        agent_service: AgentService for session/history management.
        execute_tool: Async callable ``(name, args, session_id) -> str``.
        todo_service: TodoService for plan tracking.
        tool_names: All available tool names.
        session_id: The parent conversation session ID.
        user_message: The task description to orchestrate.
    """

    def __init__(
        self,
        llm,
        agent_service,
        execute_tool: ToolExecutorFn,
        todo_service,
        tool_names: List[str],
        session_id: str,
        user_message: str,
    ) -> None:
        self._llm = llm
        self._agent_service = agent_service
        self._execute_tool = execute_tool
        self._todo_service = todo_service
        self._tool_names = tool_names
        self._session_id = session_id
        self._user_message = user_message
        self._trace = TraceCollector(session_id, user_message)

    async def run(self) -> Optional[str]:
        """Execute the full orchestration pipeline (non-streaming).

        Returns:
            The synthesized final answer text, or None on failure.
        """
        try:
            # Phase 1: Role extraction
            self._trace.start_phase("role_extraction")
            role_extractor = RoleExtractor(self._llm)
            extraction = await role_extractor.extract(
                self._user_message, self._tool_names,
            )
            roles = extraction.roles
            self._trace.set_roles([r.role_type for r in roles])
            self._trace.end_phase(
                "role_extraction",
                output_summary=f"roles={[r.role_type for r in roles]}",
            )

            # Phase 2: Workflow planning
            self._trace.start_phase("planning")
            planner = WorkflowPlanner(self._llm)
            plan = await planner.plan(self._user_message, roles)
            batches = WorkflowPlanner.build_team_batches(plan.steps)
            self._trace.set_plan_info(len(plan.steps), len(batches))
            self._trace.end_phase(
                "planning",
                output_summary=f"steps={len(plan.steps)}, batches={len(batches)}",
            )

            # Phase 3: TODO creation
            self._trace.start_phase("todo_creation")
            await self._todo_service._create_orchestrated(
                self._session_id, self._user_message, plan.steps,
            )
            step_index_map = {
                s.step_name: i for i, s in enumerate(plan.steps)
            }
            self._trace.end_phase("todo_creation")

            # Phase 4: Execution
            self._trace.start_phase("execution")
            executor = TeamExecutor(
                llm=self._llm,
                agent_service=self._agent_service,
                execute_tool=self._execute_tool,
                tool_names=self._tool_names,
                parent_session_id=self._session_id,
                roles=roles,
                todo_service=self._todo_service,
                step_index_map=step_index_map,
                trace_collector=self._trace,
            )
            step_results = await executor.execute_all_batches(batches)
            self._trace.end_phase(
                "execution",
                output_summary=f"completed={sum(1 for r in step_results if r.status.value == 'completed')}/{len(step_results)}",
            )

            # Phase 5: Synthesis
            self._trace.start_phase("synthesis")
            synthesizer = Synthesizer(self._llm)
            final_answer = await synthesizer.synthesize(
                self._user_message, step_results,
            )
            self._trace.set_synthesis_input(synthesizer.get_last_synthesis_input())
            self._trace.end_phase("synthesis")

            # Finalize and persist trace
            self._trace.finalize()
            try:
                await self._trace.persist(self._session_id)
            except Exception:
                logger.warning("Trace persist failed", exc_info=True)

            return final_answer

        except Exception as e:
            logger.warning("Workflow pipeline failed: %s", e, exc_info=True)
            self._trace.set_fallback(str(e))
            self._trace.finalize()
            return None

    async def stream_events(self):
        """Async generator yielding SSE-formatted event dicts during pipeline execution.

        Yields dicts (not formatted strings) so the caller can integrate with
        the existing agent loop SSE emission.
        """
        try:
            # Phase 1: Role extraction
            yield {"type": "response.orchestration.started", "session_id": self._session_id}

            self._trace.start_phase("role_extraction")
            role_extractor = RoleExtractor(self._llm)
            extraction = await role_extractor.extract(
                self._user_message, self._tool_names,
            )
            roles = extraction.roles
            self._trace.set_roles([r.role_type for r in roles])
            self._trace.end_phase(
                "role_extraction",
                output_summary=f"roles={[r.role_type for r in roles]}",
            )
            yield {
                "type": "response.orchestration.phase_completed",
                "phase": "role_extraction",
                "roles": [r.role_type for r in roles],
            }

            # Phase 2: Workflow planning
            self._trace.start_phase("planning")
            planner = WorkflowPlanner(self._llm)
            plan = await planner.plan(self._user_message, roles)
            batches = WorkflowPlanner.build_team_batches(plan.steps)
            self._trace.set_plan_info(len(plan.steps), len(batches))
            self._trace.end_phase(
                "planning",
                output_summary=f"steps={len(plan.steps)}, batches={len(batches)}",
            )
            yield {
                "type": "response.orchestration.phase_completed",
                "phase": "planning",
                "steps": len(plan.steps),
                "batches": len(batches),
            }

            # Phase 3: TODO creation
            self._trace.start_phase("todo_creation")
            await self._todo_service._create_orchestrated(
                self._session_id, self._user_message, plan.steps,
            )
            step_index_map = {
                s.step_name: i for i, s in enumerate(plan.steps)
            }
            self._trace.end_phase("todo_creation")

            # Emit TODO state
            todo_state = self._todo_service.get_state(self._session_id)
            if todo_state:
                yield {
                    "type": "response.todo.updated",
                    "todo": {
                        "task": todo_state.task,
                        "steps": [
                            {"description": s.description, "status": s.status, "result": s.result}
                            for s in todo_state.steps
                        ],
                    },
                }

            # Phase 4: Execution with step events
            self._trace.start_phase("execution")
            step_events_queue: List[dict] = []

            async def on_step_event(event_type: str, data: dict) -> None:
                step_events_queue.append({"type": event_type, **data})

            executor = TeamExecutor(
                llm=self._llm,
                agent_service=self._agent_service,
                execute_tool=self._execute_tool,
                tool_names=self._tool_names,
                parent_session_id=self._session_id,
                roles=roles,
                todo_service=self._todo_service,
                step_index_map=step_index_map,
                on_step_event=on_step_event,
                trace_collector=self._trace,
            )
            step_results = await executor.execute_all_batches(batches)
            self._trace.end_phase(
                "execution",
                output_summary=f"completed={sum(1 for r in step_results if r.status.value == 'completed')}/{len(step_results)}",
            )

            # Flush step events
            for evt in step_events_queue:
                yield evt

            # Emit updated TODO state
            todo_state = self._todo_service.get_state(self._session_id)
            if todo_state:
                yield {
                    "type": "response.todo.updated",
                    "todo": {
                        "task": todo_state.task,
                        "steps": [
                            {"description": s.description, "status": s.status, "result": s.result}
                            for s in todo_state.steps
                        ],
                    },
                }

            # Phase 5: Streaming synthesis
            self._trace.start_phase("synthesis")
            synthesizer = Synthesizer(self._llm)
            full_text_parts: List[str] = []

            async for chunk in synthesizer.stream_synthesize(
                self._user_message, step_results,
            ):
                full_text_parts.append(chunk)
                yield {"type": "response.output_text.delta", "delta": chunk}

            full_text = "".join(full_text_parts)
            self._trace.set_synthesis_input(synthesizer.get_last_synthesis_input())
            self._trace.end_phase("synthesis")

            yield {"type": "response.output_text.done", "text": full_text}

            # Finalize trace
            self._trace.finalize()
            try:
                await self._trace.persist(self._session_id)
            except Exception:
                logger.warning("Trace persist failed", exc_info=True)

            yield {"type": "response.orchestration.completed", "final_text": full_text}

        except Exception as e:
            logger.exception("Streaming workflow pipeline error")
            self._trace.set_fallback(str(e))
            self._trace.finalize()
            yield {"type": "response.orchestration.failed", "error": str(e)}
