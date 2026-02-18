# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Unit tests for app.services.prompts.base module."""

from app.config import settings
from app.services.prompts.base import (
    AGENT_IDENTITY_PROMPT,
    HARD_CLEAR_PLACEHOLDER,
    SystemPromptBuilder,
    build_system_prompt,
)
from app.services.prompts.compaction import COMPACTION_PREFIX
from app.services.providers.skill import SkillProvider

# ---------------------------------------------------------------------------
# TestBuildSystemPrompt
# ---------------------------------------------------------------------------


class TestBuildSystemPrompt:
    """Tests for build_system_prompt() backwards-compatible wrapper."""

    def test_default_includes_identity(self):
        result = build_system_prompt()
        assert "<identity>" in result
        assert "Heureum Agent" in result

    def test_default_includes_all_sections(self):
        result = build_system_prompt()
        for tag in [
            "<safety>",
            "<response_style>",
            "<tool_usage>",
            "<conversation>",
            "<language>",
        ]:
            assert tag in result, f"Missing section: {tag}"

    def test_no_client_tools_no_client_guides(self):
        """Without client_tool_prompts, no client-provided guides appear.
        Server-side guides (todo, periodic_task) are always present."""
        provider = SkillProvider()
        result = build_system_prompt(server_tool_prompts=provider.get_all_guide_prompts())
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

    def test_tool_guides_wrapper(self):
        """Tool guides are grouped inside <tool_guides> container."""
        guides = ['<tool_guide name="bash">\nRun commands.\n</tool_guide>']
        result = build_system_prompt(server_tool_prompts=guides)
        assert "<tool_guides>" in result
        assert "</tool_guides>" in result
        # The individual guide is nested inside the wrapper
        wrapper_pos = result.index("<tool_guides>")
        guide_pos = result.index('<tool_guide name="bash">')
        wrapper_end = result.index("</tool_guides>")
        assert wrapper_pos < guide_pos < wrapper_end

    def test_no_tool_guides_no_wrapper(self):
        """No <tool_guides> wrapper when no guides are provided."""
        result = build_system_prompt()
        assert "<tool_guides>" not in result

    def test_client_guide_auto_wrapped(self):
        """Plain client guide text gets auto-wrapped in <tool_guide>."""
        result = build_system_prompt(client_tool_prompts=["Use bash to run commands."])
        assert '<tool_guide name="client">' in result
        assert "Use bash to run commands." in result

    def test_state_prompts_in_session_state(self):
        """State prompts are placed inside <session_state> tag."""
        result = build_system_prompt(state_prompts=["<current_todo>\nStep 1\n</current_todo>"])
        assert "<session_state>" in result
        assert "</session_state>" in result
        assert "<current_todo>" in result

    def test_no_state_prompts_no_session_state(self):
        """No <session_state> tag when no state prompts are provided."""
        result = build_system_prompt()
        assert "<session_state>" not in result

    def test_state_prompts_separate_from_instructions(self):
        """State prompts and instructions occupy separate sections."""
        result = build_system_prompt(
            instructions="Be concise.",
            state_prompts=["<current_todo>\nStep 1\n</current_todo>"],
        )
        # Both sections present
        assert "<session_state>" in result
        assert "<instructions>" in result
        # State is NOT inside instructions
        instr_start = result.index("<instructions>")
        instr_end = result.index("</instructions>")
        state_start = result.index("<session_state>")
        assert not (instr_start < state_start < instr_end)

    def test_section_ordering(self):
        """Verify the overall section order: identity < tool_guides < session_state < instructions < current_date."""
        result = build_system_prompt(
            server_tool_prompts=['<tool_guide name="test">\nTest.\n</tool_guide>'],
            state_prompts=["<current_todo>todo</current_todo>"],
            instructions="Be concise.",
        )
        identity_pos = result.index("<identity>")
        guides_pos = result.index("<tool_guides>")
        state_pos = result.index("<session_state>")
        instr_pos = result.index("<instructions>")
        date_pos = result.index("<current_date>")
        assert identity_pos < guides_pos < state_pos < instr_pos < date_pos


