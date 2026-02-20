# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tool chain registry — generic multi-step tool chaining abstraction.

Chain rules define how the output of one tool triggers a sequence of
follow-up tool calls.  Rules are registered from any source (MCP metadata,
static config, programmatic registration) and the registry builds the
follow-up ``ToolCallInfo`` list step-by-step after each tool execution.

Placeholder reference for ``arg_mapping`` values:

* ``$value``              — extracted value from the previous step's output.
* ``$value.<field>``      — a named field of the extracted value (dict).
* ``$source_args``        — full input arguments of the chain's source tool.
* ``$source_args.<field>``— a specific field from the source tool's input.

``$source_args`` is propagated through all steps so that any step can
reference the original trigger without coupling to intermediate outputs.

Example — web_search → web_fetch → grep:

    ChainRule(
        source="web_search",
        steps=[
            ChainStep(target="web_fetch", extract="results[*].url",
                      arg_mapping={"url": "$value"}),
            ChainStep(target="grep",      extract="$root",
                      arg_mapping={"path": "$value.session_file",
                                   "pattern": "$source_args.query"}),
        ],
    )
"""

import json
import logging
import uuid
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

from app.models import Message, ToolCallInfo

logger = logging.getLogger(__name__)


def _gen_call_id() -> str:
    return f"call_{uuid.uuid4().hex[:16]}"


@dataclass(frozen=True)
class ChainStep:
    """A single step in a tool chain sequence.

    Attributes:
        target: Name of the target tool to invoke.
        extract: JSONPath expression to extract values from the previous
            step's result.  Use ``"$root"`` to pass the entire result.
        arg_mapping: Mapping of target parameter names to placeholder
            expressions.  Supported: ``$value``, ``$value.<field>``,
            ``$source_args``, ``$source_args.<field>``, or literal strings.
    """

    target: str
    extract: str
    arg_mapping: Dict[str, str]


@dataclass(frozen=True)
class ChainRule:
    """A multi-step tool chain starting from a source tool.

    Attributes:
        source: Name of the source tool whose output triggers chaining.
        steps: Ordered sequence of follow-up steps. After the source tool
            executes, step[0] runs using the source's result. After step[0]
            executes, step[1] runs using step[0]'s result, and so on.
    """

    source: str
    steps: List[ChainStep] = field(default_factory=list)


class ToolChainRegistry:
    """Registry of tool chain rules.

    Collects rules from any source and generates follow-up tool calls
    after tool execution.  For multi-step chains, tracks which step
    each active chain is on via ``_active_chains``.
    """

    # Type alias for active chain entries: (rule, step_index, source_args, pending_count)
    _ChainEntry = Tuple["ChainRule", int, Dict[str, Any], int]

    def __init__(self) -> None:
        self._rules: Dict[str, List[ChainRule]] = {}  # source_tool -> rules
        # session_id -> list of (rule, current_step_index, source_args)
        self._active_chains: Dict[str, List["ToolChainRegistry._ChainEntry"]] = {}

    def register(self, rule: ChainRule) -> None:
        """Register a single chain rule."""
        self._rules.setdefault(rule.source, []).append(rule)

    def register_many(self, rules: List[ChainRule]) -> None:
        """Register multiple chain rules at once."""
        for rule in rules:
            self.register(rule)

    def clear(self) -> None:
        """Remove all registered rules."""
        self._rules.clear()

    def clear_session(self, session_id: str) -> None:
        """Remove active chain state for a session."""
        self._active_chains.pop(session_id, None)

    @property
    def rules(self) -> Dict[str, List[ChainRule]]:
        """Read-only access to registered rules."""
        return self._rules

    # ------------------------------------------------------------------
    # Parsing / extraction helpers (Phase 1 caching support)
    # ------------------------------------------------------------------

    @staticmethod
    def _parse_result(result_json: str) -> Optional[Any]:
        """Parse a JSON result string, returning ``None`` on failure."""
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
        """Resolve a single placeholder string to a concrete value.

        Supported placeholders:

        * ``"$value"`` — the extracted value as-is.
        * ``"$value.field"`` — a named field from the extracted value
          (the value must be a dict; falls back to the raw value).
        * ``"$source_args"`` — the entire source tool input arguments dict.
        * ``"$source_args.field"`` — a specific field from the source tool's
          input arguments. Useful for propagating the original query through
          a multi-step chain.
        * Any other string — used as a literal constant.
        """
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
        """Build argument dicts from already-parsed *data* and a chain step.

        Args:
            data: Parsed JSON data from the previous step's result.
            step: Chain step with extract path and arg mapping.
            source_args: Input arguments of the chain's **source** tool
                (the tool that originally triggered the chain). Enables
                ``$source_args`` / ``$source_args.field`` placeholders so
                later steps can reference the original input without
                hardcoding intermediate output field names.
        """
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

    # ------------------------------------------------------------------
    # Per-result builder (Phase 2)
    # ------------------------------------------------------------------

    def build_per_result(
        self,
        tc: ToolCallInfo,
        result_msg: Message,
        session_id: Optional[str] = None,
        *,
        _parse_cache: Optional[Dict[int, Any]] = None,
        _path_cache: Optional[Dict[Tuple[int, str], List]] = None,
    ) -> List[ToolCallInfo]:
        """Generate follow-up tool calls for a single (tc, result_msg) pair.

        This is the per-result building block used by :meth:`build`.  It
        handles both new chain detection and active chain continuation.

        Args:
            tc: The tool call that was just executed.
            result_msg: The corresponding tool result message.
            session_id: Session ID for multi-step chain tracking.
            _parse_cache: Optional shared parse cache (id(content) -> parsed).
            _path_cache: Optional shared path cache ((id(content), extract) -> values).

        Returns:
            List of follow-up ToolCallInfo to execute next.
        """
        if _parse_cache is None:
            _parse_cache = {}
        if _path_cache is None:
            _path_cache = {}

        chained: List[ToolCallInfo] = []
        new_active: List[ToolChainRegistry._ChainEntry] = []

        content = result_msg.content
        content_id = id(content)

        # Cached parse
        if content_id not in _parse_cache:
            _parse_cache[content_id] = self._parse_result(content)
        data = _parse_cache[content_id]

        # 1) New chains triggered by this tool
        rules = self._rules.get(tc.name, [])
        source_args = tc.args  # original source tool's input arguments
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
                        ToolCallInfo(name=step.target, args=args, id=_gen_call_id())
                    )
            chained.extend(step_follow_ups)
            if len(rule.steps) > 1 and step_follow_ups:
                new_active.append((rule, 1, source_args, len(step_follow_ups)))

        # 2) Active chains continuing from this tool
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
                            ToolCallInfo(name=step.target, args=args, id=_gen_call_id())
                        )
                chained.extend(step_follow_ups)
                new_count = pending_count - 1
                if new_count > 0:
                    # More completions expected at this step
                    remaining.append((rule, step_idx, src_args, new_count))
                elif step_idx + 1 < len(rule.steps) and step_follow_ups:
                    new_active.append((rule, step_idx + 1, src_args, len(step_follow_ups)))
            remaining.extend(new_active)
            if remaining:
                self._active_chains[session_id] = remaining
            else:
                self._active_chains.pop(session_id, None)
        return chained

    # ------------------------------------------------------------------
    # Bulk builder (delegates to build_per_result)
    # ------------------------------------------------------------------

    def build(
        self,
        executed_calls: List[ToolCallInfo],
        tool_results: List[Message],
        session_id: Optional[str] = None,
    ) -> List[ToolCallInfo]:
        """Generate the next follow-up tool calls from executed results.

        Handles two sources of chained calls:
          1. New chains: executed tool matches a registered rule's source.
          2. Active chains: executed tool matches an in-progress chain's
             current step (continuing the sequence).

        Args:
            executed_calls: Tool calls that were just executed.
            tool_results: Corresponding tool result messages (same order).
            session_id: Session ID for tracking multi-step chain progress.

        Returns:
            List of follow-up ToolCallInfo to execute next.
        """
        chained: List[ToolCallInfo] = []
        # Shared caches across all (tc, result_msg) pairs in this batch
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
        """Extract chained tool arguments from a result using a chain step.

        Kept for backward compatibility. Internally delegates to
        :meth:`_parse_result` and :meth:`_extract_chain_args_from_data`.

        Args:
            result_json: JSON string from the previous tool's output.
            step: Chain step with extract path and arg mapping.

        Returns:
            List of argument dicts for the target tool.
        """
        data = ToolChainRegistry._parse_result(result_json)
        if data is None:
            return []
        return ToolChainRegistry._extract_chain_args_from_data(data, step)

    @staticmethod
    def _resolve_jsonpath(data: Any, path: str) -> List[Any]:
        """Resolve a minimal JSONPath expression.

        Supports dot notation with ``[*]`` wildcard for arrays.
        Example: ``"results[*].url"`` extracts the ``url`` field from each
        element of the ``results`` array.

        Special path ``"$root"`` returns the entire parsed object as a
        single-element list, useful when subsequent steps need the whole
        result (e.g. to pick multiple fields via ``$value.field``).
        """
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
