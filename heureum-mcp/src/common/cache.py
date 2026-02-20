# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Simple TTL cache using stdlib dict + time.monotonic.

No external dependencies required.
"""

from __future__ import annotations

import copy
import hashlib
import time
from typing import Any, Optional


class TTLCache:
    """In-memory cache with TTL expiration and max-size eviction (FIFO)."""

    def __init__(self, ttl: float = 900.0, max_size: int = 100) -> None:
        """Initialize the TTL cache.

        Args:
            ttl (float): Time-to-live in seconds for each cached entry.
            max_size (int): Maximum number of entries before FIFO eviction.
        """
        self._ttl = ttl
        self._max_size = max_size
        self._store: dict[str, tuple[Any, float]] = {}

    def get(self, key: str) -> Optional[Any]:
        """Return a shallow copy of cached value if present and not expired, else None.

        Args:
            key (str): The cache key to look up.

        Returns:
            Optional[Any]: A shallow copy of the cached value, or None if the
                key is missing or expired.
        """
        entry = self._store.get(key)
        if entry is None:
            return None
        value, expire_time = entry
        if time.monotonic() > expire_time:
            del self._store[key]
            return None
        # Shallow copy to prevent mutation of cached data
        if isinstance(value, dict):
            return copy.copy(value)
        if isinstance(value, list):
            return copy.copy(value)
        return value

    def set(self, key: str, value: Any) -> None:
        """Store a value with TTL. Evicts oldest entries if over max_size.

        Args:
            key (str): The cache key under which to store the value.
            value (Any): The value to cache.
        """
        self._evict_expired()
        while len(self._store) >= self._max_size:
            oldest_key = next(iter(self._store))
            del self._store[oldest_key]
        self._store[key] = (value, time.monotonic() + self._ttl)

    def clear(self) -> None:
        """Clear all cached entries."""
        self._store.clear()

    def _evict_expired(self) -> None:
        """Remove all expired entries."""
        now = time.monotonic()
        expired = [k for k, (_, exp) in self._store.items() if now > exp]
        for k in expired:
            del self._store[k]


def make_cache_key(*parts: str) -> str:
    """Create a deterministic cache key from parts.

    Args:
        *parts (str): Variable number of string components to combine
            into a single cache key.

    Returns:
        str: A SHA-256 hex digest of the colon-joined parts.
    """
    raw = ":".join(str(p) for p in parts)
    return hashlib.sha256(raw.encode()).hexdigest()


def _create_caches() -> tuple[TTLCache, TTLCache, TTLCache]:
    """Create cache instances using configured settings (lazy import to avoid circular deps)."""
    from src.config import settings

    return (
        TTLCache(ttl=settings.CACHE_TTL, max_size=settings.CACHE_MAX_SIZE),
        TTLCache(ttl=settings.CACHE_TTL, max_size=settings.CACHE_MAX_SIZE),
        TTLCache(ttl=settings.CACHE_TTL, max_size=settings.CACHE_MAX_SIZE),
    )


search_cache, fetch_cache, raw_content_cache = _create_caches()
