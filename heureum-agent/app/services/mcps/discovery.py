# Copyright (c) 2026 Heureum AI. All rights reserved.

"""MCP tool-discovery helpers."""

import logging
from typing import Any, Dict, List, Optional, Set, Tuple

from app.services.tools import ChainRule, ChainStep, ToolChainRegistry

logger = logging.getLogger(__name__)


def append_discovered_tool(
    *,
    tool: Any,
    server_url: str,
    available_tools: List[Dict[str, Any]],
    server_tool_names: Set[str],
    tool_to_server: Dict[str, str],
) -> str:
    """Append a discovered MCP tool schema and return its name."""
    tool_name = tool.name
    available_tools.append(
        {
            "type": "function",
            "function": {
                "name": tool_name,
                "description": tool.description or "",
                "parameters": tool.inputSchema,
            },
        }
    )
    server_tool_names.add(tool_name)
    tool_to_server[tool_name] = server_url
    return tool_name


def collect_discovery_metadata(
    *,
    tool: Any,
    tool_name: str,
    pending_chains: List[Tuple[str, list]],
    approval_required_tools: Set[str],
    display_names: Dict[str, str],
    has_chain_registry: bool,
) -> None:
    """Collect chain/approval/display metadata from a discovered tool."""
    meta = getattr(tool, "meta", None) or {}
    chain = meta.get("chain")
    if isinstance(chain, list) and chain and has_chain_registry:
        pending_chains.append((tool_name, chain))
    if meta.get("requires_approval"):
        approval_required_tools.add(tool_name)
    display_name = meta.get("display_name")
    assert display_name, f"MCP tool '{tool_name}' missing display_name in meta"
    display_names[tool_name] = display_name


def register_pending_chains(
    *,
    chain_registry: Optional[ToolChainRegistry],
    pending_chains: List[Tuple[str, list]],
) -> None:
    """Register collected chain metadata into the shared registry."""
    if chain_registry is None or not pending_chains:
        return

    for source, raw_steps in pending_chains:
        steps = [
            ChainStep(
                target=entry["target"],
                extract=entry["extract"],
                arg_mapping=entry.get("arg_mapping", {}),
            )
            for entry in raw_steps
        ]
        chain_registry.register(ChainRule(source=source, steps=steps))
    logger.info("Chain rules registered: %s", list(chain_registry.rules.keys()))
