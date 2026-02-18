# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Tests for proxy view: user-message deduplication, todo persistence, and coverage."""

import json
from decimal import Decimal
from unittest.mock import MagicMock, patch

import httpx
import pytest
from chat_messages.models import (
    Message,
    ModelPricing,
    Question,
)
from chat_messages.models import Response as ResponseModel
from chat_messages.models import (
    Session,
)
from django.contrib.auth import get_user_model
from proxy.views import _calculate_cost, _persist_output
from rest_framework.test import APIClient

User = get_user_model()


TEST_SESSION_ID = "test-session-proxy-dedup"

# Minimal agent response returned by the mocked httpx stream
AGENT_RESPONSE = {
    "id": "resp_mock",
    "status": "completed",
    "model": "test-model",
    "output": [
        {
            "type": "message",
            "role": "assistant",
            "content": [{"type": "output_text", "text": "Hello!"}],
            "status": "completed",
        }
    ],
    "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
    "metadata": {"session_id": TEST_SESSION_ID},
}

SAMPLE_TODO = {
    "task": "Set up notifications",
    "steps": [
        {
            "description": "Install dependencies",
            "status": "completed",
            "result": "Done",
        },
        {"description": "Configure provider", "status": "in_progress", "result": None},
        {"description": "Test delivery", "status": "pending", "result": None},
    ],
}


def _build_sse_body(response_data: dict, extra_events: list[dict] | None = None) -> str:
    """Build an SSE response body that the proxy can parse."""
    lines = []
    lines.append(f"data: {json.dumps({'type': 'response.created', 'response': response_data})}")
    for evt in extra_events or []:
        lines.append(f"data: {json.dumps(evt)}")
    lines.append(f"data: {json.dumps({'type': 'response.completed', 'response': response_data})}")
    lines.append("data: [DONE]")
    return "\n".join(lines)


class _FakeStreamResponse:
    """Mock for httpx streaming response context manager."""

    def __init__(self, response_data, extra_events=None):
        self._body = _build_sse_body(response_data, extra_events)

    def raise_for_status(self):
        pass

    def iter_lines(self):
        return iter(self._body.split("\n"))

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


class _FakeHTTPClient:
    """Mock httpx.Client that returns a fake streaming response."""

    def __init__(self, response_data, extra_events=None):
        self._response_data = response_data
        self._extra_events = extra_events

    def stream(self, *args, **kwargs):
        return _FakeStreamResponse(self._response_data, self._extra_events)

    def __enter__(self):
        return self

    def __exit__(self, *args):
        pass


def _make_initial_request_payload(user_text: str = "Hello") -> dict:
    """Build request payload for an initial user message (no tool results)."""
    return {
        "input": [
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": user_text}],
            }
        ],
        "stream": True,
        "metadata": {"session_id": TEST_SESSION_ID},
    }


def _make_followup_request_payload(user_text: str = "Hello") -> dict:
    """Build request payload for a follow-up with tool results (user msg re-sent as context)."""
    return {
        "input": [
            # Original user message re-sent as context
            {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": user_text}],
            },
            # Tool call from previous round
            {
                "type": "function_call",
                "call_id": "call_abc123",
                "name": "bash",
                "arguments": '{"command": "ls"}',
            },
            # Tool result from previous round
            {
                "type": "function_call_output",
                "call_id": "call_abc123",
                "output": "file1.txt\nfile2.txt",
            },
        ],
        "stream": True,
        "metadata": {"session_id": TEST_SESSION_ID},
    }


# ── Fixtures ──


@pytest.fixture
def api_client(db):
    return APIClient()


@pytest.fixture
def session(db):
    return Session.objects.create(session_id=TEST_SESSION_ID, title="Test Dedup")


