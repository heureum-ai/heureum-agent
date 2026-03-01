# Copyright (c) 2026 Heureum AI. All rights reserved.

"""DeepAgents factory — builds LangGraph agents for the v2 endpoint."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any, Callable, Sequence

from deepagents import create_deep_agent
from deepagents.backends import FilesystemBackend, LocalShellBackend
from langchain_core.messages import AIMessage, HumanMessage
from langchain_core.tools import BaseTool
from langgraph.checkpoint.memory import MemorySaver
from langgraph.errors import GraphRecursionError
from langgraph.graph.state import CompiledStateGraph

from app.agents.types import AgentDefinition
from app.services.prompts.base import SUBAGENT_IDENTITY_PROMPT

logger = logging.getLogger(__name__)

# Project root for resolving skill paths
_AGENT_APP_ROOT = Path(__file__).parent.parent  # heureum-agent/app/

# Shared in-process checkpointer (persists state between HTTP requests in same process)
_CHECKPOINTER = MemorySaver()

# Recursion limit multiplier for sub-agents spawned by the `task` tool.
# LangGraph's default is 25. Sub-agents doing web research + file ops need more headroom.
_SUBAGENT_RECURSION_MULTIPLIER = 4
_SUBAGENT_RECURSION_MIN = 100

# System prompt injected into sub-agents spawned by the `task` tool.
# Explicitly tells the sub-agent which tools it has and that web_fetch is absent.
_RESEARCH_SUBAGENT_SYSTEM_PROMPT = (
    SUBAGENT_IDENTITY_PROMPT
    + """
<tool_guidance>
You have mcp_web__search for web searches. You do NOT have web_fetch.
When using mcp_web__search, synthesize answers from the returned snippets directly.
Do not attempt to fetch URLs or read files you have not written yourself.

