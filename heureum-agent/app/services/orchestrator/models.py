# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Data models for the dynamic multi-agent orchestration system.

Adapted from auto_prompt's DynamicAgentRole / WorkflowStep patterns,
extended with TeamBatch for parallel execution and StepResult for
tracking individual step outcomes.
"""

from enum import Enum
from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class DynamicAgentRole(BaseModel):
    """A dynamically-created agent role determined by the LLM.

    Each role represents a specialized sub-agent that the orchestrator
    will instantiate with a tailored system prompt and tool access.
    """

    role_type: str = Field(
        ..., description="Unique identifier for this role (e.g. 'researcher', 'analyst')"
    )
    objective: str = Field(
        ..., description="What this agent should accomplish"
    )
    tool_access: List[str] = Field(
        default_factory=list,
        description="Tool names this agent may use (empty = text-only)",
    )
    context_needs: List[str] = Field(
        default_factory=list,
        description=(
            "role_type values whose outputs this agent needs as input. "
            "'*' means all previous results."
        ),
    )
    constraints: List[str] = Field(
        default_factory=list,
        description="Constraints or guidelines for this agent",
    )
    priority: int = Field(
        default=3,
        ge=1,
        le=5,
        description="Execution priority (1 = highest, 5 = lowest)",
    )


class AgentRoleExtraction(BaseModel):
    """LLM output: the set of agent roles needed for a task."""

    roles: List[DynamicAgentRole] = Field(
        ..., description="The agent roles required to complete the task"
    )
    reasoning: str = Field(
        default="", description="Why these roles were chosen"
    )


class WorkflowStep(BaseModel):
    """A single step in the orchestrated workflow execution plan."""

    step_name: str = Field(
        ..., description="Unique identifier for the step (e.g. 'research_market')"
    )
    task: str = Field(
        ..., description="The specific work this step must perform"
    )
    assigned_agent: str = Field(
        ..., description="The role_type of the agent executing this step"
    )
    depends_on: List[str] = Field(
        default_factory=list,
        description="step_name values that must complete before this step starts",
    )


class WorkflowExecutionPlan(BaseModel):
    """LLM output: the ordered workflow with dependency graph."""

    steps: List[WorkflowStep] = Field(
        ..., description="Ordered list of execution steps"
    )
    reasoning: str = Field(
        default="", description="Why this execution order was chosen"
    )


class TeamBatch(BaseModel):
    """A group of workflow steps that can execute in parallel.

    Built by topological sort — all steps in a batch have their
    dependencies satisfied by earlier batches.
    """

    batch_index: int = Field(..., description="0-based batch order")
    steps: List[WorkflowStep] = Field(
        ..., description="Steps in this parallel batch"
    )


class StepStatus(str, Enum):
    """Execution status for a single workflow step."""

    PENDING = "pending"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    FAILED = "failed"
    SKIPPED = "skipped"


class StepResult(BaseModel):
    """Result of executing a single workflow step."""

    step_name: str
    assigned_agent: str
    status: StepStatus = StepStatus.PENDING
    output: str = ""
    error: Optional[str] = None


class ToolCallTrace(BaseModel):
    """Trace of a single tool call within a step."""

    tool_name: str
    args_summary: str = ""
    result_preview: str = ""
    duration_ms: float = 0.0
    error: Optional[str] = None


class StepTrace(BaseModel):
    """Detailed execution trace for a single workflow step."""

    step_name: str
    assigned_agent: str
    status: StepStatus = StepStatus.PENDING
    started_at: float = 0.0
    ended_at: float = 0.0
    duration_ms: float = 0.0
    llm_call_count: int = 0
    tool_calls: List[ToolCallTrace] = Field(default_factory=list)
    system_prompt: str = ""  # Full system prompt sent to this agent
    context_received: str = ""
    full_output: str = ""
    output_preview: str = ""
    error: Optional[str] = None


class DataFlowEdge(BaseModel):
    """Records a single data transfer between two workflow steps.

    Captured when a step receives context from a completed dependency,
    making the full inter-agent data flow graph visible in the trace.
    """

    source_step: str  # step_name of the provider
    source_agent: str  # role_type of the provider
    target_step: str  # step_name of the consumer
    target_agent: str  # role_type of the consumer
    data_preview: str = ""  # first ~200 chars of the transferred data
    data_size: int = 0  # length of the full transferred data (chars)
    status: str = "completed"  # source step status when data was read


class PhaseTrace(BaseModel):
    """Trace of a single orchestration phase."""

    phase: str  # role_extraction, planning, todo_creation, execution, synthesis
    started_at: float = 0.0
    ended_at: float = 0.0
    duration_ms: float = 0.0
    output_summary: str = ""
    error: Optional[str] = None


class OrchestrationTrace(BaseModel):
    """Full trace of an orchestration pipeline run."""

    session_id: str
    user_message: str = ""
    started_at: float = 0.0
    ended_at: float = 0.0
    total_duration_ms: float = 0.0
    # Pipeline data
    phases: List[PhaseTrace] = Field(default_factory=list)
    step_traces: List[StepTrace] = Field(default_factory=list)
    data_flow_edges: List[DataFlowEdge] = Field(default_factory=list)
    roles_extracted: List[str] = Field(default_factory=list)
    steps_planned: int = 0
    batches_count: int = 0
    fallback_used: bool = False
    fallback_reason: str = ""
    synthesis_input: str = ""


class OrchestratorResult(BaseModel):
    """Final result of the full orchestration pipeline."""

    session_id: str
    step_results: List[StepResult] = Field(default_factory=list)
    final_answer: str = ""
    metadata: Dict[str, Any] = Field(default_factory=dict)
