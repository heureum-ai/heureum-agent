# Copyright (c) 2026 Heureum AI. All rights reserved.

"""
Orphaned tool_result repair.

After compaction drops assistant messages, the corresponding tool_result
messages become orphans — their tool_use_id references a tool_use that no
longer exists in the conversation.  Anthropic's API rejects such messages
with "unexpected tool_use_id" errors.

This module detects and removes orphaned tool_results.

Prerequisites (Message model):
  The current Message(role, content) model lacks tool-calling fields.
  For this module to function, Message needs:

    class Message(BaseModel):
        role: str
        content: str
        tool_call_id: Optional[str] = None   # tool role: ID of the tool_use being responded to
        tool_calls: Optional[List[dict]] = None  # assistant role: list of tool_use blocks with 'id' key

  Until those fields are added, this module is a safe no-op (returns
  messages unchanged).

Reference: OpenClaw repairToolUseResultPairing (compaction.ts:340-358)
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import List

from langchain_core.messages import AIMessage, BaseMessage, ToolMessage

logger = logging.getLogger(__name__)


@dataclass
class RepairReport:
    """Result of a repair pass.

    Attributes:
        messages (List[BaseMessage]): The repaired message list with orphans removed.
        dropped_orphan_count (int): Number of orphaned tool_result messages
            that were dropped during repair.
    """

    messages: List[BaseMessage]
    dropped_orphan_count: int


def repair_tool_use_result_pairing(messages: List[BaseMessage]) -> RepairReport:
    """Remove orphaned tool_result messages whose tool_use was dropped.

    Scans assistant messages for tool_use IDs (via ``tool_calls`` attribute),
    then drops any ToolMessage whose ``tool_call_id`` is not found in
    that set.

    Args:
        messages (List[BaseMessage]): Conversation message list to scan and repair.

    Returns:
        RepairReport: A report containing the cleaned message list and the
            count of dropped orphan messages.
    """
    if not messages:
        return RepairReport(messages=messages, dropped_orphan_count=0)

    tool_use_ids: set[str] = set()
    has_tool_messages = any(
        isinstance(msg, ToolMessage) and getattr(msg, "tool_call_id", None) for msg in messages
    )

    if not has_tool_messages:
        return RepairReport(messages=messages, dropped_orphan_count=0)

    for msg in messages:
        if not isinstance(msg, AIMessage):
            continue
        tool_calls = getattr(msg, "tool_calls", None)
        if not tool_calls:
            continue
        for tc in tool_calls:
            tc_id = tc.get("id") if isinstance(tc, dict) else getattr(tc, "id", None)
            if tc_id:
                tool_use_ids.add(tc_id)

    repaired: List[BaseMessage] = []
    dropped = 0

    for msg in messages:
        if isinstance(msg, ToolMessage):
            tc_id = getattr(msg, "tool_call_id", None)
            if tc_id and tc_id not in tool_use_ids:
                logger.info("Dropped orphaned tool_result: tool_call_id=%s", tc_id)
                dropped += 1
                continue
        repaired.append(msg)

    if dropped:
        logger.info("Repaired tool_use/tool_result pairing: dropped %d orphans", dropped)

    return RepairReport(messages=repaired, dropped_orphan_count=dropped)
