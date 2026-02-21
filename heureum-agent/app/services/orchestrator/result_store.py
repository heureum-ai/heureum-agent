# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Filesystem-based agent result store.

Persists orchestration artifacts (workflow plans, step results, sub-agent
outputs, synthesis) to a structured directory tree so that:
  - Concurrent sub-agents never contend on the same file (each writes to
    its own directory).
  - Results are human-readable (``cat result.md``).
  - Agents can read each other's output via the filesystem as a fallback
    when in-memory state is unavailable.

Directory layout::

    data/sessions/{parent_session_id}/
    ├── workflow.json
    ├── steps/
    │   ├── {step_name}/
    │   │   ├── meta.json
    │   │   ├── prompt.md
    │   │   ├── result.md
    │   │   └── subagents/
    │   │       ├── {child_session_id}/
    │   │       │   ├── meta.json
    │   │       │   └── result.md
    │   │       └── ...
    │   └── ...
    └── synthesis.md

All writes are wrapped in try/except so filesystem failures never
interrupt the orchestration pipeline.
"""

import json
import logging
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

logger = logging.getLogger(__name__)


class AgentResultStore:
    """Filesystem I/O layer for orchestration results.

    Args:
        base_dir: Root directory for all session data (e.g. ``"data"``).
        session_id: The parent orchestration session ID.
    """

    def __init__(self, base_dir: str, session_id: str) -> None:
        self._root = Path(base_dir) / "sessions" / session_id
        self._root.mkdir(parents=True, exist_ok=True)

    # ------------------------------------------------------------------
    # Workflow
    # ------------------------------------------------------------------

    def save_workflow(
        self,
        roles: List[Dict[str, Any]],
        steps: List[Dict[str, Any]],
        batches: List[Dict[str, Any]],
    ) -> None:
        """Persist the workflow plan as ``workflow.json``."""
        try:
            payload = {
                "saved_at": time.time(),
                "roles": roles,
                "steps": steps,
                "batches": batches,
            }
            (self._root / "workflow.json").write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception:
            logger.warning("Failed to save workflow.json", exc_info=True)

    # ------------------------------------------------------------------
    # Step results
    # ------------------------------------------------------------------

    def save_step_prompt(self, step_name: str, prompt: str) -> None:
        """Persist the system prompt used for the step as ``steps/{name}/prompt.md``."""
        try:
            path = self._root / "steps" / step_name / "prompt.md"
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(prompt, encoding="utf-8")
        except Exception:
            logger.warning("Failed to save step prompt for %s", step_name, exc_info=True)

    def save_step_messages(
        self,
        step_name: str,
        child_session_id: str,
        task: str,
        status: str,
        merged_messages: Optional[List[Dict[str, Any]]] = None,
        progress_log: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        """Persist the step agent's own messages to ``steps/{name}/messages.json``.

        This is distinct from ``save_subagent_result`` (which logs sub-sub-agents).
        Here we log the step agent itself — the "상위 에이전트" for each step.
        """
        try:
            step_dir = self._root / "steps" / step_name
            step_dir.mkdir(parents=True, exist_ok=True)
            payload = {
                "saved_at": time.time(),
                "child_session_id": child_session_id,
                "step_name": step_name,
                "task": task,
                "status": status,
                "messages": merged_messages or [],
                "tool_progress": progress_log or [],
            }
            (step_dir / "messages.json").write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception:
            logger.warning("Failed to save step messages for %s", step_name, exc_info=True)

    def save_step_result(
        self,
        step_name: str,
        result: Any,
        duration_ms: float,
        task: str = "",
    ) -> None:
        """Persist a step result to ``steps/{name}/meta.json`` + ``result.md``."""
        try:
            step_dir = self._root / "steps" / step_name
            step_dir.mkdir(parents=True, exist_ok=True)

            meta = {
                "step_name": step_name,
                "task": task,
                "status": result.status.value if hasattr(result, "status") else "unknown",
                "assigned_agent": getattr(result, "assigned_agent", ""),
                "duration_ms": round(duration_ms, 1),
                "saved_at": time.time(),
                "error": getattr(result, "error", None),
            }
            (step_dir / "meta.json").write_text(
                json.dumps(meta, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )

            output = getattr(result, "output", None) or getattr(result, "error", "") or ""
            (step_dir / "result.md").write_text(output, encoding="utf-8")
        except Exception:
            logger.warning("Failed to save step result for %s", step_name, exc_info=True)

    def read_step_result(self, step_name: str) -> Optional[str]:
        """Read ``steps/{name}/result.md``, returning *None* if missing."""
        try:
            path = self._root / "steps" / step_name / "result.md"
            if path.exists():
                return path.read_text(encoding="utf-8")
        except Exception:
            logger.warning("Failed to read step result for %s", step_name, exc_info=True)
        return None

    def load_step_result(self, step_name: str) -> Optional[Any]:
        """Read ``meta.json`` + ``result.md`` and reconstruct a ``StepResult``.

        Unlike :meth:`read_step_result` (which returns raw text only), this
        method returns a full ``StepResult`` object so callers can inspect
        status, assigned_agent, error, etc.
        """
        try:
            step_dir = self._root / "steps" / step_name
            meta_path = step_dir / "meta.json"
            result_path = step_dir / "result.md"

            if not meta_path.exists():
                return None

            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            output = result_path.read_text(encoding="utf-8") if result_path.exists() else ""

            from app.services.orchestrator.models import StepResult, StepStatus

            return StepResult(
                step_name=meta.get("step_name", step_name),
                assigned_agent=meta.get("assigned_agent", ""),
                status=StepStatus(meta.get("status", "pending")),
                output=output if meta.get("status") != "failed" else "",
                error=meta.get("error"),
            )
        except Exception:
            logger.warning("Failed to load step result for %s", step_name, exc_info=True)
            return None

    # ------------------------------------------------------------------
    # Sub-agent results (nested under a step)
    # ------------------------------------------------------------------

    def save_subagent_result(
        self,
        step_name: str,
        child_session_id: str,
        task: str,
        status: str,
        result_summary: str,
        merged_messages: Optional[List[Dict[str, Any]]] = None,
        progress_log: Optional[List[Dict[str, Any]]] = None,
    ) -> None:
        """Persist a sub-agent result under ``steps/{step}/subagents/{child}/``."""
        try:
            sa_dir = self._root / "steps" / step_name / "subagents" / child_session_id
            sa_dir.mkdir(parents=True, exist_ok=True)

            meta = {
                "child_session_id": child_session_id,
                "step_name": step_name,
                "task": task[:500],
                "status": status,
                "saved_at": time.time(),
                "message_count": len(merged_messages or []),
                "tool_call_count": len(progress_log or []),
            }
            (sa_dir / "meta.json").write_text(
                json.dumps(meta, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            (sa_dir / "result.md").write_text(result_summary or "", encoding="utf-8")
            payload = {
                "saved_at": time.time(),
                "child_session_id": child_session_id,
                "step_name": step_name,
                "messages": merged_messages or [],
                "tool_progress": progress_log or [],
            }
            (sa_dir / "messages.json").write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception:
            logger.warning(
                "Failed to save subagent result for %s/%s",
                step_name,
                child_session_id,
                exc_info=True,
            )

    def read_subagent_result(
        self,
        step_name: str,
        child_session_id: str,
    ) -> Optional[str]:
        """Read ``steps/{step}/subagents/{child}/result.md``."""
        try:
            path = (
                self._root / "steps" / step_name / "subagents" / child_session_id / "result.md"
            )
            if path.exists():
                return path.read_text(encoding="utf-8")
        except Exception:
            logger.warning(
                "Failed to read subagent result for %s/%s",
                step_name,
                child_session_id,
                exc_info=True,
            )
        return None

    # ------------------------------------------------------------------
    # Synthesis
    # ------------------------------------------------------------------

    def save_synthesis(self, text: str) -> None:
        """Persist the final synthesized answer as ``synthesis.md``."""
        try:
            (self._root / "synthesis.md").write_text(text or "", encoding="utf-8")
        except Exception:
            logger.warning("Failed to save synthesis.md", exc_info=True)

    # ------------------------------------------------------------------
    # Main agent run (non-workflow interactions)
    # ------------------------------------------------------------------

    def save_main_agent_run(
        self,
        output_items: List[Any],
        final_text: str,
        iteration: int,
        tool_call_count: int,
        usage: Dict[str, Any],
        run_ts: Optional[str] = None,
    ) -> None:
        """Persist a main agent request run to ``agent_run/{ts}/``.

        Captures all tool calls + results and the final response text so
        non-workflow interactions are stored alongside orchestration artifacts.

        Args:
            output_items: FunctionToolCall and FunctionToolResult items from ctx.
            final_text: The final text response returned to the user.
            iteration: Number of LLM iterations in this run.
            tool_call_count: Total tool calls made.
            usage: Token usage dict.
            run_ts: Optional HHMMSS timestamp string (auto-generated if None).
        """
        try:
            if run_ts is None:
                from datetime import datetime, timezone
                run_ts = datetime.now(timezone.utc).strftime("%H%M%S")
            run_dir = self._root / "agent_run" / run_ts
            run_dir.mkdir(parents=True, exist_ok=True)

            items: List[Any] = []
            for item in output_items:
                try:
                    if hasattr(item, "model_dump"):
                        items.append(item.model_dump())
                    elif isinstance(item, dict):
                        items.append(item)
                except Exception:
                    items.append({"error": "serialization_failed"})

            payload = {
                "saved_at": time.time(),
                "iteration": iteration,
                "tool_call_count": tool_call_count,
                "usage": usage,
                "items": items,
            }
            (run_dir / "tool_calls.json").write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            (run_dir / "result.md").write_text(final_text or "", encoding="utf-8")
        except Exception:
            logger.warning("Failed to save main agent run log", exc_info=True)

    # ------------------------------------------------------------------
    # Orchestrator phase logs
    # ------------------------------------------------------------------

    def save_orchestrator_phase(
        self,
        phase_name: str,
        context: Dict[str, Any],
        result_summary: Any,
        duration_ms: float,
    ) -> None:
        """Persist an orchestrator LLM phase log to ``orchestrator/{phase}.json``.

        Args:
            phase_name: e.g. "role_extraction", "planning", "synthesis".
            context: Input context (task, roles, etc.) sent to the LLM.
            result_summary: Structured result produced by the LLM phase.
            duration_ms: Wall-clock duration of the LLM call in milliseconds.
        """
        try:
            orch_dir = self._root / "orchestrator"
            orch_dir.mkdir(parents=True, exist_ok=True)

            payload = {
                "saved_at": time.time(),
                "phase": phase_name,
                "duration_ms": round(duration_ms, 1),
                "context": context,
                "result": result_summary,
            }
            (orch_dir / f"{phase_name}.json").write_text(
                json.dumps(payload, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
        except Exception:
            logger.warning(
                "Failed to save orchestrator phase log: %s", phase_name, exc_info=True
            )
