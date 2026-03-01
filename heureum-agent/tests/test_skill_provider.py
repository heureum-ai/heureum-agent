# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for app.services.providers.skill — SkillController class."""

import pytest
from app.services.skills import SkillController
from app.services.skills.metadata import parse_skill_md


@pytest.fixture
def provider():
    """Create a fresh SkillController instance (triggers discovery)."""
    return SkillController()


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
        assert meta.tools == []

    def test_no_frontmatter(self, tmp_path):
        md = tmp_path / "SKILL.md"
        md.write_text("Just plain markdown.")
        meta = parse_skill_md(str(md))
        assert meta.name == ""
        assert meta.body == "Just plain markdown."
        assert meta.tools == []

    def test_empty_frontmatter(self, tmp_path):
        md = tmp_path / "SKILL.md"
        md.write_text("---\n---\nBody only.")
        meta = parse_skill_md(str(md))
        assert meta.name == ""
        assert meta.body == "Body only."

    def test_tools_parsed(self, tmp_path):
        md = tmp_path / "SKILL.md"
        md.write_text(
            "---\nname: test\ndescription: desc\n"
            "tools: tool_a, tool_b, web_search, web_fetch\n"
            "---\nBody."
        )
        meta = parse_skill_md(str(md))
        assert meta.tools == ["tool_a", "tool_b", "web_search", "web_fetch"]

    def test_empty_tools(self, tmp_path):
        md = tmp_path / "SKILL.md"
        md.write_text(
            "---\nname: test\ndescription: desc\ntools:\n---\nBody."
        )
        meta = parse_skill_md(str(md))
        assert meta.tools == []


# ---------------------------------------------------------------------------
# Discovery (relies on app/skills/ packages being importable)
# ---------------------------------------------------------------------------


class TestSkillDiscovery:
    def test_all_skills_discovered(self, provider):
        names = provider.get_all_tool_names()
        assert "manage_periodic_task" in names
        assert "notify_user" in names

    def test_tool_schemas_count(self, provider):
        schemas = provider.get_all_tool_schemas()
        assert len(schemas) >= 2
        schema_names = {s["function"]["name"] for s in schemas}
        assert "manage_periodic_task" in schema_names
        assert "notify_user" in schema_names

    def test_get_skill_by_name(self, provider):
        skill = provider.get_skill("periodic_task")
        assert skill is not None
        assert skill.name == "periodic_task"

    def test_get_skill_for_tool_name(self, provider):
        skill = provider.get_skill_for_tool("manage_periodic_task")
        assert skill is not None
        assert skill.name == "periodic_task"

    def test_get_skill_for_unknown_tool(self, provider):
        assert provider.get_skill_for_tool("nonexistent_tool") is None

    def test_resolve_allowed_server_tools_from_snapshot(self, provider):
        snapshot = {
            "prompt": "<available_skills/>",
            "skills": [
                {
                    "name": "periodic_task",
                    "description": "Manage periodic tasks",
                    "location": "/tmp/SKILL.md",
                    "tools": ["manage_periodic_task"],
                }
            ],
        }
        allowed = provider.resolve_allowed_server_tools(skills_snapshot=snapshot)
        assert allowed == {"manage_periodic_task"}

    def test_get_all_tool_schemas_filtered_by_snapshot(self, provider):
        snapshot = {
            "prompt": "<available_skills/>",
            "skills": [
                {
                    "name": "periodic_task",
                    "description": "Manage periodic tasks",
                    "location": "/tmp/SKILL.md",
                    "tools": ["manage_periodic_task"],
                }
            ],
        }
        schemas = provider.get_all_tool_schemas(skills_snapshot=snapshot)
        names = {s["function"]["name"] for s in schemas}
        assert names == {"manage_periodic_task"}


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
# depends_on
# ---------------------------------------------------------------------------


class TestDependsOn:
    def test_parse_depends_on(self, tmp_path):
        """depends_on is parsed from frontmatter."""
        md = tmp_path / "SKILL.md"
        md.write_text("---\nname: a\ndescription: A\ndepends_on: b, c\n---\nBody.")
        meta = parse_skill_md(str(md))
        assert meta.depends_on == ["b", "c"]

    def test_depends_on_empty(self, tmp_path):
        """When depends_on is absent, defaults to empty list."""
        md = tmp_path / "SKILL.md"
        md.write_text("---\nname: x\ndescription: X\n---\nBody.")
        meta = parse_skill_md(str(md))
        assert meta.depends_on == []


# plan_task and activate_task integration tests removed in Phase 9 cutover
# (service.py deleted; v2 DeepAgents handles tasks and activation natively)
