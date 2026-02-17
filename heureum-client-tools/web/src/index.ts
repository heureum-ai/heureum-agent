export { webFetch } from './fetch.js'
export {
  extractContent,
  htmlToMarkdown,
  markdownToText,
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

// Tool definitions for LLM binding
export { WEB_TOOLS, handleWebTool, type ToolResult as WebHandlerResult } from './tool-schema.js'
