# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Open Responses specification schemas.

Based on https://www.openresponses.org/specification
"""

from enum import Enum
from typing import Any, Dict, List, Literal, Optional, Union

from pydantic import BaseModel, Field, model_validator


class MessageRole(str, Enum):
    """Message role enumeration.

    Attributes:
        USER (str): User role.
        ASSISTANT (str): Assistant role.
        SYSTEM (str): System role.
        DEVELOPER (str): Developer role.
        TOOL (str): Tool result role (internal use, serialized as
            ``function_call_output`` in Open Responses format).
    """

    USER = "user"
    ASSISTANT = "assistant"
    SYSTEM = "system"
    DEVELOPER = "developer"
    TOOL = "tool"


class ItemStatus(str, Enum):
    """Item lifecycle status.

    Attributes:
        IN_PROGRESS (str): Item is currently being processed.
        INCOMPLETE (str): Item was not fully completed.
        COMPLETED (str): Item finished successfully.
    """

    IN_PROGRESS = "in_progress"
    INCOMPLETE = "incomplete"
    COMPLETED = "completed"


class ResponseStatus(str, Enum):
    """Response lifecycle status.

    Attributes:
        QUEUED (str): Response is queued for processing.
        IN_PROGRESS (str): Response is currently being processed.
        COMPLETED (str): Response finished successfully.
        INCOMPLETE (str): Response was not fully completed.
        FAILED (str): Response encountered an error.
        CANCELLED (str): Response was cancelled before completion.
    """

    QUEUED = "queued"
    IN_PROGRESS = "in_progress"
    COMPLETED = "completed"
    INCOMPLETE = "incomplete"
    FAILED = "failed"
    CANCELLED = "cancelled"


class InputTextContent(BaseModel):
    """Text content for user input.

    Attributes:
        type (Literal["input_text"]): Content type discriminator.
        text (str): The input text value.
    """

    type: Literal["input_text"] = "input_text"
    text: str


class OutputTextContent(BaseModel):
    """Text content for model output.

    Attributes:
        type (Literal["output_text"]): Content type discriminator.
        text (str): The output text value.
        annotations (List[Any]): Annotations associated with the text.
    """

    type: Literal["output_text"] = "output_text"
    text: str
    annotations: List[Any] = Field(default_factory=list)


ContentPart = Union[InputTextContent, OutputTextContent]


class MessageItem(BaseModel):
    """Base message item structure.

    Attributes:
        id (Optional[str]): Unique identifier for this item.
        type (Literal["message"]): Item type discriminator.
        role (MessageRole): Role of the message author.
        status (ItemStatus): Lifecycle status of the item.
        content (Union[str, List[ContentPart]]): Message body as plain
            text or structured content parts. String values are
            automatically normalized to ``[InputTextContent(text=...)]``.
    """

    id: Optional[str] = None
    type: Literal["message"] = "message"
    role: MessageRole
    status: ItemStatus = ItemStatus.COMPLETED
    content: Union[str, List[ContentPart]]

    @model_validator(mode="after")
    def _normalize_content(self) -> "MessageItem":
        """Normalize string content to a list of InputTextContent."""
        if isinstance(self.content, str):
            self.content = [InputTextContent(text=self.content)]
        return self


class UserMessageItem(MessageItem):
    """User message item.

    Attributes:
        role (Literal[MessageRole.USER]): Fixed to the user role.
    """

    role: Literal[MessageRole.USER] = MessageRole.USER


class AssistantMessageItem(MessageItem):
    """Assistant message item.

    Attributes:
        role (Literal[MessageRole.ASSISTANT]): Fixed to the assistant role.
        usage (Optional[Usage]): Token usage for this LLM call.
    """

    role: Literal[MessageRole.ASSISTANT] = MessageRole.ASSISTANT
    usage: Optional["Usage"] = None


class SystemMessageItem(MessageItem):
    """System message item.

    Attributes:
        role (Literal[MessageRole.SYSTEM]): Fixed to the system role.
    """

    role: Literal[MessageRole.SYSTEM] = MessageRole.SYSTEM


class DeveloperMessageItem(MessageItem):
    """Developer message item.

    Attributes:
        role (Literal[MessageRole.DEVELOPER]): Fixed to the developer role.
    """

    role: Literal[MessageRole.DEVELOPER] = MessageRole.DEVELOPER


class ReasoningItem(BaseModel):
    """Model reasoning trace (Phase 2).

    Attributes:
        type (Literal["reasoning"]): Item type discriminator.
        id (Optional[str]): Unique identifier for this item.
        status (ItemStatus): Lifecycle status of the reasoning item.
        content (Optional[str]): Plain-text reasoning content.
        encrypted_content (Optional[str]): Encrypted reasoning payload.
        summary (Optional[str]): Short summary of the reasoning.
    """

    type: Literal["reasoning"] = "reasoning"
    id: Optional[str] = None
    status: ItemStatus = ItemStatus.COMPLETED
    content: Optional[str] = None
    encrypted_content: Optional[str] = None
    summary: Optional[str] = None


class ItemReferenceItem(BaseModel):
    """Reference to a prior output item (Phase 2).

    Attributes:
        type (Literal["item_reference"]): Item type discriminator.
        id (Optional[str]): Unique identifier for this reference.
        item_id (str): ID of the referenced item.
    """

    type: Literal["item_reference"] = "item_reference"
    id: Optional[str] = None
    item_id: str = Field(description="ID of the referenced item")


class FunctionToolCall(BaseModel):
    """A function-type tool call emitted by the model.

    Attributes:
        type (Literal["function_call"]): Item type discriminator.
        id (Optional[str]): Unique identifier for this item.
        call_id (Optional[str]): Correlation ID for matching results.
        name (str): Name of the function to invoke.
        arguments (str): JSON-encoded arguments for the function.
        status (ItemStatus): Lifecycle status of the tool call.
        usage (Optional[Usage]): Token usage for this LLM call.
    """

    type: Literal["function_call"] = "function_call"
    id: Optional[str] = None
    call_id: Optional[str] = None
    name: str
    arguments: str
    status: ItemStatus = ItemStatus.COMPLETED
    usage: Optional["Usage"] = None
    display_name: str


class FunctionToolResult(BaseModel):
    """A tool result sent back by the client after executing a tool call.

    Attributes:
        type (Literal["function_call_output"]): Item type discriminator.
        id (Optional[str]): Unique identifier for this item.
        call_id (str): Correlation ID matching the originating tool call.
        output (str): Serialized result of the tool execution.
        status (ItemStatus): Lifecycle status of the tool result.
    """

    type: Literal["function_call_output"] = "function_call_output"
    id: Optional[str] = None
    call_id: str
    output: str
    status: ItemStatus = ItemStatus.COMPLETED


class FunctionDefinition(BaseModel):
    """Function definition within a tool.

    Attributes:
        name (str): Function name the model can reference.
        description (Optional[str]): Human-readable description of the
            function's purpose.
        parameters (Optional[Dict[str, Any]]): JSON Schema describing
            accepted parameters.
    """

    name: str
    description: Optional[str] = None
    parameters: Optional[Dict[str, Any]] = None


class ToolMeta(BaseModel):
    """Optional metadata classifying a tool for server-side behaviour.

    Clients send this alongside each tool definition so that the agent
    can dynamically classify tools without hard-coding tool names.

    Attributes:
        snapshot (bool): Tool returns a point-in-time snapshot that
            becomes stale when newer output arrives (e.g. DOM content).
        mutating (bool): Tool performs a state-changing action.
        read_only (bool): Tool is purely observational.
        poll (bool): Tool is a polling/wait tool (loop detection).
    """

    snapshot: bool = False
    mutating: bool = False
    read_only: bool = False
    poll: bool = False


class ToolDefinition(BaseModel):
    """Definition of a tool the model can use.

    Accepts both nested and flat formats:
      - Nested (OpenAI): ``{ "type": "function", "function": { "name": ... } }``
      - Flat (legacy):   ``{ "type": "function", "name": ..., "parameters": ... }``

    Attributes:
        type (Literal["function"]): Tool type discriminator.
        function (FunctionDefinition): The function specification.
        guide (Optional[str]): System prompt guide text provided by the
            client. Included in the system prompt but excluded from the
            LLM tool schema.
        tool_meta (Optional[ToolMeta]): Classification metadata for
            server-side behaviour (stale invalidation, mutation tracking,
            loop detection).
    """

    type: Literal["function"] = "function"
    function: FunctionDefinition
    guide: Optional[str] = None
    display_name: str
    tool_meta: Optional[ToolMeta] = None

    @model_validator(mode="before")
    @classmethod
    def _normalize_flat_format(cls, values: Any) -> Any:
        """Convert flat tool format to nested ``function`` wrapper."""
        if isinstance(values, dict) and "function" not in values and "name" in values:
            values = {
                "type": values.get("type", "function"),
                "function": {
                    "name": values["name"],
                    "description": values.get("description"),
                    "parameters": values.get("parameters"),
                },
                "guide": values.get("guide"),
                "display_name": values.get("display_name"),
                "tool_meta": values.get("tool_meta"),
            }
        return values

    @property
    def name(self) -> str:
        """Shortcut for ``self.function.name``."""
        return self.function.name


MessageItemUnion = Union[
    UserMessageItem, AssistantMessageItem, SystemMessageItem, DeveloperMessageItem
]

# NOTE: MessageRole.TOOL is intentionally absent — tool messages are
# serialized as FunctionToolResult paired with their FunctionToolCall.
ROLE_TO_MESSAGE_CLASS = {
    MessageRole.USER: UserMessageItem,
    MessageRole.ASSISTANT: AssistantMessageItem,
    MessageRole.SYSTEM: SystemMessageItem,
    MessageRole.DEVELOPER: DeveloperMessageItem,
}

InputItem = Union[
    UserMessageItem,
    AssistantMessageItem,
    SystemMessageItem,
    DeveloperMessageItem,
    FunctionToolCall,
    FunctionToolResult,
    ReasoningItem,
    ItemReferenceItem,
]

OutputItem = Union[AssistantMessageItem, FunctionToolCall, FunctionToolResult, ReasoningItem]


class SkillSnapshotItem(BaseModel):
    """Single skill entry in the client-provided skill catalog.

    Attributes:
        name (str): Short skill identifier (e.g. ``coding``, ``docx``).
        description (str): One-line human-readable description.
        location (str): Absolute path to the SKILL.md file the model
            can ``read`` on demand.
        tools (List[str]): Tool names belonging to this skill.
        body (Optional[str]): SKILL.md content (workflow prompt).
            When provided, the skill is registered to the Platform DB
            so the server can fetch the body without reading from disk.
    """

    name: str
    description: str
    location: str
    tools: List[str] = Field(default_factory=list)
    body: Optional[str] = None


class SkillsSnapshot(BaseModel):
    """Client-provided skill catalog for the OpenClaw lazy-read pattern.

    Attributes:
        version (Optional[str]): Cache / change-tracking token.
        prompt (str): Pre-built ``<available_skills>`` block for the
            system prompt.
        skills (List[SkillSnapshotItem]): Individual skill entries.
    """

    version: Optional[str] = None
    prompt: str
    skills: List[SkillSnapshotItem] = Field(default_factory=list)

    @classmethod
    def extract_prompt(cls, snapshot: Optional["SkillsSnapshot"]) -> Optional[str]:
        """Extract the skills prompt from a snapshot, or None."""
        if snapshot and snapshot.prompt:
            return snapshot.prompt
        return None


class ResponseRequest(BaseModel):
    """Request to generate a response.

    Attributes:
        model (str): Model identifier to use for generation.
        input (Union[str, List[InputItem]]): Context provided as a plain
            string or an array of input items.
        tools (Optional[List[ToolDefinition]]): Tools available to the model.
        previous_response_id (Optional[str]): Reference to a prior response
            for multi-turn conversations.
        instructions (Optional[str]): Additional guidance for the model.
        temperature (Optional[float]): Sampling randomness (0 to 2).
        max_output_tokens (Optional[int]): Maximum tokens to generate.
        stream (bool): Whether to enable streaming output.
        metadata (Optional[Dict[str, str]]): Custom metadata key-value pairs
            (maximum 16 pairs).
    """

    model: str = Field(default="default", description="Model identifier")
    input: Union[str, List[InputItem]] = Field(description="Context as string or array of items")
    tools: Optional[List[ToolDefinition]] = Field(
        default=None, description="Tools available to the model"
    )
    previous_response_id: Optional[str] = Field(default=None, description="Reference to prior turn")
    instructions: Optional[str] = Field(default=None, description="Additional guidance")
    temperature: Optional[float] = Field(
        default=None, ge=0, le=2, description="Sampling randomness"
    )
    max_output_tokens: Optional[int] = Field(default=None, gt=0, description="Generation limit")
    stream: bool = Field(default=False, description="Enable streaming")
    metadata: Optional[Dict[str, str]] = Field(
        default=None, description="Custom metadata (max 16 pairs)"
    )
    tool_choice: Optional[Union[Literal["auto", "required", "none"], Dict[str, Any]]] = Field(
        default=None, description="Tool selection strategy"
    )
    truncation: Optional[Literal["auto", "disabled"]] = Field(
        default=None, description="Context truncation strategy"
    )
    skills_snapshot: Optional[SkillsSnapshot] = Field(
        default=None, description="Client skill catalog"
    )


class InputTokenDetails(BaseModel):
    """Breakdown of input token usage.

    Attributes:
        cached_tokens (int): Tokens served from prompt cache.
    """

    cached_tokens: int = Field(default=0, description="Tokens served from cache")


class OutputTokenDetails(BaseModel):
    """Breakdown of output token usage.

    Attributes:
        reasoning_tokens (int): Tokens used for reasoning.
    """

    reasoning_tokens: int = Field(default=0, description="Tokens used for reasoning")


class Usage(BaseModel):
    """Token usage statistics.

    Attributes:
        input_tokens (int): Number of tokens in the input.
        output_tokens (int): Number of tokens in the output.
        total_tokens (int): Total tokens consumed.
        input_tokens_details (InputTokenDetails): Breakdown of input tokens.
        output_tokens_details (OutputTokenDetails): Breakdown of output tokens.
    """

    input_tokens: int = Field(description="Tokens in input")
    output_tokens: int = Field(description="Tokens in output")
    total_tokens: int = Field(description="Total tokens used")
    input_tokens_details: InputTokenDetails = Field(description="Input token breakdown")
    output_tokens_details: OutputTokenDetails = Field(description="Output token breakdown")

    @classmethod
    def zero(cls) -> "Usage":
        """Return a zeroed-out Usage instance."""
        return cls(
            input_tokens=0,
            output_tokens=0,
            total_tokens=0,
            input_tokens_details=InputTokenDetails(),
            output_tokens_details=OutputTokenDetails(),
        )

    def add(self, other: "Usage") -> "Usage":
        """Return a new Usage that is the sum of *self* and *other*."""
        return Usage(
            input_tokens=self.input_tokens + other.input_tokens,
            output_tokens=self.output_tokens + other.output_tokens,
            total_tokens=self.total_tokens + other.total_tokens,
            input_tokens_details=InputTokenDetails(
                cached_tokens=(
                    self.input_tokens_details.cached_tokens
                    + other.input_tokens_details.cached_tokens
                ),
            ),
            output_tokens_details=OutputTokenDetails(
                reasoning_tokens=(
                    self.output_tokens_details.reasoning_tokens
                    + other.output_tokens_details.reasoning_tokens
                ),
            ),
        )


class ResponseObject(BaseModel):
    """Response from the model.

    Attributes:
        id (str): Unique response identifier.
        object (Literal["response"]): Object type discriminator.
        created_at (int): Unix timestamp of creation.
        completed_at (Optional[int]): Unix timestamp of completion.
        model (str): Model used for generation.
        status (ItemStatus): Completion state of the response.
        output (List[OutputItem]): Generated output items.
        usage (Usage): Token usage statistics.
        error (Optional[ErrorObject]): Structured error information,
            if the response failed.
        metadata (Optional[Dict[str, Any]]): Custom metadata.
    """

    id: str = Field(description="Unique response identifier")
    object: Literal["response"] = "response"
    created_at: int = Field(description="Unix timestamp of creation")
    completed_at: Optional[int] = Field(default=None, description="Unix timestamp of completion")
    model: str = Field(description="Model used")
    status: ResponseStatus = Field(description="Completion state")
    output: List[OutputItem] = Field(description="Generated items")
    usage: Usage = Field(description="Token statistics")
    error: Optional["ErrorObject"] = Field(default=None, description="Structured error information")
    metadata: Optional[Dict[str, Any]] = Field(default=None, description="Custom metadata")


class ErrorType(str, Enum):
    """Error category enumeration.

    Attributes:
        INVALID_REQUEST (str): Invalid or malformed request.
        NOT_FOUND (str): Requested resource was not found.
        MODEL_ERROR (str): Model encountered an error during generation.
        TOO_MANY_REQUESTS (str): Rate limit exceeded.
        SERVER_ERROR (str): Internal server error.
    """

    INVALID_REQUEST = "invalid_request_error"
    NOT_FOUND = "not_found"
    MODEL_ERROR = "model_error"
    TOO_MANY_REQUESTS = "too_many_requests"
    SERVER_ERROR = "server_error"


class ErrorObject(BaseModel):
    """Structured error response.

    Attributes:
        type (ErrorType): Error category identifier.
        code (Optional[str]): Detailed error code.
        param (Optional[str]): Name of the related parameter, if any.
        message (str): Human-readable error explanation.
    """

    type: ErrorType = Field(description="Error category")
    code: Optional[str] = Field(default=None, description="Detailed error code")
    param: Optional[str] = Field(default=None, description="Related parameter")
    message: str = Field(description="Human-readable explanation")


ResponseObject.model_rebuild()
AssistantMessageItem.model_rebuild()
FunctionToolCall.model_rebuild()
