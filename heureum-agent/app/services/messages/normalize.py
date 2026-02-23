# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Pure normalization helpers for message-domain pipelines."""

from __future__ import annotations

import json
import re
from typing import Any, ClassVar

from app.services.messages.base import MessageControllerBase
from app.schemas.open_responses import InputTokenDetails, OutputTokenDetails, Usage
from app.services.messages.types import NormalizedLLMOutput, PlatformMessageRecord
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage as LCSystemMessage,
    ToolMessage,
)


_PAGE_HEADER_RE = re.compile(
    r'^(?:Page:\s*"(?P<title>[^"]*)")?\s*(?:URL:\s*(?P<url>\S+))?',
    re.MULTILINE,
)


def _text_from_block(block: dict) -> str | None:
    """Single content block → text string, or None to skip."""
    if "text" in block:
        return block["text"] or ""
    if "function_response" in block:
        return block["function_response"]["response"]["output"] or ""
    if "refusal" in block:
        return block["refusal"] or ""
    if "type" in block:
        return None
    raise ValueError(f"Unknown content block type: {block!r}")


_FALLBACK_TOOL_CALL_ID = "unknown"
_TOOL_RESULT_PREFIX = "[Tool result:"


class MessageNormalizeController(MessageControllerBase):
    """Class-based normalization/path controller."""

    component_name = "messages.normalize"

    # Platform record type dispatch
    _PLATFORM_TYPE_FUNCTION_CALL: ClassVar[str] = "function_call"
    _PLATFORM_TYPE_FUNCTION_CALL_OUTPUT: ClassVar[str] = "function_call_output"

    # Platform record role → LangChain message class
    _PLATFORM_ROLE_TO_LC: ClassVar[dict[str, type[BaseMessage]]] = {
        "user": HumanMessage,
        "assistant": AIMessage,
        "system": LCSystemMessage,
    }

    # Platform record types to skip (return None)
    _PLATFORM_SKIP_TYPES: ClassVar[frozenset[str]] = frozenset(
        {
            "permission_grant",
            "todo_state",
        }
    )

    # ── Normalize helpers ──────────────────────────────────────────────

    def normalize_usage_metadata(self, usage: dict[str, Any] | None) -> dict[str, int] | None:
        """Normalize usage dict to LangChain ``usage_metadata`` shape."""
        if not usage:
            return None
        input_tokens = int(usage.get("input_tokens", 0) or 0)
        output_tokens = int(usage.get("output_tokens", 0) or 0)
        total_tokens = int(usage.get("total_tokens", input_tokens + output_tokens) or 0)
        return {
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
            "total_tokens": total_tokens,
        }

    def normalize_open_content(self, content: str | list) -> str:
        """Flatten Open Responses structured content into plain text."""
        if isinstance(content, str):
            return content
        return "\n".join(part["text"] for part in content if part.get("text"))

    def normalize_list_messages_payload(self, data: Any) -> list[PlatformMessageRecord]:
        """Normalize `/api/v1/messages` response payload into a list."""
        if isinstance(data, list):
            return [entry for entry in data if isinstance(entry, dict)]
        if isinstance(data, dict):
            results = data.get("results", [])
            if isinstance(results, list):
                return [entry for entry in results if isinstance(entry, dict)]
        return []

    # ── Content extraction ─────────────────────────────────────────────

    def extract_lc_text(self, content: Any) -> str:
        """Extract plain text from LangChain message content."""
        if isinstance(content, str):
            return content
        if isinstance(content, list):
            parts: list[str] = []
            for item in content:
                if isinstance(item, str):
                    parts.append(item)
                elif isinstance(item, dict):
                    text = _text_from_block(item)
                    if text:
                        parts.append(text)
            return " ".join(parts)
        return str(content)

    def _extract_usage(self, response) -> Usage:
        """Extract token usage from raw LLM response."""
        meta = getattr(response, "usage_metadata", None) or {}
        input_details = meta.get("input_token_details") or {}
        output_details = meta.get("output_token_details") or {}
        return Usage(
            input_tokens=meta.get("input_tokens", 0),
            output_tokens=meta.get("output_tokens", 0),
            total_tokens=meta.get("total_tokens", 0),
            input_tokens_details=InputTokenDetails(
                cached_tokens=input_details.get("cache_read", 0),
            ),
            output_tokens_details=OutputTokenDetails(
                reasoning_tokens=output_details.get("reasoning", 0),
            ),
        )

    def _extract_reasoning(self, content: Any) -> str:
        """Extract thinking/reasoning text from LangChain message content."""
        if not isinstance(content, list):
            return ""
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                if item.get("type") == "thinking" and "thinking" in item:
                    parts.append(item["thinking"])
                elif item.get("type") == "reasoning" and "content" in item:
                    parts.append(item["content"])
        return "\n".join(parts) if parts else ""

    def normalize_llm_response(self, response) -> NormalizedLLMOutput:
        """LLM 응답을 즉시 정규화 — text, reasoning, usage, tool_calls 한 번에 추출."""
        text = self.extract_lc_text(response.content)
        reasoning = self._extract_reasoning(response.content)
        usage = self._extract_usage(response)
        tool_calls = getattr(response, "tool_calls", None) or None
        return NormalizedLLMOutput(
            text=text,
            reasoning=reasoning,
            usage=usage,
            tool_calls=tool_calls,
            raw_message=response,
        )

    # ── Platform record → LangChain ────────────────────────────────────

    def platform_record_to_lc_message(self, record: PlatformMessageRecord) -> BaseMessage | None:
        """Convert a Platform DB message record into a LangChain message."""

        def text_to_lc() -> BaseMessage | None:
            role = record["role"]
            content = self.normalize_open_content(record["content"])
            if not content and not role:
                return None
            cls = self._PLATFORM_ROLE_TO_LC.get(role)
            if cls is not None:
                return cls(content=content)
            if role == "tool":
                return ToolMessage(
                    content=content, tool_call_id=record.get("tool_call_id", _FALLBACK_TOOL_CALL_ID)
                )
            return None

        def parse_function_call() -> AIMessage:
            content = record["content"]
            call_id = content.get("call_id") or content.get("id") or _FALLBACK_TOOL_CALL_ID
            raw_args = content["arguments"]
            args = raw_args if isinstance(raw_args, dict) else json.loads(raw_args)
            return AIMessage(
                content="", tool_calls=[{"name": content["name"], "args": args, "id": call_id}]
            )

        def parse_function_call_output() -> ToolMessage:
            content = record["content"]
            return ToolMessage(content=content["output"], tool_call_id=content["call_id"])

        msg_type = record["type"]
        if msg_type in self._PLATFORM_SKIP_TYPES:
            return None
        if msg_type == self._PLATFORM_TYPE_FUNCTION_CALL:
            return parse_function_call()
        if msg_type == self._PLATFORM_TYPE_FUNCTION_CALL_OUTPUT:
            return parse_function_call_output()
        return text_to_lc()

    def platform_records_to_lc_messages(
        self, records: list[PlatformMessageRecord]
    ) -> list[BaseMessage]:
        """Convert Platform message records into LangChain messages."""
        return [m for r in records if (m := self.platform_record_to_lc_message(r)) is not None]

    # ── LangChain helpers ───────────────────────────────────────────────

    def lc_role(self, msg: BaseMessage) -> str:
        """Return a role string for a LangChain message."""
        if isinstance(msg, HumanMessage):
            return "user"
        if isinstance(msg, AIMessage):
            return "assistant"
        if isinstance(msg, ToolMessage):
            return "tool"
        if isinstance(msg, LCSystemMessage):
            return "system"
        return "user"

    def serialize_lc_message(self, msg: BaseMessage) -> dict:
        """Serialize a LangChain message to a JSON-friendly dict."""
        role = self.lc_role(msg)
        content = self.extract_lc_text(msg.content) if hasattr(msg, "content") else ""
        result: dict = {"role": role, "content": content}

        if isinstance(msg, AIMessage):
            tool_calls = msg.tool_calls or []
            if tool_calls:
                result["tool_calls"] = tool_calls
            usage = getattr(msg, "usage_metadata", None)
            if usage:
                result["usage"] = dict(usage) if not isinstance(usage, dict) else usage
        elif isinstance(msg, ToolMessage):
            result["tool_call_id"] = msg.tool_call_id
            if msg.name:
                result["tool_name"] = msg.name

        return result

    # ── History filters ────────────────────────────────────────────────

    def strip_tool_call_narration(self, lc_messages: list[BaseMessage]) -> list[BaseMessage]:
        """Remove narration text from AIMessage instances that carry tool_calls."""

        def clear_narration(msg: AIMessage) -> AIMessage:
            return AIMessage(
                content="",
                tool_calls=msg.tool_calls,
                additional_kwargs=msg.additional_kwargs,
                response_metadata=msg.response_metadata,
                usage_metadata=msg.usage_metadata,  # type: ignore[arg-type]
                id=msg.id,
            )

        return [
            clear_narration(m) if isinstance(m, AIMessage) and m.tool_calls and m.content else m
            for m in lc_messages
        ]

    def strip_tool_messages(self, lc_messages: list[BaseMessage]) -> tuple[list[BaseMessage], bool]:
        """Strip AI(tool_calls) + ToolMessage pairs from history."""

        def is_tool_related(msg: BaseMessage) -> bool:
            return isinstance(msg, ToolMessage) or (
                isinstance(msg, AIMessage) and bool(msg.tool_calls)
            )

        clean = [m for m in lc_messages if not is_tool_related(m)]
        return clean, len(clean) != len(lc_messages)

    # ── Snapshot helpers ─────────────────────────────────────────────

    def is_snapshot_content(self, content: str) -> bool:
        """Check if content looks like a large snapshot (e.g. page DOM)."""
        return content.startswith("Page:") or "[Interactive Elements]" in content[:500]

    def extract_snapshot_header(self, content: str) -> str:
        """Extract short summary header from a snapshot tool output."""
        match = _PAGE_HEADER_RE.search(content)
        if match and (match.group("title") or match.group("url")):
            title = match.group("title") or ""
            url = match.group("url") or ""
            return f'Page: "{title}" URL: {url}'.strip()
        return content.split("\n", 1)[0][:120]

    def invalidate_stale_snapshots(self, lc_history: list[BaseMessage]) -> int:
        """Replace older snapshot tool outputs with one-line summaries."""

        def browser_body(msg: BaseMessage) -> str | None:
            if isinstance(msg, ToolMessage):
                return msg.content or ""
            if isinstance(msg, HumanMessage):
                content = msg.content or ""
                if content.startswith(_TOOL_RESULT_PREFIX):
                    bracket_end = content.find("]")
                    return content[bracket_end + 1 :].lstrip() if bracket_end > 0 else content
            return None

        def make_stale(msg: BaseMessage, body: str) -> BaseMessage:
            stale = f"[Stale snapshot replaced] {self.extract_snapshot_header(body)}"
            if isinstance(msg, ToolMessage):
                return ToolMessage(content=stale, tool_call_id=msg.tool_call_id)
            return HumanMessage(content=stale)

        replaced = 0
        seen_latest = False
        for idx in range(len(lc_history) - 1, -1, -1):
            body = browser_body(lc_history[idx])
            if body is None or not self.is_snapshot_content(body):
                continue
            if not seen_latest:
                seen_latest = True
                continue
            lc_history[idx] = make_stale(lc_history[idx], body)
            replaced += 1
        return replaced
