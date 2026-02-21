# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Workflow pipeline runner.

Runs the full multi-agent orchestration pipeline triggered when
``manage_todo(action="create")`` returns a workflow signal:
  task
  -> RoleExtractor
  -> WorkflowPlanner + build_team_batches
  -> PlanSkill.create_orchestrated
  -> TeamExecutor.execute_all_batches
  -> Synthesizer.synthesize / stream_synthesize
  -> TraceCollector.persist

Provides both ``run()`` (non-streaming) and ``stream_events()`` (SSE)
interfaces for integration with the agent loop.
"""

import asyncio
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
from app.services.orchestrator.result_store import AgentResultStore
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
        skill_provider: SkillProvider for agent skill catalog and plan_task access.
        tool_names: All available tool names.
        session_id: The parent conversation session ID.
        user_message: The task description to orchestrate.
    """

    def __init__(
        self,
        llm,
        agent_service,
        execute_tool: ToolExecutorFn,
        skill_provider,
        tool_names: List[str],
        session_id: str,
        user_message: str,
    ) -> None:
        self._llm = llm
        self._agent_service = agent_service
        self._execute_tool = execute_tool
        self._skill_provider = skill_provider
        self._plan_skill = skill_provider._skills.get("plan_task")
        self._tool_names = tool_names
        self._session_id = session_id
        self._user_message = user_message
        self._trace = TraceCollector(session_id, user_message)
        self._result_store = AgentResultStore(settings.AGENT_WORK_DIR, session_id)

    async def run(self) -> Optional[str]:
        """Execute the full orchestration pipeline (non-streaming).

        Returns:
            The synthesized final answer text, or None on failure.
        """
        try:
            # Phase 1: Role extraction
            self._trace.start_phase("role_extraction")
            catalog = self._skill_provider.get_agent_skill_catalog()
            role_extractor = RoleExtractor(self._llm)
            _t0 = time.time()
            extraction = await role_extractor.extract(
                self._user_message, self._tool_names, skill_reference=catalog,
            )
            _role_extraction_ms = (time.time() - _t0) * 1000
            roles = extraction.roles
            self._trace.set_roles([r.role_type for r in roles])
            self._trace.end_phase(
                "role_extraction",
                output_summary=f"roles={[r.role_type for r in roles]}",
            )
            self._result_store.save_orchestrator_phase(
                phase_name="role_extraction",
                context={"task": self._user_message, "available_tools": self._tool_names},
                result_summary={
                    "roles": [
                        {"role_type": r.role_type, "objective": r.objective, "tool_access": r.tool_access}
                        for r in roles
                    ],
                },
                duration_ms=_role_extraction_ms,
            )

            # Phase 2: Workflow planning
            self._trace.start_phase("planning")
            planner = WorkflowPlanner(self._llm)
            _t0 = time.time()
            plan = await planner.plan(self._user_message, roles)
            _planning_ms = (time.time() - _t0) * 1000
            batches = WorkflowPlanner.build_team_batches(plan.steps)
            self._trace.set_plan_info(len(plan.steps), len(batches))
            self._trace.end_phase(
                "planning",
                output_summary=f"steps={len(plan.steps)}, batches={len(batches)}",
            )
            self._result_store.save_orchestrator_phase(
                phase_name="planning",
                context={
                    "task": self._user_message,
                    "roles": [r.role_type for r in roles],
                },
                result_summary={
                    "steps": [
                        {
                            "step_name": s.step_name,
                            "task": s.task,
                            "assigned_agent": s.assigned_agent,
                            "depends_on": list(s.depends_on),
                        }
                        for s in plan.steps
                    ],
                    "batch_count": len(batches),
                },
                duration_ms=_planning_ms,
            )

            # Persist workflow plan to filesystem
            self._result_store.save_workflow(
                roles=[{"role_type": r.role_type, "objective": r.objective} for r in roles],
                steps=[{"step_name": s.step_name, "task": s.task, "assigned_agent": s.assigned_agent, "depends_on": s.depends_on} for s in plan.steps],
                batches=[{"batch_index": i, "steps": [s.step_name for s in b.steps]} for i, b in enumerate(batches)],
            )

            # Build batch_index_map: step_name -> batch index
            batch_index_map: Dict[str, int] = {}
            for batch_idx, batch in enumerate(batches):
                for bstep in batch.steps:
                    batch_index_map[bstep.step_name] = batch_idx

            # Phase 3: TODO creation
            self._trace.start_phase("todo_creation")
            await self._plan_skill.create_orchestrated(
                self._session_id, self._user_message, plan.steps,
                batch_index_map=batch_index_map,
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
                plan_skill=self._plan_skill,
                step_index_map=step_index_map,
                trace_collector=self._trace,
                result_store=self._result_store,
                skill_provider=self._skill_provider,
            )
            step_results = await executor.execute_all_batches(batches)
            executor.cleanup_registry()
            self._trace.end_phase(
                "execution",
                output_summary=f"completed={sum(1 for r in step_results if r.status.value == 'completed')}/{len(step_results)}",
            )

            # Phase 5: Synthesis
            self._trace.start_phase("synthesis")
            synthesizer = Synthesizer(self._llm)
            _t0 = time.time()
            final_answer = await synthesizer.synthesize(
                self._user_message, step_results,
            )
            _synthesis_ms = (time.time() - _t0) * 1000
            synthesis_input = synthesizer.get_last_synthesis_input()
            self._trace.set_synthesis_input(synthesis_input)
            self._trace.end_phase("synthesis")

            # Persist synthesis to filesystem
            self._result_store.save_synthesis(final_answer or "")
            self._result_store.save_orchestrator_phase(
                phase_name="synthesis",
                context={"task": self._user_message, "synthesis_input": synthesis_input},
                result_summary={"answer_length": len(final_answer or "")},
                duration_ms=_synthesis_ms,
            )

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
            catalog = self._skill_provider.get_agent_skill_catalog()
            role_extractor = RoleExtractor(self._llm)
            _t0 = time.time()
            extraction = await role_extractor.extract(
                self._user_message, self._tool_names, skill_reference=catalog,
            )
            _role_extraction_ms = (time.time() - _t0) * 1000
            roles = extraction.roles
            self._trace.set_roles([r.role_type for r in roles])
            self._trace.end_phase(
                "role_extraction",
                output_summary=f"roles={[r.role_type for r in roles]}",
            )
            self._result_store.save_orchestrator_phase(
                phase_name="role_extraction",
                context={"task": self._user_message, "available_tools": self._tool_names},
                result_summary={
                    "roles": [
                        {"role_type": r.role_type, "objective": r.objective, "tool_access": r.tool_access}
                        for r in roles
                    ],
                },
                duration_ms=_role_extraction_ms,
            )
            yield {
                "type": "response.orchestration.phase_completed",
                "phase": "role_extraction",
                "roles": [r.role_type for r in roles],
            }

            # Phase 2: Workflow planning
            self._trace.start_phase("planning")
            planner = WorkflowPlanner(self._llm)
            _t0 = time.time()
            plan = await planner.plan(self._user_message, roles)
            _planning_ms = (time.time() - _t0) * 1000
            batches = WorkflowPlanner.build_team_batches(plan.steps)
            self._trace.set_plan_info(len(plan.steps), len(batches))
            self._trace.end_phase(
                "planning",
                output_summary=f"steps={len(plan.steps)}, batches={len(batches)}",
            )
            self._result_store.save_orchestrator_phase(
                phase_name="planning",
                context={
                    "task": self._user_message,
                    "roles": [r.role_type for r in roles],
                },
                result_summary={
                    "steps": [
                        {
                            "step_name": s.step_name,
                            "task": s.task,
                            "assigned_agent": s.assigned_agent,
                            "depends_on": list(s.depends_on),
                        }
                        for s in plan.steps
                    ],
                    "batch_count": len(batches),
                },
                duration_ms=_planning_ms,
            )

            # Persist workflow plan to filesystem
            self._result_store.save_workflow(
                roles=[{"role_type": r.role_type, "objective": r.objective} for r in roles],
                steps=[{"step_name": s.step_name, "task": s.task, "assigned_agent": s.assigned_agent, "depends_on": s.depends_on} for s in plan.steps],
                batches=[{"batch_index": i, "steps": [s.step_name for s in b.steps]} for i, b in enumerate(batches)],
            )

            yield {
                "type": "response.orchestration.phase_completed",
                "phase": "planning",
                "steps": len(plan.steps),
                "batches": len(batches),
            }

            # Build batch_index_map: step_name -> batch index
            batch_index_map: Dict[str, int] = {}
            for batch_idx, batch in enumerate(batches):
                for bstep in batch.steps:
                    batch_index_map[bstep.step_name] = batch_idx

            # Phase 3: TODO creation
            self._trace.start_phase("todo_creation")
            await self._plan_skill.create_orchestrated(
                self._session_id, self._user_message, plan.steps,
                batch_index_map=batch_index_map,
            )
            step_index_map = {
                s.step_name: i for i, s in enumerate(plan.steps)
            }
            self._trace.end_phase("todo_creation")

            # Emit TODO state
            todo_state = self._plan_skill.get_state(self._session_id)
            if todo_state:
                _todo_event = {
                    "type": "response.todo.updated",
                    "todo": {
                        "task": todo_state.task,
                        "steps": [
                            {
                                "description": s.description,
                                "status": s.status,
                                "result": s.result,
                                "step_name": s.step_name,
                                "assigned_agent": s.assigned_agent,
                                "batch_index": s.batch_index,
                            }
                            for s in todo_state.steps
                        ],
                    },
                }
                logger.info(
                    "Emitting initial todo.updated — batch_index_map=%s, steps=%s",
                    batch_index_map,
                    [(s.step_name, s.batch_index) for s in todo_state.steps],
                )
                yield _todo_event

            # Phase 4: Execution with real-time step events via asyncio.Queue
            self._trace.start_phase("execution")
            event_queue: asyncio.Queue = asyncio.Queue()
            _DONE = object()

            async def on_step_event(event_type: str, data: dict) -> None:
                # Emit the step event immediately
                await event_queue.put({"type": event_type, **data})
                # Also emit current TODO state so UI updates in real-time
                if self._plan_skill:
                    todo_state = self._plan_skill.get_state(self._session_id)
                    if todo_state:
                        await event_queue.put({
                            "type": "response.todo.updated",
                            "todo": {
                                "task": todo_state.task,
                                "steps": [
                                    {
                                        "description": s.description,
                                        "status": s.status,
                                        "result": s.result,
                                        "step_name": s.step_name,
                                        "assigned_agent": s.assigned_agent,
                                        "batch_index": s.batch_index,
                                    }
                                    for s in todo_state.steps
                                ],
                            },
                        })

            executor = TeamExecutor(
                llm=self._llm,
                agent_service=self._agent_service,
                execute_tool=self._execute_tool,
                tool_names=self._tool_names,
                parent_session_id=self._session_id,
                roles=roles,
                plan_skill=self._plan_skill,
                step_index_map=step_index_map,
                on_step_event=on_step_event,
                trace_collector=self._trace,
                result_store=self._result_store,
                skill_provider=self._skill_provider,
            )

            # Emit synthetic sessions_spawn events to trigger frontend
            # SubagentProgressCard polling.  The frontend skips sessions_spawn
            # from the tool-call UI but remembers the call_id; when the
            # matching tool_result arrives with status "accepted", it starts
            # polling GET /subagent/status/{parentSessionId} which discovers
            # all children spawned by TeamExecutor.
            _poll_call_id = f"orch-{self._session_id}"
            yield {
                "type": "response.function_call.done",
                "item": {
                    "call_id": _poll_call_id,
                    "name": "sessions_spawn",
                    "arguments": json.dumps({"task": self._user_message}),
                },
            }
            yield {
                "type": "response.tool_result.done",
                "call_id": _poll_call_id,
                "status": "completed",
                "output": json.dumps({"status": "accepted"}),
            }

            async def _run_execution():
                try:
                    return await executor.execute_all_batches(batches)
                finally:
                    await event_queue.put(_DONE)

            exec_task = asyncio.create_task(_run_execution())

            # Consume events in real-time as steps start/complete
            while True:
                event = await event_queue.get()
                if event is _DONE:
                    break
                yield event

            step_results = await exec_task
            self._trace.end_phase(
                "execution",
                output_summary=f"completed={sum(1 for r in step_results if r.status.value == 'completed')}/{len(step_results)}",
            )

            # Give frontend polling time to observe final child states
            # before cleaning up registry records (poll interval = 3s).
            await asyncio.sleep(5)
            executor.cleanup_registry()

            # Phase 5: Streaming synthesis
            self._trace.start_phase("synthesis")
            synthesizer = Synthesizer(self._llm)
            full_text_parts: List[str] = []
            _t0 = time.time()

            async for chunk in synthesizer.stream_synthesize(
                self._user_message, step_results,
            ):
                full_text_parts.append(chunk)
                yield {"type": "response.output_text.delta", "delta": chunk}

            full_text = "".join(full_text_parts)
            _synthesis_ms = (time.time() - _t0) * 1000
            synthesis_input = synthesizer.get_last_synthesis_input()
            self._trace.set_synthesis_input(synthesis_input)
            self._trace.end_phase("synthesis")

            # Persist synthesis to filesystem
            self._result_store.save_synthesis(full_text)
            self._result_store.save_orchestrator_phase(
                phase_name="synthesis",
                context={"task": self._user_message, "synthesis_input": synthesis_input},
                result_summary={"answer_length": len(full_text)},
                duration_ms=_synthesis_ms,
            )

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
