# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Shared models for the application."""

from enum import Enum
from typing import Any, Dict, List, Optional

from app.schemas.open_responses import Usage
from pydantic import BaseModel


class AgentResponse(BaseModel):
    """Agent response model for text-only LLM calls.

    Attributes:
        message (str): The text content of the agent's reply.
        session_id (str): Session identifier for the conversation.
        usage (Optional[Usage]): Token usage statistics from the LLM.
        reasoning (Optional[str]): Thinking/reasoning content from the LLM.
    """

    message: str
    session_id: str
    usage: Optional[Usage] = None
    reasoning: Optional[str] = None


class ToolCallInfo(BaseModel):
    """Single tool call descriptor returned by the LLM.

    Attributes:
        name (str): Name of the tool function to invoke.
        args (Dict[str, Any]): Parsed arguments for the tool call.
        id (str): Unique identifier correlating call and result.
    """

    name: str
    args: Dict[str, Any]
    id: str


class LLMResultType(str, Enum):
    """Discriminator for LLM response kind.

    Attributes:
        TEXT (str): Plain text response.
        TOOL_CALL (str): Tool calling response.
    """

    TEXT = "text"
    TOOL_CALL = "tool_call"


class LLMResult(BaseModel):
    """Result of a single LLM invocation with tool support.

    Returned by ``AgentService.process_messages_with_tools()``.

    Attributes:
        type (LLMResultType): Discriminator for response kind.
        text (Optional[str]): Assistant text when type is TEXT.
        tool_calls (Optional[List[ToolCallInfo]]): Tool calls when type
            is TOOL_CALL.
        session_id (str): Session identifier for the conversation.
        usage (Usage): Token usage statistics from the LLM.
    """

    type: LLMResultType
    text: Optional[str] = None
    tool_calls: Optional[List[ToolCallInfo]] = None
    assistant_lc_message: Optional[Any] = None
    session_id: str
    usage: Usage
    reasoning: Optional[str] = None
