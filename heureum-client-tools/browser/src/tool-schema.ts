/**
 * Browser ToolDefinitions for LLM tool binding (18 tools).
 *
 * The extension executes these via WebSocket; parameters here describe
 * what the LLM should provide.
 */

import {
  BROWSER_NAVIGATE_TOOL,
  BROWSER_NEW_TAB_TOOL,
  BROWSER_CLICK_TOOL,
  BROWSER_TYPE_TOOL,
  BROWSER_GET_CONTENT_TOOL,
  BROWSER_SCREENSHOT_TOOL,
  BROWSER_HOVER_TOOL,
  BROWSER_SELECT_TOOL,
  BROWSER_EVALUATE_TOOL,
  BROWSER_SCROLL_TOOL,
  BROWSER_KEY_PRESS_TOOL,
  BROWSER_BACK_TOOL,
  BROWSER_FORWARD_TOOL,
  BROWSER_RELOAD_TOOL,
  BROWSER_GET_TABS_TOOL,
  BROWSER_SWITCH_TAB_TOOL,
  BROWSER_CLOSE_TAB_TOOL,
  BROWSER_WAIT_FOR_TOOL,
} from './tools.js'

import type { BrowserToolDefinition } from './types.js'

// ── Browser workflow guide (shared by navigate tool) ─────────────────

const BROWSER_GUIDE =
  '<tool_guide name="browser">\n'
  + "Controls the user's Chrome browser. The user is already logged in to their websites.\n"
  + 'Call browser_get_content before clicking or typing to get accurate CSS selectors.\n'
  + "Use browser_new_tab to open pages without leaving the user's current tab.\n"
  + 'Use browser_screenshot to capture visual state when you need to verify layout or content.\n'
  + 'Use browser_wait_for after actions that trigger dynamic content loading.\n'
  + '</tool_guide>'

// ── Existing 5 tools ─────────────────────────────────────────────────

const NAVIGATE: BrowserToolDefinition = {
  type: 'function',
  name: BROWSER_NAVIGATE_TOOL,
  display_name: 'Navigate',
  description:
    "Navigate the user's current browser tab to a URL. Returns the page title, URL, interactive elements with CSS selectors, and visible text.",
  parameters: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL to navigate to (must include http:// or https://)',
      },
    },
    required: ['url'],
  },
  guide: BROWSER_GUIDE,
  tool_meta: { snapshot: true, read_only: true },
}

const NEW_TAB: BrowserToolDefinition = {
  type: 'function',
  name: BROWSER_NEW_TAB_TOOL,
  display_name: 'New Tab',
  description:
    "Open a URL in a new browser tab without affecting the user's current tab. Returns page content.",
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to open in a new tab' },
    },
    required: ['url'],
  },
  tool_meta: { snapshot: true, read_only: true },
}

const CLICK: BrowserToolDefinition = {
  type: 'function',
  name: BROWSER_CLICK_TOOL,
  display_name: 'Click',
  description:
    'Click an element on the current browser page. Use a CSS selector from browser_get_content. Returns updated page content after the click.',
  parameters: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: 'CSS selector of the element to click (get selectors from browser_get_content)',
      },
    },
    required: ['selector'],
  },
  tool_meta: { snapshot: true, mutating: true },
}

const TYPE: BrowserToolDefinition = {
  type: 'function',
  name: BROWSER_TYPE_TOOL,
  display_name: 'Type',
  description:
    'Type text into an input field on the current browser page. Use a CSS selector from browser_get_content.',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector of the input element to type into' },
      text: { type: 'string', description: 'The text to type into the input field' },
      clear: {
        type: 'boolean',
        description: 'Whether to clear the existing value before typing (default: true)',
      },
    },
    required: ['selector', 'text'],
  },
  tool_meta: { mutating: true },
}

const GET_CONTENT: BrowserToolDefinition = {
  type: 'function',
  name: BROWSER_GET_CONTENT_TOOL,
  display_name: 'Get Content',
  description:
    'Get the current browser page content: title, URL, interactive elements with CSS selectors, and visible text. Always call this before clicking or typing to get accurate CSS selectors.',
  parameters: { type: 'object', properties: {} },
  tool_meta: { snapshot: true, read_only: true },
}

// ── New 13 tools ─────────────────────────────────────────────────────

const SCREENSHOT: BrowserToolDefinition = {
  type: 'function',
  name: BROWSER_SCREENSHOT_TOOL,
  display_name: 'Screenshot',
  description:
    'Take a screenshot of the current browser page or a specific element. Returns a base64-encoded PNG image.',
  parameters: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: 'CSS selector of a specific element to capture. Omit for full visible viewport.',
      },
      full_page: {
        type: 'boolean',
        description: 'Capture the full scrollable page instead of just the visible viewport (default: false)',
      },
    },
  },
  tool_meta: { read_only: true },
}

const HOVER: BrowserToolDefinition = {
  type: 'function',
  name: BROWSER_HOVER_TOOL,
  display_name: 'Hover',
  description:
    'Hover over an element on the page to trigger dropdowns, tooltips, or other hover-activated UI.',
  parameters: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: 'CSS selector of the element to hover over',
      },
    },
    required: ['selector'],
  },
  tool_meta: { read_only: true },
}

const SELECT: BrowserToolDefinition = {
  type: 'function',
  name: BROWSER_SELECT_TOOL,
  display_name: 'Select Option',
  description:
    'Select an option from a <select> dropdown element by value.',
  parameters: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: 'CSS selector of the <select> element',
      },
      value: {
        type: 'string',
        description: 'The value attribute of the option to select',
      },
    },
    required: ['selector', 'value'],
  },
  tool_meta: { mutating: true },
}

