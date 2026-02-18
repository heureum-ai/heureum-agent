# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for app.services.tool_chain — ToolChainRegistry."""

import json

from app.models import Message, ToolCallInfo
from app.schemas.open_responses import MessageRole
from app.services.providers.tool import ChainRule, ChainStep, ToolChainRegistry


# ---------------------------------------------------------------------------
# 1. Single-step chains (migrated from test_mcp_client.py)
# ---------------------------------------------------------------------------


class TestBuildSingleStep:
    def test_web_search_chains_web_fetch(self):
        """web_search results produce web_fetch calls for each URL."""
        registry = ToolChainRegistry()
        registry.register(
            ChainRule(
                source="web_search",
                steps=[
                    ChainStep(target="web_fetch", extract="results[*].url", arg_mapping={"url": "$value"}),
                ],
            )
        )
        search_result = json.dumps({
            "results": [
                {"url": "https://example.com/1", "title": "One"},
                {"url": "https://example.com/2", "title": "Two"},
            ]
        })
        executed = [ToolCallInfo(name="web_search", args={"query": "q"}, id="c1")]
        results = [Message(role=MessageRole.TOOL, content=search_result, tool_call_id="c1")]

        chained = registry.build(executed, results)

        assert len(chained) == 2
        assert all(tc.name == "web_fetch" for tc in chained)
        assert chained[0].args == {"url": "https://example.com/1"}
        assert chained[1].args == {"url": "https://example.com/2"}

    def test_non_search_tool_no_chain(self):
        registry = ToolChainRegistry()
        executed = [ToolCallInfo(name="calculator", args={}, id="c1")]
        results = [Message(role=MessageRole.TOOL, content="42", tool_call_id="c1")]

        assert registry.build(executed, results) == []

    def test_invalid_json_no_chain(self):
        registry = ToolChainRegistry()
        registry.register(
            ChainRule(
                source="web_search",
                steps=[ChainStep(target="web_fetch", extract="results[*].url", arg_mapping={"url": "$value"})],
            )
        )
        executed = [ToolCallInfo(name="web_search", args={"query": "q"}, id="c1")]
        results = [Message(role=MessageRole.TOOL, content="not json", tool_call_id="c1")]

        assert registry.build(executed, results) == []


# ---------------------------------------------------------------------------
# 2. Multi-step chain sequences
# ---------------------------------------------------------------------------


class TestBuildMultiStep:
    def _make_registry(self) -> ToolChainRegistry:
        registry = ToolChainRegistry()
        registry.register(
            ChainRule(
                source="web_search",
                steps=[
                    ChainStep(target="web_fetch", extract="results[*].url", arg_mapping={"url": "$value"}),
                    ChainStep(target="summarize", extract="content", arg_mapping={"text": "$value"}),
                ],
            )
        )
        return registry

    def test_first_step_returns_immediate_target(self):
        registry = self._make_registry()
        search_result = json.dumps({"results": [{"url": "https://example.com/1"}]})
        executed = [ToolCallInfo(name="web_search", args={"query": "q"}, id="c1")]
        results = [Message(role=MessageRole.TOOL, content=search_result, tool_call_id="c1")]

        chained = registry.build(executed, results, session_id="s1")

        assert len(chained) == 1
        assert chained[0].name == "web_fetch"

    def test_second_step_continues_chain(self):
        registry = self._make_registry()

        # Step 0: web_search → web_fetch
        search_result = json.dumps({"results": [{"url": "https://example.com/1"}]})
        step0 = registry.build(
            [ToolCallInfo(name="web_search", args={"query": "q"}, id="c1")],
            [Message(role=MessageRole.TOOL, content=search_result, tool_call_id="c1")],
            session_id="s1",
        )

        # Step 1: web_fetch → summarize
        fetch_result = json.dumps({"content": "Hello world"})
        step1 = registry.build(
            step0,
            [Message(role=MessageRole.TOOL, content=fetch_result, tool_call_id=step0[0].id)],
            session_id="s1",
        )

        assert len(step1) == 1
        assert step1[0].name == "summarize"
        assert step1[0].args == {"text": "Hello world"}

    def test_chain_completes_after_all_steps(self):
        registry = self._make_registry()

        # Step 0
        step0 = registry.build(
            [ToolCallInfo(name="web_search", args={"query": "q"}, id="c1")],
            [Message(role=MessageRole.TOOL, content=json.dumps({"results": [{"url": "https://x.com"}]}), tool_call_id="c1")],
            session_id="s1",
        )
        # Step 1
        step1 = registry.build(
            step0,
            [Message(role=MessageRole.TOOL, content=json.dumps({"content": "Hi"}), tool_call_id=step0[0].id)],
            session_id="s1",
        )
        # Step 2: after summarize, no more steps
        step2 = registry.build(
            step1,
            [Message(role=MessageRole.TOOL, content=json.dumps({"summary": "Brief"}), tool_call_id=step1[0].id)],
            session_id="s1",
        )

        assert step2 == []

    def test_clear_session_stops_chain(self):
        registry = self._make_registry()

        step0 = registry.build(
            [ToolCallInfo(name="web_search", args={"query": "q"}, id="c1")],
            [Message(role=MessageRole.TOOL, content=json.dumps({"results": [{"url": "https://x.com"}]}), tool_call_id="c1")],
            session_id="s1",
        )
        assert len(step0) == 1

        registry.clear_session("s1")

        # After clear, step[1] should NOT fire
        chained = registry.build(
            step0,
            [Message(role=MessageRole.TOOL, content=json.dumps({"content": "Hi"}), tool_call_id=step0[0].id)],
            session_id="s1",
        )
        assert chained == []


