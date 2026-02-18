import { CODING_TOOLS } from '@heureum/coding'
// TODO: re-enable when document tools are ready
// import { PDF_TOOLS } from '@heureum/pdf'
// import { PPT_TOOLS } from '@heureum/ppt'
// import { DOCX_TOOLS } from '@heureum/word'
// import { XLSX_TOOLS } from '@heureum/xlsx'
import { WEB_TOOLS } from '@heureum/web'

interface ToolDefinition {
  type: 'function'
  name: string
  description?: string
  parameters?: Record<string, any>
  guide?: string
}

// --- select_cwd (dynamic description) ---

export function buildSelectCwdTool(cwd: string | null): ToolDefinition {
  const cwdStatus = cwd
    ? `Current working directory is: ${cwd}.`
    : 'No working directory is currently set.'
  return {
    type: 'function',
    name: 'select_cwd',
    description: `Open a folder picker dialog to let the user select a working directory for subsequent bash commands. ${cwdStatus} Call this before running bash commands if the user hasn't selected a working directory yet, or if they want to change it.`,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  }
}

// --- browser (5 tools, static) ---

const BROWSER_NAVIGATE_TOOL: ToolDefinition = {
  type: 'function',
  name: 'browser_navigate',
  description:
    'Navigate the user\'s current browser tab to a URL. Returns the page title, URL, interactive elements with CSS selectors, and visible text.',
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
  guide:
    '<tool_guide name="browser">\n'
    + "Controls the user's Chrome browser. The user is already logged in to their websites.\n"
    + 'Call browser_get_content before clicking or typing to get accurate CSS selectors.\n'
    + "Use browser_new_tab to open pages without leaving the user's current tab.\n"
    + '</tool_guide>',
}

const BROWSER_NEW_TAB_TOOL: ToolDefinition = {
  type: 'function',
  name: 'browser_new_tab',
  description:
    'Open a URL in a new browser tab without affecting the user\'s current tab. Returns page content.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to open in a new tab' },
    },
    required: ['url'],
  },
}

const BROWSER_CLICK_TOOL: ToolDefinition = {
  type: 'function',
  name: 'browser_click',
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
}

const BROWSER_TYPE_TOOL: ToolDefinition = {
  type: 'function',
  name: 'browser_type',
  description:
    'Type text into an input field on the current browser page. Use a CSS selector from browser_get_content.',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector of the input element to type into' },
      text: { type: 'string', description: 'The text to type into the input field' },
    },
    required: ['selector', 'text'],
  },
}

const BROWSER_GET_CONTENT_TOOL: ToolDefinition = {
  type: 'function',
  name: 'browser_get_content',
  description:
    'Get the current browser page content: title, URL, interactive elements with CSS selectors, and visible text. Always call this before clicking or typing to get accurate CSS selectors.',
  parameters: { type: 'object', properties: {} },
}

const BROWSER_TOOLS: ToolDefinition[] = [
  BROWSER_NAVIGATE_TOOL,
  BROWSER_NEW_TAB_TOOL,
  BROWSER_CLICK_TOOL,
  BROWSER_TYPE_TOOL,
  BROWSER_GET_CONTENT_TOOL,
]

// --- getTools: context-based full list ---

export function getTools(context?: { cwd?: string | null }): ToolDefinition[] {
  return [
    ...CODING_TOOLS,
    buildSelectCwdTool(context?.cwd ?? null),
    ...BROWSER_TOOLS,
    // TODO: re-enable when document tools are ready
    // ...DOCX_TOOLS,
    // ...PDF_TOOLS,
    // ...PPT_TOOLS,
    // ...XLSX_TOOLS,
    ...WEB_TOOLS,
  ]
}
