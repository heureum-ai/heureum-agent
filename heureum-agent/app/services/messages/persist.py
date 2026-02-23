# Copyright (c) 2026 Heureum AI. All rights reserved.

"""Best-effort message persistence to Platform DB.

Used by both the main agent loop and sub-agents.
All methods are fire-and-forget: failures never block agent execution.

Sub-agent operations use per-session queues to guarantee ordering
(run_start before messages before run_complete) without blocking callers.
"""

import asyncio
import logging
from typing import Any, Dict, Optional

import httpx

logger = logging.getLogger(__name__)


class PersistController:
    """Best-effort message persistence to Platform DB.

    Main loop and sub-agent both share this controller.
    All methods are fire-and-forget: failure never blocks agent execution.

    Sub-agent persist uses per-session FIFO queues so that ``run_start``
    always completes before any ``message`` or ``run_complete`` is sent.
    """

    TIMEOUT = 3.0
    CONTENT_MAX = 50_000
    _WORKER_IDLE_TIMEOUT = 60.0

    def __init__(self, platform_api_url: str) -> None:
        self._base = f"{platform_api_url}/api/v1"
        self._client = httpx.AsyncClient(
            limits=httpx.Limits(
                max_connections=20,
                max_keepalive_connections=5,
                keepalive_expiry=30,
            ),
            timeout=httpx.Timeout(self.TIMEOUT, connect=2.0),
        )
        self._queues: Dict[str, asyncio.Queue] = {}
        self._workers: Dict[str, asyncio.Task] = {}

    async def close(self) -> None:
        """Close the shared HTTP client and shut down all workers."""
        for q in self._queues.values():
            q.put_nowait(None)
        for task in self._workers.values():
            if not task.done():
                task.cancel()
        self._queues.clear()
        self._workers.clear()
        await self._client.aclose()

    def _truncate(self, text: str) -> str:
        """Truncate text to CONTENT_MAX characters."""
        if not isinstance(text, str):
            return ""
        if len(text) > self.CONTENT_MAX:
            return text[: self.CONTENT_MAX]
        return text

    # -------------------------------------------------------------------
    # Per-session ordered queue
    # -------------------------------------------------------------------

    def _ensure_worker(self, session_id: str) -> asyncio.Queue:
        q = self._queues.get(session_id)
        if q is None:
            q = asyncio.Queue()
            self._queues[session_id] = q
            self._workers[session_id] = asyncio.create_task(self._drain_queue(session_id, q))
        elif session_id in self._workers and self._workers[session_id].done():
            self._workers[session_id] = asyncio.create_task(self._drain_queue(session_id, q))
        return q

    async def _drain_queue(self, session_id: str, q: asyncio.Queue) -> None:
        while True:
            try:
                coro = await asyncio.wait_for(q.get(), timeout=self._WORKER_IDLE_TIMEOUT)
            except asyncio.TimeoutError:
                self._queues.pop(session_id, None)
                self._workers.pop(session_id, None)
                return
            if coro is None:
                self._queues.pop(session_id, None)
                self._workers.pop(session_id, None)
                return
            try:
                await coro
            except Exception as e:
                logger.debug("Persist failed (best-effort): %s", e)

    # -------------------------------------------------------------------
    # Sub-agent persist — public (enqueue)
    # -------------------------------------------------------------------

    async def subagent_run_start(
        self,
        record: Any,
        root_session_id: str,
        system_prompt: str = "",
    ) -> None:
        """Enqueue run-start POST."""
        q = self._ensure_worker(record.child_session_id)
        q.put_nowait(self._post_run_start(record, root_session_id, system_prompt))

    async def subagent_message(
        self,
        record: Any,
        seq: int,
        role: str,
        content: str,
        tool_call_id: str = "",
        tool_name: str = "",
        metadata: Optional[Dict[str, Any]] = None,
    ) -> None:
        """Enqueue message POST."""
        q = self._ensure_worker(record.child_session_id)
        q.put_nowait(
            self._post_message(record, seq, role, content, tool_call_id, tool_name, metadata)
        )

    async def subagent_run_complete(
        self,
        record: Any,
        status: str,
        result_summary: str,
    ) -> None:
        """Enqueue run-complete PATCH, then signal worker to exit."""
        q = self._ensure_worker(record.child_session_id)
        q.put_nowait(self._post_run_complete(record, status, result_summary))
        q.put_nowait(None)

    # -------------------------------------------------------------------
    # Sub-agent persist — private (actual HTTP)
    # -------------------------------------------------------------------

    async def _post_run_start(
        self,
        record: Any,
        root_session_id: str,
        system_prompt: str,
    ) -> None:
        await self._client.post(
            f"{self._base}/subagents/internal/runs/",
            json={
                "child_session_id": record.child_session_id,
                "root_session_id": root_session_id,
                "parent_session_id": record.parent_session_id,
                "task": self._truncate(record.task),
                "system_prompt": self._truncate(system_prompt),
                "started_at": record.started_at,
            },
            timeout=self.TIMEOUT,
        )

    async def _post_message(
        self,
        record: Any,
        seq: int,
        role: str,
        content: str,
        tool_call_id: str,
        tool_name: str,
        metadata: Optional[Dict[str, Any]],
    ) -> None:
        await self._client.post(
            f"{self._base}/subagents/internal/runs/{record.child_session_id}/messages/",
            json={
                "seq": seq,
                "role": role,
                "content": self._truncate(content),
                "tool_call_id": tool_call_id,
                "tool_name": tool_name,
                "metadata": metadata or {},
            },
            timeout=self.TIMEOUT,
        )

    async def _post_run_complete(
        self,
        record: Any,
        status: str,
        result_summary: str,
    ) -> None:
        import time

        await self._client.patch(
            f"{self._base}/subagents/internal/runs/{record.child_session_id}/complete/",
            json={
                "status": status,
                "result_summary": self._truncate(result_summary),
                "completed_at": time.time(),
            },
            timeout=self.TIMEOUT,
        )

    # -------------------------------------------------------------------
    # Main loop persist (Track C)
    # -------------------------------------------------------------------

    async def save_message(
        self,
        session_id: str,
        response_id: Optional[int],
        seq: int,
        msg_type: str,
        role: str,
        content: Any,
        **kwargs: Any,
    ) -> None:
        """POST single message to Platform internal API. Best-effort."""
        if not response_id:
            return
        try:
            payload: Dict[str, Any] = {
                "session_id": session_id,
                "response_id": response_id,
                "seq": seq,
                "type": msg_type,
                "role": role,
                "content": self._truncate(content) if isinstance(content, str) else content,
            }
            payload.update(kwargs)
            await self._client.post(
                f"{self._base}/messages/internal/save/",
                json=payload,
                timeout=self.TIMEOUT,
            )
        except Exception as e:
            logger.debug("Message save failed (best-effort): %s", e)

    async def complete_response(
        self,
        response_id: Optional[int],
        status: str,
        usage: Optional[Dict[str, Any]] = None,
        model: str = "",
    ) -> None:
        """PATCH Response status to Platform. Best-effort."""
        if not response_id:
            return
        try:
            payload: Dict[str, Any] = {"status": status}
            if usage:
                payload["input_tokens"] = usage.get("input_tokens", 0)
                payload["output_tokens"] = usage.get("output_tokens", 0)
            if model:
                payload["model"] = model
            await self._client.patch(
                f"{self._base}/messages/internal/response/{response_id}/complete/",
                json=payload,
                timeout=self.TIMEOUT,
            )
        except Exception as e:
            logger.debug("Response complete failed (best-effort): %s", e)

    async def save_tool_history(
        self,
        session_id: str,
        response_id: Optional[int],
        items: list,
    ) -> None:
        """POST tool_history bulk to Platform. Best-effort."""
        if not response_id or not items:
            return
        try:
            await self._client.post(
                f"{self._base}/messages/internal/tool-history/",
                json={
                    "session_id": session_id,
                    "response_id": response_id,
                    "items": items,
                },
                timeout=self.TIMEOUT,
            )
        except Exception as e:
            logger.debug("Tool history save failed (best-effort): %s", e)
