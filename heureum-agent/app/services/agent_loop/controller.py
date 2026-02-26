# Copyright (c) 2026 Heureum AI. All rights reserved.

"""AgentLoopController — composition root for the agent loop package."""

from __future__ import annotations

import asyncio
import atexit
import logging
from typing import Dict

from app.config import settings
from app.services.agent_service import AgentService
from app.services.mcps import MCPClientController
from app.services.middleware import (
    Domain,
    MCPDiscoverEvent,
    MessageRegistry,
    Middleware,
    MiddlewareContext,
    MiddlewareRunner,
    ToolHookBridgeMiddleware,
)
from app.services.middleware.subagent import SubagentSpawnMiddleware
from app.services.skills import SkillController
from app.services.tools import ToolController, clear_session_loop_state
from app.services.subagent import (
    SubagentContext,
    set_context as set_subagent_context,
    create_subagent_task,
    cleanup_session_state as cleanup_subagent_session_state,
    _get_context as _get_subagent_context,
)
from app.skills.plan_task.service import (
    get_registry as get_subagent_registry,
    _clear_depth as clear_subagent_depth,
)

from app.services.agent_loop.execution import ToolExecutionController
from app.services.agent_loop.intelligence import LoopIntelligenceController

logger = logging.getLogger(__name__)


