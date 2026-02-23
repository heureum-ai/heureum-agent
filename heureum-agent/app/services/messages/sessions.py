# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Session state controller for message-domain runtime data."""

from __future__ import annotations

import asyncio
import time
from langchain_core.messages import BaseMessage

from app.services.messages.base import MessageControllerBase


class SessionStateController(MessageControllerBase):
    """Manage in-memory session histories, locks, and last-access metadata."""

    component_name = "messages.sessions"

    def __init__(self) -> None:
        self.sessions: dict[str, list[BaseMessage]] = {}
        self.locks: dict[str, asyncio.Lock] = {}
        self.last_access: dict[str, float] = {}

    def has_session(self, session_id: str) -> bool:
        return session_id in self.sessions

    def get_session(self, session_id: str) -> list[BaseMessage] | None:
        return self.sessions.get(session_id)

    def set_session(self, session_id: str, history: list[BaseMessage]) -> None:
        self.sessions[session_id] = history
        self.touch_session(session_id)

    def ensure_session(self, session_id: str) -> list[BaseMessage]:
        history = self.sessions.setdefault(session_id, [])
        self.touch_session(session_id)
        return history

    def touch_session(self, session_id: str, ts: float | None = None) -> None:
        self.last_access[session_id] = ts if ts is not None else time.time()

    def remove_session(self, session_id: str) -> None:
        self.sessions.pop(session_id, None)
        self.locks.pop(session_id, None)
        self.last_access.pop(session_id, None)

    def get_session_lock(self, session_id: str) -> asyncio.Lock:
        return self.locks.setdefault(session_id, asyncio.Lock())

    def is_session_locked(self, session_id: str) -> bool:
        lock = self.locks.get(session_id)
        return lock is not None and lock.locked()

    def cleanup_stale_sessions(
        self,
        *,
        ttl_seconds: int,
        max_sessions: int,
        now: float | None = None,
    ) -> tuple[int, int]:
        """Cleanup expired and overflow sessions.

        Returns:
            tuple[int, int]: (expired_count, overflow_evicted_count)
        """
        now_ts = now if now is not None else time.time()

        expired = [
            sid
            for sid, ts in self.last_access.items()
            if now_ts - ts > ttl_seconds and not self.is_session_locked(sid)
        ]
        for sid in expired:
            self.remove_session(sid)

        overflow_evicted = 0
        if len(self.sessions) > max_sessions:
            evictable = [
                (sid, ts) for sid, ts in self.last_access.items() if not self.is_session_locked(sid)
            ]
            evictable.sort(key=lambda item: item[1])
            to_evict = len(self.sessions) - max_sessions
            for sid, _ in evictable[:to_evict]:
                self.remove_session(sid)
                overflow_evicted += 1

        return len(expired), overflow_evicted