After completing your research, call store_finding(topic, content) to save your
results to the shared session store so the orchestrating agent can access them.
Use a short descriptive topic key (e.g. "korea_economy" or "japan_culture").
</tool_guidance>
"""
)


class _GracefulSubAgent:
    """Wraps a compiled sub-agent runnable to handle GraphRecursionError gracefully.

    DeepAgents' ``atask`` calls ``subagent.ainvoke(state)`` without passing a
    LangGraph config, so the sub-agent uses the default recursion_limit=25.
    We override this via ``.with_config({"recursion_limit": N})``, and when
    the limit IS reached (e.g. a very complex task), we catch ``GraphRecursionError``
    and return a clean partial-result message instead of crashing the parent agent.

    The ``__getattr__`` delegation ensures deepagents can access all other
    attributes on the underlying compiled graph (e.g. ``config_specs``).
    """

    def __init__(self, inner: Any, recursion_limit: int) -> None:
        self._runnable = inner.with_config({"recursion_limit": recursion_limit})
        self._recursion_limit = recursion_limit

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _extract_task(messages: list) -> str:
        """Pull the task description from the first HumanMessage."""
        for m in messages:
            if isinstance(m, HumanMessage) or getattr(m, "type", "") == "human":
                content = getattr(m, "content", "")
                if isinstance(content, str):
                    return content[:400]
        return ""

    @staticmethod
    def _read_tmp_results() -> str:
        """Read any .txt/.md files written to the virtual /tmp/ dir."""
        tmp_dir = _AGENT_APP_ROOT / "tmp"
        if not tmp_dir.exists():
            return ""
        parts: list[str] = []
        for f in sorted(tmp_dir.iterdir()):
            if f.is_file() and f.suffix in (".txt", ".md"):
                try:
                    content = f.read_text(encoding="utf-8").strip()
                    if content:
                        parts.append(f"[{f.name}]\n{content}")
                except Exception:
                    pass
        return "\n\n---\n\n".join(parts)

    def _build_partial_result(self, messages: list) -> dict:
        """Construct a graceful response when the iteration limit is reached."""
        task = self._extract_task(messages)
        tmp_content = self._read_tmp_results()

        sections: list[str] = [
            f"최대 반복 횟수({self._recursion_limit}회)에 도달하여 작업을 마무리합니다.",
        ]
        if task:
            sections.append(f"**작업**: {task}")

        if tmp_content:
            sections.append(
                "**지금까지 수집된 내용**:\n\n" + tmp_content
            )
        else:
            sections.append(
                "중간 결과 파일이 없습니다. "
                "검색된 스니펫 정보를 바탕으로 상위 에이전트가 결과를 정리해 주세요."
            )

        return {"messages": [AIMessage(content="\n\n".join(sections))]}

    # ------------------------------------------------------------------
    # Runnable interface (required by deepagents)
    # ------------------------------------------------------------------

    async def ainvoke(self, input: Any, config: Any = None, **kwargs: Any) -> dict:
        try:
            return await self._runnable.ainvoke(input, config=config, **kwargs)
        except GraphRecursionError:
            logger.warning(
                "Sub-agent reached recursion limit (%d) — returning graceful partial result",
                self._recursion_limit,
            )
            messages = input.get("messages", []) if isinstance(input, dict) else []
            return self._build_partial_result(messages)

    def invoke(self, input: Any, config: Any = None, **kwargs: Any) -> dict:
        try:
            return self._runnable.invoke(input, config=config, **kwargs)
        except GraphRecursionError:
            logger.warning(
                "Sub-agent reached recursion limit (%d) (sync) — returning graceful partial result",
                self._recursion_limit,
            )
            messages = input.get("messages", []) if isinstance(input, dict) else []
            return self._build_partial_result(messages)

    def __getattr__(self, name: str) -> Any:
        # Delegate all other attribute access to the wrapped runnable
        return getattr(self._runnable, name)


def _map_model_to_deepagents(model: str) -> str:
    """Map AGENT_MODEL to deepagents provider:model format."""
    if model.startswith("gemini"):
        return f"google:{model}"
    if model.startswith(("gpt-", "o1", "o3", "o4")):
        return f"openai:{model}"
    if model.startswith("claude"):
        return f"anthropic:{model}"
    # Already in provider:model format
    if ":" in model:
        return model
    # Unknown format - try as-is
    logger.warning("Unknown model format '%s', passing as-is to deepagents", model)
    return model


def _resolve_skill_paths(skills: list[str]) -> list[str]:
    """Convert skill names to POSIX paths relative to app root.

    E.g., "web_search_task" -> "/skills/web_search_task/"
    (These paths are relative to the FilesystemBackend root_dir which is _AGENT_APP_ROOT)
    """
    return [f"/skills/{skill}/" for skill in skills]


def _build_subagent(
    deepagents_model: str,
    custom_tools: list,
    backend: FilesystemBackend | LocalShellBackend,
    recursion_limit: int,
) -> dict:
    """Build a general-purpose sub-agent wrapped in _GracefulSubAgent.

    DeepAgents creates a default "general-purpose" sub-agent with LangGraph's
    default recursion_limit=25. By passing a CompiledSubAgent named
    "general-purpose" to create_deep_agent, we override that default
    (dict comprehension in _build_task_tool picks the last entry per name).

    _GracefulSubAgent catches GraphRecursionError and returns a clean
    partial-result message instead of crashing the parent agent.
    """
    inner = create_deep_agent(
        model=deepagents_model,
        tools=custom_tools,
        system_prompt=_RESEARCH_SUBAGENT_SYSTEM_PROMPT,
        backend=backend,
        # No checkpointer: sub-agents are ephemeral, no state persistence needed
        checkpointer=None,
        name="research-subagent",
    )
    return {
        "name": "general-purpose",
        "description": (
            "General-purpose research and analysis sub-agent. "
            "Use for web searches, file read/write operations, "
            "and multi-step data synthesis tasks."
        ),
        "runnable": _GracefulSubAgent(inner, recursion_limit),
    }


def build_agent(
    model: str,
    agent_config: AgentDefinition,
    custom_tools: Sequence[BaseTool | Callable | dict[str, Any]] | None = None,
    system_prompt: str | None = None,
    interrupt_on: dict[str, Any] | None = None,
    root_dir: str | None = None,
) -> CompiledStateGraph:
    """Build a DeepAgents LangGraph agent for the given configuration.

    Context compaction is handled by DeepAgents' built-in SummarizationMiddleware
    (part of the standard middleware stack). No additional middleware needed.

    Args:
        model: Model identifier (e.g., "gpt-4o-mini").
        agent_config: Agent definition from AGENT.md.
        custom_tools: MCP tools + client tool callables.
        system_prompt: Additional system prompt (from request instructions).
        interrupt_on: Tools that require human approval.
        root_dir: If set, use LocalShellBackend anchored to this directory.
            Enables native ls/read_file/write_file/grep/execute tools.
            Defaults to FilesystemBackend pointing to app/ root.

    Returns:
        Compiled LangGraph state graph with checkpointer attached.
    """
    deepagents_model = _map_model_to_deepagents(model)

    # Build skill paths
    skill_paths = _resolve_skill_paths(agent_config.skills) if agent_config.skills else None

    # Backend for filesystem + skills
    # LocalShellBackend: real ls/read_file/write_file/grep/execute (anchored to root_dir)
    # FilesystemBackend: virtual mode for skills only (no native shell tools)
    if root_dir:
        backend = LocalShellBackend(root_dir=root_dir, virtual_mode=True)
    else:
        backend = FilesystemBackend(root_dir=str(_AGENT_APP_ROOT), virtual_mode=True)

    # Build system prompt from agent identity + caller instructions
    full_system_prompt = agent_config.identity_prompt or ""
    if system_prompt:
        full_system_prompt = f"{system_prompt}\n\n{full_system_prompt}" if full_system_prompt else system_prompt

    # Build a custom "general-purpose" sub-agent that:
    #  1. Has a higher recursion limit (default is 25, too low for research tasks)
    #  2. Catches GraphRecursionError and returns a graceful partial result
    subagent_recursion_limit = max(
        agent_config.max_iterations * _SUBAGENT_RECURSION_MULTIPLIER,
        _SUBAGENT_RECURSION_MIN,
    )

    # Sub-agent uses the same backend root so virtual-fs paths (e.g. /tmp/) are shared.
    if root_dir:
        subagent_backend = LocalShellBackend(root_dir=root_dir, virtual_mode=True)
    else:
        subagent_backend = FilesystemBackend(root_dir=str(_AGENT_APP_ROOT), virtual_mode=True)

    custom_subagents = [
        _build_subagent(
            deepagents_model=deepagents_model,
            custom_tools=list(custom_tools or []),
            backend=subagent_backend,
            recursion_limit=subagent_recursion_limit,
        )
    ]

    logger.info(
        "Building DeepAgent: model=%s agent=%s skills=%s tools=%d "
        "root_dir=%s subagent_recursion_limit=%d",
        deepagents_model,
        agent_config.name,
        agent_config.skills,
        len(custom_tools or []),
        root_dir or "(app)",
        subagent_recursion_limit,
    )

    agent = create_deep_agent(
        model=deepagents_model,
        tools=list(custom_tools or []),
        system_prompt=full_system_prompt or None,
        skills=skill_paths,
        backend=backend,
        checkpointer=_CHECKPOINTER,
        interrupt_on=interrupt_on,
        name=agent_config.name,
        subagents=custom_subagents,
    )

    return agent
