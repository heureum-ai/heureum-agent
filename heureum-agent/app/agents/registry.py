# Copyright (c) 2026 Heureum AI. All rights reserved.

"""AgentRegistry — auto-discovers AGENT.md files and provides agent definitions."""

import logging
import os
from typing import Dict, Optional

from app.agents.metadata import parse_agent_md
from app.agents.types import AgentDefinition
from app.config import settings

logger = logging.getLogger(__name__)

_AGENTS_DIR = os.path.join(os.path.dirname(__file__))


class AgentRegistry:
    """Discovers and caches AgentDefinition instances from AGENT.md files.

    Scans ``app/agents/<name>/AGENT.md`` subdirectories on first access.
    """

    def __init__(self) -> None:
        self._agents: Dict[str, AgentDefinition] = {}
        self._loaded = False

    def _ensure_loaded(self) -> None:
        if self._loaded:
            return
        self._loaded = True
        for entry in os.listdir(_AGENTS_DIR):
            agent_dir = os.path.join(_AGENTS_DIR, entry)
            md_path = os.path.join(agent_dir, "AGENT.md")
            if os.path.isdir(agent_dir) and os.path.isfile(md_path):
                try:
                    defn = parse_agent_md(md_path)
                    # Resolve {app_name} placeholder in identity_prompt
                    resolved_prompt = defn.identity_prompt.replace(
                        "{app_name}", settings.APP_NAME
                    )
                    defn = AgentDefinition(
                        name=defn.name,
                        description=defn.description,
                        trigger=defn.trigger,
                        identity_prompt=resolved_prompt,
                        skills=defn.skills,
                        mcp_tools=defn.mcp_tools,
                        client_tools=defn.client_tools,
                        max_iterations=defn.max_iterations,
                    )
                    self._agents[defn.name] = defn
                    logger.info("Loaded agent definition: %s", defn.name)
                except Exception:
                    logger.warning("Failed to load AGENT.md from %s", md_path, exc_info=True)

    def get_agent(self, name: str) -> Optional[AgentDefinition]:
        """Return an AgentDefinition by name, or None if not found."""
        self._ensure_loaded()
        return self._agents.get(name)

    def list_agents(self) -> list[AgentDefinition]:
        """Return all registered agent definitions."""
        self._ensure_loaded()
        return list(self._agents.values())

    def get_router_catalog(self) -> str:
        """Build a text catalog of agents for the router classification prompt.

        Returns a formatted string listing each agent's name, description,
        and trigger condition for injection into the router system prompt.
        """
        self._ensure_loaded()
        lines = []
        for defn in self._agents.values():
            lines.append(
                f"- name: {defn.name}\n"
                f"  description: {defn.description}\n"
                f"  trigger: {defn.trigger}"
            )
        return "\n".join(lines)
