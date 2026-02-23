# Copyright (c) 2026 Heureum AI. All rights reserved.

"""MiddlewareRunner — registration, ordering, and execution of middleware chains."""

from __future__ import annotations

import logging
from typing import List, Optional, Set

from app.services.middleware.types import (
    BeforeResult,
    Domain,
    Middleware,
    MiddlewareEvent,
)

logger = logging.getLogger(__name__)


class MiddlewareBlocked(Exception):
    """Raised when a middleware blocks execution."""

    def __init__(self, reason: str) -> None:
        self.reason = reason
        super().__init__(reason)


class _RegisteredMiddleware:
    """Internal wrapper tracking a middleware and its domain filter."""

    __slots__ = ("middleware", "domains")

    def __init__(self, middleware: Middleware, domains: Optional[Set[Domain]]) -> None:
        self.middleware = middleware
        self.domains = domains  # None = all domains

    def matches(self, event: MiddlewareEvent) -> bool:
        if self.domains is None:
            return True
        return event.domain in self.domains


class MiddlewareRunner:
    """Manages middleware registration and sequential before/after execution."""

    def __init__(self) -> None:
        self._chain: List[_RegisteredMiddleware] = []

    def register(
        self,
        middleware: Middleware,
        *,
        domains: Optional[List[Domain]] = None,
    ) -> None:
        """Register a middleware, optionally scoped to specific domains."""
        domain_set = set(domains) if domains else None
        self._chain.append(_RegisteredMiddleware(middleware, domain_set))

    def unregister(self, middleware: Middleware) -> None:
        """Remove a previously registered middleware."""
        self._chain = [r for r in self._chain if r.middleware is not middleware]

    async def run_before(self, event: MiddlewareEvent) -> BeforeResult:
        """Execute before-hooks in registration order.

        * If any middleware returns ``blocked=True``, execution stops and that
          result is returned immediately.
        * ``modified_args`` are accumulated — last writer wins.
        """
        accumulated_args = None

        for reg in self._chain:
            if not reg.matches(event):
                continue
            try:
                result = await reg.middleware.before(event)
                if result.blocked:
                    return result
                if result.modified_args is not None:
                    if accumulated_args is None:
                        accumulated_args = {}
                    accumulated_args.update(result.modified_args)
            except Exception:
                logger.warning(
                    "Middleware %s.before failed for %s",
                    reg.middleware.name,
                    event.domain.value,
                    exc_info=True,
                )

        return BeforeResult(modified_args=accumulated_args)

    async def run_after(self, event: MiddlewareEvent) -> None:
        """Execute after-hooks in reverse registration order.

        Exceptions are caught and logged (fire-and-forget).
        """
        for reg in reversed(self._chain):
            if not reg.matches(event):
                continue
            try:
                await reg.middleware.after(event)
            except Exception:
                logger.warning(
                    "Middleware %s.after failed for %s",
                    reg.middleware.name,
                    event.domain.value,
                    exc_info=True,
                )
