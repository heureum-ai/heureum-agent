# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for app.services.providers.skill — SkillProvider class."""

import pytest
from app.services.providers.skill import SkillProvider, SkillMeta, parse_skill_md


@pytest.fixture
def provider():
    """Create a fresh SkillProvider instance (triggers discovery)."""
    return SkillProvider()


# ---------------------------------------------------------------------------
# parse_skill_md
# ---------------------------------------------------------------------------


class TestParseSkillMd:
    def test_basic_frontmatter(self, tmp_path):
        md = tmp_path / "SKILL.md"
        md.write_text("---\nname: test\ndescription: A test skill\n---\nBody content here.")
        meta = parse_skill_md(str(md))
        assert meta.name == "test"
        assert meta.description == "A test skill"
        assert meta.body == "Body content here."
        assert meta.server_tools == []
        assert meta.client_tools == []

    def test_no_frontmatter(self, tmp_path):
        md = tmp_path / "SKILL.md"
        md.write_text("Just plain markdown.")
        meta = parse_skill_md(str(md))
        assert meta.name == ""
        assert meta.body == "Just plain markdown."
        assert meta.server_tools == []
        assert meta.client_tools == []

    def test_empty_frontmatter(self, tmp_path):
        md = tmp_path / "SKILL.md"
        md.write_text("---\n---\nBody only.")
        meta = parse_skill_md(str(md))
        assert meta.name == ""
        assert meta.body == "Body only."

    def test_server_and_client_tools_parsed(self, tmp_path):
        md = tmp_path / "SKILL.md"
        md.write_text(
            "---\nname: test\ndescription: desc\n"
            "server_tools: tool_a, tool_b\n"
            "client_tools: web_search, web_fetch\n"
            "---\nBody."
        )
        meta = parse_skill_md(str(md))
        assert meta.server_tools == ["tool_a", "tool_b"]
        assert meta.client_tools == ["web_search", "web_fetch"]

    def test_empty_client_tools(self, tmp_path):
        md = tmp_path / "SKILL.md"
        md.write_text(
            "---\nname: test\ndescription: desc\n"
            "server_tools: my_tool\n"
            "client_tools:\n"
            "---\nBody."
        )
        meta = parse_skill_md(str(md))
        assert meta.server_tools == ["my_tool"]
        assert meta.client_tools == []


# ---------------------------------------------------------------------------
# Discovery (relies on app/skills/ packages being importable)
# ---------------------------------------------------------------------------


class TestSkillDiscovery:
    def test_all_skills_discovered(self, provider):
        names = provider.get_all_tool_names()
        assert "manage_todo" in names
        assert "manage_periodic_task" in names
        assert "notify_user" in names

    def test_tool_schemas_count(self, provider):
        schemas = provider.get_all_tool_schemas()
        assert len(schemas) >= 3
        schema_names = {s["function"]["name"] for s in schemas}
        assert "manage_todo" in schema_names
        assert "manage_periodic_task" in schema_names
        assert "notify_user" in schema_names

    def test_guide_prompts_wrapped_in_xml(self, provider):
        prompts = provider.get_all_guide_prompts()
        assert len(prompts) >= 3
        for p in prompts:
            assert p.startswith("<tool_guide")
            assert p.endswith("</tool_guide>")

    def test_get_skill_by_name(self, provider):
        plan = provider.get_skill("plan_task")
        assert plan is not None
        assert plan.name == "plan_task"

    def test_get_skill_for_tool_name(self, provider):
        skill = provider.get_skill_for_tool("manage_todo")
        assert skill is not None
        assert skill.name == "plan_task"

    def test_get_skill_for_unknown_tool(self, provider):
        assert provider.get_skill_for_tool("nonexistent_tool") is None


# ---------------------------------------------------------------------------
# State prompts / session management
# ---------------------------------------------------------------------------


class TestSessionManagement:
    def test_get_state_prompts_empty_session(self, provider):
        prompts = provider.get_state_prompts("nonexistent_session")
        assert prompts == []

    def test_clear_session_no_error(self, provider):
        # Should not raise even for nonexistent session
        provider.clear_session("nonexistent_session")


# ---------------------------------------------------------------------------
# Active filtering (client_tools-aware)
# ---------------------------------------------------------------------------


