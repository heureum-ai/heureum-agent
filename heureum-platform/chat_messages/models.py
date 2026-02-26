# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Message models for storing conversation data using Open Responses specification."""
from django.conf import settings
from django.db import models
from django.utils import timezone
import uuid


class Response(models.Model):
    """Model for storing Open Responses response objects."""

    STATUS_CHOICES = [
        ("in_progress", "In Progress"),
        ("incomplete", "Incomplete"),
        ("completed", "Completed"),
        ("failed", "Failed"),
    ]

    # Open Responses fields
    id = models.CharField(max_length=255, primary_key=True, editable=False)
    session_id = models.CharField(max_length=255, db_index=True)
    model = models.CharField(max_length=100, default="default")
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default="completed")

    # Timestamps
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    completed_at = models.DateTimeField(null=True, blank=True)

    # Usage stats
    input_tokens = models.IntegerField(default=0)
    output_tokens = models.IntegerField(default=0)
    total_tokens = models.IntegerField(default=0)
    cached_tokens = models.IntegerField(default=0)

    # Pricing
    input_cost = models.DecimalField(max_digits=12, decimal_places=6, default=0)
    output_cost = models.DecimalField(max_digits=12, decimal_places=6, default=0)
    total_cost = models.DecimalField(max_digits=12, decimal_places=6, default=0)

    # Metadata
    metadata = models.JSONField(default=dict, blank=True)

    # Reference to previous response for conversation continuity
    previous_response_id = models.CharField(max_length=255, null=True, blank=True, db_index=True)

    class Meta:
        """Meta options for Response model."""
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["session_id", "-created_at"]),
            models.Index(fields=["previous_response_id"]),
        ]

    def save(self, *args, **kwargs):
        """Override save to generate ID if not provided."""
        if not self.id:
            self.id = f"resp_{uuid.uuid4().hex}"
        super().save(*args, **kwargs)

    def __str__(self) -> str:
        """String representation of the response."""
        return f"Response {self.id} ({self.status})"


class Message(models.Model):
    """Model for storing Open Responses message items."""

    ROLE_CHOICES = [
        ("user", "User"),
        ("assistant", "Assistant"),
        ("system", "System"),
        ("developer", "Developer"),
        ("tool", "Tool"),
    ]

    STATUS_CHOICES = [
        ("in_progress", "In Progress"),
        ("incomplete", "Incomplete"),
        ("completed", "Completed"),
        ("failed", "Failed"),
    ]

    # Open Responses item fields
    id = models.CharField(max_length=255, primary_key=True, editable=False)
    type = models.CharField(max_length=50, default="message")
    role = models.CharField(max_length=20, choices=ROLE_CHOICES)
    status = models.CharField(max_length=20, choices=STATUS_CHOICES, default="completed")

    # Sequence number for idempotent real-time persist (null for proxy-created)
    seq = models.PositiveIntegerField(null=True, blank=True)

    # Content stored as JSON array of content parts
    content = models.JSONField(default=list)

    # Relationship to response
    response = models.ForeignKey(
        Response,
        on_delete=models.CASCADE,
        related_name="output_items",
        null=True,
        blank=True
    )

    # For backward compatibility and indexing
    session_id = models.CharField(max_length=255, db_index=True)
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    # Usage stats (per-message)
    model = models.CharField(max_length=100, default="", blank=True)
    input_tokens = models.IntegerField(default=0)
    output_tokens = models.IntegerField(default=0)
    total_tokens = models.IntegerField(default=0)
    input_cost = models.DecimalField(max_digits=12, decimal_places=6, default=0)
    output_cost = models.DecimalField(max_digits=12, decimal_places=6, default=0)
    total_cost = models.DecimalField(max_digits=12, decimal_places=6, default=0)

    # Additional metadata
    metadata = models.JSONField(default=dict, blank=True)

    class Meta:
        """Meta options for Message model."""
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["session_id", "-created_at"]),
            models.Index(fields=["response", "-created_at"]),
        ]
        constraints = [
            models.UniqueConstraint(
                fields=["response", "seq"],
                condition=models.Q(seq__isnull=False),
                name="unique_response_seq",
            ),
        ]

    def save(self, *args, **kwargs):
        """Override save to generate ID if not provided."""
        if not self.id:
            self.id = f"msg_{uuid.uuid4().hex}"
        super().save(*args, **kwargs)

    def __str__(self) -> str:
        """String representation of the message."""
        text_content = self.get_text_content()
        preview = text_content[:50] if text_content else "[no text]"
        return f"{self.role}: {preview}..."

    def get_text_content(self) -> str:
        """Extract text from content parts."""
        if not self.content:
            return ""

        text_parts = []
        for part in self.content:
            if isinstance(part, dict) and part.get("type") in ["input_text", "output_text"]:
                text_parts.append(part.get("text", ""))

        return " ".join(text_parts)


