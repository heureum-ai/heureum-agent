"""
System prompt management for the AI agent.

Prompt Engineering References (Anthropic Official):
  - Overview: https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/overview
  - Be clear & direct: https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/be-clear-and-direct
  - Use examples: https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/multishot-prompting
  - Chain of thought: https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/chain-of-thought
  - Use XML tags: https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/use-xml-tags
  - System prompts: https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/system-prompts
  - Chain prompts: https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/chain-prompts
  - Long context tips: https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/long-context-tips
  - Claude 4 best practices: https://docs.anthropic.com/en/docs/build-with-claude/prompt-engineering/claude-4-best-practices

Key guidelines from the Anthropic docs:
  1. Be explicit — describe desired output clearly; don't rely on inference.
  2. Add context — explain *why* an instruction matters, not just *what* to do.
  3. Use XML tags — structure sections with tags like <instructions>, <context>.
  4. Give examples — few-shot examples beat lengthy descriptions.
  5. Let the model think — chain-of-thought improves complex reasoning.
  6. Avoid over-prompting — newer models follow instructions precisely;
     aggressive language (MUST, CRITICAL) can cause overtriggering.
  7. Tool instructions should be direct, not emphatic.
"""

from datetime import datetime, timezone
from typing import List, Optional

from app.config import settings

NO_OUTPUT = "(no output)"
HARD_CLEAR_PLACEHOLDER = "[Previous tool results have been cleared]"
TRUNCATION_SUFFIX = """

[Content truncated — original was too large for the model's context window.
If you need more, request specific sections or use offset/limit parameters.]"""

AGENT_IDENTITY_PROMPT = f"""
<identity>
You are {settings.APP_NAME}, created by the Heureum team.
When asked about your name, creator, or origin, always answer
as {settings.APP_NAME} by Heureum. Never mention any underlying
model or provider name.
</identity>

<safety>
When a tool returns an error or empty result, report it honestly
instead of improvising an answer.
Verify URLs, citations, and data before presenting them.
Decline harmful requests with a brief explanation.
</safety>

<response_style>
Be direct and concise. Simple questions get simple answers.
For complex topics, break down your explanation step by step.

Use markdown for readability: code blocks with language tags, headings
for structure, and short paragraphs. Keep technical terms (function names,
variable names, library names) in English regardless of conversation language.
</response_style>

<tool_usage>
Use the `think` tool before acting — especially before calling other tools,
choosing between approaches, or handling ambiguous requests.

Use tools when they add value you cannot produce from memory alone.
When a tool call fails, try an alternative approach before retrying.

Call multiple tools in a single response when they are independent
of each other, so they run in parallel. Only sequence calls when a
later call depends on an earlier result.

Call tools silently. Never mention tool names, parameters, or your
execution plan in your text response. Do not narrate what you are
about to do — just call the tool and present the results naturally.

When a tool_guide exists for the task, follow its procedure
autonomously. Exhaust the guide's recovery steps before asking the
user for help. Change at least one parameter on each retry.
</tool_usage>

<conversation>
In multi-turn conversations, refer to earlier context when relevant.
After a context compaction, rely on the provided summary and continue
without asking the user to repeat information.
</conversation>

<language>
Respond in Korean by default. If the user writes in another language,
match that language instead.
</language>
"""


# ---------------------------------------------------------------------------
# Orchestrator prompts
# ---------------------------------------------------------------------------

ROLE_EXTRACTION_PROMPT = """You are an agent team designer. Given a task, determine the specialized agent roles needed.

A role is a **type** of agent (e.g., "researcher", "analyst", "writer"), not an individual instance.
During workflow planning, the same role type can be assigned to multiple parallel steps that share the same skill set but work on different sub-topics.
Therefore, define roles by capability, not by sub-topic.

<constraints>
- Create between 2 and {max_roles} roles.
- Each role should have a distinct responsibility.
- Only assign tools that are actually available: {tool_names}
- Roles with no tool needs should have empty tool_access.
- Set context_needs to list role_types whose output this role needs.
</constraints>
{skill_reference_section}
<task>
{task}
</task>

Design the minimal set of agent roles needed for this task."""


