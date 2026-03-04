# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Request router — single LLM call to classify user requests to agents."""

import json
import logging
from typing import TYPE_CHECKING

from langchain_core.messages import BaseMessage, HumanMessage, SystemMessage

if TYPE_CHECKING:
    from app.agents.registry import AgentRegistry
    from app.services.agent_service import AgentService

logger = logging.getLogger(__name__)

_DEFAULT_AGENT = None  # None = use default main agent flow (activate_skill + ask_question)

ROUTER_CLASSIFICATION_PROMPT = """\
You are a request router. Analyze the user's latest message in the context \
of the conversation and select the most appropriate agent.

<agents>
{agent_catalog}
</agents>

Rules:
- Simple greetings, chitchat, factual questions answerable from memory alone -> simple
- Travel planning, restaurant/place recommendations, weather, directions, flights -> travel
- Tasks requiring web search for current/real-time information (not travel-related) -> web_search
- Multi-step analysis, research, comparison, or tasks needing planning -> complex
- Everything else (file operations, coding, general tool tasks) -> default

Respond with ONLY a JSON object: {{"agent": "agent_name"}}
Do not include any other text."""


def _extract_last_user_text(messages: list[BaseMessage]) -> str:
    """Extract the last user message text for classification."""
    for msg in reversed(messages):
        if isinstance(msg, HumanMessage):
            content = msg.content
            if isinstance(content, str):
                return content
            if isinstance(content, list):
                texts = [p.get("text", "") for p in content if isinstance(p, dict) and p.get("type") == "text"]
                return " ".join(texts)
    return ""


async def classify_request(
    messages: list[BaseMessage],
    agent_registry: "AgentRegistry",
    agent_service: "AgentService",
) -> str | None:
    """Classify a user request into an agent name via a single lightweight LLM call.

    Args:
        messages: Current conversation messages.
        agent_registry: Registry of available agent definitions.
        agent_service: AgentService instance (for LLM access).

    Returns:
        Agent name string (e.g. "simple", "complex", "web_search"),
        or None to use the default main agent flow.
    """
    catalog = agent_registry.get_router_catalog()
    if not catalog:
        return _DEFAULT_AGENT

    user_text = _extract_last_user_text(messages)
    if not user_text:
        return _DEFAULT_AGENT

    system_prompt = ROUTER_CLASSIFICATION_PROMPT.format(agent_catalog=catalog)

    # Build a minimal message list for classification:
    # Only the last user message to keep the call lightweight.
    classification_messages = [
        SystemMessage(content=system_prompt),
        HumanMessage(content=user_text),
    ]

    try:
        result = await agent_service.llm.ainvoke(classification_messages)
        raw = result.content.strip()

        # Parse JSON response
        # Handle cases where the model wraps JSON in markdown code blocks
        if raw.startswith("```"):
            raw = raw.split("```")[1]
            if raw.startswith("json"):
                raw = raw[4:]
            raw = raw.strip()

        parsed = json.loads(raw)
        agent_name = parsed.get("agent")

        # "default" means use the original main agent flow
        if not agent_name or agent_name == "default":
            logger.info("Router chose default flow (user: %s)", user_text[:80])
            return None

        # Validate agent exists
        if agent_registry.get_agent(agent_name) is None:
            logger.warning(
                "Router returned unknown agent '%s', using default flow",
                agent_name,
            )
            return None

        logger.info("Router classified request as '%s' (user: %s)", agent_name, user_text[:80])
        return agent_name

    except Exception:
        logger.warning("Router classification failed, using default flow", exc_info=True)
        return None
