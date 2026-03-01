# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for Progressive Skill Activation (tool surface minimisation)."""

import json
import pytest
from app.services.skills import SkillController


@pytest.fixture
def provider():
    """Create a fresh SkillController instance (triggers discovery)."""
    return SkillController()


def _make_snapshot(*skill_defs):
    """Helper to build a skills_snapshot dict.

    Each skill_def is (name, [tool_names]).
    """
    return {
        "prompt": "<available_skills/>",
        "skills": [
            {"name": name, "description": f"{name} skill", "location": "", "tools": tools}
            for name, tools in skill_defs
        ],
    }


# ---------------------------------------------------------------------------
# _build_snapshot_skill_map
# ---------------------------------------------------------------------------


class TestBuildSnapshotSkillMap:
    def test_basic_mapping(self, provider):
        snapshot = _make_snapshot(
            ("coding_task", ["bash", "write_file"]),
            ("web_task", ["web_search", "web_fetch"]),
        )
        mapping = provider._build_snapshot_skill_map(snapshot)
        assert mapping["coding_task"] == ["bash", "write_file"]
        assert mapping["web_task"] == ["web_search", "web_fetch"]

    def test_none_snapshot_returns_empty(self, provider):
        assert provider._build_snapshot_skill_map(None) == {}

    def test_empty_skills_returns_empty(self, provider):
        assert provider._build_snapshot_skill_map({"skills": []}) == {}

    def test_normalizes_names(self, provider):
        snapshot = _make_snapshot(("Coding_Task", ["bash"]))
        mapping = provider._build_snapshot_skill_map(snapshot)
        assert "coding_task" in mapping


# ---------------------------------------------------------------------------
# activate_skills
# ---------------------------------------------------------------------------


class TestActivateSkills:
    def test_activate_valid_skill(self, provider):
        session_id = "test_activate"
        snapshot = _make_snapshot(("coding_task", ["bash", "write_file"]))
        provider._session_snapshots[session_id] = snapshot
        # Ensure session has initial active set (server skills only)
        provider.get_active_tool_names(session_id, snapshot)

        activated = provider.activate_skills(session_id, ["coding_task"])
        assert "coding_task" in activated
        assert activated["coding_task"] == ["bash", "write_file"]

    def test_activate_invalid_skill_ignored(self, provider):
        session_id = "test_invalid"
        snapshot = _make_snapshot(("coding_task", ["bash"]))
        provider._session_snapshots[session_id] = snapshot
        provider.get_active_tool_names(session_id, snapshot)

        activated = provider.activate_skills(session_id, ["nonexistent_skill"])
        assert activated == {}

    def test_activate_multiple_skills(self, provider):
        session_id = "test_multi"
        snapshot = _make_snapshot(
            ("coding_task", ["bash"]),
            ("web_task", ["web_search"]),
        )
        provider._session_snapshots[session_id] = snapshot
        provider.get_active_tool_names(session_id, snapshot)

        activated = provider.activate_skills(session_id, ["coding_task", "web_task"])
        assert len(activated) == 2
        assert "coding_task" in activated
        assert "web_task" in activated


# ---------------------------------------------------------------------------
# get_active_tool_names
# ---------------------------------------------------------------------------


class TestGetActiveToolNames:
    def test_initial_state_server_tools_only(self, provider):
        """On first call, only server skill tools should be active."""
        session_id = "test_initial"
        snapshot = _make_snapshot(
            ("coding_task", ["bash", "write_file"]),
            ("web_task", ["web_search", "web_fetch"]),
        )
        tools = provider.get_active_tool_names(session_id, snapshot)
        assert tools is not None
        # Server tools (manage_periodic_task, notify_user, etc.) should be present
        assert "manage_periodic_task" in tools or "notify_user" in tools
        # Client tools should NOT be present initially
        assert "bash" not in tools
        assert "web_search" not in tools

    def test_after_activation_includes_client_tools(self, provider):
        """After activating a skill, its tools should appear."""
        session_id = "test_after_activate"
        snapshot = _make_snapshot(
            ("coding_task", ["bash", "write_file"]),
            ("web_task", ["web_search"]),
        )
        provider._session_snapshots[session_id] = snapshot
        provider.get_active_tool_names(session_id, snapshot)  # initialise

        provider.activate_skills(session_id, ["coding_task"])

        tools = provider.get_active_tool_names(session_id, snapshot)
        assert "bash" in tools
        assert "write_file" in tools
        # web_task not activated
        assert "web_search" not in tools

    def test_server_tools_always_included(self, provider):
        """Server skill tools are always present regardless of activation."""
        session_id = "test_server_always"
        snapshot = _make_snapshot(("coding_task", ["bash"]))
        tools = provider.get_active_tool_names(session_id, snapshot)
        # All server skill tools should be present
        for skill_key in provider._skills:
            for tool in provider._tools_by_skill.get(skill_key, set()):
                assert tool in tools, f"Server tool '{tool}' missing from active tools"

    def test_no_snapshot_returns_server_tools(self, provider):
        """Without a snapshot, only server tools are returned."""
        session_id = "test_no_snap"
        tools = provider.get_active_tool_names(session_id, None)
        assert tools is not None
        # Server tools present
        for skill_key in provider._skills:
            for tool in provider._tools_by_skill.get(skill_key, set()):
                assert tool in tools


