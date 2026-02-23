"""History/session control helpers for message-domain handling."""

from __future__ import annotations

from typing import Any, Callable, Container, Mapping, Sequence

from app.schemas.open_responses import ResponseRequest
from app.services.messages.base import MessageControllerBase
from app.services.messages.normalize import MessageNormalizeController
from app.services.messages.responses import ResponseMessageController
from langchain_core.messages import AIMessage, BaseMessage, HumanMessage, SystemMessage, ToolMessage

GUIDANCE_PREFIXES: tuple[str, ...] = (
    "You tried to respond without finishing the plan",
    "Continue the plan.",
    "The previous response was inadequate",
    "The user's original request:",
)


class HistoryMessageController(MessageControllerBase):
    """Class-based history/session controller."""

    component_name = "messages.history"

    def __init__(
        self,
        normalizer: MessageNormalizeController,
        responses: ResponseMessageController,
    ) -> None:
        self._normalize = normalizer
        self._responses = responses

    def prepare_messages_for_session(
        self,
        *,
        request: ResponseRequest,
        messages: list[BaseMessage],
        history: list[BaseMessage],
        replace_tool_result: Callable[..., None] | None = None,
    ) -> list[BaseMessage]:
        """Normalize incoming messages for new-turn vs continuation semantics."""
        if not history:
            echo_msg = self._responses.parse_tool_call_echoes(request)
            if echo_msg:
                non_tool = [m for m in messages if not isinstance(m, ToolMessage)]
                tool_results = [m for m in messages if isinstance(m, ToolMessage)]
                return non_tool + [echo_msg] + tool_results
            return messages

        tool_results = [m for m in messages if isinstance(m, ToolMessage)]
        if tool_results:
            for tr in tool_results:
                if replace_tool_result is not None:
                    replace_tool_result(
                        tool_call_id=tr.tool_call_id or "",
                        output=self._normalize.extract_lc_text(tr.content),
                        tool_name=tr.name,
                    )
                    continue

                for i, hist_msg in enumerate(history):
                    if (
                        isinstance(hist_msg, ToolMessage)
                        and hist_msg.tool_call_id == tr.tool_call_id
                    ):
                        history[i] = tr
                        break
            return []

        history_set = {
            (self._normalize.lc_role(m), self._normalize.extract_lc_text(m.content))
            for m in history
        }
        return [
            m
            for m in messages
            if (self._normalize.lc_role(m), self._normalize.extract_lc_text(m.content))
            not in history_set
        ]

    def extract_last_user_query(self, history: Sequence[BaseMessage]) -> str:
        """Extract the most recent real user query from message history."""
        for msg in reversed(history):
            if isinstance(msg, HumanMessage):
                content = self._normalize.extract_lc_text(msg.content)
                if content and not any(content.startswith(prefix) for prefix in GUIDANCE_PREFIXES):
                    return content
        return ""

    def append_to_history(
        self,
        *,
        lc_history: list[BaseMessage],
        messages: Sequence[BaseMessage],
        response_text: str,
        usage: Mapping[str, Any] | None = None,
        assistant_lc_message: BaseMessage | None = None,
    ) -> None:
        """Persist user messages + assistant response to LC history."""
        lc_history.extend(messages)
        if assistant_lc_message is not None:
            lc_history.append(assistant_lc_message)
            return

        usage_metadata = self._normalize.normalize_usage_metadata(dict(usage) if usage else None)
        lc_history.append(
            AIMessage(
                content=response_text,
                usage_metadata=usage_metadata,  # type: ignore[arg-type]
            )
        )

    def replace_tool_result_in_history(
        self,
        *,
        lc_history: list[BaseMessage],
        tool_call_id: str,
        output: str,
    ) -> bool:
        """Replace a placeholder tool result in LC history."""
        for i, msg in enumerate(lc_history):
            if isinstance(msg, ToolMessage) and getattr(msg, "tool_call_id", None) == tool_call_id:
                lc_history[i] = ToolMessage(content=output, tool_call_id=tool_call_id)
                return True
        return False

    def append_tool_interaction_to_history(
        self,
        *,
        lc_history: list[BaseMessage],
        messages: Sequence[BaseMessage],
        tool_calls: Sequence[Mapping[str, Any]],
        tool_results: Sequence[BaseMessage],
        usage: Mapping[str, Any] | None = None,
        assistant_lc_message: BaseMessage | None = None,
        snapshot_tools: Container[str] = frozenset(),
    ) -> int:
        """Persist user messages + assistant tool calls + tool results.

        Args:
            snapshot_tools: Dynamic set of tool names whose output is
                page content subject to stale-snapshot invalidation.
                Provided by the client via ``tool_meta.snapshot``.

        Returns number of stale page snapshots replaced.
        """
        has_new_page = any(
            self._normalize.is_snapshot_content(self._normalize.extract_lc_text(tr.content))
            for tr in tool_results
            if isinstance(tr, ToolMessage)
            and (
                (tr.name or "") in snapshot_tools
                or self._normalize.is_snapshot_content(self._normalize.extract_lc_text(tr.content))
            )
        )

        lc_history.extend(messages)

        if assistant_lc_message is not None:
            lc_history.append(assistant_lc_message)
            lc_history.extend(tool_results)
        else:
            lc_history.append(
                AIMessage(
                    content="",
                    additional_kwargs={
                        "synthetic_tool_calls": list(tool_calls),
                        "synthetic_usage": self._normalize.normalize_usage_metadata(
                            dict(usage) if usage else None
                        ),
                    },
                )
            )
            for tr in tool_results:
                if isinstance(tr, ToolMessage):
                    lc_history.append(tr)
                else:
                    lc_history.append(
                        ToolMessage(
                            content=self._normalize.extract_lc_text(tr.content),
                            tool_call_id=getattr(tr, "tool_call_id", "synthetic"),
                        )
                    )

        if not has_new_page:
            return 0
        return self._normalize.invalidate_stale_snapshots(lc_history)

    def preview_text(self, content: Any, limit: int = 220) -> str:
        """Render content as a short one-line preview."""
        text = self._normalize.extract_lc_text(content).replace("\n", "\\n")
        if len(text) <= limit:
            return text
        return f"{text[:limit]}...(truncated {len(text) - limit} chars)"

    def summarize_tool_calls(self, tool_calls: Any) -> list[dict[str, Any]]:
        """Return compact tool-call metadata for logs."""
        if not isinstance(tool_calls, list):
            return []
        summaries: list[dict[str, Any]] = []
        for call in tool_calls:
            if not isinstance(call, dict):
                summaries.append({"raw_type": type(call).__name__})
                continue
            args = call.get("args")
            if isinstance(args, dict):
                args_shape = sorted(args.keys())
            else:
                args_shape = type(args).__name__
            summaries.append(
                {
                    "id": call.get("id"),
                    "name": call.get("name"),
                    "args_shape": args_shape,
                }
            )
        return summaries

    def serialize_lc_history_for_log(
        self,
        lc_messages: Sequence[BaseMessage],
    ) -> list[dict[str, Any]]:
        """Serialize LC history into compact debug-friendly payload."""
        serialized: list[dict[str, Any]] = []
        for i, msg in enumerate(lc_messages):
            item: dict[str, Any] = {
                "idx": i,
                "type": msg.__class__.__name__,
                "content_preview": self.preview_text(getattr(msg, "content", "")),
            }

            if isinstance(msg, SystemMessage):
                item["role"] = "system"
            elif isinstance(msg, HumanMessage):
                item["role"] = "user"
            elif isinstance(msg, ToolMessage):
                item["role"] = "tool"
                item["tool_call_id"] = getattr(msg, "tool_call_id", None)
                item["status"] = getattr(msg, "status", None)
            elif isinstance(msg, AIMessage):
                item["role"] = "assistant"
                tool_calls = getattr(msg, "tool_calls", None) or []
                if tool_calls:
                    item["tool_calls"] = self.summarize_tool_calls(tool_calls)
                invalid_calls = getattr(msg, "invalid_tool_calls", None) or []
                if invalid_calls:
                    item["invalid_tool_calls_count"] = len(invalid_calls)
                usage = getattr(msg, "usage_metadata", None)
                if isinstance(usage, dict):
                    item["usage"] = {
                        "input_tokens": usage.get("input_tokens"),
                        "output_tokens": usage.get("output_tokens"),
                        "total_tokens": usage.get("total_tokens"),
                    }

            additional_kwargs = getattr(msg, "additional_kwargs", None)
            if isinstance(additional_kwargs, dict) and additional_kwargs:
                item["additional_kwargs_keys"] = sorted(additional_kwargs.keys())
                if (
                    "tool_calls" in additional_kwargs
                    and "tool_calls" not in item
                    and isinstance(additional_kwargs.get("tool_calls"), list)
                ):
                    item["raw_tool_calls_count"] = len(additional_kwargs["tool_calls"])

            response_metadata = getattr(msg, "response_metadata", None)
            if isinstance(response_metadata, dict) and response_metadata:
                item["response_metadata_keys"] = sorted(response_metadata.keys())

            serialized.append(item)
        return serialized