# ═══════════════════════════════════════════════════════════════════════════════
# User message deduplication tests
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.django_db
class TestUserMessageDeduplication:
    def _post_proxy(self, api_client, payload):
        """POST to the proxy endpoint with mocked agent backend."""
        with patch("proxy.views.httpx.Client", return_value=_FakeHTTPClient(AGENT_RESPONSE)):
            resp = api_client.post(
                "/api/v1/proxy/",
                payload,
                format="json",
            )
        return resp

    def test_initial_request_stores_user_message(self, api_client, session):
        """An initial request (no tool results) should store exactly 1 user message."""
        payload = _make_initial_request_payload("Hi there")
        resp = self._post_proxy(api_client, payload)

        assert resp.status_code == 200

        user_msgs = Message.objects.filter(
            session_id=TEST_SESSION_ID,
            role="user",
            type="message",
        )
        assert user_msgs.count() == 1
        assert user_msgs.first().get_text_content() == "Hi there"

    def test_followup_request_does_not_duplicate_user_message(self, api_client, session):
        """A follow-up request (with tool results) should NOT create another user message."""
        # First: initial request creates the user message
        self._post_proxy(api_client, _make_initial_request_payload("Hi there"))
        assert (
            Message.objects.filter(session_id=TEST_SESSION_ID, role="user", type="message").count()
            == 1
        )

        # Second: follow-up with tool results — user message is just context
        self._post_proxy(api_client, _make_followup_request_payload("Hi there"))

        # Should still be exactly 1 user message
        user_msgs = Message.objects.filter(session_id=TEST_SESSION_ID, role="user", type="message")
        assert user_msgs.count() == 1

    def test_multiple_followup_rounds_no_duplication(self, api_client, session):
        """Simulating 3 rounds of tool execution — user message count stays at 1."""
        # Round 1: initial
        self._post_proxy(api_client, _make_initial_request_payload("Do something"))

        # Rounds 2-4: follow-ups
        for _ in range(3):
            self._post_proxy(api_client, _make_followup_request_payload("Do something"))

        user_msgs = Message.objects.filter(session_id=TEST_SESSION_ID, role="user", type="message")
        assert user_msgs.count() == 1

    def test_function_call_items_still_stored_on_followup(self, api_client, session):
        """function_call and function_call_output items should still be persisted on follow-up."""
        # Initial request
        self._post_proxy(api_client, _make_initial_request_payload("Hi"))

        # Follow-up with tool results
        self._post_proxy(api_client, _make_followup_request_payload("Hi"))

        # function_call and function_call_output from INPUT should be stored
        fc_msgs = Message.objects.filter(session_id=TEST_SESSION_ID, type="function_call")
        fco_msgs = Message.objects.filter(session_id=TEST_SESSION_ID, type="function_call_output")
        assert fc_msgs.count() >= 1
        assert fco_msgs.count() >= 1

    def test_new_user_message_in_separate_turn_is_stored(self, api_client, session):
        """A genuinely new user message (no tool results) should still be stored."""
        # First message
        self._post_proxy(api_client, _make_initial_request_payload("First message"))
        assert (
            Message.objects.filter(session_id=TEST_SESSION_ID, role="user", type="message").count()
            == 1
        )

        # Second message (new turn, no tool results)
        self._post_proxy(api_client, _make_initial_request_payload("Second message"))
        assert (
            Message.objects.filter(session_id=TEST_SESSION_ID, role="user", type="message").count()
            == 2
        )