# ---------------------------------------------------------------------------
# 3. Registration
# ---------------------------------------------------------------------------


class TestRegistration:
    def test_register_and_clear(self):
        registry = ToolChainRegistry()
        registry.register(ChainRule(source="a", steps=[ChainStep(target="b", extract="x", arg_mapping={})]))
        assert "a" in registry.rules
        registry.clear()
        assert registry.rules == {}

    def test_register_many(self):
        registry = ToolChainRegistry()
        registry.register_many([
            ChainRule(source="a", steps=[ChainStep(target="b", extract="x", arg_mapping={})]),
            ChainRule(source="c", steps=[ChainStep(target="d", extract="y", arg_mapping={})]),
        ])
        assert "a" in registry.rules
        assert "c" in registry.rules


# ---------------------------------------------------------------------------
# 4. JSONPath resolver
# ---------------------------------------------------------------------------


class TestResolveJsonpath:
    def test_simple_key(self):
        assert ToolChainRegistry._resolve_jsonpath({"a": 1}, "a") == [1]

    def test_nested_key(self):
        assert ToolChainRegistry._resolve_jsonpath({"a": {"b": 2}}, "a.b") == [2]

    def test_wildcard_array(self):
        data = {"items": [{"v": 1}, {"v": 2}]}
        assert ToolChainRegistry._resolve_jsonpath(data, "items[*].v") == [1, 2]

    def test_missing_key(self):
        assert ToolChainRegistry._resolve_jsonpath({"a": 1}, "b") == []

    def test_root_returns_whole_object(self):
        data = {"x": 1, "y": [2, 3]}
        assert ToolChainRegistry._resolve_jsonpath(data, "$root") == [data]


# ---------------------------------------------------------------------------
# 5. build_per_result
# ---------------------------------------------------------------------------


class TestBuildPerResult:
    def test_single_result_generates_chain(self):
        """build_per_result produces chained calls for a single (tc, result) pair."""
        registry = ToolChainRegistry()
        registry.register(
            ChainRule(
                source="web_search",
                steps=[
                    ChainStep(target="web_fetch", extract="results[*].url", arg_mapping={"url": "$value"}),
                ],
            )
        )
        tc = ToolCallInfo(name="web_search", args={"query": "q"}, id="c1")
        result_msg = Message(
            role=MessageRole.TOOL,
            content=json.dumps({"results": [{"url": "https://example.com/1"}]}),
            tool_call_id="c1",
        )

        chained = registry.build_per_result(tc, result_msg)

        assert len(chained) == 1
        assert chained[0].name == "web_fetch"
        assert chained[0].args == {"url": "https://example.com/1"}

    def test_active_chain_continuation(self):
        """build_per_result tracks and continues multi-step chains."""
        registry = ToolChainRegistry()
        registry.register(
            ChainRule(
                source="web_search",
                steps=[
                    ChainStep(target="web_fetch", extract="results[*].url", arg_mapping={"url": "$value"}),
                    ChainStep(target="summarize", extract="content", arg_mapping={"text": "$value"}),
                ],
            )
        )

        # Step 0
        tc0 = ToolCallInfo(name="web_search", args={"query": "q"}, id="c1")
        result0 = Message(
            role=MessageRole.TOOL,
            content=json.dumps({"results": [{"url": "https://example.com/1"}]}),
            tool_call_id="c1",
        )
        step0 = registry.build_per_result(tc0, result0, session_id="s1")
        assert len(step0) == 1
        assert step0[0].name == "web_fetch"

        # Step 1
        result1 = Message(
            role=MessageRole.TOOL,
            content=json.dumps({"content": "Page text"}),
            tool_call_id=step0[0].id,
        )
        step1 = registry.build_per_result(step0[0], result1, session_id="s1")
        assert len(step1) == 1
        assert step1[0].name == "summarize"
        assert step1[0].args == {"text": "Page text"}


