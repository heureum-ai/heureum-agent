// Copyright (c) 2026 Heureum AI. All rights reserved.

/**
 * Shared tool display helpers.
 *
 * Used by ChatPage and ChatViewerPage to render tool call blocks.
 * Display names are provided dynamically from each tool source
 * (MCP meta, Skill schema, Client ToolDefinition) via SSE events.
 */

import type { ToolCallInfo } from '../../types';

/** Tools that mutate session files — used to trigger file panel refresh. */
export const FILE_MUTATION_TOOLS = new Set([
  'write', 'edit', 'delete',
]);

/** snake_case → Title Case fallback for tools without a display_name. */
export function formatToolName(name: string): string {
  return name
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** Derive display action + detail from a tool call. */
export function getToolDisplay(tc: ToolCallInfo): { action: string; detail?: string } {
  const name = tc.toolName || '';
  const args = tc.toolArgs || {};
  const action = tc.displayName || (name ? formatToolName(name) : tc.command);

  switch (name) {
    case 'bash':
      return { action, detail: tc.command };
    case 'read':
    case 'write':
    case 'edit':
    case 'delete':
      return { action, detail: args.path ? String(args.path) : undefined };
    case 'ls':
      return { action, detail: args.path ? String(args.path) : 'all files' };
    case 'grep':
    case 'find':
      return { action, detail: args.pattern ? String(args.pattern) : undefined };
    case 'search':
    case 'tavily_search':
      return { action, detail: args.query ? String(args.query) : undefined };
    case 'fetch':
      return { action, detail: args.url ? String(args.url) : undefined };
    case 'browser_navigate':
    case 'browser_new_tab':
    case 'open_url':
      return { action, detail: args.url ? String(args.url) : undefined };
    case 'browser_click':
    case 'browser_type':
      return { action, detail: args.selector ? String(args.selector) : undefined };
    case 'manage_periodic_task': {
      const ptAction = args.action ? String(args.action) : '';
      const ptTitle = args.title ? String(args.title) : '';
      const detail = ptTitle ? `${ptAction}: ${ptTitle}` : ptAction;
      return { action, detail: detail || undefined };
    }
    case 'notify_user':
      return { action, detail: args.title ? String(args.title) : undefined };
    default:
      if (!name) return { action: tc.command };
      return { action };
  }
}