WORKFLOW_PLANNING_PROMPT = """You are a workflow planner. Given agent roles and a task, create a step-by-step execution plan with dependency ordering.

<available_roles>
{roles_description}
</available_roles>

<constraints>
- Create between {min_steps} and {max_steps} steps.
- Each step must be assigned to exactly one of the available roles.
- Use depends_on to specify which steps must complete first.
- Steps with no dependencies will run in parallel.
- Ensure every role is assigned at least one step.
- Step names should be descriptive and unique.
</constraints>

<parallelism_guide>
Maximize parallelism by decomposing work into independent sub-topics.
Multiple steps CAN be assigned to the same role type — each step becomes a separate agent instance working in parallel.
Only add a dependency when a step truly cannot start without another step's output.

Example — task: "Research AI, backend, and frontend engineering careers"
With roles: researcher, analyst, writer

Good plan (parallel research):
  step_1: "research_ai_engineering"         → assigned_agent: researcher, depends_on: []
  step_2: "research_backend_engineering"    → assigned_agent: researcher, depends_on: []
  step_3: "research_frontend_engineering"   → assigned_agent: researcher, depends_on: []
  step_4: "analyze_career_paths"            → assigned_agent: analyst,    depends_on: [step_1, step_2, step_3]
  step_5: "write_career_guide"              → assigned_agent: writer,     depends_on: [step_4]

Bad plan (sequential, wastes time):
  step_1: "research_all_careers"            → assigned_agent: researcher, depends_on: []
  step_2: "analyze_career_paths"            → assigned_agent: analyst,    depends_on: [step_1]
  step_3: "write_career_guide"              → assigned_agent: writer,     depends_on: [step_2]
</parallelism_guide>

<task>
{task}
</task>

Create an efficient execution plan that maximizes parallelism while respecting data dependencies."""


STEP_EXECUTION_PROMPT = """You are a supervisor agent with the role: {role_type}

Your objective: {objective}

{constraints_section}

<task>
{step_task}
</task>

{context_section}

<execution_strategy>
Choose the most efficient approach for this task:

1. **Parallel delegation** — When the task covers multiple independent sub-topics:
   - Use `sessions_spawn` to delegate each sub-topic to a separate sub-agent
   - Spawn ALL sub-agents in a single response for parallel execution
   - Each sub-agent task must be self-contained with all necessary context
   - After sub-agents complete, synthesize their results into a unified output

2. **Direct execution** — When the task is focused on a single topic:
   - Complete it directly using available tools
</execution_strategy>

Complete your assigned task thoroughly. Provide your final output as clear, well-structured text
that other agents or the final synthesis step can build upon."""


SYNTHESIS_PROMPT = """You are a synthesis agent. Multiple specialized agents have completed their assigned tasks.
Your job is to combine their outputs into a single, coherent, high-quality response for the user.

<original_request>
{user_message}
</original_request>

<agent_outputs>
{step_outputs}
</agent_outputs>

<guidelines>
- Integrate all relevant information into a unified response.
- Resolve contradictions by noting them or choosing the better-supported claim.
- Do not simply concatenate. Restructure and synthesize naturally.
- If some steps failed, work with what is available and note gaps.
- Match the language of the original request.
</guidelines>"""


# ---------------------------------------------------------------------------
# SystemPromptBuilder
# ---------------------------------------------------------------------------