class TestActiveFiltering:
    def test_active_schemas_with_web_search(self, provider):
        """When web_search is available, periodic_task tools are included."""
        schemas = provider.get_active_tool_schemas({"web_search"})
        names = {s["function"]["name"] for s in schemas}
        assert "manage_todo" in names
        assert "notify_user" in names
        assert "manage_periodic_task" in names

    def test_active_schemas_without_client_tools(self, provider):
        """Without client tools, skills with empty client_tools are still active."""
        schemas = provider.get_active_tool_schemas(set())
        names = {s["function"]["name"] for s in schemas}
        assert "manage_todo" in names
        assert "notify_user" in names
        # periodic_task now has empty client_tools → always active
        assert "manage_periodic_task" in names

    def test_active_guide_prompts_with_web_fetch(self, provider):
        """When web_fetch is available, periodic_task guide is included."""
        prompts = provider.get_active_guide_prompts({"web_fetch"})
        prompt_text = "\n".join(prompts)
        assert "periodic_task" in prompt_text
        assert "plan_task" in prompt_text
        assert "notification_task" in prompt_text

    def test_active_guide_prompts_without_client_tools(self, provider):
        """Without client tools, all skills with empty client_tools are active."""
        prompts = provider.get_active_guide_prompts(set())
        prompt_text = "\n".join(prompts)
        # periodic_task now has empty client_tools → always active
        assert "periodic_task" in prompt_text
        assert "plan_task" in prompt_text
        assert "notification_task" in prompt_text

    def test_is_skill_active_empty_client_tools(self, provider):
        """Skills with no client_tools are always active."""
        plan = provider.get_skill("plan_task")
        assert provider._is_skill_active(plan, set()) is True
        assert provider._is_skill_active(plan, {"web_search"}) is True

    def test_is_skill_active_with_client_tools(self, provider):
        """periodic_task now has empty client_tools → always active.
        Use document_word_task to test client_tools gating instead."""
        # periodic_task: empty client_tools → always active
        periodic = provider.get_skill("periodic_task")
        assert provider._is_skill_active(periodic, set()) is True
        assert provider._is_skill_active(periodic, {"web_search"}) is True
        # document_word_task: has client_tools → conditional
        doc = provider.get_skill("document_word_task")
        if doc is not None:
            assert provider._is_skill_active(doc, set()) is False
            assert provider._is_skill_active(doc, {"docx_read"}) is True
            assert provider._is_skill_active(doc, {"unrelated_tool"}) is False

    def test_get_all_still_returns_everything(self, provider):
        """get_all_* methods remain backward compatible and return all skills."""
        all_schemas = provider.get_all_tool_schemas()
        all_names = {s["function"]["name"] for s in all_schemas}
        assert "manage_periodic_task" in all_names
        assert "manage_todo" in all_names
        assert "notify_user" in all_names

        all_prompts = provider.get_all_guide_prompts()
        all_prompt_text = "\n".join(all_prompts)
        assert "periodic_task" in all_prompt_text


# ---------------------------------------------------------------------------
# depends_on
# ---------------------------------------------------------------------------


class TestDependsOn:
    def test_parse_depends_on(self, tmp_path):
        """depends_on is parsed from frontmatter."""
        md = tmp_path / "SKILL.md"
        md.write_text(
            "---\nname: a\ndescription: A\n"
            "depends_on: b, c\n"
            "---\nBody."
        )
        meta = parse_skill_md(str(md))
        assert meta.depends_on == ["b", "c"]

    def test_depends_on_empty(self, tmp_path):
        """When depends_on is absent, defaults to empty list."""
        md = tmp_path / "SKILL.md"
        md.write_text("---\nname: x\ndescription: X\n---\nBody.")
        meta = parse_skill_md(str(md))
        assert meta.depends_on == []

    def test_active_guide_includes_dependency(self, provider):
        """periodic_task depends_on web_search_task — its guide should appear even
        when web_search_task is not independently active."""
        # web_search_task has empty client_tools so it's always active on its own,
        # but we verify it appears in the resolved list alongside periodic_task.
        prompts = provider.get_active_guide_prompts({"web_search"})
        prompt_text = "\n".join(prompts)
        assert "periodic_task" in prompt_text
        assert "web_search_task" in prompt_text

    def test_no_duplicate_guides(self, provider):
        """If web_search_task is already active, it should not be duplicated."""
        prompts = provider.get_active_guide_prompts({"web_search"})
        names = [p.split('name="')[1].split('"')[0] for p in prompts]
        assert names.count("web_search_task") == 1

    def test_circular_dependency_safe(self, tmp_path, provider):
        """Circular depends_on must not cause infinite recursion."""
        # Simulate circular dependency by patching the meta cache on two skills.
        skill_a = provider.get_skill("periodic_task")
        skill_b = provider.get_skill("web_search_task")
        if skill_a is None or skill_b is None:
            pytest.skip("Required skills not discovered")

        # Temporarily inject circular dependency: periodic_task -> web_search_task -> periodic_task
        original_b_meta = skill_b._skill_meta_cache
        skill_b._skill_meta_cache = SkillMeta(
            name="web_search_task",
            description="",
            body="body",
            server_tools=[],
            client_tools=[],
            depends_on=["periodic_task"],
        )
        try:
            # Should not hang or raise
            resolved = provider._resolve_with_deps([skill_a])
            resolved_names = [s.name for s in resolved]
            assert "periodic_task" in resolved_names
            assert "web_search_task" in resolved_names
        finally:
            skill_b._skill_meta_cache = original_b_meta


# ---------------------------------------------------------------------------
# PlanSkill integration
# ---------------------------------------------------------------------------


class TestPlanSkillIntegration:
    @pytest.mark.asyncio
    async def test_create_todo(self, provider):
        plan = provider.get_skill("plan_task")
        result = await plan.execute(
            "manage_todo",
            {"action": "create", "task": "Test task", "steps": ["Step 1", "Step 2"]},
            "test_session",
        )
        assert "Test task" in result
        assert "Step 1" in result

    @pytest.mark.asyncio
    async def test_update_step(self, provider):
        plan = provider.get_skill("plan_task")
        await plan.execute(
            "manage_todo",
            {"action": "create", "task": "Update test", "steps": ["Step A"]},
            "test_update_session",
        )
        result = await plan.execute(
            "manage_todo",
            {"action": "update_step", "step_index": 0, "status": "completed", "result": "Done"},
            "test_update_session",
        )
        assert "Done" in result

    @pytest.mark.asyncio
    async def test_state_prompt_after_create(self, provider):
        plan = provider.get_skill("plan_task")
        await plan.execute(
            "manage_todo",
            {"action": "create", "task": "State test", "steps": ["S1"]},
            "test_state_session",
        )
        prompt = plan.get_state_prompt("test_state_session")
        assert prompt is not None
        assert "State test" in prompt

    def test_clear_session_removes_state(self, provider):
        plan = provider.get_skill("plan_task")
        plan.clear_session("test_session")
        plan.clear_session("test_update_session")
        plan.clear_session("test_state_session")
        assert plan.get_state("test_session") is None
