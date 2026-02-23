# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Base contracts for message-domain services."""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict, Generic, Optional, TypeVar


EventT = TypeVar("EventT")
ResultT = TypeVar("ResultT")


class MessageControllerBase(ABC):
    """Base class for all message-domain controllers/components."""

    component_name: str = "messages"

    def __repr__(self) -> str:
        return f"{self.__class__.__name__}(component_name={self.component_name!r})"


class MessageStoreClient(MessageControllerBase, ABC):
    """Abstract storage client for message-related persistence."""

    @abstractmethod
    async def write_text(
        self,
        *,
        session_id: str,
        path: str,
        content: str,
        created_by: str = "agent",
    ) -> None:
        """Create or overwrite a text file in a session-scoped store."""

    @abstractmethod
    async def read_text(
        self,
        *,
        session_id: str,
        path: str,
    ) -> Optional[str]:
        """Read a text file from a session-scoped store."""

    async def aclose(self) -> None:
        """Optional async cleanup hook."""


class MessageHistoryClient(MessageControllerBase, ABC):
    """Abstract client for platform-stored message history."""

    @abstractmethod
    async def list_messages(
        self,
        *,
        session_id: str,
        ordering: str = "created_at",
    ) -> list[Dict[str, Any]]:
        """Load stored messages for a session."""

    async def aclose(self) -> None:
        """Optional async cleanup hook."""


class MessagePipeline(MessageControllerBase, ABC, Generic[EventT, ResultT]):
    """Abstract pipeline that persists a domain event."""

    @abstractmethod
    async def persist(self, event: EventT) -> ResultT:
        """Persist an event and return a typed result."""