# ---------------------------------------------------------------------------
# 6. Caching behaviour
# ---------------------------------------------------------------------------


class TestBuildCaching:
    def test_caches_json_parse(self):
        """Two rules against the same source share a single parse."""
        registry = ToolChainRegistry()
        registry.register(
            ChainRule(
                source="tool_a",
                steps=[ChainStep(target="b", extract="x", arg_mapping={"v": "$value"})],
            )
        )
        registry.register(
            ChainRule(
                source="tool_a",
                steps=[ChainStep(target="c", extract="y", arg_mapping={"v": "$value"})],
            )
        )

        content = json.dumps({"x": 1, "y": 2})
        tc = ToolCallInfo(name="tool_a", args={}, id="c1")
        result_msg = Message(role=MessageRole.TOOL, content=content, tool_call_id="c1")

        parse_cache: dict = {}
        path_cache: dict = {}
        chained = registry.build_per_result(
            tc, result_msg, _parse_cache=parse_cache, _path_cache=path_cache,
        )

        # Both rules should produce results
        assert len(chained) == 2
        targets = {c.name for c in chained}
        assert targets == {"b", "c"}

        # Parse cache should have exactly one entry (same content string obj)
        assert len(parse_cache) == 1

    def test_caches_jsonpath(self):
        """Same extract path on the same content is resolved once."""
        registry = ToolChainRegistry()
        # Two rules with the same extract path but different targets
        registry.register(
            ChainRule(
                source="tool_a",
                steps=[ChainStep(target="b", extract="items[*].id", arg_mapping={"v": "$value"})],
            )
        )
        registry.register(
            ChainRule(
                source="tool_a",
                steps=[ChainStep(target="c", extract="items[*].id", arg_mapping={"v": "$value"})],
            )
        )

        content = json.dumps({"items": [{"id": 1}, {"id": 2}]})
        tc = ToolCallInfo(name="tool_a", args={}, id="c1")
        result_msg = Message(role=MessageRole.TOOL, content=content, tool_call_id="c1")

        parse_cache: dict = {}
        path_cache: dict = {}
        chained = registry.build_per_result(
            tc, result_msg, _parse_cache=parse_cache, _path_cache=path_cache,
        )

        # 2 rules x 2 items = 4 chained calls
        assert len(chained) == 4
        # Path cache should have exactly one entry (same content + same extract)
        assert len(path_cache) == 1


# ---------------------------------------------------------------------------
# 7. Placeholder resolution ($value.field, $source_args.field, $root)
# ---------------------------------------------------------------------------


class TestPlaceholderResolution:
    """Tests for _resolve_placeholder and _extract_chain_args_from_data."""

    def test_value_dot_field_extracts_dict_field(self):
        step = ChainStep(
            target="grep",
            extract="$root",
            arg_mapping={"path": "$value.session_file", "mode": "$value.extract_mode"},
        )
        data = {"session_file": "/session/web_fetch/example.md", "extract_mode": "markdown", "title": "Example"}
        result = ToolChainRegistry._extract_chain_args_from_data(data, step)
        assert len(result) == 1
        assert result[0]["path"] == "/session/web_fetch/example.md"
        assert result[0]["mode"] == "markdown"

    def test_value_dot_field_missing_key_skips_entry(self):
        """Missing $value.field returns None, causing the entry to be skipped."""
        step = ChainStep(target="t", extract="$root", arg_mapping={"x": "$value.missing_key"})
        data = {"other": "val"}
        result = ToolChainRegistry._extract_chain_args_from_data(data, step)
        assert result == []

    def test_value_dot_field_non_dict_falls_back(self):
        """When extracted value is not a dict, $value.field falls back to the raw value."""
        step = ChainStep(target="t", extract="name", arg_mapping={"x": "$value.something"})
        data = {"name": "plain_string"}
        result = ToolChainRegistry._extract_chain_args_from_data(data, step)
        assert result[0]["x"] == "plain_string"

    def test_source_args_field(self):
        """$source_args.query pulls from the source tool's input arguments."""
        step = ChainStep(
            target="grep",
            extract="$root",
            arg_mapping={"pattern": "$source_args.query", "path": "$value.session_file"},
        )
        data = {"session_file": "/session/file.md", "title": "Page Title"}
        source_args = {"query": "python async 2026", "max_results": 5}
        result = ToolChainRegistry._extract_chain_args_from_data(data, step, source_args=source_args)
        assert len(result) == 1
        assert result[0]["pattern"] == "python async 2026"
        assert result[0]["path"] == "/session/file.md"

    def test_source_args_whole_dict(self):
        """$source_args returns the entire source args dict."""
        step = ChainStep(target="t", extract="$root", arg_mapping={"ctx": "$source_args"})
        data = {"x": 1}
        source_args = {"query": "test", "depth": "basic"}
        result = ToolChainRegistry._extract_chain_args_from_data(data, step, source_args=source_args)
        assert result[0]["ctx"] == {"query": "test", "depth": "basic"}

    def test_source_args_missing_field_skips_step(self):
        """Missing $source_args field returns None, causing the step to be skipped."""
        step = ChainStep(target="t", extract="$root", arg_mapping={"x": "$source_args.nonexistent"})
        data = {"y": 1}
        source_args = {"query": "q"}
        result = ToolChainRegistry._extract_chain_args_from_data(data, step, source_args=source_args)
        assert result == []

    def test_source_args_none_skips_step(self):
        """When no source_args provided, $source_args.field returns None → skip."""
        step = ChainStep(target="t", extract="$root", arg_mapping={"x": "$source_args.query"})
        data = {"y": 1}
        result = ToolChainRegistry._extract_chain_args_from_data(data, step, source_args=None)
        assert result == []

    def test_literal_string_passed_through(self):
        step = ChainStep(target="t", extract="$root", arg_mapping={"mode": "strict"})
        data = {"x": 1}
        result = ToolChainRegistry._extract_chain_args_from_data(data, step)
        assert result[0]["mode"] == "strict"


