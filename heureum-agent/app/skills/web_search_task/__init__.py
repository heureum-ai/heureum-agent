# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Web search task skill — guide-only, no custom tools.

Provides a tool_guide in the system prompt that teaches the LLM the
search → fetch → read workflow. All actual tools (search, fetch, read)
are MCP server tools registered elsewhere.
"""


class _WebSearchTaskSkill:
    name = "web_search_task"
    tool_schemas: list = []


skill = _WebSearchTaskSkill()
