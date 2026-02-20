# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Local search task skill — guide-only, no custom tools.

Provides a tool_guide in the system prompt that teaches the LLM the
find → grep → read search workflow. All actual tools (find, grep, read, ls)
are MCP server tools registered elsewhere.
"""


class _LocalSearchTaskSkill:
    name = "local_search_task"
    tool_schemas: list = []


skill = _LocalSearchTaskSkill()
