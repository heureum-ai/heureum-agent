/**
 * Browser tool name constants, classification sets, and command helper.
 */

// ── Tool name constants ──────────────────────────────────────────────

export const BROWSER_NAVIGATE_TOOL = 'browser_navigate' as const
export const BROWSER_NEW_TAB_TOOL = 'browser_new_tab' as const
export const BROWSER_CLICK_TOOL = 'browser_click' as const
export const BROWSER_TYPE_TOOL = 'browser_type' as const
export const BROWSER_GET_CONTENT_TOOL = 'browser_get_content' as const
export const BROWSER_SCREENSHOT_TOOL = 'browser_screenshot' as const
export const BROWSER_HOVER_TOOL = 'browser_hover' as const
export const BROWSER_SELECT_TOOL = 'browser_select' as const
export const BROWSER_EVALUATE_TOOL = 'browser_evaluate' as const
export const BROWSER_SCROLL_TOOL = 'browser_scroll' as const
export const BROWSER_KEY_PRESS_TOOL = 'browser_key_press' as const
export const BROWSER_BACK_TOOL = 'browser_back' as const
export const BROWSER_FORWARD_TOOL = 'browser_forward' as const
export const BROWSER_RELOAD_TOOL = 'browser_reload' as const
export const BROWSER_GET_TABS_TOOL = 'browser_get_tabs' as const
export const BROWSER_SWITCH_TAB_TOOL = 'browser_switch_tab' as const
export const BROWSER_CLOSE_TAB_TOOL = 'browser_close_tab' as const
export const BROWSER_WAIT_FOR_TOOL = 'browser_wait_for' as const

export type BrowserToolName =
  | typeof BROWSER_NAVIGATE_TOOL
  | typeof BROWSER_NEW_TAB_TOOL
  | typeof BROWSER_CLICK_TOOL
  | typeof BROWSER_TYPE_TOOL
  | typeof BROWSER_GET_CONTENT_TOOL
  | typeof BROWSER_SCREENSHOT_TOOL
  | typeof BROWSER_HOVER_TOOL
  | typeof BROWSER_SELECT_TOOL
  | typeof BROWSER_EVALUATE_TOOL
  | typeof BROWSER_SCROLL_TOOL
  | typeof BROWSER_KEY_PRESS_TOOL
  | typeof BROWSER_BACK_TOOL
  | typeof BROWSER_FORWARD_TOOL
  | typeof BROWSER_RELOAD_TOOL
  | typeof BROWSER_GET_TABS_TOOL
  | typeof BROWSER_SWITCH_TAB_TOOL
  | typeof BROWSER_CLOSE_TAB_TOOL
  | typeof BROWSER_WAIT_FOR_TOOL

// ── Classification sets ──────────────────────────────────────────────

/** Tools that return page content (stale detection for server-side compaction) */
export const BROWSER_PAGE_TOOLS: ReadonlySet<string> = new Set([
  BROWSER_NAVIGATE_TOOL,
  BROWSER_CLICK_TOOL,
  BROWSER_GET_CONTENT_TOOL,
  BROWSER_NEW_TAB_TOOL,
  BROWSER_BACK_TOOL,
  BROWSER_FORWARD_TOOL,
  BROWSER_RELOAD_TOOL,
  BROWSER_SWITCH_TAB_TOOL,
])

/** State-changing tools (permission classification) */
export const BROWSER_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  BROWSER_CLICK_TOOL,
  BROWSER_TYPE_TOOL,
  BROWSER_SELECT_TOOL,
  BROWSER_EVALUATE_TOOL,
  BROWSER_KEY_PRESS_TOOL,
  BROWSER_CLOSE_TAB_TOOL,
])

/** Read-only tools */
export const BROWSER_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  BROWSER_NAVIGATE_TOOL,
  BROWSER_GET_CONTENT_TOOL,
  BROWSER_SCREENSHOT_TOOL,
  BROWSER_HOVER_TOOL,
  BROWSER_SCROLL_TOOL,
  BROWSER_GET_TABS_TOOL,
  BROWSER_NEW_TAB_TOOL,
  BROWSER_SWITCH_TAB_TOOL,
  BROWSER_BACK_TOOL,
  BROWSER_FORWARD_TOOL,
  BROWSER_RELOAD_TOOL,
  BROWSER_WAIT_FOR_TOOL,
])

/** Polling tools (loop detection) */
export const BROWSER_POLL_TOOLS: ReadonlySet<string> = new Set([
  BROWSER_WAIT_FOR_TOOL,
])

// ── All tool names ───────────────────────────────────────────────────

export const ALL_BROWSER_TOOL_NAMES: ReadonlySet<string> = new Set([
  ...BROWSER_PAGE_TOOLS,
  ...BROWSER_MUTATING_TOOLS,
  ...BROWSER_READ_ONLY_TOOLS,
  ...BROWSER_POLL_TOOLS,
])

export function isBrowserToolName(name: string): name is BrowserToolName {
  return ALL_BROWSER_TOOL_NAMES.has(name)
}

// ── Command helper ───────────────────────────────────────────────────

/**
 * Convert a browser tool call into the action + params payload
 * expected by the Electron → Extension WebSocket protocol.
 *
 * Tool name `browser_navigate` → action `navigate`.
 */
export function prepareBrowserCommand(
  toolName: string,
  args: Record<string, unknown>,
): { action: string; params: Record<string, unknown> } {
  const action = toolName.replace(/^browser_/, '')
  return { action, params: { ...args } }
}