class Session(models.Model):
    """Model for storing session-level state."""

    session_id = models.CharField(max_length=255, unique=True, db_index=True)
    user = models.ForeignKey(
        settings.AUTH_USER_MODEL,
        null=True,
        blank=True,
        on_delete=models.CASCADE,
        related_name="sessions",
    )
    title = models.CharField(max_length=200, null=True, blank=True)
    cwd = models.CharField(max_length=1024, null=True, blank=True)
    skills_snapshot = models.JSONField(default=dict, blank=True)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)

    # Aggregate usage
    total_input_tokens = models.IntegerField(default=0)
    total_output_tokens = models.IntegerField(default=0)
    total_tokens = models.IntegerField(default=0)
    total_cost = models.DecimalField(max_digits=12, decimal_places=6, default=0)

    class Meta:
        ordering = ["-updated_at"]

    def __str__(self) -> str:
        title_display = self.title or "(untitled)"
        return f"Session {self.session_id[:8]}... - {title_display}"


class ToolPermission(models.Model):
    """Model for storing persistent tool execution permissions per client."""

    client_id = models.CharField(max_length=255, db_index=True)
    tool_name = models.CharField(max_length=100)
    command = models.CharField(max_length=255)
    allowed = models.BooleanField(default=True)
    created_at = models.DateTimeField(default=timezone.now)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        unique_together = [("client_id", "tool_name", "command")]
        ordering = ["-updated_at"]

    def __str__(self) -> str:
        status = "allowed" if self.allowed else "denied"
        return f"{self.client_id[:8]}... - {self.tool_name}:{self.command} ({status})"


class Question(models.Model):
    """Model for storing reverse questions asked by the LLM to the user."""

    ANSWER_TYPE_CHOICES = [
        ("choice", "Choice"),
        ("user_input", "User Input"),
    ]

    id = models.CharField(max_length=255, primary_key=True, editable=False)
    session_id = models.CharField(max_length=255, db_index=True)
    response = models.ForeignKey(
        Response,
        on_delete=models.CASCADE,
        related_name="questions",
        null=True,
        blank=True,
    )
    call_id = models.CharField(max_length=255, db_index=True)
    question_text = models.TextField()
    choices = models.JSONField(default=list)
    allow_user_input = models.BooleanField(default=False)
    user_answer = models.TextField(null=True, blank=True)
    answer_type = models.CharField(
        max_length=20,
        choices=ANSWER_TYPE_CHOICES,
        null=True,
        blank=True,
    )
    created_at = models.DateTimeField(default=timezone.now, db_index=True)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["-created_at"]
        indexes = [
            models.Index(fields=["session_id", "-created_at"]),
            models.Index(fields=["call_id"]),
        ]

    def save(self, *args, **kwargs):
        if not self.id:
            self.id = f"q_{uuid.uuid4().hex}"
        super().save(*args, **kwargs)

    def __str__(self) -> str:
        answered = "answered" if self.user_answer else "pending"
        return f"Question {self.id}: {self.question_text[:50]}... ({answered})"


