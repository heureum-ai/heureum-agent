# Copyright (c) 2026 Heureum AI. All rights reserved.

import json

from app.services.orchestrator.result_store import AgentResultStore


class TestAgentResultStoreSubagentMessages:
    def test_save_subagent_result_persists_messages_and_tool_progress(self, tmp_path):
        store = AgentResultStore(str(tmp_path), "sess_test")

        messages = [
            {
                "idx": 0,
                "role": "user",
                "type": "HumanMessage",
                "content": "collect data",
            },
            {
                "idx": 1,
                "role": "assistant",
                "type": "AIMessage",
                "content": "running tools",
                "tool_calls": [{"id": "call_1", "name": "mcp_web__search"}],
            },
        ]
        progress = [
            {
                "tool_name": "mcp_web__search",
                "detail": "query=abc",
                "status": "completed",
                "started_at": 1.0,
                "completed_at": 2.0,
            }
        ]

        store.save_subagent_result(
            step_name="research",
            child_session_id="sub_1",
            task="find sources",
            status="completed",
            result_summary="done",
            merged_messages=messages,
            progress_log=progress,
        )

        sa_dir = tmp_path / "sessions" / "sess_test" / "steps" / "research" / "subagents" / "sub_1"

        meta = json.loads((sa_dir / "meta.json").read_text(encoding="utf-8"))
        assert meta["message_count"] == 2
        assert meta["tool_call_count"] == 1

        payload = json.loads((sa_dir / "messages.json").read_text(encoding="utf-8"))
        assert payload["messages"] == messages
        assert payload["tool_progress"] == progress