# ---------------------------------------------------------------------------
# TestSystemPromptBuilder
# ---------------------------------------------------------------------------


class TestSystemPromptBuilder:
    """Tests for SystemPromptBuilder class."""

    def test_build_default(self):
        result = SystemPromptBuilder().build()
        assert "<identity>" in result
        assert "<current_date>" in result

    def test_add_tool_guide_with_name(self):
        builder = SystemPromptBuilder()
        builder.add_tool_guide("test_tool", "Use this tool for testing.")
        result = builder.build()
        assert '<tool_guide name="test_tool">' in result
        assert "<tool_guides>" in result

    def test_add_tool_guide_pre_wrapped(self):
        builder = SystemPromptBuilder()
        builder.add_tool_guide("ignored", '<tool_guide name="real">\nBody.\n</tool_guide>')
        result = builder.build()
        assert '<tool_guide name="real">' in result
        # Should NOT double-wrap
        assert result.count("<tool_guide name=") == 1

    def test_add_tool_guides_batch(self):
        builder = SystemPromptBuilder()
        guides = [
            '<tool_guide name="a">\nA.\n</tool_guide>',
            '<tool_guide name="b">\nB.\n</tool_guide>',
        ]
        builder.add_tool_guides(guides)
        result = builder.build()
        assert '<tool_guide name="a">' in result
        assert '<tool_guide name="b">' in result

    def test_add_state_prompt(self):
        builder = SystemPromptBuilder()
        builder.add_state_prompt("<current_todo>Step 1</current_todo>")
        result = builder.build()
        assert "<session_state>" in result
        assert "<current_todo>Step 1</current_todo>" in result

    def test_add_state_prompts_batch(self):
        builder = SystemPromptBuilder()
        builder.add_state_prompts(
            [
                "<current_todo>Step 1</current_todo>",
                "<previous_attempts>Attempt 1</previous_attempts>",
            ]
        )
        result = builder.build()
        assert "<current_todo>" in result
        assert "<previous_attempts>" in result

    def test_set_instructions(self):
        builder = SystemPromptBuilder()
        builder.set_instructions("Be concise.")
        result = builder.build()
        assert "<instructions>" in result
        assert "Be concise." in result

    def test_empty_state_prompt_ignored(self):
        builder = SystemPromptBuilder()
        builder.add_state_prompt("")
        builder.add_state_prompt("   ")
        result = builder.build()
        assert "<session_state>" not in result

    def test_empty_instructions_ignored(self):
        builder = SystemPromptBuilder()
        builder.set_instructions("")
        result = builder.build()
        assert "<instructions>" not in result

    def test_chaining(self):
        """Builder methods return self for chaining."""
        result = (
            SystemPromptBuilder()
            .add_tool_guide("test", "body")
            .add_state_prompt("<todo>x</todo>")
            .set_instructions("Be brief.")
            .build()
        )
        assert "<tool_guides>" in result
        assert "<session_state>" in result
        assert "<instructions>" in result


# ---------------------------------------------------------------------------
# TestPromptConstants
# ---------------------------------------------------------------------------


class TestPromptConstants:
    """Tests for module-level prompt constants."""

    def test_identity_contains_app_name(self):
        assert "Heureum Agent" in AGENT_IDENTITY_PROMPT

    def test_prompt_does_not_leak_model_name(self):
        """Identity prompt must NOT reveal the underlying model name."""
        assert settings.AGENT_MODEL not in AGENT_IDENTITY_PROMPT

    def test_compaction_prefix_value(self):
        assert COMPACTION_PREFIX == "[compaction] Previous conversation summary:"

    def test_hard_clear_placeholder_value(self):
        assert HARD_CLEAR_PLACEHOLDER == "[Previous tool results have been cleared]"
