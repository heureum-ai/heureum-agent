import { BROWSER_TOOLS } from './tool-schema.js'

interface ClientToolDefinition {
  type: string
  name: string
  description?: string
  display_name: string
  parameters?: Record<string, unknown>
  guide?: string
}

// Tool definitions for LLM binding
export { BROWSER_TOOLS } from './tool-schema.js'
export const toolsList = (): ClientToolDefinition[] => BROWSER_TOOLS.map((tool) => ({ ...tool }))

// Tool name constants and classification sets
export {
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
  BROWSER_PAGE_TOOLS,
  BROWSER_MUTATING_TOOLS,
  BROWSER_READ_ONLY_TOOLS,
  BROWSER_POLL_TOOLS,
  ALL_BROWSER_TOOL_NAMES,
  isBrowserToolName,
  prepareBrowserCommand,
  type BrowserToolName,
} from './tools.js'

// Types
export type { BrowserToolResult, BrowserCommandPayload, BrowserToolDefinition, ToolMeta } from './types.js'

// Configs
export { BROWSER_DEFAULTS } from './configs.js'

// Content parser
export { isBrowserPageContent, extractPageHeader } from './content-parser.js'

// Prompt
export { BROWSER_WORKFLOW_PROMPT, buildBrowserWorkflowPrompt } from './prompt.js'
export type { BrowserPromptOptions } from './prompt.js'

// Skills
import { loadSkills } from '../skills/index.js'
export type { SkillDefinition } from '../skills/index.js'
export const BROWSER_SKILLS = loadSkills()