# ═══════════════════════════════════════════════════════════════════════════════
# Todo state persistence tests
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.django_db
class TestTodoStatePersistence:
    def _post_proxy_with_todo(self, api_client, todo_events):
        """POST to proxy with mocked agent that emits todo SSE events."""
        payload = _make_initial_request_payload("Create a plan")
        extra = [{"type": "response.todo.updated", "todo": t} for t in todo_events]
        fake_client = _FakeHTTPClient(AGENT_RESPONSE, extra_events=extra)
        with patch("proxy.views._agent_client", fake_client):
            resp = api_client.post("/api/v1/proxy/", payload, format="json")
            # Consume streaming content INSIDE the mock context so the
            # generator uses the mocked _agent_client and runs to completion
            # (including the _persist_output call at the end).
            if hasattr(resp, "streaming_content"):
                b"".join(resp.streaming_content)
        return resp

    def test_todo_state_persisted_from_streaming(self, api_client, session):
        """A response.todo.updated SSE event should be persisted as a todo_state Message."""
        resp = self._post_proxy_with_todo(api_client, [SAMPLE_TODO])
        assert resp.status_code == 200

        todo_msgs = Message.objects.filter(session_id=TEST_SESSION_ID, type="todo_state")
        assert todo_msgs.count() == 1

    def test_todo_state_contains_correct_data(self, api_client, session):
        """The persisted todo_state should have the correct task and steps."""
        self._post_proxy_with_todo(api_client, [SAMPLE_TODO])

        todo_msg = Message.objects.get(session_id=TEST_SESSION_ID, type="todo_state")
        content = todo_msg.content
        assert content["task"] == "Set up notifications"
        assert len(content["steps"]) == 3
        assert content["steps"][0]["status"] == "completed"
        assert content["steps"][1]["status"] == "in_progress"

    def test_only_last_todo_state_persisted(self, api_client, session):
        """Multiple todo events in one stream should result in only the last being persisted."""
        early_todo = {
            "task": "Set up notifications",
            "steps": [
                {"description": "Step 1", "status": "in_progress", "result": None},
            ],
        }
        final_todo = {
            "task": "Set up notifications",
            "steps": [
                {"description": "Step 1", "status": "completed", "result": "Done"},
                {"description": "Step 2", "status": "in_progress", "result": None},
            ],
        }
        self._post_proxy_with_todo(api_client, [early_todo, final_todo])

        todo_msgs = Message.objects.filter(session_id=TEST_SESSION_ID, type="todo_state")
        assert todo_msgs.count() == 1
        content = todo_msgs.first().content
        # Should be the FINAL state, not the early one
        assert len(content["steps"]) == 2
        assert content["steps"][0]["status"] == "completed"

    def test_no_todo_state_when_no_todo_events(self, api_client, session):
        """When no todo events are emitted, no todo_state Message should be created."""
        payload = _make_initial_request_payload("Hello")
        with patch(
            "proxy.views.httpx.Client",
            return_value=_FakeHTTPClient(AGENT_RESPONSE),
        ):
            api_client.post("/api/v1/proxy/", payload, format="json")

        todo_msgs = Message.objects.filter(session_id=TEST_SESSION_ID, type="todo_state")
        assert todo_msgs.count() == 0


# ═══════════════════════════════════════════════════════════════════════════════
# _calculate_cost
# ═══════════════════════════════════════════════════════════════════════════════


class TestCalculateCost:
    def test_with_pricing(self):
        pricing = MagicMock()
        pricing.input_cost_per_mtok = Decimal("3.0")
        pricing.output_cost_per_mtok = Decimal("15.0")
        input_cost, output_cost = _calculate_cost(1_000_000, 500_000, pricing)
        assert input_cost == Decimal("3.0")
        assert output_cost == Decimal("7.5")

    def test_without_pricing(self):
        input_cost, output_cost = _calculate_cost(1000, 500, None)
        assert input_cost == Decimal(0)
        assert output_cost == Decimal(0)

    def test_zero_tokens(self):
        pricing = MagicMock()
        pricing.input_cost_per_mtok = Decimal("3.0")
        pricing.output_cost_per_mtok = Decimal("15.0")
        input_cost, output_cost = _calculate_cost(0, 0, pricing)
        assert input_cost == Decimal(0)
        assert output_cost == Decimal(0)


