import { WEB_TOOLS } from './tool-schema.js'

interface ClientToolDefinition {
  type: string
  name: string
  description?: string
  display_name: string
  parameters?: Record<string, unknown>
  guide?: string
}

export { webFetch } from './fetch.js'
export {
  extractContent,
  htmlToMarkdown,
  htmlToText,
  fetchFirecrawl,
  type ExtractedContent,
  type ExtractMode,
} from './extract.js'
export {
  wrapContent,
  wrapAndTruncate,
  detectInjection,
  wrapperOverhead,
  BOUNDARY_START,
  BOUNDARY_END,
  type ExternalContentSource,
} from './content-safety.js'
export {
  fetchWithSsrfGuard,
  validateUrl,
  validateUrlAsync,
  SSRFError,
  type FetchResponse,
} from './ssrf.js'
export { TTLCache, makeCacheKey, fetchCache } from './cache.js'
export { settings } from './config.js'
export { WEB_DEFAULTS, WEB_SETTINGS, type WebSettings } from './configs.js'
export type { TaskContext, WebToolResult } from './types.js'
export { WEB_WORKFLOW_PROMPT, buildWebWorkflowPrompt } from './prompt.js'
export type { WebPromptOptions } from './prompt.js'

export {
  webInitTask,
  webWriteSource,
  webWriteIntermediate,
  webPackTask,
  webUnpackTask,
  webReadParsed,
  webReadSource,
  handleWebTool,
  stripSecurityWrapper,
  truncateAtWord,
  buildSnippet,
  WEB_INIT_TASK_TOOL,
  WEB_WRITE_SOURCE_TOOL,
  WEB_WRITE_INTERMEDIATE_TOOL,
  WEB_PACK_TASK_TOOL,
  WEB_UNPACK_TASK_TOOL,
  WEB_READ_PARSED_TOOL,
  WEB_READ_SOURCE_TOOL,
  WEB_FETCH_TOOL,
  type ToolResult as WebHandlerResult,
} from './tools.js'

export {
  WebPipeline,
  resolveWebWorkDir,
  WEB_STEP_SOURCE,
  WEB_STEP_PARSED,
  WEB_STEP_INTERMEDIATE,
  WEB_STEP_OUTPUT,
} from './pipeline.js'

// Tool definitions for LLM binding
export { WEB_TOOLS } from './tool-schema.js'
export const toolsList = (): ClientToolDefinition[] => WEB_TOOLS.map((tool) => ({ ...tool }))

// Skills
import { loadSkills } from '../skills/index.js'
export type { SkillDefinition } from '../skills/index.js'
export const WEB_SKILLS = loadSkills()
