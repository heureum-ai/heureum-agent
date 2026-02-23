"""Response/request control helpers for message-domain handling.

This module centralizes Open Responses IO shaping:
  - request input parsing
  - SSE formatting
  - response item/object builders
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any, Mapping, Sequence

from app.services.messages.base import MessageControllerBase
from langchain_core.messages import (
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage as LCSystemMessage,
    ToolMessage,
)
from app.schemas.open_responses import (
    AssistantMessageItem,
    ErrorObject,
    FunctionToolCall,
    FunctionToolResult,
    ItemReferenceItem,
    ItemStatus,
    MessageItem,
    MessageRole,
    OutputTextContent,
    ReasoningItem,
    ResponseObject,
    ResponseRequest,
    ResponseStatus,
    Usage,
)


class ResponseMessageController(MessageControllerBase):
    """Class-based response/request controller."""

    component_name = "messages.responses"

    def format_sse_event(self, event: dict[str, Any]) -> str:
        """Format a payload as a single SSE event line."""
        return f"data: {json.dumps(event)}\n\n"

    def sse_event(self, event: dict[str, Any]) -> str:
        """Compatibility alias of ``format_sse_event``."""
        return self.format_sse_event(event)

    def sse_done(self) -> str:
        """Format terminal SSE marker."""
        return "data: [DONE]\n\n"

    def serialize_tool_history(
        self,
        tool_history: Sequence[Any] | None,
    ) -> list[dict[str, Any]] | None:
        """Normalize tool history items into JSON-serializable dicts."""
        if not tool_history:
            return None
        serialized: list[dict[str, Any]] = []
        for item in tool_history:
            if hasattr(item, "model_dump"):
                dumped = item.model_dump()
                if isinstance(dumped, dict):
                    serialized.append(dumped)
                    continue
            if isinstance(item, dict):
                serialized.append(item)
                continue
            serialized.append({"value": str(item)})
        return serialized

    def parse_input_messages(self, request: ResponseRequest) -> list[BaseMessage]:
        """Parse Open Responses input items into LangChain messages."""
        if isinstance(request.input, str):
            return [HumanMessage(content=request.input)]

        messages: list[BaseMessage] = []
        for item in request.input:
            if isinstance(item, FunctionToolResult):
                messages.append(ToolMessage(content=item.output, tool_call_id=item.call_id))
            elif isinstance(item, FunctionToolCall):
                continue
            elif isinstance(item, (ReasoningItem, ItemReferenceItem)):
                continue
            elif isinstance(item, MessageItem):
                if isinstance(item.content, str):
                    text = item.content
                else:
                    text = "\n".join(cp.text for cp in item.content if hasattr(cp, "text"))
                if item.role == MessageRole.SYSTEM:
                    messages.append(LCSystemMessage(content=text))
                elif item.role == MessageRole.ASSISTANT:
                    messages.append(AIMessage(content=text))
                else:
                    messages.append(HumanMessage(content=text))
        return messages

    def parse_input(self, request: ResponseRequest) -> list[BaseMessage]:
        """Compatibility alias of ``parse_input_messages``."""
        return self.parse_input_messages(request)

    def parse_tool_call_echoes(self, request: ResponseRequest) -> AIMessage | None:
        """Rebuild assistant tool-call message from echoed function_call items."""
        if isinstance(request.input, str):
            return None

        echoes = [item for item in request.input if isinstance(item, FunctionToolCall)]
        if not echoes:
            return None

        tool_calls = []
        for tc in echoes:
            try:
                args = json.loads(tc.arguments) if isinstance(tc.arguments, str) else tc.arguments
            except (json.JSONDecodeError, TypeError):
                args = {}
            tool_calls.append({"name": tc.name, "args": args, "id": tc.call_id})

        return AIMessage(content="", tool_calls=tool_calls)

    def extract_session_id(self, metadata: Mapping[str, Any] | None) -> str:
        """Extract session_id from request metadata or generate a new one."""
        if metadata:
            sid = metadata.get("session_id")
            if sid:
                return str(sid)
        return f"session_{uuid.uuid4().hex[:16]}"

    def extract_cwd(self, metadata: Mapping[str, Any] | None) -> str:
        """Extract cwd from request metadata."""
        if metadata:
            return str(metadata.get("cwd", ""))
        return ""

    def build_text_output(
        self,
        text: str,
        status: ItemStatus = ItemStatus.COMPLETED,
    ) -> AssistantMessageItem:
        """Build assistant text output item."""
        return AssistantMessageItem(
            id=f"msg_{uuid.uuid4().hex}",
            role=MessageRole.ASSISTANT,
            status=status,
            content=[OutputTextContent(text=text)],
        )

    def text_output(
        self,
        text: str,
        status: ItemStatus = ItemStatus.COMPLETED,
    ) -> AssistantMessageItem:
        """Compatibility alias of ``build_text_output``."""
        return self.build_text_output(text, status)

    def build_tool_call_output(
        self,
        name: str,
        arguments: dict[str, Any],
        call_id: str,
        display_name: str = "",
    ) -> FunctionToolCall:
        """Build function_call output item."""
        assert display_name, f"display_name required for tool '{name}'"
        return FunctionToolCall(
            id=f"fc_{uuid.uuid4().hex}",
            call_id=call_id,
            name=name,
            arguments=json.dumps(arguments) if isinstance(arguments, dict) else arguments,
            status=ItemStatus.COMPLETED,
            display_name=display_name,
        )

    def tool_call_output(
        self,
        name: str,
        arguments: dict[str, Any],
        call_id: str,
        display_name: str = "",
    ) -> FunctionToolCall:
        """Compatibility alias of ``build_tool_call_output``."""
        return self.build_tool_call_output(name, arguments, call_id, display_name)

    def make_tool_result_message(
        self,
        *,
        tool_name: str,
        tool_call_id: str,
        result: str,
    ) -> ToolMessage:
        """Build tool-result LangChain message from a completed tool call."""
        return ToolMessage(
            content=result,
            tool_call_id=tool_call_id,
            name=tool_name,
        )

    def append_tool_output_items(
        self,
        *,
        tool_name: str,
        display_name: str,
        arguments: dict[str, Any],
        tool_call_id: str,
        result: str,
        output_items: list[Any],
    ) -> None:
        """Append ``FunctionToolCall`` + ``FunctionToolResult`` output items."""
        output_items.append(
            self.build_tool_call_output(
                tool_name, arguments, tool_call_id, display_name=display_name
            )
        )
        output_items.append(
            FunctionToolResult(
                id=f"out_{uuid.uuid4().hex}",
                call_id=tool_call_id,
                output=result,
            )
        )

    def build_response_metadata(
        self,
        *,
        session_id: str,
        tool_history: Sequence[Any] | None = None,
        extra_metadata: Mapping[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Build response metadata payload with router-compatible semantics."""
        meta: dict[str, Any] = {"session_id": session_id}
        serialized = self.serialize_tool_history(tool_history)
        if serialized:
            meta["tool_history"] = serialized
        for key, value in (extra_metadata or {}).items():
            if value is not None:
                meta[key] = value
        return meta

    def build_response_object(
        self,
        *,
        output_items: list[Any],
        status: ResponseStatus,
        session_id: str,
        created_at: int,
        model: str,
        error: ErrorObject | None = None,
        usage: Usage | None = None,
        tool_history: Sequence[Any] | None = None,
        extra_metadata: Mapping[str, Any] | None = None,
    ) -> ResponseObject:
        """Build ``ResponseObject`` with normalized metadata and usage."""
        resolved_usage = usage or Usage.zero()
        metadata = self.build_response_metadata(
            session_id=session_id,
            tool_history=tool_history,
            extra_metadata=extra_metadata,
        )
        return ResponseObject(
            id=f"resp_{uuid.uuid4().hex}",
            created_at=created_at,
            completed_at=int(time.time()),
            model=model,
            status=status,
            output=output_items,
            usage=resolved_usage,
            error=error,
            metadata=metadata,
        )

    def build_response(
        self,
        output_items: list[Any],
        status: ResponseStatus,
        session_id: str,
        created_at: int,
        model: str,
        error: ErrorObject | None = None,
        usage: Usage | None = None,
        **extra_metadata: Any,
    ) -> ResponseObject:
        """Compatibility alias matching router helper signature."""
        tool_history = extra_metadata.pop("tool_history", None)
        return self.build_response_object(
            output_items=output_items,
            status=status,
            session_id=session_id,
            created_at=created_at,
            model=model,
            error=error,
            usage=usage,
            tool_history=tool_history,
            extra_metadata=extra_metadata,
        )
