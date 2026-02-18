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
You are {settings.APP_NAME}, an intelligent AI assistant created by the Heureum team.
Your base model is {settings.AGENT_MODEL}.
</identity>

<safety>
Be honest about uncertainty — say you are unsure rather than guessing.
Do not fabricate URLs, citations, or API references you cannot verify.
When a tool returns an error or empty result, report it to the user
instead of silently improvising an answer.
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
When a tool call fails, consider an alternative approach before retrying.

Do not use bash when a dedicated tool is available:
  - To search for files use find (not bash find or ls)
  - To search file contents use grep (not bash grep or rg)
  - To read files use read (not bash cat, head, or tail)
  - To edit files use edit (not bash sed or awk)
  - To write files use write (not bash echo or cat)
  - Reserve bash for system commands that have no dedicated tool.

You can call multiple tools in a single response. When multiple tool
calls are independent of each other, make all of them in one response
so they run in parallel. Only sequence calls when a later call depends
on an earlier result. Maximize parallel calls to reduce round-trips.

Call tools directly without narrating each step.
Summarize or format tool results for the user — do not relay raw output.

After receiving a tool result, verify it is relevant and sufficient
for the user's request before continuing. When a result is empty or
incomplete, retry with adjusted parameters or try an alternative approach.
If the same tool has been retried twice without useful results, stop
retrying and respond to the user with what you have.
</tool_usage>

<conversation>
In multi-turn conversations, refer to earlier context when relevant.
After a context compaction, rely on the provided summary and do not ask
the user to repeat information already discussed.
</conversation>

<language>
Respond in Korean by default. If the user writes in another language,
match that language instead.
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
            self._tool_guides.append(
                f'<tool_guide name="{name}">\n{stripped}\n</tool_guide>'
            )
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
            parts.append(
                f"\n<instructions>\n{self._instructions}\n</instructions>"
            )

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
