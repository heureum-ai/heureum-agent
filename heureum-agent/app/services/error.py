"""LLM error classification.

Centralizes detection of known LLM provider error patterns so that
retry / recovery logic in the agent service can branch cleanly.
"""


class LLMErrorClassifier:
    """Classifies LLM API exceptions into actionable categories.

    Each class method inspects the string representation of an exception
    and returns ``True`` when a known pattern is matched.

    Categories
    ----------
    - **context_overflow** – prompt exceeds the model's context window.
    - **retryable** – transient server / rate-limit errors worth retrying.
    - **thought_signature** – Gemini thinking-model signature validation
      failure (requires context rewriting, not a simple retry).
    """

    # -- patterns --------------------------------------------------------

    _CONTEXT_OVERFLOW_PATTERNS: tuple[str, ...] = (
        "context_length_exceeded",
        "context window",
        "maximum context length",
        "token limit",
        "too many tokens",
        "request too large",
        "content_too_large",
        "max_tokens",
        "string too long",
        "prompt is too long",
        "input too long",
    )

    _RETRYABLE_PATTERNS: tuple[str, ...] = (
        "500",
        "502",
        "503",
        "504",
        "529",
        "rate limit",
        "rate_limit",
        "429",
        "overloaded",
        "temporarily unavailable",
        "internal server error",
        "service unavailable",
        "resource exhausted",
        "resource_exhausted",
        "deadline exceeded",
    )

    # -- public API ------------------------------------------------------

    @staticmethod
    def is_context_overflow(error: Exception) -> bool:
        """Check whether an exception indicates a context window overflow.

        Args:
            error: The exception to inspect.

        Returns:
            True if the error message matches a known overflow pattern.
        """
        msg = str(error).lower()
        return any(s in msg for s in LLMErrorClassifier._CONTEXT_OVERFLOW_PATTERNS)

    @staticmethod
    def is_retryable(error: Exception) -> bool:
        """Check whether an LLM error is transient and worth retrying.

        Covers server errors (5xx), rate limits (429), and other transient
        provider-side availability failures.

        Args:
            error: The exception to inspect.

        Returns:
            True if the error is likely transient.
        """
        msg = str(error).lower()
        return any(s in msg for s in LLMErrorClassifier._RETRYABLE_PATTERNS)

    @staticmethod
    def is_thought_signature(error: Exception) -> bool:
        """Detect Gemini thought-signature validation failures.

        Gemini thinking models include a cryptographic signature in their
        ``thought`` blocks.  Replaying stale AIMessage(tool_calls) +
        ToolMessage sequences can trigger ``"Thought signature is not
        valid"`` — this is *not* a transient error and must not be retried
        with the same payload.

        Args:
            error: The exception to inspect.

        Returns:
            True if the error is a Gemini thought-signature failure.
        """
        msg = str(error).lower()
        return "thought signature" in msg and "not valid" in msg
