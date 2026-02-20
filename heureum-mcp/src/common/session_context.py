# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Session context extraction from MCP request metadata.

When the Agent calls an MCP tool it may attach ``session_id`` and
``platform_api_url`` via the ``_meta`` field.  Server-side tools use
:func:`extract_session_context` to retrieve these values from the
FastMCP :class:`Context` object.

If the metadata is absent (e.g. local / CLI usage), functions return
``None`` so tools can fall back to local-mode behaviour.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)

# Re-use a single httpx pool across all platform clients in the process.
_shared_http_client = None


@dataclass(frozen=True)
class SessionContext:
    """Immutable container for session metadata forwarded from the Agent."""

    session_id: str
    platform_api_url: str
    cwd: str = ""


def extract_session_context(ctx) -> Optional[SessionContext]:
    """Extract session_id and platform_api_url from FastMCP Context.

    The Agent sends these values via ``ClientSession.call_tool(meta=...)``.
    On the server side they appear at ``ctx.request_context.meta``.

    Args:
        ctx: A FastMCP ``Context`` instance (or any object with
            ``request_context.meta``).

    Returns:
        A :class:`SessionContext` if both fields are present, otherwise
        ``None`` (indicating local-mode / no session scope).
    """
    try:
        meta = ctx.request_context.meta
        session_id = getattr(meta, "session_id", None)
        platform_api_url = getattr(meta, "platform_api_url", None)
        cwd = getattr(meta, "cwd", "") or ""
        if session_id and platform_api_url:
            return SessionContext(
                session_id=session_id,
                platform_api_url=platform_api_url,
                cwd=cwd,
            )
    except (AttributeError, ValueError):
        logger.debug("Session context extraction failed (no meta on ctx)", exc_info=True)
    return None


def get_platform_client(session_ctx: SessionContext):
    """Create a :class:`PlatformFileClient` from a :class:`SessionContext`.

    Shares a single ``httpx.AsyncClient`` across all invocations within
    the process to avoid connection-pool churn.

    Args:
        session_ctx: Session context with ``session_id`` and ``platform_api_url``.

    Returns:
        A :class:`PlatformFileClient` instance scoped to the session.
    """
    global _shared_http_client

    import httpx
    from src.tools.filesystem.platform_ops import PlatformFileClient

    if _shared_http_client is None:
        _shared_http_client = httpx.AsyncClient(timeout=30.0)

    return PlatformFileClient(
        platform_api_url=session_ctx.platform_api_url,
        session_id=session_ctx.session_id,
        cwd="/session",
        http_client=_shared_http_client,
    )
