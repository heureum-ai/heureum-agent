# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for DB-backed skill metadata wiring in ToolExecutionController.resolve_tools."""

from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.schemas.open_responses import ResponseRequest
from app.services.agent_loop.execution import ToolExecutionController


class _DummySkillController:
    def __init__(self, active_skill_names=None):
        self.display_names = {}
        self._active_skill_names = set(active_skill_names or [])

    def enrich_snapshot(self, skills_snapshot, session_id=None):
        return skills_snapshot

    def get_missing_tool_names(self, available_names, skills_snapshot=None):
        return set()

    def get_all_tool_names(self, skills_snapshot=None):
        return set()

    def get_active_skill_names(self, session_id):
        return set(self._active_skill_names)


@pytest.fixture(autouse=True)
def _clear_caches():
    ToolExecutionController._tool_schema_cache.clear()
    ToolExecutionController._skill_schema_cache.clear()
    ToolExecutionController._skill_body_cache.clear()


def _build_controller(active_skill_names=None) -> ToolExecutionController:
    skill_controller = _DummySkillController(active_skill_names=active_skill_names)
    mcp_client = SimpleNamespace(server_tool_names=set(), display_names={})
    return ToolExecutionController(
        agent_service=MagicMock(),
        skill_controller=skill_controller,
        mcp_client=mcp_client,
        tool_controller=MagicMock(),
    )


def _build_request(snapshot_prompt: str) -> ResponseRequest:
    return ResponseRequest(
        model="default",
        input="hello",
        skills_snapshot={
            "prompt": snapshot_prompt,
            "skills": [
                {
                    "name": "remote_skill",
                    "description": "Remote skill",
                    "location": "",
                    "tools": [],
                }
            ],
        },
    )


@pytest.mark.asyncio
async def test_resolve_tools_uses_fetch_skill_schemas_and_resolves_tool_schemas():
    ctrl = _build_controller()
    request = _build_request("<available_skills/>")
    persist = MagicMock()
    persist.fetch_skill_schemas = AsyncMock(return_value=[
        {
            "skill_name": "remote_skill",
            "description": "Remote skill from DB",
            "tools": ["remote_tool"],
        }
    ])
    persist.fetch_tool_schemas = AsyncMock(return_value=[
        {
            "tool_name": "remote_tool",
            "execution_target": "client",
            "display_name": "RemoteTool",
            "guide": "Use remote_tool carefully.",
            "schema": {
                "type": "function",
                "function": {
                    "name": "remote_tool",
                    "description": "Remote tool",
                    "parameters": {"type": "object", "properties": {}, "required": []},
                },
            },
        }
    ])
    persist.fetch_skill_body = AsyncMock(return_value="")

    (
        _tool_names,
        _client_tool_schemas,
        client_tool_names,
        client_tool_prompts,
        _display_names,
        _meta_sets,
    ) = await ctrl.resolve_tools(
        request,
        session_id="session_1",
        persist_controller=persist,
    )

    persist.fetch_skill_schemas.assert_awaited_once()
    persist.fetch_tool_schemas.assert_awaited_once()
    missing_names = persist.fetch_tool_schemas.await_args.args[0]
    assert "remote_tool" in missing_names
    persist.fetch_skill_body.assert_not_awaited()
    assert "remote_tool" in client_tool_names
    assert any("remote_tool" in prompt for prompt in client_tool_prompts)


@pytest.mark.asyncio
async def test_resolve_tools_uses_fetch_skill_body_when_snapshot_prompt_missing():
    ctrl = _build_controller(active_skill_names={"remote_skill"})
    request = _build_request("")
    persist = MagicMock()
    persist.fetch_skill_schemas = AsyncMock(return_value=[
        {
            "skill_name": "remote_skill",
            "description": "Remote skill from DB",
            "tools": [],
        }
    ])
    persist.fetch_tool_schemas = AsyncMock(return_value=[])
    persist.fetch_skill_body = AsyncMock(return_value="## Remote skill body")

    (
        _tool_names,
        _client_tool_schemas,
        _client_tool_names,
        client_tool_prompts,
        _display_names,
        _meta_sets,
    ) = await ctrl.resolve_tools(
        request,
        session_id="session_2",
        persist_controller=persist,
    )

    persist.fetch_skill_schemas.assert_awaited_once()
    persist.fetch_skill_body.assert_awaited_once_with("remote_skill")
    assert any(
        '<tool_guide name="remote_skill">' in prompt and "Remote skill body" in prompt
        for prompt in client_tool_prompts
    )