class ModelPricing(models.Model):
    """Pricing data for LLM models, sourced from models.dev."""

    model_id = models.CharField(max_length=255, unique=True)  # e.g., "google/gemini-3-flash-preview"
    provider = models.CharField(max_length=100, db_index=True)
    model_name = models.CharField(max_length=200, db_index=True)  # part after "/"
    display_name = models.CharField(max_length=200)
    input_cost_per_mtok = models.DecimalField(max_digits=10, decimal_places=4, default=0)
    output_cost_per_mtok = models.DecimalField(max_digits=10, decimal_places=4, default=0)
    cache_read_cost_per_mtok = models.DecimalField(max_digits=10, decimal_places=4, default=0)
    cache_write_cost_per_mtok = models.DecimalField(max_digits=10, decimal_places=4, default=0)
    raw_data = models.JSONField(default=dict)
    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["provider", "model_name"]

    def __str__(self) -> str:
        return f"{self.model_id} (${self.input_cost_per_mtok}/{self.output_cost_per_mtok} per MTok)"

    # Canonical providers to prefer when multiple providers offer the same model
    CANONICAL_PROVIDERS = ["openai", "anthropic", "google", "meta", "mistral", "deepseek", "xai"]

    @classmethod
    def get_for_model(cls, model_name: str):
        """Find pricing by model_name, preferring canonical providers. Cached 1h."""
        from django.core.cache import cache

        if not model_name:
            return None
        cache_key = f"model_pricing:{model_name}"
        cached = cache.get(cache_key)
        if cached is not None:
            return cached if cached != "__none__" else None

        matches = cls.objects.filter(model_name=model_name)
        if not matches.exists():
            cache.set(cache_key, "__none__", 3600)
            return None
        result = None
        for provider in cls.CANONICAL_PROVIDERS:
            match = matches.filter(provider=provider).first()
            if match:
                result = match
                break
        if result is None:
            result = matches.first()
        cache.set(cache_key, result, 3600)  # 1 hour TTL
        return result


class ToolSchema(models.Model):
    """Global tool schema registry."""

    tool_name = models.CharField(max_length=100, unique=True, db_index=True)
    description = models.TextField(blank=True, default="")
    parameters_schema = models.JSONField(default=dict, blank=True)

    display_name = models.CharField(max_length=100, blank=True, default="")
    guide = models.TextField(blank=True, default="")

    # source × execution_target matrix:
    #   mcp   + server → MCP server tool (e.g. mcp_web__search)
    #   mcp   + client → client MCP tool
    #   tool  + server → server standalone tool
    #   tool  + client → client standalone tool (e.g. web_fetch, read)
    #   skill + server → server skill tool (e.g. tool_approval, manage_todo)
    #   skill + client → client skill tool
    source = models.CharField(max_length=20, default="unknown")
    execution_target = models.CharField(max_length=20, default="server")

    # Tool classification
    is_snapshot = models.BooleanField(default=False)
    is_mutating = models.BooleanField(default=False)
    is_read_only = models.BooleanField(default=False)
    is_poll = models.BooleanField(default=False)
    requires_approval = models.BooleanField(default=False)

    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["tool_name"]

    def __str__(self) -> str:
        return f"{self.tool_name} ({self.source}/{self.execution_target})"

    def to_openai_schema(self) -> dict:
        """Reconstruct OpenAI-format tool schema for LLM binding."""
        return {
            "type": "function",
            "function": {
                "name": self.tool_name,
                "description": self.description,
                "parameters": self.parameters_schema,
            },
        }


class SkillSchema(models.Model):
    """Global skill registry. Stores skill metadata + body separately."""

    skill_name = models.CharField(max_length=100, unique=True, db_index=True)
    description = models.TextField(blank=True, default="")
    tools = models.JSONField(default=list)
    depends_on = models.JSONField(default=list)
    subagent_access = models.CharField(max_length=20, default="always")
    catalog = models.BooleanField(default=True)
    source = models.CharField(max_length=20, default="server")  # "server" or "client"
    body = models.TextField(blank=True, default="")

    updated_at = models.DateTimeField(auto_now=True)

    class Meta:
        ordering = ["skill_name"]

    def __str__(self) -> str:
        return f"{self.skill_name} ({self.source})"


class SuggestedQuestion(models.Model):
    """Recommended questions shown on the new chat page."""

    id = models.CharField(max_length=255, primary_key=True, editable=False)
    question_text = models.TextField()
    order = models.IntegerField(default=0)
    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(default=timezone.now)

    class Meta:
        ordering = ["order", "-created_at"]

    def save(self, *args, **kwargs):
        if not self.id:
            self.id = f"sq_{uuid.uuid4().hex}"
        super().save(*args, **kwargs)

    def __str__(self) -> str:
        return self.question_text[:60]
