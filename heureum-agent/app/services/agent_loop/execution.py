# Copyright (c) 2026 Heureum AI. All rights reserved.

"""ToolExecutionController — tool execution pipeline, resolve_tools, and judge evaluation."""

from __future__ import annotations

import asyncio
import logging
import time
import uuid
from typing import TYPE_CHECKING, Any, Dict, List, Optional, Set, Tuple

from app.config import ApprovalChoice, settings
from app.models import ToolCallInfo
from app.schemas.open_responses import (
    FunctionToolResult,
    ResponseObject,
    ResponseRequest,
    Usage,
)
from app.services.tools.controller import ToolMetaSets
from app.services.middleware.types import (
    MCPCallEvent,
    MiddlewareContext,
    SkillExecuteEvent,
    ToolCallEvent,
)
from langchain_core.messages import BaseMessage, ToolMessage

if TYPE_CHECKING:
    from app.services.agent_service import AgentService
    from app.services.mcps import MCPClientController
    from app.services.middleware.messages import MessageRegistry
    from app.services.middleware.runner import MiddlewareRunner
    from app.services.skills import SkillController
    from app.services.tools import ToolController

logger = logging.getLogger(__name__)


class ToolExecutionController:
    """Tool execution pipeline with constructor-injected dependencies."""

    _tool_schema_cache: Dict[frozenset, tuple[float, list]] = {}
    _TOOL_SCHEMA_CACHE_TTL = 300.0  # 5 minutes
    _skill_schema_cache: Dict[frozenset, tuple[float, list]] = {}
    _SKILL_SCHEMA_CACHE_TTL = 300.0  # 5 minutes
    _skill_body_cache: Dict[str, tuple[float, str]] = {}
    _SKILL_BODY_CACHE_TTL = 300.0  # 5 minutes

    def __init__(
        self,
        agent_service: AgentService,
        skill_controller: SkillController,
        mcp_client: MCPClientController,
        tool_controller: ToolController,
        middleware_runner: MiddlewareRunner | None = None,
        messages: MessageRegistry | None = None,
    ) -> None:
        self.agent_service = agent_service
        self.skill_controller = skill_controller
        self.mcp_client = mcp_client
        self.tool_controller = tool_controller
        self._middleware = middleware_runner
        self._messages = messages

    async def execute_tool(self, name: str, arguments: Dict[str, Any], session_id: str = "") -> str:
        """Dispatch tool execution by name, firing Skill/MCP middleware events."""
        if self.skill_controller.get_skill_for_tool(name) is not None:
            if self._middleware:
                ctx = MiddlewareContext(session_id=session_id)
                event = SkillExecuteEvent(context=ctx, tool_name=name, arguments=arguments)
                before = await self._middleware.run_before(event)
                if before.blocked:
                    if self._messages:
                        error_message, _ = await self._messages.resolve(
                            "tool.error_skill_blocked",
                            session_id=session_id,
                            reason=before.reason,
                        )
                        return error_message
                    return f"Error: Skill blocked: {before.reason}"
                args = (
                    before.modified_args.get("arguments", arguments)
                    if before.modified_args
                    else arguments
                )
                result = await self.skill_controller.execute_tool(name, args, session_id)
                event.result = result
                await self._middleware.run_after(event)
                return result
            return await self.skill_controller.execute_tool(name, arguments, session_id)

        # Use safe check: if fast-path fails, retry discovery once before giving up.
        # This prevents transient failures during MCP cache TTL refresh windows.
        if await self.mcp_client.is_server_tool_safe(name):
            if self._middleware:
                ctx = MiddlewareContext(session_id=session_id)
                event = MCPCallEvent(context=ctx, tool_name=name, arguments=arguments)
                before = await self._middleware.run_before(event)
                if before.blocked:
                    if self._messages:
                        error_message, _ = await self._messages.resolve(
                            "tool.error_mcp_blocked",
                            session_id=session_id,
                            reason=before.reason,
                        )
                        return error_message
                    return f"Error: MCP tool blocked: {before.reason}"
                args = (
                    before.modified_args.get("arguments", arguments)
                    if before.modified_args
                    else arguments
                )
                result = await self.mcp_client.call_tool(name, args, session_id=session_id)
                event.result = result
                await self._middleware.run_after(event)
                return result
            return await self.mcp_client.call_tool(name, arguments, session_id=session_id)

        if self._messages:
            error_message, _ = await self._messages.resolve(
                "tool.error_unavailable",
                session_id=session_id,
                name=name,
            )
            return error_message
        return f"Error: Tool '{name}' is no longer available."

    async def safe_execute_tool(
        self, tc: ToolCallInfo, session_id: str = ""
    ) -> tuple[ToolCallInfo, str]:
        """Execute a single tool call and convert failures to readable tool output."""
        if self._middleware:
            return await self._safe_execute_tool_middleware(tc, session_id)
        return await self.tool_controller.safe_execute(tc, self._execute_tool_adapter, session_id)

    async def _safe_execute_tool_middleware(
        self, tc: ToolCallInfo, session_id: str
    ) -> tuple[ToolCallInfo, str]:
        """Middleware path: ToolHookBridge handles legacy hooks via the chain."""
        meta = self.tool_controller.get_tool_meta(session_id)
        ctx = MiddlewareContext(
            session_id=session_id,
            extras={
                "tool_call_id": tc.id,
                "_dynamic_mutating": frozenset(meta.mutating_tools),
                "_dynamic_read_only": frozenset(meta.read_only_tools),
                "_dynamic_poll": frozenset(meta.poll_tools),
            },
        )
        event = ToolCallEvent(context=ctx, tool_name=tc.name, params=dict(tc.args))

        before = await self._middleware.run_before(event)  # type: ignore[union-attr]
        if before.blocked:
            if self._messages:
                error_message, _ = await self._messages.resolve(
                    "tool.error_blocked",
                    session_id=session_id,
                    reason=before.reason,
                )
                return tc, error_message
            return tc, f"Error: Tool blocked: {before.reason}"

        params = (
            before.modified_args.get("params", event.params)
            if before.modified_args
            else event.params
        )

        try:
            result = await self.execute_tool(tc.name, params, session_id=session_id)
            if not result or (isinstance(result, str) and not result.strip()):
                if self._messages:
                    result, _ = await self._messages.resolve(
                        "tool.error_empty",
                        session_id=session_id,
                        name=tc.name,
                    )
                else:
                    result = (
                        f"[EMPTY_RESULT] {tc.name} returned no output. "
                        "Consider retrying with different parameters."
                    )
            event.result = result
            await self._middleware.run_after(event)  # type: ignore[union-attr]
            return tc, result
        except Exception as e:
            logger.warning("Tool execution failed (%s): %s", tc.name, e)
            if self._messages:
                error_string, _ = await self._messages.resolve(
                    "tool.error_exec",
                    session_id=session_id,
                    name=tc.name,
                    error=str(e),
                )
            else:
                error_string = f"Error executing tool '{tc.name}': {e}"
            event.error = str(e)
            await self._middleware.run_after(event)  # type: ignore[union-attr]
            return tc, error_string

    async def _execute_tool_adapter(
        self, name: str, arguments: Dict[str, Any], session_id: str = ""
    ) -> str:
        """Adapter matching the ``(name, args, session_id) -> str`` signature."""
        return await self.execute_tool(name, arguments, session_id=session_id)

    @staticmethod
    def extract_display_names(
        tool_calls: List[ToolCallInfo], display_names: Dict[str, str]
    ) -> None:
        """Pop LLM-generated display_name from args into the shared dict."""
        for tc in tool_calls:
            if isinstance(tc.args, dict):
                dn = tc.args.pop("display_name", None)
                if dn and tc.name not in display_names:
                    display_names[tc.name] = dn

    async def execute_tool_calls(
        self,
        tool_calls: List[ToolCallInfo],
        all_output_items: list,
        display_names: Dict[str, str],
        session_id: str = "",
    ) -> List[BaseMessage]:
        """Execute tool calls in parallel and append call/result items to history."""
        if not tool_calls:
            return []
        self.extract_display_names(tool_calls, display_names)

        results = await self.tool_controller.execute_parallel(
            tool_calls, self._execute_tool_adapter, session_id
        )

        tool_results: List[BaseMessage] = []
        for tc, result_str in results:
            tool_results.append(
                ToolMessage(
                    content=result_str,
                    tool_call_id=tc.id,
                    name=tc.name,
                )
            )
            all_output_items.append(
                self.agent_service.responses.tool_call_output(
                    tc.name, tc.args, tc.id, display_name=display_names[tc.name]
                )
            )
            all_output_items.append(
                FunctionToolResult(
                    id=f"out_{uuid.uuid4().hex}",
                    call_id=tc.id,
                    output=result_str,
                )
            )
        return tool_results

    async def execute_tool_calls_pipelined(
        self,
        tool_calls: List[ToolCallInfo],
        all_output_items: list,
        display_names: Dict[str, str],
        session_id: str,
        max_depth: int = 0,
        result_queue: Optional[asyncio.Queue] = None,
    ) -> Tuple[List[BaseMessage], List[ToolCallInfo]]:
        """Execute tool calls with pipelined chain follow-ups.

        Instead of waiting for *all* tools to finish before detecting chain
        follow-ups, this function uses ``asyncio.wait(FIRST_COMPLETED)`` so
        that each tool's result can immediately trigger chain follow-up calls.

        Follow-up calls that do *not* require approval are added to the
        in-flight task set immediately.  Calls that require approval are
        collected in a ``deferred_approval`` list and returned to the caller.

        Chain depth is tracked per in-flight tool call (hop count from the
        original tool), not per event-loop cycle.  This avoids completion-order
        races where late-finishing sibling calls lose their follow-ups.

        Args:
            tool_calls: Initial batch of tool calls.
            all_output_items: Mutable list for output items (modified in place).
            session_id: Current session ID.
            max_depth: Maximum chain depth (0 = use ``settings.MAX_CHAIN_DEPTH``).
            result_queue: If provided, each ``(tc, result_str)`` is put on the
                queue as soon as it completes (for streaming).

        Returns:
            ``(all_results, deferred_approval)`` — all result Messages and
            any chained calls that still need user approval.
        """
        self.extract_display_names(tool_calls, display_names)
        if max_depth <= 0:
            max_depth = settings.MAX_CHAIN_DEPTH

        all_results: List[BaseMessage] = []
        deferred_approval: List[ToolCallInfo] = []

        pending: Dict[asyncio.Task, Tuple[ToolCallInfo, int]] = {
            asyncio.create_task(self.safe_execute_tool(tc, session_id=session_id)): (
                tc,
                0,
            )
            for tc in tool_calls
        }

        while pending:
            done, _ = await asyncio.wait(pending.keys(), return_when=asyncio.FIRST_COMPLETED)

            for task in done:
                _tc_orig, hop_depth = pending.pop(task)
                tc_done, result_str = task.result()

                msg = self.agent_service.responses.make_tool_result_message(
                    tool_name=tc_done.name,
                    tool_call_id=tc_done.id,
                    result=result_str,
                )
                all_results.append(msg)
                self.agent_service.responses.append_tool_output_items(
                    tool_name=tc_done.name,
                    display_name=display_names[tc_done.name],
                    arguments=tc_done.args,
                    tool_call_id=tc_done.id,
                    result=result_str,
                    output_items=all_output_items,
                )

                if result_queue is not None:
                    await result_queue.put((tc_done, result_str))

                if hop_depth < max_depth:
                    follow_ups = self.tool_controller.build_per_result(
                        tc_done,
                        msg,
                        session_id=session_id,
                    )
                    for fu in follow_ups:
                        pending[
                            asyncio.create_task(self.safe_execute_tool(fu, session_id=session_id))
                        ] = (
                            fu,
                            hop_depth + 1,
                        )

        if result_queue is not None:
            await result_queue.put(None)  # sentinel

        return all_results, deferred_approval

    def _snapshot_tools_for(self, session_id: str) -> frozenset:
        """Return the snapshot tool names for a session from ToolController."""
        return frozenset(self.tool_controller.get_tool_meta(session_id).snapshot_tools)

    async def handle_chained_calls(
        self,
        chained: List[ToolCallInfo],
        session_id: str,
        created_at: int,
        model: str,
        total_usage: Usage,
        tool_call_count: int,
        all_output_items: list,
        display_names: Dict[str, str],
        iteration: int | None = None,
    ) -> ResponseObject | None:
        """Execute or gate chained calls, looping through follow-up chains.

        After executing a batch of chained calls, the results are fed back into
        ``tool_controller.build()`` to detect further chain steps.  This loop
        continues up to ``MAX_CHAIN_DEPTH`` times, ensuring multi-step chains
        run to completion without returning to the LLM between steps.

        Returns an approval response if any tool in a batch requires user
        approval; otherwise returns ``None`` after all chain steps complete.
        """
        current = chained
        for _ in range(settings.MAX_CHAIN_DEPTH):
            if not current:
                break

            chain_results = await self.execute_tool_calls(
                current, all_output_items, display_names, session_id=session_id
            )
            await self.agent_service.append_tool_interaction(
                session_id,
                [],
                [tc.model_dump() for tc in current],
                chain_results,
                snapshot_tools=self._snapshot_tools_for(session_id),
            )

            current = self.tool_controller.build(current, chain_results, session_id=session_id)

        return None

    async def handle_approval_continuation(
        self,
        session_id: str,
        messages: List[BaseMessage],
        all_output_items: list,
        created_at: int,
        model: str,
        total_usage: Usage,
        tool_call_count: int,
        display_names: Dict[str, str],
    ) -> tuple[ResponseObject | None, List[BaseMessage], int, Usage]:
        """Handle approval answer from previous INCOMPLETE response, if present."""
        approval_result = self.mcp_client.handle_approval_response(session_id, messages)
        if not approval_result:
            return None, messages, tool_call_count, total_usage

        pending_tcs = approval_result["tool_calls"]
        messages = approval_result["filtered_messages"]
        tool_call_dicts = [tc.model_dump() for tc in pending_tcs]

        if approval_result["usage"]:
            total_usage = total_usage.add(approval_result["usage"])

        if approval_result["decision"] in (
            ApprovalChoice.ALLOW_ONCE.decision,
            ApprovalChoice.ALWAYS_ALLOW.decision,
        ):
            tool_results = await self.execute_tool_calls(
                pending_tcs, all_output_items, display_names, session_id=session_id
            )
            tool_call_count += len(tool_results)
        else:
            tool_results = []
            for tc in pending_tcs:
                if self._messages:
                    denied_message, _ = await self._messages.resolve(
                        "tool.error_denied",
                        session_id=session_id,
                        name=tc.name,
                    )
                else:
                    denied_message = f"Permission denied by user for tool: {tc.name}"
                tool_results.append(
                    ToolMessage(
                        content=denied_message,
                        tool_call_id=tc.id,
                        name=tc.name,
                    )
                )

        await self.agent_service.append_tool_interaction(
            session_id,
            approval_result["input_messages"],
            tool_call_dicts,
            tool_results,
            usage=approval_result["usage"].model_dump() if approval_result["usage"] else {},
            assistant_lc_message=approval_result.get("assistant_lc_message"),
            snapshot_tools=self._snapshot_tools_for(session_id),
        )

        remaining = approval_result.get("remaining_chained", [])
        if remaining:
            chain_resp = await self.handle_chained_calls(
                remaining,
                session_id,
                created_at,
                model,
                total_usage,
                tool_call_count,
                all_output_items,
                display_names,
            )
            if chain_resp:
                return chain_resp, [], tool_call_count, total_usage

        chained = self.tool_controller.build(pending_tcs, tool_results, session_id=session_id)
        if chained:
            chain_resp = await self.handle_chained_calls(
                chained,
                session_id,
                created_at,
                model,
                total_usage,
                tool_call_count,
                all_output_items,
                display_names,
            )
            if chain_resp:
                return chain_resp, [], tool_call_count, total_usage

        return None, [], tool_call_count, total_usage

    # -- skills snapshot / persist helpers ------------------------------------

    @staticmethod
    def _snapshot_items(skills_snapshot: Any) -> list:
        if not skills_snapshot:
            return []
        if isinstance(skills_snapshot, dict):
            items = skills_snapshot.get("skills")
        else:
            items = getattr(skills_snapshot, "skills", None)
        return items if isinstance(items, list) else []

    @classmethod
    def _snapshot_skill_names(cls, skills_snapshot: Any) -> list[str]:
        names: list[str] = []
        for item in cls._snapshot_items(skills_snapshot):
            name = item.get("name") if isinstance(item, dict) else getattr(item, "name", None)
            if isinstance(name, str) and name.strip():
                names.append(name.strip())
        return names

    @staticmethod
    def _snapshot_has_prompt(skills_snapshot: Any) -> bool:
        if not skills_snapshot:
            return False
        prompt = (
            skills_snapshot.get("prompt")
            if isinstance(skills_snapshot, dict)
            else getattr(skills_snapshot, "prompt", None)
        )
        return bool(isinstance(prompt, str) and prompt.strip())

    @staticmethod
    def _snapshot_item_tools(item: Any) -> list[str]:
        raw = item.get("tools") if isinstance(item, dict) else getattr(item, "tools", None)
        if not isinstance(raw, list):
            return []
        return [tool for tool in raw if isinstance(tool, str) and tool]

    @staticmethod
    def _set_snapshot_item_tools(item: Any, tools: list[str]) -> None:
        if isinstance(item, dict):
            item["tools"] = tools
        else:
            item.tools = tools

    async def _fetch_skill_schemas_cached(
        self,
        persist_controller: Any,
        names: list[str],
    ) -> list[dict]:
        if not names or not persist_controller:
            return []
        cache_key = frozenset(name.strip().lower() for name in names if isinstance(name, str) and name.strip())
        if not cache_key:
            return []

        now = time.monotonic()
        cached = self._skill_schema_cache.get(cache_key)
        if cached and (now - cached[0]) < self._SKILL_SCHEMA_CACHE_TTL:
            return cached[1]

        schemas = await persist_controller.fetch_skill_schemas(list(names))
        if len(self._skill_schema_cache) > 50:
            stale_keys = [
                key
                for key, value in self._skill_schema_cache.items()
                if (now - value[0]) >= self._SKILL_SCHEMA_CACHE_TTL
            ]
            for key in stale_keys:
                del self._skill_schema_cache[key]
        self._skill_schema_cache[cache_key] = (now, schemas)
        return schemas

    async def _fetch_skill_body_cached(
        self,
        persist_controller: Any,
        skill_name: str,
    ) -> str:
        if not persist_controller or not isinstance(skill_name, str) or not skill_name.strip():
            return ""
        key = skill_name.strip()
        now = time.monotonic()
        cached = self._skill_body_cache.get(key)
        if cached and (now - cached[0]) < self._SKILL_BODY_CACHE_TTL:
            return cached[1]

        body = await persist_controller.fetch_skill_body(key)
        if len(self._skill_body_cache) > 200:
            stale_keys = [
                cache_key
                for cache_key, value in self._skill_body_cache.items()
                if (now - value[0]) >= self._SKILL_BODY_CACHE_TTL
            ]
            for cache_key in stale_keys:
                del self._skill_body_cache[cache_key]
        self._skill_body_cache[key] = (now, body or "")
        return body or ""

    async def resolve_tools(
        self,
        request: ResponseRequest,
        session_id: str | None = None,
        persist_controller: Any | None = None,
    ) -> Tuple[List[str], List[dict], Set[str], List[str], Dict[str, str], ToolMetaSets]:
        """Resolve tool names, schemas, client tool names, guides, display names, and metadata.

        When *persist_controller* is provided, tools needed by active skills
        but not supplied by the client or MCP are fetched from Platform DB.

        Returns:
            (tool_names, client_tool_schemas, client_tool_names, client_tool_prompts,
             display_names, tool_meta_sets)
        """
        # Inject server-only skills into snapshot so they pass allowlist filters
        self.skill_controller.enrich_snapshot(request.skills_snapshot, session_id=session_id)

        client_tool_names: Set[str] = set()
        client_tool_schemas: List[dict] = []
        tool_names: List[str] = []
        client_tool_prompts: List[str] = []
        display_names: Dict[str, str] = {}
        meta_sets = ToolMetaSets()
        snapshot_skill_names = self._snapshot_skill_names(request.skills_snapshot)

        if request.tools:
            for t in request.tools:
                name = t.function.name
                client_tool_names.add(name)
                tool_names.append(name)
                client_tool_schemas.append(
                    t.model_dump(exclude_none=True, exclude={"guide", "display_name", "tool_meta"})
                )
                if t.guide:
                    client_tool_prompts.append(t.guide)
                if t.display_name:
                    display_names[name] = t.display_name
                if t.tool_meta:
                    if t.tool_meta.snapshot:
                        meta_sets.snapshot_tools.add(name)
                    if t.tool_meta.mutating:
                        meta_sets.mutating_tools.add(name)
                    if t.tool_meta.read_only:
                        meta_sets.read_only_tools.add(name)
                    if t.tool_meta.poll:
                        meta_sets.poll_tools.add(name)

        # Build skill metadata from Platform DB when snapshot skill entries are
        # present. This lets us recover missing "tools" arrays and resolve
        # schemas even when the client sends only skill names.
        db_skill_tools: Set[str] = set()
        if persist_controller and snapshot_skill_names:
            db_skills = await self._fetch_skill_schemas_cached(
                persist_controller,
                snapshot_skill_names,
            )
            db_by_name = {
                (item.get("skill_name") or "").strip().lower(): item
                for item in db_skills
                if isinstance(item, dict) and item.get("skill_name")
            }
            for snap_item in self._snapshot_items(request.skills_snapshot):
                snap_name = (
                    snap_item.get("name")
                    if isinstance(snap_item, dict)
                    else getattr(snap_item, "name", None)
                )
                if not isinstance(snap_name, str) or not snap_name.strip():
                    continue
                existing_tools = self._snapshot_item_tools(snap_item)
                if existing_tools:
                    db_skill_tools.update(existing_tools)
                    continue
                db_skill = db_by_name.get(snap_name.strip().lower())
                if not db_skill:
                    continue
                db_tools = [
                    tool
                    for tool in db_skill.get("tools", [])
                    if isinstance(tool, str) and tool
                ]
                if not db_tools:
                    continue
                self._set_snapshot_item_tools(snap_item, db_tools)
                db_skill_tools.update(db_tools)
            for item in db_skills:
                if not isinstance(item, dict):
                    continue
                for tool in item.get("tools", []):
                    if isinstance(tool, str) and tool:
                        db_skill_tools.add(tool)

            # When snapshot.prompt is absent, fetch SKILL.md bodies from DB and
            # expose them as tool guides.
            if not self._snapshot_has_prompt(request.skills_snapshot):
                norm_active = set()
                if session_id:
                    norm_active = {
                        (name or "").strip().lower()
                        for name in self.skill_controller.get_active_skill_names(session_id)
                    }
                target_skill_names = (
                    [
                        name
                        for name in snapshot_skill_names
                        if (name or "").strip().lower() in norm_active
                    ]
                    if norm_active
                    else list(snapshot_skill_names)
                )
                seen_guides = set(client_tool_prompts)
                if target_skill_names:
                    bodies = await asyncio.gather(*(
                        self._fetch_skill_body_cached(persist_controller, name)
                        for name in target_skill_names
                    ))
                    for skill_name, body in zip(target_skill_names, bodies):
                        if not body:
                            continue
                        safe_name = skill_name.replace('"', "'").strip() or "skill"
                        guide = f'<tool_guide name="{safe_name}">\n{body}\n</tool_guide>'
                        if guide not in seen_guides:
                            seen_guides.add(guide)
                            client_tool_prompts.append(guide)

        # 1. Resolve allowed local server skill tools.
        allowed_skill_tools = self.skill_controller.get_all_tool_names(
            skills_snapshot=request.skills_snapshot,
        )

        # 1. Collect available tool names (client + MCP)
        available = client_tool_names | set(self.mcp_client.server_tool_names)

        # 2. Fetch missing tools from DB if persist_controller available
        missing = self.skill_controller.get_missing_tool_names(
            available_names=available,
            skills_snapshot=request.skills_snapshot,
        )
        # Include tools referenced by DB skill metadata (for snapshot skills
        # unknown to local server skill registry).
        missing |= {
            tool_name
            for tool_name in db_skill_tools
            if tool_name not in available and tool_name not in allowed_skill_tools
        }
        if missing and persist_controller:
            cache_key = frozenset(missing)
            now = time.monotonic()
            cached = self._tool_schema_cache.get(cache_key)
            if cached and (now - cached[0]) < self._TOOL_SCHEMA_CACHE_TTL:
                db_tools = cached[1]
            else:
                db_tools = await persist_controller.fetch_tool_schemas(list(missing))
                # Evict stale entries when cache grows too large
                if len(self._tool_schema_cache) > 50:
                    stale_keys = [
                        k for k, v in self._tool_schema_cache.items()
                        if (now - v[0]) >= self._TOOL_SCHEMA_CACHE_TTL
                    ]
                    for k in stale_keys:
                        del self._tool_schema_cache[k]
                self._tool_schema_cache[cache_key] = (now, db_tools)
            for item in db_tools:
                name = item["tool_name"]
                client_tool_schemas.append(item["schema"])
                tool_names.append(name)
                # Only mark as client tool if execution_target is "client".
                # Server-side tools (skill, mcp) stay out of client_tool_names
                # so they get routed to server execution.
                if item.get("execution_target") == "client":
                    client_tool_names.add(name)
                if item.get("guide"):
                    client_tool_prompts.append(item["guide"])
                if item.get("display_name"):
                    display_names[name] = item["display_name"]

        if client_tool_names:
            for name in self.mcp_client.server_tool_names:
                if name not in client_tool_names:
                    tool_names.append(name)
        for name in allowed_skill_tools:
            if name not in tool_names:
                tool_names.append(name)

        display_names.update(self.mcp_client.display_names)
        display_names.update(self.skill_controller.display_names)

        return (
            tool_names,
            client_tool_schemas,
            client_tool_names,
            client_tool_prompts,
            display_names,
            meta_sets,
        )