# ---------------------------------------------------------------------------
# 8. Source args propagation through multi-step chains
# ---------------------------------------------------------------------------


class TestSourceArgsPropagation:
    """Verify $source_args flows through all steps in a multi-step chain."""

    def _make_registry(self) -> ToolChainRegistry:
        registry = ToolChainRegistry()
        registry.register(
            ChainRule(
                source="web_search",
                steps=[
                    ChainStep(
                        target="web_fetch",
                        extract="results[*].url",
                        arg_mapping={"url": "$value"},
                    ),
                    ChainStep(
                        target="grep",
                        extract="$root",
                        arg_mapping={
                            "path": "$value.session_file",
                            "pattern": "$source_args.query",
                        },
                    ),
                ],
            )
        )
        return registry

    def test_three_step_chain_propagates_source_args(self):
        """web_search → web_fetch → grep: $source_args.query reaches step[1]."""
        registry = self._make_registry()

        # Step 0: web_search triggers web_fetch
        search_result = json.dumps({
            "results": [{"url": "https://example.com/article"}]
        })
        step0 = registry.build(
            [ToolCallInfo(name="web_search", args={"query": "python async 2026"}, id="c1")],
            [Message(role=MessageRole.TOOL, content=search_result, tool_call_id="c1")],
            session_id="s1",
        )
        assert len(step0) == 1
        assert step0[0].name == "web_fetch"
        assert step0[0].args == {"url": "https://example.com/article"}

        # Step 1: web_fetch result triggers grep with $source_args.query
        fetch_result = json.dumps({
            "session_file": "/session/web_fetch/example.com/article-ab12.md",
            "title": "Python Async Guide",
            "status": 200,
        })
        step1 = registry.build(
            step0,
            [Message(role=MessageRole.TOOL, content=fetch_result, tool_call_id=step0[0].id)],
            session_id="s1",
        )
        assert len(step1) == 1
        assert step1[0].name == "grep"
        assert step1[0].args == {
            "path": "/session/web_fetch/example.com/article-ab12.md",
            "pattern": "python async 2026",
        }

        # Step 2: after grep, chain is complete
        grep_result = json.dumps({"matches": [{"line": 42, "text": "python async example"}]})
        step2 = registry.build(
            step1,
            [Message(role=MessageRole.TOOL, content=grep_result, tool_call_id=step1[0].id)],
            session_id="s1",
        )
        assert step2 == []

    def test_source_args_survives_session_clear(self):
        """Clearing session mid-chain stops propagation."""
        registry = self._make_registry()

        step0 = registry.build(
            [ToolCallInfo(name="web_search", args={"query": "test"}, id="c1")],
            [Message(role=MessageRole.TOOL, content=json.dumps({"results": [{"url": "https://x.com"}]}), tool_call_id="c1")],
            session_id="s1",
        )
        registry.clear_session("s1")

        step1 = registry.build(
            step0,
            [Message(role=MessageRole.TOOL, content=json.dumps({"session_file": "/f", "title": "T"}), tool_call_id=step0[0].id)],
            session_id="s1",
        )
        assert step1 == []
