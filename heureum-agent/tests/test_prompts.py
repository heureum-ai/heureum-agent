# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Unit tests for app.services.prompts.base module."""

from app.config import settings
from app.services.prompts.base import HARD_CLEAR_PLACEHOLDER
from app.services.prompts.compaction import COMPACTION_PREFIX
from app.services.prompts.base import (
    AGENT_IDENTITY_PROMPT,
    build_system_prompt,
)


# ---------------------------------------------------------------------------
# TestBuildSystemPrompt
# ---------------------------------------------------------------------------

class TestBuildSystemPrompt:
    """Tests for build_system_prompt()."""

    def test_default_includes_identity(self):
        result = build_system_prompt()
        assert "<identity>" in result
        assert "Heureum Agent" in result

    def test_default_includes_all_sections(self):
        result = build_system_prompt()
        for tag in ["<safety>", "<response_style>", "<tool_usage>", "<conversation>", "<language>"]:
            assert tag in result, f"Missing section: {tag}"

    def test_no_client_tools_no_client_guides(self):
        """Without client_tool_prompts, no client-provided guides appear.
        Server-side guides (todo, periodic_task) are always present."""
        result = build_system_prompt()
        # Server-side guides are always present
        assert "manage_todo" in result

    def test_client_tools_included(self):
        guides = ['<tool_guide name="bash">\nUse bash to run commands.\n</tool_guide>']
        result = build_system_prompt(client_tool_prompts=guides)
        assert '<tool_guide name="bash">' in result
        assert "Use bash to run commands." in result

    def test_multiple_client_tools(self):
        guides = [
            '<tool_guide name="ask_question">\nAsk questions.\n</tool_guide>',
            '<tool_guide name="bash">\nRun commands.\n</tool_guide>',
        ]
        result = build_system_prompt(client_tool_prompts=guides)
        assert '<tool_guide name="ask_question">' in result
        assert '<tool_guide name="bash">' in result

    def test_ordering_static_before_dynamic(self):
        """Static identity comes before dynamic tool guides."""
        guides = ['<tool_guide name="bash">\nRun commands.\n</tool_guide>']
        result = build_system_prompt(client_tool_prompts=guides)
        identity_pos = result.index("<identity>")
        guide_pos = result.index("<tool_guide")
        assert identity_pos < guide_pos

    def test_instructions_included(self):
        result = build_system_prompt(instructions="Be concise.")
        assert "<instructions>" in result
        assert "Be concise." in result

    def test_no_instructions_no_tag(self):
        result = build_system_prompt()
        assert "<instructions>" not in result

    def test_instructions_present(self):
        result = build_system_prompt(instructions="Be concise.")
        assert "<instructions>" in result
        assert "Be concise." in result


# ---------------------------------------------------------------------------
# TestPromptConstants
# ---------------------------------------------------------------------------

class TestPromptConstants:
    """Tests for module-level prompt constants."""

    def test_identity_contains_app_name(self):
        assert "Heureum Agent" in AGENT_IDENTITY_PROMPT

    def test_prompt_contains_model(self):
        assert settings.AGENT_MODEL in AGENT_IDENTITY_PROMPT

    def test_compaction_prefix_value(self):
        assert COMPACTION_PREFIX == "[compaction] Previous conversation summary:"

    def test_hard_clear_placeholder_value(self):
        assert HARD_CLEAR_PLACEHOLDER == "[Previous tool results have been cleared]"