# ---------------------------------------------------------------------------
# enrich_snapshot with session_id caching
# ---------------------------------------------------------------------------


class TestEnrichSnapshotCaching:
    def test_caches_snapshot_when_session_id_provided(self, provider):
        session_id = "test_cache"
        snapshot = _make_snapshot(("coding_task", ["bash"]))
        provider.enrich_snapshot(snapshot, session_id=session_id)
        assert session_id in provider._session_snapshots
        assert provider._session_snapshots[session_id] is snapshot

    def test_no_cache_without_session_id(self, provider):
        snapshot = _make_snapshot(("coding_task", ["bash"]))
        provider.enrich_snapshot(snapshot)
        # No session should be cached
        assert len(provider._session_snapshots) == 0


# ---------------------------------------------------------------------------
# clear_session cleanup
# ---------------------------------------------------------------------------


class TestClearSessionCleanup:
    def test_clears_active_skills(self, provider):
        session_id = "test_clear"
        snapshot = _make_snapshot(("coding_task", ["bash"]))
        provider._session_snapshots[session_id] = snapshot
        provider.get_active_tool_names(session_id, snapshot)
        provider.activate_skills(session_id, ["coding_task"])

        assert session_id in provider._active_skills
        assert session_id in provider._session_snapshots

        provider.clear_session(session_id)

        assert session_id not in provider._active_skills
        assert session_id not in provider._session_snapshots


# activate_task and plan_task tests removed in Phase 9 cutover
# (service.py files deleted; v2 DeepAgents handles tasks and activation natively)


# ---------------------------------------------------------------------------
# get_active_skill_names
# ---------------------------------------------------------------------------


class TestGetActiveSkillNames:
    def test_no_state_returns_empty(self, provider):
        """No PSA state → empty set."""
        result = provider.get_active_skill_names("nonexistent_session")
        assert result == set()

    def test_excludes_server_skills(self, provider):
        """Only client skills are returned, server skill keys excluded."""
        session_id = "test_active_names"
        snapshot = _make_snapshot(
            ("coding_task", ["bash", "write_file"]),
            ("web_task", ["web_search"]),
        )
        provider._session_snapshots[session_id] = snapshot
        # Initialise PSA state (adds server skill keys)
        provider.get_active_tool_names(session_id, snapshot)
        # Activate client skills
        provider.activate_skills(session_id, ["coding_task", "web_task"])

        active = provider.get_active_skill_names(session_id)
        # Client skills present
        assert "coding_task" in active
        assert "web_task" in active
        # Server skill keys excluded
        for key in provider._skills:
            assert key not in active

    def test_returns_only_activated_skills(self, provider):
        """Only explicitly activated client skills are returned."""
        session_id = "test_partial"
        snapshot = _make_snapshot(
            ("coding_task", ["bash"]),
            ("web_task", ["web_search"]),
        )
        provider._session_snapshots[session_id] = snapshot
        provider.get_active_tool_names(session_id, snapshot)
        provider.activate_skills(session_id, ["coding_task"])

        active = provider.get_active_skill_names(session_id)
        assert "coding_task" in active
        assert "web_task" not in active

    def test_filtered_controller_delegates(self, provider):
        """_FilteredSkillController.get_active_skill_names delegates to base."""
        session_id = "test_filtered_names"
        snapshot = _make_snapshot(("coding_task", ["bash"]))
        provider._session_snapshots[session_id] = snapshot
        provider.get_active_tool_names(session_id, snapshot)
        provider.activate_skills(session_id, ["coding_task"])

        filtered = provider.filtered({"bash", "manage_todo"})
        active = filtered.get_active_skill_names(session_id)
        assert "coding_task" in active
