# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
TraceCollector — captures structured traces of the orchestration pipeline.

Records timing, inputs, and outputs for each phase (role extraction,
planning, execution, synthesis) and each individual step within the
execution phase.  The resulting trace can be rendered as markdown and
persisted alongside the TODO file for debugging and observability.
"""

import logging
import re
import time
from datetime import datetime, timezone
from typing import List, Optional

import httpx

from app.config import settings
from app.services.orchestrator.models import (
    DataFlowEdge,
    OrchestrationTrace,
    PhaseTrace,
    StepTrace,
    ToolCallTrace,
)

logger = logging.getLogger(__name__)


class TraceCollector:
    """Accumulates trace data during an orchestration pipeline run.

    Usage::

        trace = TraceCollector(session_id, user_message)
        trace.start_phase("role_extraction")
        ...
        trace.end_phase("role_extraction", output_summary="roles=[researcher, analyst]")

        trace.add_step_trace(step_trace)

        result = trace.finalize()
        await trace.persist()
    """

    def __init__(self, session_id: str, user_message: str) -> None:
        self._trace = OrchestrationTrace(
            session_id=session_id,
            user_message=user_message,
            started_at=time.time(),
        )
        self._phase_starts: dict[str, float] = {}

    # ------------------------------------------------------------------
    # Phase-level tracing
    # ------------------------------------------------------------------

    def start_phase(self, phase: str) -> None:
        """Record the start of a pipeline phase."""
        self._phase_starts[phase] = time.time()

    def end_phase(
        self,
        phase: str,
        output_summary: str = "",
        error: Optional[str] = None,
    ) -> None:
        """Record the end of a pipeline phase."""
        started = self._phase_starts.pop(phase, 0.0)
        ended = time.time()
        self._trace.phases.append(
            PhaseTrace(
                phase=phase,
                started_at=started,
                ended_at=ended,
                duration_ms=round((ended - started) * 1000, 1),
                output_summary=output_summary,
                error=error,
            )
        )

    # ------------------------------------------------------------------
    # Step-level tracing
    # ------------------------------------------------------------------

    def add_step_trace(self, step_trace: StepTrace) -> None:
        """Add a completed step trace."""
        self._trace.step_traces.append(step_trace)

    # ------------------------------------------------------------------
    # Metadata setters
    # ------------------------------------------------------------------

    def set_roles(self, role_names: List[str]) -> None:
        self._trace.roles_extracted = role_names

    def set_plan_info(self, steps_planned: int, batches_count: int) -> None:
        self._trace.steps_planned = steps_planned
        self._trace.batches_count = batches_count

    def set_fallback(self, reason: str) -> None:
        self._trace.fallback_used = True
        self._trace.fallback_reason = reason

    def set_synthesis_input(self, synthesis_input: str) -> None:
        self._trace.synthesis_input = synthesis_input

    def add_data_flow_edge(self, edge: DataFlowEdge) -> None:
        """Record a data transfer between two steps."""
        self._trace.data_flow_edges.append(edge)

    # ------------------------------------------------------------------
    # Finalization
    # ------------------------------------------------------------------

    def finalize(self) -> OrchestrationTrace:
        """Finalize the trace with end time and total duration."""
        self._trace.ended_at = time.time()
        self._trace.total_duration_ms = round(
            (self._trace.ended_at - self._trace.started_at) * 1000, 1
        )
        return self._trace

    @property
    def trace(self) -> OrchestrationTrace:
        return self._trace

    # ------------------------------------------------------------------
    # Markdown rendering
    # ------------------------------------------------------------------

    def render_markdown(self) -> str:
        """Render the trace as a human-readable markdown document."""
        t = self._trace
        lines: List[str] = []

        # Header
        lines.append("# Orchestration Trace")
        lines.append("")
        lines.append(f"**Session**: `{t.session_id}`")
        ts_str = datetime.fromtimestamp(t.started_at, tz=timezone.utc).strftime(
            "%Y-%m-%d %H:%M:%S UTC"
        )
        lines.append(f"**Started**: {ts_str}")
        lines.append(f"**Total Duration**: {t.total_duration_ms:,.1f}ms")
        if t.fallback_used:
            lines.append(f"**Fallback**: Yes - {t.fallback_reason}")
        lines.append("")

        # User message
        msg_preview = t.user_message[:200] + ("..." if len(t.user_message) > 200 else "")
        lines.append(f"**User Message**: {msg_preview}")
        lines.append("")

        # Phase timeline
        lines.append("## Pipeline Phases")
        lines.append("")
        if t.phases:
            lines.append("| Phase | Duration | Status |")
            lines.append("|-------|----------|--------|")
            for p in t.phases:
                status = f"Error: {p.error}" if p.error else "OK"
                lines.append(f"| {p.phase} | {p.duration_ms:,.1f}ms | {status} |")
            total_phase_ms = sum(p.duration_ms for p in t.phases)
            lines.append(f"| **Total** | **{total_phase_ms:,.1f}ms** | |")
        else:
            lines.append("_No phases recorded._")
        lines.append("")

        # Phase details
        for p in t.phases:
            if p.output_summary or p.error:
                lines.append(f"### {p.phase}")
                if p.output_summary:
                    for detail_line in p.output_summary.splitlines():
                        lines.append(f"> {detail_line}")
                if p.error:
                    lines.append(f"> **Error**: {p.error}")
                lines.append("")

        # Roles & plan summary
        if t.roles_extracted:
            lines.append("## Roles Extracted")
            lines.append("")
            for role in t.roles_extracted:
                lines.append(f"- `{role}`")
            lines.append("")

        if t.steps_planned > 0:
            lines.append(f"**Steps Planned**: {t.steps_planned} across {t.batches_count} batch(es)")
            lines.append("")

        # Step execution details
        if t.step_traces:
            lines.append("## Step Execution Details")
            lines.append("")

            for st in t.step_traces:
                status_icon = {
                    "completed": "V",
                    "failed": "X",
                    "skipped": "O",
                    "in_progress": "~",
                    "pending": ".",
                }.get(st.status.value, "?")

                lines.append(f"### {status_icon} {st.step_name} ({st.assigned_agent})")
                lines.append("")
                lines.append(f"- **Status**: {st.status.value}")
                lines.append(f"- **Duration**: {st.duration_ms:,.1f}ms")
                lines.append(f"- **LLM Calls**: {st.llm_call_count}")
                lines.append(f"- **Tool Calls**: {len(st.tool_calls)}")

                if st.output_preview:
                    lines.append(f"- **Output**: {st.output_preview}")
                if st.error:
                    lines.append(f"- **Error**: {st.error}")
                lines.append("")

                # System prompt sent to this agent
                if st.system_prompt:
                    lines.append("**System Prompt**:")
                    lines.append("")
                    lines.append("<details>")
                    lines.append("<summary>Click to expand</summary>")
                    lines.append("")
                    lines.append("```")
                    lines.append(st.system_prompt)
                    lines.append("```")
                    lines.append("")
                    lines.append("</details>")
                    lines.append("")

                # Context received from previous agents
                if st.context_received:
                    lines.append("**Context Received** (from previous agents):")
                    lines.append("")
                    lines.append("<details>")
                    lines.append("<summary>Click to expand</summary>")
                    lines.append("")
                    lines.append("```")
                    lines.append(st.context_received)
                    lines.append("```")
                    lines.append("")
                    lines.append("</details>")
                    lines.append("")

                # Tool call details
                if st.tool_calls:
                    lines.append("**Tool Calls**:")
                    lines.append("")
                    for i, tc in enumerate(st.tool_calls, 1):
                        err_part = f" (**Error**: {tc.error})" if tc.error else ""
                        lines.append(
                            f"{i}. `{tc.tool_name}` ({tc.duration_ms:,.0f}ms){err_part}"
                        )
                        if tc.args_summary:
                            lines.append(f"   - Args: {tc.args_summary}")
                        if tc.result_preview:
                            preview = tc.result_preview.replace("\n", " ")
                            lines.append(f"   - Result: {preview}")
                    lines.append("")

                # Full output (what this agent passes to next agents)
                if st.full_output:
                    lines.append("**Full Output** (passed to dependent agents):")
                    lines.append("")
                    lines.append("<details>")
                    lines.append("<summary>Click to expand</summary>")
                    lines.append("")
                    for out_line in st.full_output.splitlines():
                        lines.append(f"> {out_line}")
                    lines.append("")
                    lines.append("</details>")
                    lines.append("")

        # Data flow between agents
        if t.data_flow_edges:
            lines.append("## Data Flow Between Agents")
            lines.append("")
            lines.append("| From (step -> agent) | To (step -> agent) | Data Size | Preview |")
            lines.append("|---------------------|--------------------|-----------:|---------|")
            for edge in t.data_flow_edges:
                preview = edge.data_preview[:80].replace("\n", " ").replace("|", "\\|")
                if len(edge.data_preview) > 80:
                    preview += "..."
                status_mark = "" if edge.status == "completed" else f" [{edge.status}]"
                lines.append(
                    f"| {edge.source_step} -> `{edge.source_agent}`{status_mark} "
                    f"| {edge.target_step} -> `{edge.target_agent}` "
                    f"| {edge.data_size:,} chars "
                    f"| {preview} |"
                )
            lines.append("")

        # Synthesis input (how all outputs were combined for final response)
        if t.synthesis_input:
            lines.append("## Synthesis Input")
            lines.append("")
            lines.append("The following combined agent outputs were sent to the synthesis LLM:")
            lines.append("")
            lines.append("<details>")
            lines.append("<summary>Click to expand</summary>")
            lines.append("")
            for syn_line in t.synthesis_input.splitlines():
                lines.append(f"> {syn_line}")
            lines.append("")
            lines.append("</details>")
            lines.append("")

        # Footer
        lines.append("---")
        completed = sum(1 for s in t.step_traces if s.status.value == "completed")
        failed = sum(1 for s in t.step_traces if s.status.value == "failed")
        skipped = sum(1 for s in t.step_traces if s.status.value == "skipped")
        total = len(t.step_traces)
        lines.append(
            f"Summary: {completed}/{total} completed, "
            f"{failed} failed, {skipped} skipped | "
            f"Total: {t.total_duration_ms:,.1f}ms"
        )

        return "\n".join(lines)

    # ------------------------------------------------------------------
    # Persistence
    # ------------------------------------------------------------------

    @staticmethod
    def _make_trace_filename(user_message: str) -> str:
        """Generate a unique trace filename from the user message."""
        slug = re.sub(r"[^a-z0-9]+", "-", user_message.lower()).strip("-")[:40]
        ts = datetime.now(timezone.utc).strftime("%H%M%S")
        return f"TRACE-{slug}-{ts}.md"

    async def persist(self, session_id: str) -> None:
        """Write trace markdown to session files via Platform API."""
        content = self.render_markdown()
        filename = self._make_trace_filename(self._trace.user_message)
        url = f"{settings.MCP_SERVER_URL}/api/v1/sessions/{session_id}/files/write/"

        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.post(url, json={
                    "path": filename,
                    "content": content,
                    "created_by": "agent",
                })
                if resp.status_code not in (200, 201):
                    logger.warning("Failed to write trace %s: %s", filename, resp.text)
                else:
                    logger.debug("Trace persisted: %s", filename)
        except Exception as e:
            logger.warning("Failed to write trace %s: %s", filename, e)
