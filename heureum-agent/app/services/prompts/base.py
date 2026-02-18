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


def build_system_prompt(
    server_tool_prompts: Optional[List[str]] = None,
    client_tool_prompts: Optional[List[str]] = None,
    instructions: Optional[str] = None,
) -> str:
    """Build a system prompt based on available tools.

    Args:
        server_tool_prompts (Optional[List[str]]): Guide texts from
            the skill registry (XML-wrapped SKILL.md bodies).
        client_tool_prompts (Optional[List[str]]): Guide texts provided by
            clients for inclusion in the system prompt.
        instructions (Optional[str]): Extra instructions to append
            inside an ``<instructions>`` XML block.

    Returns:
        str: The assembled system prompt string.
    """
    parts = [AGENT_IDENTITY_PROMPT]

    # Server-side tool guides from skill registry
    if server_tool_prompts:
        parts.extend(server_tool_prompts)

    if client_tool_prompts:
        for guide in client_tool_prompts:
            parts.append(guide)

    if instructions:
        parts.append(f"\n<instructions>\n{instructions}\n</instructions>")

    today = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    parts.append(f"\n<current_date>{today}</current_date>")

    return "\n".join(parts)
