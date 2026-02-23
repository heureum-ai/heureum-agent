# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tool-domain composition controller."""

import asyncio
import logging
from collections.abc import Awaitable, Callable
from typing import Any, Dict, List, Optional, Set, Tuple

from langchain_core.messages import BaseMessage

from app.models import ToolCallInfo
from app.services.tools.chains import ToolChainRegistry
from app.services.tools.hooks import BeforeHookResult, ToolHook, ToolHookRunner
from app.services.tools.types import ChainRule

logger = logging.getLogger(__name__)


class ToolMetaSets:
    """Dynamic tool classification sets built from client-provided tool_meta.

    Stored per-session in :class:`ToolController` so hooks and callers
    can access them without parameter threading.
    """

    __slots__ = ("snapshot_tools", "mutating_tools", "read_only_tools", "poll_tools")

    def __init__(
        self,
        *,
        snapshot_tools: Set[str] | None = None,
        mutating_tools: Set[str] | None = None,
        read_only_tools: Set[str] | None = None,
        poll_tools: Set[str] | None = None,
    ) -> None:
        self.snapshot_tools: Set[str] = snapshot_tools or set()
        self.mutating_tools: Set[str] = mutating_tools or set()
        self.read_only_tools: Set[str] = read_only_tools or set()
        self.poll_tools: Set[str] = poll_tools or set()


class ToolController:
    """Central controller for chain building and tool hook execution."""

    def __init__(
        self,
        tool_chain_registry: Optional[ToolChainRegistry] = None,
        tool_hook_runner: Optional[ToolHookRunner] = None,
    ) -> None:
        self.tool_chain_registry = tool_chain_registry or ToolChainRegistry()
        self.tool_hook_runner = tool_hook_runner or ToolHookRunner()
        self._session_meta: Dict[str, ToolMetaSets] = {}

    def register(self, rule: ChainRule) -> None:
        self.tool_chain_registry.register(rule)

    def register_many(self, rules: List[ChainRule]) -> None:
        self.tool_chain_registry.register_many(rules)

    def clear(self) -> None:
        self.tool_chain_registry.clear()

    def clear_session(self, session_id: str) -> None:
        self.tool_chain_registry.clear_session(session_id)
        self._session_meta.pop(session_id, None)

    # -- per-session tool metadata -----------------------------------------

    def set_tool_meta(self, session_id: str, meta: ToolMetaSets) -> None:
        """Store client-provided tool metadata for a session."""
        self._session_meta[session_id] = meta

    def get_tool_meta(self, session_id: str) -> ToolMetaSets:
        """Get tool metadata for a session (empty defaults if not set)."""
        return self._session_meta.get(session_id, ToolMetaSets())

    def build_per_result(
        self,
        tc: ToolCallInfo,
        result_msg: BaseMessage,
        session_id: Optional[str] = None,
        *,
        _parse_cache: Optional[Dict[int, Any]] = None,
        _path_cache: Optional[Dict[Tuple[int, str], List]] = None,
    ) -> List[ToolCallInfo]:
        return self.tool_chain_registry.build_per_result(
            tc=tc,
            result_msg=result_msg,
            session_id=session_id,
            _parse_cache=_parse_cache,
            _path_cache=_path_cache,
        )

    def build(
        self,
        executed_calls: List[ToolCallInfo],
        tool_results: List[BaseMessage],
        session_id: Optional[str] = None,
    ) -> List[ToolCallInfo]:
        return self.tool_chain_registry.build(
            executed_calls=executed_calls,
            tool_results=tool_results,
            session_id=session_id,
        )

    def register_hook(self, hook: ToolHook) -> None:
        self.tool_hook_runner.register(hook)

    async def run_before_hooks(
        self,
        tool_name: str,
        params: Dict[str, Any],
        context: Dict[str, Any],
    ) -> BeforeHookResult:
        return await self.tool_hook_runner.run_before(tool_name, params, context)

    async def run_after_hooks(
        self,
        tool_name: str,
        params: Dict[str, Any],
        result: Optional[str],
        error: Optional[str],
        context: Dict[str, Any],
    ) -> None:
        await self.tool_hook_runner.run_after(tool_name, params, result, error, context)

    # ------------------------------------------------------------------
    # Common execution helpers (used by main agent loop & sub-agents)
    # ------------------------------------------------------------------

    async def safe_execute(
        self,
        tc: ToolCallInfo,
        execute_fn: Callable[[str, Dict[str, Any], str], Awaitable[str]],
        session_id: str = "",
    ) -> Tuple[ToolCallInfo, str]:
        """Run before hooks → *execute_fn* → after hooks for a single tool call.

        Args:
            tc: Tool call descriptor.
            execute_fn: ``(name, args, session_id) -> result`` coroutine.
            session_id: Current session identifier.

        Returns:
            ``(tc, result_str)`` — the original tool call and its output (or error string).
        """
        context: Dict[str, Any] = {"session_id": session_id, "tool_call_id": tc.id}

        hook_result = await self.run_before_hooks(tc.name, tc.args, context)
        if hook_result.blocked:
            return tc, f"Error: Tool blocked: {hook_result.reason}"
        params = hook_result.adjusted_params if hook_result.adjusted_params is not None else tc.args

        try:
            result = await execute_fn(tc.name, params, session_id)
            if not result or (isinstance(result, str) and not result.strip()):
                result = f"[EMPTY_RESULT] {tc.name} returned no output. Consider retrying with different parameters."
            await self.run_after_hooks(tc.name, params, result, None, context)
            return tc, result
        except Exception as e:
            logger.warning("Tool execution failed (%s): %s", tc.name, e)
            err_str = f"Error executing tool '{tc.name}': {e}"
            await self.run_after_hooks(tc.name, params, None, str(e), context)
            return tc, err_str

    async def execute_parallel(
        self,
        tool_calls: List[ToolCallInfo],
        execute_fn: Callable[[str, Dict[str, Any], str], Awaitable[str]],
        session_id: str = "",
        on_complete: Optional[Callable[[ToolCallInfo, str], Awaitable[None]]] = None,
    ) -> List[Tuple[ToolCallInfo, str]]:
        """Execute *tool_calls* in parallel via ``safe_execute``.

        Args:
            tool_calls: Batch of tool calls.
            execute_fn: ``(name, args, session_id) -> result`` coroutine.
            session_id: Current session identifier.
            on_complete: Optional callback fired after each tool completes.

        Returns:
            Ordered list of ``(tc, result_str)`` tuples (same order as *tool_calls*).
        """
        if not tool_calls:
            return []

        async def _run(tc: ToolCallInfo) -> Tuple[ToolCallInfo, str]:
            pair = await self.safe_execute(tc, execute_fn, session_id)
            if on_complete is not None:
                await on_complete(pair[0], pair[1])
            return pair

        return list(await asyncio.gather(*[_run(tc) for tc in tool_calls]))