class AgentLoopController:
    """Composition root — owns all sub-controllers and session lifecycle."""

    def __init__(self) -> None:
        # Middleware runner
        self.middleware = MiddlewareRunner()

        # Sub-controllers
        self.tool_controller = ToolController()
        self.skill_controller = SkillController()
        self.mcp_client = MCPClientController(
            chain_registry=self.tool_controller.tool_chain_registry
        )
        self.agent_service = AgentService(skill_provider=self.skill_controller)
        self.persist_controller = (
            self.agent_service.message_controller.init_persist(settings.PLATFORM_API_URL)
            if settings.PLATFORM_API_URL
            else None
        )

        # Bridge existing ToolHookRunner into the middleware chain
        self.middleware.register(
            ToolHookBridgeMiddleware(self.tool_controller.tool_hook_runner),
            domains=[Domain.TOOL],
        )

        # Inject middleware into AgentService (for compaction domain)
        self.agent_service.middleware_runner = self.middleware

        # Centralized message registry (for middleware-interceptable messages)
        self.messages = MessageRegistry(self.middleware)

        # Composed tool execution controller (with middleware)
        self.tool_exec = ToolExecutionController(
            agent_service=self.agent_service,
            skill_controller=self.skill_controller,
            mcp_client=self.mcp_client,
            tool_controller=self.tool_controller,
            middleware_runner=self.middleware,
            messages=self.messages,
        )

        # Subagent spawn middleware (activate_skill dedup + skill count limit)
        self._subagent_middleware = SubagentSpawnMiddleware(
            max_skills=settings.SUBAGENT_MAX_SKILLS
        )
        self.middleware.register(
            self._subagent_middleware, domains=[Domain.SUBAGENT]
        )

        # Loop intelligence (loop-awareness for LLM)
        self.intelligence = LoopIntelligenceController()
        self.middleware.register(
            self.intelligence.create_middleware(),
            domains=[Domain.TOOL, Domain.PROMPT, Domain.MESSAGE],
        )

        # Session state
        self._session_loop_locks: Dict[str, asyncio.Lock] = {}
        self._initialized = False
        self._init_lock = asyncio.Lock()

        # Wire SubagentContext — bound method, no deferred lambda needed
        set_subagent_context(
            SubagentContext(
                agent_service=self.agent_service,
                mcp_client=self.mcp_client,
                skill_controller=self.skill_controller,
                tool_controller=self.tool_controller,
                execute_tool=self.tool_exec.execute_tool,
                persist_controller=self.persist_controller,
                messages=self.messages,
            )
        )

        atexit.register(self._atexit_close_mcp)

    # -- session lock management -------------------------------------------

    def get_loop_lock(self, session_id: str) -> asyncio.Lock:
        """Serialize full loop executions per session.

        The per-session lock guarantees that:
          1. Session history is appended in a deterministic order — concurrent
             requests for the same session cannot interleave tool-result writes.
          2. ``tool_controller`` chain state is accessed
             sequentially per session, preventing chain-step tracking races.

        The lock is intentionally coarse (one lock per session covering the
        entire agent loop).  Within a single lock acquisition, the pipelined
        tool executor achieves parallelism by running multiple tool calls
        concurrently via ``asyncio.wait``, so splitting the lock further
        would add complexity without measurable benefit.
        """
        return self._session_loop_locks.setdefault(session_id, asyncio.Lock())

    def cleanup_stale_locks(self) -> None:
        """Remove per-session locks for evicted sessions and sweep stale subagent records."""
        sessions = getattr(self.agent_service, "sessions", None)
        if sessions is None or not isinstance(sessions, dict):
            return

        active_sessions = set(sessions.keys())
        stale = [
            sid
            for sid in self._session_loop_locks
            if sid not in active_sessions and not self._session_loop_locks[sid].locked()
        ]
        for sid in stale:
            self._session_loop_locks.pop(sid, None)
            self._subagent_middleware.clear_session(sid)
            self.mcp_client.clear_session_state(sid)
            self.tool_controller.clear_session(sid)
            self.skill_controller.clear_session(sid)
            self.intelligence.clear_session(sid)
            clear_session_loop_state(sid)

        try:
            stale_ids = get_subagent_registry().sweep_stale()
            for sid in stale_ids:
                clear_subagent_depth(sid)
                cleanup_subagent_session_state(sid)
        except Exception:
            pass

    def remove_session_lock(self, session_id: str) -> None:
        """Remove the per-session loop lock (used by delete_session endpoint)."""
        self._session_loop_locks.pop(session_id, None)

    # -- middleware registration -------------------------------------------

    def register_middleware(
        self,
        middleware: Middleware,
        *,
        domains: list[Domain] | None = None,
    ) -> None:
        """Public API: register an external middleware."""
        self.middleware.register(middleware, domains=domains)

    # -- initialization ----------------------------------------------------

    async def ensure_initialized(self) -> None:
        """Discover MCP tools once and cache tool schemas in AgentService."""
        if self._initialized:
            return

        async with self._init_lock:
            if self._initialized:
                return

            mcp_tools = []
            try:
                mcp_tools = await self.mcp_client.discover_tools()
                self.agent_service.mcp_tool_controller.set_tools(mcp_tools)
                if mcp_tools:
                    logger.info(
                        "MCP tools discovered: %s",
                        [t["function"]["name"] for t in mcp_tools],
                    )

                # Fire MCP discover after-event
                ctx = MiddlewareContext()
                event = MCPDiscoverEvent(context=ctx, discovered_tools=mcp_tools)
                await self.middleware.run_after(event)
            except BaseException as e:
                logger.warning("MCP initialization failed (continuing without MCP tools): %s", e)
                self.agent_service.mcp_tool_controller.set_tools([])

            # Skill startup must run even when MCP discovery fails.
            # plan_task relies on startup-time dependency injection.
            try:
                await self.skill_controller.startup(
                    create_subagent_task_fn=create_subagent_task,
                    get_skills_prompt=lambda: _get_subagent_context().skills_prompt,
                    subagent_config={
                        "max_spawn_depth": settings.SUBAGENT_MAX_SPAWN_DEPTH,
                        "max_children": settings.SUBAGENT_MAX_CHILDREN,
                        "max_total_subagents": settings.SUBAGENT_MAX_TOTAL,
                        "max_skills": settings.SUBAGENT_MAX_SKILLS,
                    },
                    middleware=self.middleware,
                )
            except BaseException:
                # CancelledError (BaseException in 3.9+) can leak from the
                # MCP cancel scope above — catch it so startup can retry.
                logger.warning(
                    "Skill initialization failed; will retry on next request",
                    exc_info=True,
                )
                return

            # Register tools and skills to Platform DB
            if self.persist_controller:
                try:
                    await self._register_to_platform(mcp_tools)
                except Exception:
                    logger.debug("Platform schema registration failed", exc_info=True)

            self._initialized = True

    async def _register_to_platform(self, mcp_tools: list) -> None:
        """Register MCP tools and skills to Platform DB on startup."""
        # MCP tools
        mcp_items = []
        for schema in mcp_tools:
            func = schema.get("function", {})
            name = func.get("name")
            if not name:
                continue
            meta = schema.get("meta") or {}
            mcp_items.append({
                "tool_name": name,
                "description": func.get("description", ""),
                "parameters_schema": func.get("parameters", {}),
                "display_name": self.mcp_client.display_names.get(name, ""),
                "source": "mcp",
                "requires_approval": meta.get("requires_approval", False),
            })

        # Skill tool schemas
        skill_tool_items = []
        for skill_key, skill in self.skill_controller._skills.items():
            for ts in getattr(skill, "tool_schemas", []):
                func = ts.get("function", {})
                tn = func.get("name")
                if tn:
                    skill_tool_items.append({
                        "tool_name": tn,
                        "description": func.get("description", ""),
                        "parameters_schema": func.get("parameters", {}),
                        "display_name": ts.get("display_name", ""),
                        "source": "skill",
                    })

        all_tool_items = mcp_items + skill_tool_items
        if all_tool_items:
            await self.persist_controller.register_tool_schemas(all_tool_items)

        # Skills
        skill_items = []
        for skill_key, skill in self.skill_controller._skills.items():
            meta = self.skill_controller._skill_meta_by_key.get(skill_key)
            if not meta:
                continue
            skill_items.append({
                "skill_name": meta.name or skill_key,
                "description": meta.description,
                "tools": meta.tools,
                "depends_on": meta.depends_on,
                "subagent_access": meta.subagent_access,
                "source": "server",
                "body": meta.body,
            })
        if skill_items:
            await self.persist_controller.register_skill_schemas(skill_items)

        logger.info(
            "Registered to Platform: %d tool(s), %d skill(s)",
            len(all_tool_items),
            len(skill_items),
        )

    # -- cleanup -----------------------------------------------------------

    def _atexit_close_mcp(self) -> None:
        """Best-effort cleanup of MCP connections on process exit."""
        try:
            loop = asyncio.get_event_loop()
            if not loop.is_closed():
                loop.run_until_complete(self.mcp_client.close())
        except Exception:
            pass
