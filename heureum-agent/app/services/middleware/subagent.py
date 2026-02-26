# Copyright (c) 2026 Heureum AI. All rights reserved.

"""SubagentSpawnMiddleware — activate_skill dedup + skill count limit."""

from app.services.middleware.types import (
    BeforeResult,
    Middleware,
    MiddlewareEvent,
    SubagentSpawnEvent,
)


class SubagentSpawnMiddleware(Middleware):
    """Prevent duplicate activate_skill calls and enforce skill count limits."""

    def __init__(self, max_skills: int = 2) -> None:
        self._max_skills = max_skills
        self._activated: dict[str, str] = {}  # session_id → child_session_id

    async def before(self, event: MiddlewareEvent) -> BeforeResult:
        if not isinstance(event, SubagentSpawnEvent):
            return BeforeResult()

        sid = event.parent_session_id

        # 1. activate_skill dedup (only when flagged as activate_skill call)
        if event.context.extras.get("is_activate_skill") and sid in self._activated:
            return BeforeResult(blocked=True, reason="already_active")

        # 2. Skill count limit
        if len(event.child_skills) > self._max_skills:
            return BeforeResult(
                blocked=True,
                reason=f"max {self._max_skills} skills per sub-agent",
            )

        return BeforeResult()

    async def after(self, event: MiddlewareEvent) -> None:
        if isinstance(event, SubagentSpawnEvent) and event.result_status == "accepted":
            if event.context.extras.get("is_activate_skill"):
                self._activated[event.parent_session_id] = "active"

    def clear_session(self, session_id: str) -> None:
        self._activated.pop(session_id, None)