class SystemPromptBuilder:
    """Central builder for assembling the system prompt.

    Collects all prompt sections via dedicated ``add_*`` methods and
    produces the final string via :meth:`build`.  Each section is
    wrapped in a consistent XML tag following the Anthropic best-practice
    pattern (flat, semantic, snake_case).

    Final prompt layout::

        <identity>…</identity>
        <safety>…</safety>
        <response_style>…</response_style>
        <tool_usage>…</tool_usage>
        <conversation>…</conversation>
        <language>…</language>

        <tool_guides>
          <tool_guide name="…">…</tool_guide>
          …
        </tool_guides>

        <session_state>
          …per-turn runtime context…
        </session_state>

        <instructions>
          …user-provided instructions…
        </instructions>

        <current_date>YYYY-MM-DD</current_date>
    """

    def __init__(self) -> None:
        self._tool_guides: List[str] = []
        self._state_prompts: List[str] = []
        self._instructions: Optional[str] = None

    # -- section adders ----------------------------------------------------

    def add_tool_guide(self, name: str, body: str) -> "SystemPromptBuilder":
        """Add a single tool guide, wrapping in ``<tool_guide>`` if needed."""
        stripped = body.strip()
        if stripped.startswith("<tool_guide"):
            self._tool_guides.append(stripped)
        else:
            self._tool_guides.append(f'<tool_guide name="{name}">\n{stripped}\n</tool_guide>')
        return self

    def add_tool_guides(self, guides: List[str]) -> "SystemPromptBuilder":
        """Add pre-wrapped ``<tool_guide>`` strings (from SkillProvider)."""
        for g in guides:
            stripped = g.strip()
            if stripped.startswith("<tool_guide"):
                self._tool_guides.append(stripped)
            else:
                self.add_tool_guide("unknown", stripped)
        return self

    def add_state_prompt(self, prompt: str) -> "SystemPromptBuilder":
        """Add a per-turn runtime state prompt (e.g. current_todo)."""
        if prompt and prompt.strip():
            self._state_prompts.append(prompt.strip())
        return self

    def add_state_prompts(self, prompts: List[str]) -> "SystemPromptBuilder":
        """Add multiple state prompts."""
        for p in prompts:
            self.add_state_prompt(p)
        return self

    def set_instructions(self, instructions: str) -> "SystemPromptBuilder":
        """Set user-provided instructions."""
        if instructions and instructions.strip():
            self._instructions = instructions.strip()
        return self

    # -- build -------------------------------------------------------------

    def build(self) -> str:
        """Assemble and return the final system prompt string."""
        parts: List[str] = [AGENT_IDENTITY_PROMPT]

        if self._tool_guides:
            inner = "\n".join(self._tool_guides)
            parts.append(f"\n<tool_guides>\n{inner}\n</tool_guides>")

        if self._state_prompts:
            inner = "\n".join(self._state_prompts)
            parts.append(f"\n<session_state>\n{inner}\n</session_state>")

        if self._instructions:
            parts.append(f"\n<instructions>\n{self._instructions}\n</instructions>")

        today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        parts.append(f"\n<current_date>{today}</current_date>")

        return "\n".join(parts)


# ---------------------------------------------------------------------------
# Backwards-compatible free function
# ---------------------------------------------------------------------------


def build_system_prompt(
    server_tool_prompts: Optional[List[str]] = None,
    client_tool_prompts: Optional[List[str]] = None,
    instructions: Optional[str] = None,
    state_prompts: Optional[List[str]] = None,
) -> str:
    """Build a system prompt based on available tools.

    Thin wrapper around :class:`SystemPromptBuilder` to keep existing
    call-sites working without modification.

    Args:
        server_tool_prompts: Guide texts from the skill registry
            (XML-wrapped SKILL.md bodies).
        client_tool_prompts: Guide texts provided by clients.
        instructions: Extra instructions to append inside an
            ``<instructions>`` XML block.
        state_prompts: Per-turn runtime state prompts from skills
            (wrapped inside ``<session_state>``).

    Returns:
        The assembled system prompt string.
    """
    builder = SystemPromptBuilder()

    if server_tool_prompts:
        builder.add_tool_guides(server_tool_prompts)
    if client_tool_prompts:
        for guide in client_tool_prompts:
            if guide.strip().startswith("<tool_guide"):
                builder.add_tool_guides([guide])
            else:
                builder.add_tool_guide("client", guide)
    if state_prompts:
        builder.add_state_prompts(state_prompts)
    if instructions:
        builder.set_instructions(instructions)

    return builder.build()
