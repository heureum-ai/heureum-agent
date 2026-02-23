# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Client implementations for message-domain persistence."""

from __future__ import annotations

from typing import Optional

import httpx

from app.services.messages.base import (
    MessageControllerBase,
    MessageHistoryClient,
    MessageStoreClient,
)
from app.services.messages.normalize import MessageNormalizeController
from app.services.messages.types import PlatformMessageRecord
from langchain_core.messages import BaseMessage


class PlatformSessionFileClient(MessageStoreClient):
    """Platform session-files API client."""

    component_name = "messages.clients.session_files"

    def __init__(
        self,
        platform_api_url: str,
        timeout_seconds: float = 10.0,
        http_client: Optional[httpx.AsyncClient] = None,
    ) -> None:
        self._base_url = platform_api_url.rstrip("/")
        self._http = http_client or httpx.AsyncClient(timeout=timeout_seconds)
        self._owns_http = http_client is None

    def _files_url(self, session_id: str) -> str:
        return f"{self._base_url}/api/v1/sessions/{session_id}/files"

    async def write_text(
        self,
        *,
        session_id: str,
        path: str,
        content: str,
        created_by: str = "agent",
    ) -> None:
        resp = await self._http.post(
            f"{self._files_url(session_id)}/write/",
            json={
                "path": path,
                "content": content,
                "created_by": created_by,
            },
        )
        if resp.status_code not in (200, 201):
            raise RuntimeError(
                f"Failed to write session file ({session_id}:{path}) [{resp.status_code}]"
            )

    async def read_text(
        self,
        *,
        session_id: str,
        path: str,
    ) -> Optional[str]:
        resp = await self._http.get(
            f"{self._files_url(session_id)}/read/",
            params={"path": path},
        )
        if resp.status_code == 404:
            return None
        if resp.status_code != 200:
            raise RuntimeError(
                f"Failed to read session file ({session_id}:{path}) [{resp.status_code}]"
            )
        data = resp.json()
        return data.get("content", "")

    async def aclose(self) -> None:
        if self._owns_http:
            await self._http.aclose()


class PlatformMessageHistoryClient(MessageHistoryClient):
    """Platform messages API client for session rehydration."""

    component_name = "messages.clients.history"

    def __init__(
        self,
        platform_api_url: str,
        timeout_seconds: float = 10.0,
        http_client: Optional[httpx.AsyncClient] = None,
        normalizer: MessageNormalizeController | None = None,
    ) -> None:
        self._base_url = platform_api_url.rstrip("/")
        self._http = http_client or httpx.AsyncClient(timeout=timeout_seconds)
        self._owns_http = http_client is None
        self._normalizer = normalizer or MessageNormalizeController()

    async def list_messages(
        self,
        *,
        session_id: str,
        ordering: str = "created_at",
    ) -> list[PlatformMessageRecord]:
        resp = await self._http.get(
            f"{self._base_url}/api/v1/messages/",
            params={"session_id": session_id, "ordering": ordering},
        )
        if resp.status_code == 404:
            return []
        if resp.status_code != 200:
            raise RuntimeError(f"Failed to list messages ({session_id}) [{resp.status_code}]")
        return self._normalizer.normalize_list_messages_payload(resp.json())

    async def aclose(self) -> None:
        if self._owns_http:
            await self._http.aclose()


class MessageRehydrationController(MessageControllerBase):
    """Session history rehydration controller."""

    component_name = "messages.clients.rehydration"

    def __init__(self, normalizer: MessageNormalizeController) -> None:
        self._normalize = normalizer

    async def rehydrate_session(
        self,
        *,
        client: MessageHistoryClient,
        session_id: str,
        ordering: str = "created_at",
    ) -> list[BaseMessage] | None:
        """Load and convert session history from Platform API records."""
        try:
            records = await client.list_messages(session_id=session_id, ordering=ordering)
        except Exception:
            return None
        if not records:
            return None
        messages = self._normalize.platform_records_to_lc_messages(records)
        return messages or None
