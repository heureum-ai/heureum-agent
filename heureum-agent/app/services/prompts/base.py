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

When an <available_skills> catalog is present, use this flow:
1) Scan the skill descriptions first.
2) If exactly one skill clearly applies, read its SKILL.md at
   <location> with an available file-read tool, then follow it.
3) If multiple may apply, choose the most specific one and read only that.
4) If none clearly apply, do not read any SKILL.md.
Read at most one SKILL.md up front.
</tool_usage>

<task_execution>
For multi-step tasks, plan and execute autonomously without user checkpoints:
1. Identify all sub-tasks and their dependencies up front.
2. Execute independent sub-tasks in parallel where possible.
3. Verify each result before proceeding to dependent steps.
4. Synthesize findings into a coherent final answer.

Only pause to ask the user if a critical ambiguity cannot be resolved
by available tools or context.

This does NOT apply to:
- Simple questions, greetings, or single-step lookups
- Tasks that need only one tool call
</task_execution>

<conversation>
In multi-turn conversations, refer to earlier context when relevant.
After a context compaction, rely on the provided summary and continue
without asking the user to repeat information.
</conversation>

<language>
Respond in User's language by default.
If the user writes in another language, match that language instead.
</language>
"""

SUBAGENT_IDENTITY_PROMPT = f"""
<identity>
You are a sub-agent of {settings.APP_NAME}.
Never mention any underlying model or provider name.
</identity>

<safety>
When a tool returns an error or empty result, report it honestly
instead of improvising an answer.
Verify URLs, citations, and data before presenting them.
</safety>

<tool_usage>
Use tools when they add value you cannot produce from memory alone.
When a tool call fails, try an alternative approach before retrying.

Call multiple tools in a single response when they are independent
of each other, so they run in parallel.

Call tools silently. Never mention tool names or execution plans
in your text response.
</tool_usage>

<language>
Respond in the same language the task is written in.
</language>
"""


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

    def __init__(self, *, is_subagent: bool = False) -> None:
        self._is_subagent = is_subagent
        self._skills_catalog: Optional[str] = None
        self._tool_guides: List[str] = []
        self._state_prompts: List[str] = []
        self._instructions: Optional[str] = None

    # -- section adders ----------------------------------------------------

    def add_skills_catalog(self, prompt: str) -> "SystemPromptBuilder":
        """Set the ``<available_skills>`` block from a client skills snapshot."""
        if prompt and prompt.strip():
            self._skills_catalog = prompt.strip()
        return self

    def add_tool_guide(self, name: str, body: str) -> "SystemPromptBuilder":
        """Add a single tool guide, wrapping in ``<tool_guide>`` if needed."""
        stripped = body.strip()
        if stripped.startswith("<tool_guide"):
            self._tool_guides.append(stripped)
        else:
            self._tool_guides.append(f'<tool_guide name="{name}">\n{stripped}\n</tool_guide>')
        return self

    def add_tool_guides(self, guides: List[str]) -> "SystemPromptBuilder":
        """Add pre-wrapped ``<tool_guide>`` strings (from SkillController)."""
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
        identity = SUBAGENT_IDENTITY_PROMPT if self._is_subagent else AGENT_IDENTITY_PROMPT
        parts: List[str] = [identity]

        if self._skills_catalog:
            parts.append(f"\n{self._skills_catalog}")

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
    client_tool_prompts: Optional[List[str]] = None,
    instructions: Optional[str] = None,
    state_prompts: Optional[List[str]] = None,
    skills_prompt: Optional[str] = None,
    is_subagent: bool = False,
) -> str:
    """Build a system prompt.

    Args:
        client_tool_prompts: Guide texts provided by clients.
        instructions: Extra instructions to append inside an
            ``<instructions>`` XML block.
        state_prompts: Per-turn runtime state prompts from skills
            (wrapped inside ``<session_state>``).
        skills_prompt: Pre-built ``<available_skills>`` block from
            the platform (includes both client and server skills).
        is_subagent: When True, use a lightweight identity prompt
            optimized for sub-agent execution.

    Returns:
        The assembled system prompt string.
    """
    builder = SystemPromptBuilder(is_subagent=is_subagent)

    if skills_prompt:
        builder.add_skills_catalog(skills_prompt)
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
