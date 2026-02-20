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
            }
            (sa_dir / "meta.json").write_text(
                json.dumps(meta, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            (sa_dir / "result.md").write_text(result_summary or "", encoding="utf-8")
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