# ═══════════════════════════════════════════════════════════════════════════════
# _persist_output
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.django_db
class TestPersistOutput:
    @pytest.fixture
    def response_obj(self, db):
        Session.objects.create(session_id="persist-test")
        return ResponseModel.objects.create(
            session_id="persist-test",
            model="test-model",
            status="in_progress",
        )

    def test_persists_function_call(self, response_obj):
        data = {
            "output": [
                {
                    "type": "function_call",
                    "id": "fc_1",
                    "name": "bash",
                    "call_id": "call_1",
                    "arguments": '{"command": "ls"}',
                    "status": "completed",
                }
            ],
            "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
        }
        with patch.object(ModelPricing, "get_for_model", return_value=None):
            _persist_output(data, "persist-test", response_obj)

        fc = Message.objects.filter(session_id="persist-test", type="function_call")
        assert fc.count() == 1

    def test_persists_ask_question_call(self, response_obj):
        data = {
            "output": [
                {
                    "type": "function_call",
                    "id": "fc_q1",
                    "name": "ask_question",
                    "call_id": "call_q1",
                    "arguments": json.dumps(
                        {
                            "question": "What color?",
                            "choices": ["red", "blue"],
                            "allow_user_input": True,
                        }
                    ),
                    "status": "completed",
                }
            ],
            "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
        }
        with patch.object(ModelPricing, "get_for_model", return_value=None):
            _persist_output(data, "persist-test", response_obj)

        q = Question.objects.filter(session_id="persist-test")
        assert q.count() == 1
        assert q.first().question_text == "What color?"

    def test_persists_text_message(self, response_obj):
        data = {
            "output": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "Hello!"}],
                    "status": "completed",
                    "id": "msg_1",
                }
            ],
            "model": "gpt-4",
            "usage": {"input_tokens": 100, "output_tokens": 50, "total_tokens": 150},
        }
        with patch.object(ModelPricing, "get_for_model", return_value=None):
            _persist_output(data, "persist-test", response_obj)

        msgs = Message.objects.filter(session_id="persist-test", role="assistant")
        assert msgs.count() == 1

    def test_persists_tool_history(self, response_obj):
        data = {
            "output": [],
            "usage": {},
            "metadata": {
                "tool_history": [
                    {
                        "type": "function_call",
                        "id": "th_1",
                        "name": "read_file",
                        "status": "completed",
                    },
                    {
                        "type": "function_call_output",
                        "id": "th_2",
                        "status": "completed",
                    },
                ]
            },
        }
        with patch.object(ModelPricing, "get_for_model", return_value=None):
            _persist_output(data, "persist-test", response_obj)

        tool_msgs = Message.objects.filter(
            session_id="persist-test",
            type__in=["function_call", "function_call_output"],
        )
        assert tool_msgs.count() == 2

    def test_persists_todo_state(self, response_obj):
        data = {
            "output": [],
            "usage": {},
        }
        todo = {"task": "Setup", "steps": []}
        with patch.object(ModelPricing, "get_for_model", return_value=None):
            _persist_output(data, "persist-test", response_obj, todo_state=todo)

        todo_msgs = Message.objects.filter(session_id="persist-test", type="todo_state")
        assert todo_msgs.count() == 1

    def test_updates_response_usage(self, response_obj):
        data = {
            "output": [],
            "status": "completed",
            "model": "gpt-4",
            "usage": {"input_tokens": 100, "output_tokens": 50, "total_tokens": 150},
        }
        with patch.object(ModelPricing, "get_for_model", return_value=None):
            _persist_output(data, "persist-test", response_obj)

        response_obj.refresh_from_db()
        assert response_obj.input_tokens == 100
        assert response_obj.output_tokens == 50
        assert response_obj.status == "completed"

    def test_per_item_usage(self, response_obj):
        data = {
            "output": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "Hi"}],
                    "status": "completed",
                }
            ],
            "model": "gpt-4",
            "usage": {"input_tokens": 100, "output_tokens": 50, "total_tokens": 150},
        }
        item_usages = [
            {
                "type": "text",
                "usage": {"input_tokens": 80, "output_tokens": 40, "total_tokens": 120},
            }
        ]
        with patch.object(ModelPricing, "get_for_model", return_value=None):
            _persist_output(data, "persist-test", response_obj, item_usages=item_usages)

        msg = Message.objects.filter(session_id="persist-test", role="assistant").first()
        assert msg.input_tokens == 80
        assert msg.output_tokens == 40


