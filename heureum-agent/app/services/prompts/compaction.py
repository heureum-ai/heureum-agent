"""
Prompts for context compaction and summarization.
"""

from typing import Optional

COMPACTION_PREFIX = "[compaction] Previous conversation summary:"
DEFAULT_SUMMARY_FALLBACK = "No prior history."

COMPACTION_SYSTEM_PROMPT = """You are a context summarization assistant. Your task is to read a conversation between a user and an AI coding assistant, then produce a structured summary following the exact format specified.

Do NOT continue the conversation. Do NOT respond to any questions in the conversation. ONLY output the structured summary."""

COMPACTION_MERGE_INSTRUCTIONS = """Merge these partial summaries into a single cohesive summary. Preserve decisions, TODOs, open questions, and any constraints."""

COMPACTION_INITIAL_BODY = """The messages above are a conversation to summarize. Create a structured context checkpoint summary that another LLM will use to continue the work.

Use this EXACT format:

<goal>
What is the user trying to accomplish? Can be multiple items if the session covers different tasks.
</goal>

<constraints>
Any constraints, preferences, or requirements mentioned by user. "(none)" if none were mentioned.
</constraints>

<progress>
<done>Completed tasks/changes, one per line.</done>
<in_progress>Current work, one per line.</in_progress>
<blocked>Issues preventing progress, if any.</blocked>
</progress>

<decisions>
Decision: Brief rationale. One per line.
</decisions>

<next_steps>
Ordered list of what should happen next, one per line.
</next_steps>

<critical_context>
Any data, examples, or references needed to continue. "(none)" if not applicable.
</critical_context>

Keep each section concise. Preserve exact file paths, function names, and error messages."""

COMPACTION_UPDATE_BODY = """The messages above are NEW conversation messages to incorporate into the existing summary provided in <previous_summary> tags.

Update the existing structured summary with new information. RULES:
- PRESERVE all existing information from the previous summary
- ADD new progress, decisions, and context from the new messages
- UPDATE the progress section: move items from in_progress to done when completed
- UPDATE next_steps based on what was accomplished
- PRESERVE exact file paths, function names, and error messages
- If something is no longer relevant, you may remove it

Use this EXACT format:

<goal>
Preserve existing goals, add new ones if the task expanded.
</goal>

<constraints>
Preserve existing, add new ones discovered.
</constraints>

<progress>
<done>Include previously done items AND newly completed items, one per line.</done>
<in_progress>Current work — update based on progress, one per line.</in_progress>
<blocked>Current blockers — remove if resolved.</blocked>
</progress>

<decisions>
Decision: Brief rationale. Preserve all previous, add new. One per line.
</decisions>

<next_steps>
Update based on current state, one per line.
</next_steps>

<critical_context>
Preserve important context, add new if needed.
</critical_context>

Keep each section concise. Preserve exact file paths, function names, and error messages."""


def build_compaction_prompt(
    conversation: str,
    previous_summary: Optional[str] = None,
) -> str:
    """Build the compaction prompt by joining components."""
    parts = [f"<conversation>\n{conversation.strip()}\n</conversation>"]

    if previous_summary:
        parts.append(f"<previous_summary>\n{previous_summary.strip()}\n</previous_summary>")
        parts.append(COMPACTION_UPDATE_BODY)
    else:
        parts.append(COMPACTION_INITIAL_BODY)

    return "\n\n".join(parts)
