/**
 * Web ToolDefinition + handler for LLM tool binding.
 * 1 tool: fetch — fetch a URL and extract readable content.
 *
 * working_directory and session_id are injected by the frontend at call time,
 * not specified by the LLM. They are hidden from the tool schema.
 */

import * as fs from 'fs'
import * as path from 'path'
import { webFetch } from './fetch.js'
import { settings } from './config.js'
import { BOUNDARY_START, BOUNDARY_END } from './content-safety.js'

interface ToolDefinition {
  type: 'function'
  name: string
  description?: string
  parameters?: Record<string, any>
  guide?: string
}

export interface ToolResult {
  success: boolean
  output: string
}

const WEB_FETCH: ToolDefinition = {
  type: 'function',
  name: 'fetch',
  description:
    'Fetch a URL and extract its readable content. Returns a snippet (first ~1500 chars) directly in the tool response plus saves the full content as a JSON file. Includes SSRF protection and caching.',
  guide:
    '<tool_guide name="fetch_task">\n'
    + 'mcp_web__search returns brief snippets and URLs. Follow up with fetch to get actual page content.\n'
    + 'Each fetch returns a ~1500 char snippet; use read or grep on the saved file for the full page.\n'
    + 'Multiple fetch calls in the same turn run in parallel.\n'
    + '</tool_guide>',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'The URL to fetch (must include http:// or https://)' },
      max_length: {
        type: 'integer',
        description: 'Maximum content length in characters. Defaults to 20000.',
      },
      start_index: {
        type: 'integer',
        description: 'Character offset to start from (for pagination). Defaults to 0.',
      },
      extract_mode: {
        type: 'string',
        enum: ['markdown', 'text'],
        description: "Content extraction mode. Defaults to 'markdown'.",
      },
      headers: {
        type: 'object',
        description: 'Optional HTTP headers to include in the request.',
      },
    },
    required: ['url'],
  },
}

export const WEB_TOOLS: ToolDefinition[] = [WEB_FETCH]

// --- Snippet helpers ---

export function stripSecurityWrapper(text: string): string {
  const startIdx = text.indexOf(BOUNDARY_START)
  if (startIdx === -1) return text

  const contentStart = text.indexOf('\n---\n', startIdx)
  if (contentStart === -1) return text

  const endIdx = text.indexOf(BOUNDARY_END, contentStart)
  if (endIdx === -1) return text.slice(contentStart + 5) // 5 = '\n---\n'.length

  return text.slice(contentStart + 5, endIdx).trimEnd()
}

export function truncateAtWord(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text
  const truncated = text.slice(0, maxLen)
  const lastSpace = truncated.lastIndexOf(' ')
  return (lastSpace > maxLen * 0.8 ? truncated.slice(0, lastSpace) : truncated) + '...'
}

export function buildSnippet(parsed: Record<string, unknown>, outputPath: string): string {
  const title = (parsed.title as string) || 'Untitled'
  const url = (parsed.url as string) || ''
  const status = parsed.status ?? ''
  const totalLength = parsed.total_length ?? 0

  const header =
    `[fetch] ${title}\n`
    + `URL: ${url}\n`
    + `Status: ${status} | ${totalLength} chars | Saved to ${outputPath}`

  const rawText = (parsed.text as string) || ''
  if (!rawText) return header

  const content = stripSecurityWrapper(rawText)
  if (!content) return header

  const maxLen = settings.SNIPPET_LENGTH
  if (content.length <= maxLen) {
    return header + '\n\n---\n' + content + '\n---'
  }

  return (
    header
    + '\n\n---\n'
    + truncateAtWord(content, maxLen)
    + '\n---'
    + `\n\n[Truncated. Use read(path="${outputPath}") for full content.]`
  )
}

export async function handleWebTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  switch (toolName) {
    case 'fetch': {
      try {
        const url = args.url as string
        const workingDir = args.working_directory as string | undefined
        const sessionId = args.session_id as string | undefined

        const result = await webFetch({
          url,
          max_length: args.max_length as number | undefined,
          start_index: args.start_index as number | undefined,
          extract_mode: args.extract_mode as string | undefined,
          headers: args.headers as Record<string, string> | undefined,
        })

        // Build save path: {working_directory}/tmp/{session_id}/fetch_*.json
        if (!workingDir) {
          return { success: true, output: result }
        }

        const sessionDir = sessionId
          ? path.join(workingDir, 'tmp', sessionId)
          : path.join(workingDir, 'tmp')

        const hostname = new URL(url).hostname.replace(/\./g, '_')
        const timestamp = Date.now()
        const filename = `fetch_${hostname}_${timestamp}.json`
        const outputPath = path.join(sessionDir, filename)

        fs.mkdirSync(sessionDir, { recursive: true })
        fs.writeFileSync(outputPath, result, 'utf-8')

        // Return snippet — LLM can read the file for full content
        try {
          const parsed = JSON.parse(result)
          return { success: true, output: buildSnippet(parsed, outputPath) }
        } catch {
          return { success: true, output: `Saved to ${outputPath}` }
        }
      } catch (err: any) {
        return { success: false, output: err.message || 'fetch failed' }
      }
    }
    default:
      return { success: false, output: `Unknown web tool: ${toolName}` }
  }
}
