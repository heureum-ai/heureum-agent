# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Text extraction helpers for MCP results."""

from typing import Any


def extract_text_content(result: Any, empty_output_text: str) -> str:
    """Extract text parts from MCP ``CallToolResult`` content."""
    parts = []
    for content in result.content:
        if hasattr(content, "text"):
            parts.append(content.text)
    return "\n".join(parts) if parts else empty_output_text
