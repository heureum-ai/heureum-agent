# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tool chain registry — multi-step tool chaining abstraction."""

import json
from typing import Any, Dict, List, Optional, Tuple

from langchain_core.messages import BaseMessage

from app.models import ToolCallInfo
from app.services.tools.types import ChainRule, ChainStep, gen_tool_call_id


class ToolChainRegistry:
    """Registry of chain rules and per-session active chain state."""

    _ChainEntry = Tuple[ChainRule, int, Dict[str, Any], int]

    def __init__(self) -> None:
        self._rules: Dict[str, List[ChainRule]] = {}
        self._active_chains: Dict[str, List[ToolChainRegistry._ChainEntry]] = {}

    def register(self, rule: ChainRule) -> None:
        self._rules.setdefault(rule.source, []).append(rule)

    def register_many(self, rules: List[ChainRule]) -> None:
        for rule in rules:
            self.register(rule)

    def clear(self) -> None:
        self._rules.clear()

    def clear_session(self, session_id: str) -> None:
        self._active_chains.pop(session_id, None)

    @property
    def rules(self) -> Dict[str, List[ChainRule]]:
        return self._rules

    @staticmethod
    def _parse_result(result_json: str) -> Optional[Any]:
        try:
            return json.loads(result_json)
        except (json.JSONDecodeError, TypeError):
            return None

    @staticmethod
    def _resolve_placeholder(
        placeholder: str,
        val: Any,
        source_args: Optional[Dict[str, Any]] = None,
    ) -> Any:
        if placeholder == "$value":
            return val
        if placeholder.startswith("$value."):
            field = placeholder[len("$value.") :]
            return val.get(field) if isinstance(val, dict) else val
        if placeholder == "$source_args":
            return source_args or {}
        if placeholder.startswith("$source_args."):
            field = placeholder[len("$source_args.") :]
            return (source_args or {}).get(field) or None
        return placeholder

    @staticmethod
    def _extract_chain_args_from_data(
        data: Any,
        step: ChainStep,
        *,
        source_args: Optional[Dict[str, Any]] = None,
    ) -> List[Dict[str, Any]]:
        values = ToolChainRegistry._resolve_jsonpath(data, step.extract)
        result_list: List[Dict[str, Any]] = []
        for val in values:
            mapped: Dict[str, Any] = {}
            for k, v in step.arg_mapping.items():
                resolved = ToolChainRegistry._resolve_placeholder(v, val, source_args)
                if resolved is not None:
                    mapped[k] = resolved
            if mapped:
                result_list.append(mapped)
        return result_list

    def build_per_result(
        self,
        tc: ToolCallInfo,
        result_msg: BaseMessage,
        session_id: Optional[str] = None,
        *,
        _parse_cache: Optional[Dict[int, Any]] = None,
        _path_cache: Optional[Dict[Tuple[int, str], List]] = None,
    ) -> List[ToolCallInfo]:
        if _parse_cache is None:
            _parse_cache = {}
        if _path_cache is None:
            _path_cache = {}

        chained: List[ToolCallInfo] = []
        new_active: List[ToolChainRegistry._ChainEntry] = []

        content = result_msg.content
        content_id = id(content)

        if content_id not in _parse_cache:
            _parse_cache[content_id] = self._parse_result(content)
        data = _parse_cache[content_id]

        rules = self._rules.get(tc.name, [])
        source_args = tc.args
        for rule in rules:
            if not rule.steps:
                continue
            step = rule.steps[0]
            step_follow_ups: List[ToolCallInfo] = []
            if data is not None:
                path_key = (content_id, step.extract)
                if path_key not in _path_cache:
                    _path_cache[path_key] = self._resolve_jsonpath(data, step.extract)
                for args in self._extract_chain_args_from_data(
                    data,
                    step,
                    source_args=source_args,
                ):
                    step_follow_ups.append(
                        ToolCallInfo(name=step.target, args=args, id=gen_tool_call_id())
                    )
            chained.extend(step_follow_ups)
            if len(rule.steps) > 1 and step_follow_ups:
                new_active.append((rule, 1, source_args, len(step_follow_ups)))

        if session_id:
            remaining: List[ToolChainRegistry._ChainEntry] = []
            for rule, step_idx, src_args, pending_count in self._active_chains.get(session_id, []):
                if step_idx >= len(rule.steps):
                    continue
                expected_target = rule.steps[step_idx - 1].target if step_idx > 0 else rule.source
                if tc.name != expected_target:
                    remaining.append((rule, step_idx, src_args, pending_count))
                    continue
                step = rule.steps[step_idx]
                step_follow_ups: List[ToolCallInfo] = []
                if data is not None:
                    path_key = (content_id, step.extract)
                    if path_key not in _path_cache:
                        _path_cache[path_key] = self._resolve_jsonpath(data, step.extract)
                    for args in self._extract_chain_args_from_data(
                        data,
                        step,
                        source_args=src_args,
                    ):
                        step_follow_ups.append(
                            ToolCallInfo(name=step.target, args=args, id=gen_tool_call_id())
                        )
                chained.extend(step_follow_ups)
                new_count = pending_count - 1
                if new_count > 0:
                    remaining.append((rule, step_idx, src_args, new_count))
                elif step_idx + 1 < len(rule.steps) and step_follow_ups:
                    new_active.append((rule, step_idx + 1, src_args, len(step_follow_ups)))
            remaining.extend(new_active)
            if remaining:
                self._active_chains[session_id] = remaining
            else:
                self._active_chains.pop(session_id, None)
        return chained

    def build(
        self,
        executed_calls: List[ToolCallInfo],
        tool_results: List[BaseMessage],
        session_id: Optional[str] = None,
    ) -> List[ToolCallInfo]:
        chained: List[ToolCallInfo] = []
        _parse_cache: Dict[int, Any] = {}
        _path_cache: Dict[Tuple[int, str], List] = {}

        for tc, result_msg in zip(executed_calls, tool_results):
            chained.extend(
                self.build_per_result(
                    tc,
                    result_msg,
                    session_id=session_id,
                    _parse_cache=_parse_cache,
                    _path_cache=_path_cache,
                )
            )

        return chained

    @staticmethod
    def _extract_chain_args(result_json: str, step: ChainStep) -> List[Dict[str, Any]]:
        data = ToolChainRegistry._parse_result(result_json)
        if data is None:
            return []
        return ToolChainRegistry._extract_chain_args_from_data(data, step)

    @staticmethod
    def _resolve_jsonpath(data: Any, path: str) -> List[Any]:
        if path == "$root":
            return [data]

        parts = path.replace("[*]", ".[*]").split(".")
        current: List[Any] = [data]
        for part in parts:
            if not part:
                continue
            next_vals: List[Any] = []
            for item in current:
                if part == "[*]" and isinstance(item, list):
                    next_vals.extend(item)
                elif isinstance(item, dict) and part in item:
                    next_vals.append(item[part])
            current = next_vals
        return current
