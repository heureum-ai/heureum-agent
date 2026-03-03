# Copyright (c) 2026 Heureum AI. All rights reserved.

"""ClientToolRelay — relay server for sub-agent client tool execution.

Sub-agents run inside the FastAPI asyncio event loop and have no Electron IPC
channel.  When a sub-agent needs to execute a client tool (bash, read, write,
etc.) it uses this relay:

  1. Sub-agent calls ``relay.request_tool()`` → item placed on session queue,
     asyncio.Event set to wait for result.
  2. Electron subscribes to ``GET /relay/{session_id}`` SSE → reads the item,
     executes the tool locally, then POSTs result to ``POST /relay/result``.
  3. ``relay.submit_result()`` stores result and fires the event.
  4. ``request_tool()`` resumes and returns the result string.

Deadlock-free by design: ``event.wait()`` never blocks the event loop, so the
relay SSE stream (``queue.get()``) and result handler (``event.set()``) always
have an opportunity to run.
"""

import asyncio
import uuid
from dataclasses import dataclass
from typing import Any, Dict, Optional


@dataclass
class PendingCall:
    call_id: str
    tool_name: str
    args: Dict[str, Any]


class ClientToolRelay:
    """Thread-safe (asyncio) relay between sub-agents and Electron client."""

    def __init__(self) -> None:
        self._queues: Dict[str, asyncio.Queue] = {}   # root_session_id → Queue[PendingCall | None]
        self._events: Dict[str, asyncio.Event] = {}   # call_id → Event
        self._results: Dict[str, str] = {}            # call_id → result string

    def get_or_create_queue(self, session_id: str) -> asyncio.Queue:
        """Return (or create) the relay queue for a root session."""
        if session_id not in self._queues:
            self._queues[session_id] = asyncio.Queue()
        return self._queues[session_id]

    async def request_tool(
        self,
        root_session_id: str,
        tool_name: str,
        args: Dict[str, Any],
        timeout: float = 60.0,
    ) -> str:
        """Request client-side tool execution and await the result.

        Places a PendingCall on the session queue (consumed by the Electron
        SSE subscriber) then waits for the corresponding Event to fire.

        Args:
            root_session_id: Root (non-subagent) session ID for the queue.
            tool_name: Name of the client tool to execute.
            args: Tool arguments dict.
            timeout: Seconds before giving up.

        Returns:
            Tool output string, or an error message on timeout/failure.
        """
        call_id = uuid.uuid4().hex
        event = asyncio.Event()
        self._events[call_id] = event
        await self.get_or_create_queue(root_session_id).put(
            PendingCall(call_id=call_id, tool_name=tool_name, args=args)
        )
        try:
            await asyncio.wait_for(event.wait(), timeout=timeout)
            return self._results.pop(call_id, "Error: No result received")
        except asyncio.TimeoutError:
            return f"Error: Tool call '{tool_name}' timed out after {timeout}s"
        finally:
            self._events.pop(call_id, None)

    def submit_result(self, call_id: str, result: str) -> bool:
        """Receive tool execution result from Electron and unblock the waiter.

        Args:
            call_id: ID returned in the SSE relay event.
            result: Tool output string.

        Returns:
            True if the call was found and resolved, False if unknown call_id.
        """
        event = self._events.get(call_id)
        if not event:
            return False
        self._results[call_id] = result
        event.set()
        return True

    def clear_session(self, session_id: str) -> None:
        """Terminate the relay queue for a session (sends sentinel to SSE).

        Called on session cleanup so the Electron SSE subscriber exits cleanly.
        """
        q = self._queues.pop(session_id, None)
        if q:
            q.put_nowait(None)  # sentinel → relay SSE generator exits


# Module-level singleton
relay = ClientToolRelay()