# ═══════════════════════════════════════════════════════════════════════════════
# proxy_subagent_status
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.django_db
class TestProxySubagentStatus:
    @pytest.fixture
    def auth_client(self, db):
        user = User.objects.create_user(email="test@test.com", password="pass123")
        client = APIClient()
        client.force_authenticate(user=user)
        return client, user

    def test_session_not_found(self, auth_client):
        client, user = auth_client
        resp = client.get("/api/v1/subagent/status/nonexistent/")
        assert resp.status_code == 404

    def test_session_wrong_owner(self, auth_client):
        client, user = auth_client
        other_user = User.objects.create_user(email="other@test.com", password="pass123")
        Session.objects.create(session_id="other-session", user=other_user)
        resp = client.get("/api/v1/subagent/status/other-session/")
        assert resp.status_code == 404

    def test_success_proxies_to_agent(self, auth_client):
        client, user = auth_client
        Session.objects.create(session_id="my-session", user=user)

        mock_resp = MagicMock()
        mock_resp.json.return_value = {"children": []}
        mock_resp.status_code = 200
        with patch("proxy.views._agent_client") as mock_client:
            mock_client.get.return_value = mock_resp
            resp = client.get("/api/v1/subagent/status/my-session/")

        assert resp.status_code == 200
        assert resp.data == {"children": []}

    def test_agent_http_error(self, auth_client):
        client, user = auth_client
        Session.objects.create(session_id="my-session", user=user)

        with patch("proxy.views._agent_client") as mock_client:
            mock_client.get.side_effect = httpx.ConnectError("connection refused")
            resp = client.get("/api/v1/subagent/status/my-session/")

        assert resp.status_code == 502

    def test_agent_non_json_response(self, auth_client):
        client, user = auth_client
        Session.objects.create(session_id="my-session", user=user)

        mock_resp = MagicMock()
        mock_resp.json.side_effect = ValueError("not json")
        mock_resp.text = "Internal Server Error"
        mock_resp.status_code = 500
        with patch("proxy.views._agent_client") as mock_client:
            mock_client.get.return_value = mock_resp
            resp = client.get("/api/v1/subagent/status/my-session/")

        assert resp.status_code == 500
        assert resp.data["detail"] == "Internal Server Error"

    def test_session_no_user_allows_access(self, auth_client):
        """Sessions with no user (anonymous) should be accessible."""
        client, user = auth_client
        Session.objects.create(session_id="anon-session", user=None)

        mock_resp = MagicMock()
        mock_resp.json.return_value = {"children": []}
        mock_resp.status_code = 200
        with patch("proxy.views._agent_client") as mock_client:
            mock_client.get.return_value = mock_resp
            resp = client.get("/api/v1/subagent/status/anon-session/")

        assert resp.status_code == 200


# ═══════════════════════════════════════════════════════════════════════════════
# proxy_to_agent – non-streaming & error paths
# ═══════════════════════════════════════════════════════════════════════════════


