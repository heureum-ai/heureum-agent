# Copyright (c) 2026 Heureum AI. All rights reserved.

"""AGENT.md parsing — reuses the same frontmatter pattern as SKILL.md."""

from app.agents.types import AgentDefinition


def parse_agent_md(path: str) -> AgentDefinition:
    """Parse an AGENT.md file into an AgentDefinition.

    Format mirrors SKILL.md: YAML frontmatter between ``---`` fences,
    followed by a markdown body that becomes ``identity_prompt``.
    """
    with open(path, encoding="utf-8") as f:
        text = f.read()

    name = ""
    description = ""
    trigger = ""
    skills: list[str] = []
    mcp_tools = False
    max_iterations = 3
    allow_plan_mode = False
    body = text

    parts = text.split("---", 2)
    if len(parts) >= 3:
        frontmatter = parts[1]
        body = parts[2].strip()
        for line in frontmatter.strip().splitlines():
            line = line.strip()
            if not line or ":" not in line:
                continue
            key, _, value = line.partition(":")
            key = key.strip().lower()
            value = value.strip()
            if key == "name":
                name = value
            elif key == "description":
                description = value
            elif key == "trigger":
                trigger = value
            elif key == "skills":
                skills = [s.strip() for s in value.split(",") if s.strip()]
            elif key == "mcp_tools":
                mcp_tools = value.lower() in ("true", "yes", "1")
            elif key == "max_iterations":
                try:
                    max_iterations = int(value)
                except ValueError:
                    pass
            elif key == "allow_plan_mode":
                allow_plan_mode = value.lower() in ("true", "yes", "1")

    return AgentDefinition(
        name=name,
        description=description,
        trigger=trigger,
        identity_prompt=body,
        skills=skills,
        mcp_tools=mcp_tools,
        max_iterations=max_iterations,
        allow_plan_mode=allow_plan_mode,
    )
