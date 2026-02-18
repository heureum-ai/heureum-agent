# Copyright (c) 2026 Heureum AI. All rights reserved.


class AskQuestionSkill:
    """Guide-only skill for the ask_question client tool.

    Provides SKILL.md guide prompt to the LLM. No server-side execution —
    the tool is handled entirely by the client.
    """

    name = "ask_question"
    tool_schemas = []  # client tool — no server-side schemas


skill = AskQuestionSkill()