@pytest.mark.django_db
class TestProxyToAgentNonStreaming:
    @pytest.fixture
    def api_client(self, db):
        return APIClient()

    @pytest.fixture
    def session(self, db):
        return Session.objects.create(session_id=TEST_SESSION_ID)

    def test_non_streaming_success(self, api_client, session):
        """Non-streaming requests should return agent response directly."""
        agent_resp_data = {
            "id": "resp_1",
            "status": "completed",
            "model": "test-model",
            "output": [
                {
                    "type": "message",
                    "role": "assistant",
                    "content": [{"type": "output_text", "text": "Hi"}],
                }
            ],
            "usage": {"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
        }

        mock_resp = MagicMock()
        mock_resp.json.return_value = agent_resp_data
        mock_resp.raise_for_status.return_value = None

        with (
            patch("proxy.views._agent_client") as mock_client,
            patch.object(ModelPricing, "get_for_model", return_value=None),
        ):
            mock_client.post.return_value = mock_resp
            payload = {
                "input": "Hello",
                "stream": False,
                "metadata": {"session_id": TEST_SESSION_ID},
            }
            resp = api_client.post("/api/v1/proxy/", payload, format="json")

        assert resp.status_code == 200
        assert resp.data["metadata"]["session_id"] == TEST_SESSION_ID

    def test_invalid_request(self, api_client, session):
        """Invalid input should return 400."""
        resp = api_client.post("/api/v1/proxy/", {}, format="json")
        assert resp.status_code == 400

    def test_httpx_error(self, api_client, session):
        """HTTPError from agent should return 502."""
        with patch("proxy.views._agent_client") as mock_client:
            mock_client.post.side_effect = httpx.ConnectError("refused")
            payload = {
                "input": "Hello",
                "stream": False,
                "metadata": {"session_id": TEST_SESSION_ID},
            }
            resp = api_client.post("/api/v1/proxy/", payload, format="json")

        assert resp.status_code == 502

    def test_generic_exception(self, api_client, session):
        """Generic exception should return 500."""
        with patch("proxy.views._agent_client") as mock_client:
            mock_client.post.side_effect = RuntimeError("unexpected")
            payload = {
                "input": "Hello",
                "stream": False,
                "metadata": {"session_id": TEST_SESSION_ID},
            }
            resp = api_client.post("/api/v1/proxy/", payload, format="json")

        assert resp.status_code == 500

    def test_string_input_converted_to_messages(self, api_client, session):
        """Simple string input should be stored as a user message."""
        agent_resp_data = {
            "id": "resp_1",
            "status": "completed",
            "model": "test-model",
            "output": [],
            "usage": {},
        }
        mock_resp = MagicMock()
        mock_resp.json.return_value = agent_resp_data
        mock_resp.raise_for_status.return_value = None

        with (
            patch("proxy.views._agent_client") as mock_client,
            patch.object(ModelPricing, "get_for_model", return_value=None),
        ):
            mock_client.post.return_value = mock_resp
            payload = {
                "input": "Hello there",
                "stream": False,
                "metadata": {"session_id": TEST_SESSION_ID},
            }
            resp = api_client.post("/api/v1/proxy/", payload, format="json")

        assert resp.status_code == 200
        user_msgs = Message.objects.filter(session_id=TEST_SESSION_ID, role="user")
        assert user_msgs.count() == 1

    def test_function_call_output_updates_question(self, api_client, session):
        """function_call_output with user input should update Question."""
        # Create a question first
        resp_obj = ResponseModel.objects.create(session_id=TEST_SESSION_ID, model="test")
        Question.objects.create(
            session_id=TEST_SESSION_ID,
            response=resp_obj,
            call_id="call_q1",
            question_text="Pick one",
        )

        agent_resp_data = {
            "id": "resp_2",
            "status": "completed",
            "model": "test-model",
            "output": [],
            "usage": {},
        }
        mock_resp = MagicMock()
        mock_resp.json.return_value = agent_resp_data
        mock_resp.raise_for_status.return_value = None

        with (
            patch("proxy.views._agent_client") as mock_client,
            patch.object(ModelPricing, "get_for_model", return_value=None),
        ):
            mock_client.post.return_value = mock_resp
            payload = {
                "input": [
                    {
                        "type": "function_call_output",
                        "call_id": "call_q1",
                        "output": "User chose: option A",
                    }
                ],
                "stream": False,
                "metadata": {"session_id": TEST_SESSION_ID},
            }
            resp = api_client.post("/api/v1/proxy/", payload, format="json")

        assert resp.status_code == 200
        q = Question.objects.get(call_id="call_q1")
        assert q.answer_type == "choice"
        assert q.user_answer == "option A"