const EVALUATE: BrowserToolDefinition = {
  type: 'function',
  name: BROWSER_EVALUATE_TOOL,
  display_name: 'Evaluate JS',
  description:
    'Execute JavaScript in the page context and return the result. The script should return a value (use JSON.stringify for complex objects).',
  parameters: {
    type: 'object',
    properties: {
      script: {
        type: 'string',
        description: 'JavaScript code to execute in the page context',
      },
    },
    required: ['script'],
  },
  tool_meta: { mutating: true },
}

const SCROLL: BrowserToolDefinition = {
  type: 'function',
  name: BROWSER_SCROLL_TOOL,
  display_name: 'Scroll',
  description:
    'Scroll the page or a specific element.',
  parameters: {
    type: 'object',
    properties: {
      direction: {
        type: 'string',
        enum: ['up', 'down', 'left', 'right'],
        description: "Scroll direction (default: 'down')",
      },
      amount: {
        type: 'number',
        description: 'Scroll amount in pixels (default: 400)',
      },
      selector: {
        type: 'string',
        description: 'CSS selector of an element to scroll. Omit for page scroll.',
      },
    },
  },
  tool_meta: { read_only: true },
}

const KEY_PRESS: BrowserToolDefinition = {
  type: 'function',
  name: BROWSER_KEY_PRESS_TOOL,
  display_name: 'Key Press',
  description:
    'Send a keyboard event to the page or a specific element. Use standard key names (Enter, Escape, Tab, ArrowDown, etc.).',
  parameters: {
    type: 'object',
    properties: {
      key: {
        type: 'string',
        description: 'Key name (e.g., "Enter", "Escape", "Tab", "ArrowDown", "a")',
      },
      modifiers: {
        type: 'array',
        items: { type: 'string', enum: ['ctrl', 'shift', 'alt', 'meta'] },
        description: 'Modifier keys to hold during the key press',
      },
      selector: {
        type: 'string',
        description: 'CSS selector of the target element. Omit for active element.',
      },
    },
    required: ['key'],
  },
  tool_meta: { mutating: true },
}

const BACK: BrowserToolDefinition = {
  type: 'function',
  name: BROWSER_BACK_TOOL,
  display_name: 'Back',
  description: 'Navigate back in browser history. Returns updated page content.',
  parameters: { type: 'object', properties: {} },
  tool_meta: { snapshot: true, read_only: true },
}

const FORWARD: BrowserToolDefinition = {
  type: 'function',
  name: BROWSER_FORWARD_TOOL,
  display_name: 'Forward',
  description: 'Navigate forward in browser history. Returns updated page content.',
  parameters: { type: 'object', properties: {} },
  tool_meta: { snapshot: true, read_only: true },
}

const RELOAD: BrowserToolDefinition = {
  type: 'function',
  name: BROWSER_RELOAD_TOOL,
  display_name: 'Reload',
  description: 'Reload the current page. Returns updated page content.',
  parameters: { type: 'object', properties: {} },
  tool_meta: { snapshot: true, read_only: true },
}

const GET_TABS: BrowserToolDefinition = {
  type: 'function',
  name: BROWSER_GET_TABS_TOOL,
  display_name: 'Get Tabs',
  description: 'Get a list of all open browser tabs with their IDs, titles, and URLs.',
  parameters: { type: 'object', properties: {} },
  tool_meta: { read_only: true },
}

const SWITCH_TAB: BrowserToolDefinition = {
  type: 'function',
  name: BROWSER_SWITCH_TAB_TOOL,
  display_name: 'Switch Tab',
  description: 'Switch to a different browser tab by its ID. Returns the tab\'s page content.',
  parameters: {
    type: 'object',
    properties: {
      tab_id: {
        type: 'number',
        description: 'The tab ID to switch to (from browser_get_tabs)',
      },
    },
    required: ['tab_id'],
  },
  tool_meta: { snapshot: true, read_only: true },
}

const CLOSE_TAB: BrowserToolDefinition = {
  type: 'function',
  name: BROWSER_CLOSE_TAB_TOOL,
  display_name: 'Close Tab',
  description: 'Close a browser tab by its ID.',
  parameters: {
    type: 'object',
    properties: {
      tab_id: {
        type: 'number',
        description: 'The tab ID to close (from browser_get_tabs)',
      },
    },
    required: ['tab_id'],
  },
  tool_meta: { mutating: true },
}

const WAIT_FOR: BrowserToolDefinition = {
  type: 'function',
  name: BROWSER_WAIT_FOR_TOOL,
  display_name: 'Wait For',
  description:
    'Wait for a CSS selector to appear, disappear, or become visible on the page. Useful for SPAs and dynamic content.',
  parameters: {
    type: 'object',
    properties: {
      selector: {
        type: 'string',
        description: 'CSS selector to wait for',
      },
      timeout: {
        type: 'number',
        description: 'Maximum time to wait in milliseconds (default: 10000)',
      },
      state: {
        type: 'string',
        enum: ['attached', 'detached', 'visible', 'hidden'],
        description: "Desired state of the element (default: 'visible')",
      },
    },
    required: ['selector'],
  },
  tool_meta: { read_only: true, poll: true },
}

// ── Exports ──────────────────────────────────────────────────────────

export const BROWSER_TOOLS: BrowserToolDefinition[] = [
  NAVIGATE,
  NEW_TAB,
  CLICK,
  TYPE,
  GET_CONTENT,
  SCREENSHOT,
  HOVER,
  SELECT,
  EVALUATE,
  SCROLL,
  KEY_PRESS,
  BACK,
  FORWARD,
  RELOAD,
  GET_TABS,
  SWITCH_TAB,
  CLOSE_TAB,
  WAIT_FOR,
]
