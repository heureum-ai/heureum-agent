import * as fs from 'fs'
import * as path from 'path'
import { webFetch } from './fetch.js'
import { settings } from './config.js'
import { BOUNDARY_START, BOUNDARY_END } from './content-safety.js'
import {
  WebPipeline,
  WEB_STEP_INTERMEDIATE,
  WEB_STEP_OUTPUT,
  WEB_STEP_PARSED,
  WEB_STEP_SOURCE,
  webPipelineFromTaskDir,
} from './pipeline.js'
import type { ToolResult } from './types.js'

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}


export const WEB_INIT_TASK_TOOL = 'web_init_task' as const
export const WEB_WRITE_SOURCE_TOOL = 'web_write_source' as const
export const WEB_WRITE_INTERMEDIATE_TOOL = 'web_write_intermediate' as const
export const WEB_PACK_TASK_TOOL = 'web_pack_output' as const
export const WEB_UNPACK_TASK_TOOL = 'web_unpack_output' as const
export const WEB_READ_PARSED_TOOL = 'web_read_parsed' as const
export const WEB_READ_SOURCE_TOOL = 'web_read_source' as const

export const WEB_FETCH_TOOL = 'web_fetch' as const

export type { ToolResult, WebToolResult } from './types.js'

export function stripSecurityWrapper(text: string): string {
  const startIdx = text.indexOf(BOUNDARY_START)
  if (startIdx === -1) return text

  const contentStart = text.indexOf('\n---\n', startIdx)
  if (contentStart === -1) return text

  const endIdx = text.indexOf(BOUNDARY_END, contentStart)
  if (endIdx === -1) return text.slice(contentStart + 5)

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
    `[${WEB_FETCH_TOOL}] ${title}\n`
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

function buildSummary(rawResult: string): Record<string, unknown> {
  const parsed = JSON.parse(rawResult) as Record<string, unknown>
  return {
    title: parsed.title ?? 'Untitled',
    url: parsed.url ?? '',
    status: parsed.status ?? null,
    total_length: parsed.total_length ?? 0,
    fetched_at: new Date().toISOString(),
  }
}

export async function webInitTask(params: {
  session_id: string
  task_id: string
  work_dir?: string
}): Promise<ToolResult> {
  try {
    if (!params.session_id) return { success: false, output: 'Missing required parameter: session_id' }
    if (!params.task_id) return { success: false, output: 'Missing required parameter: task_id' }

    const pipeline = new WebPipeline({
      sessionId: params.session_id,
      taskType: 'web',
      taskId: params.task_id,
      workDir: params.work_dir,
    })
    pipeline.ensureStepDirs()
    await pipeline.setMeta({
      sessionId: params.session_id,
      taskType: 'web',
      taskId: params.task_id,
      createdAt: new Date().toISOString(),
    })

    return {
      success: true,
      output: `Task initialized at: ${pipeline.taskDir}`,
      outputPath: pipeline.taskDir,
    }
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` }
  }
}

export async function webWriteSource(params: {
  task_dir: string
  url: string
  max_length?: number
  start_index?: number
  extract_mode?: string
  headers?: Record<string, string>
}): Promise<ToolResult> {
  try {
    if (!params.task_dir) return { success: false, output: 'Missing required parameter: task_dir' }
    if (!params.url) return { success: false, output: 'Missing required parameter: url' }

    const pipeline = webPipelineFromTaskDir(params.task_dir)
    pipeline.ensureStepDirs()

    const requestPath = path.join(pipeline.stepPath(WEB_STEP_SOURCE), 'request.json')
    const payload = {
      url: params.url,
      max_length: params.max_length,
      start_index: params.start_index,
      extract_mode: params.extract_mode,
      headers: params.headers,
      created_at: new Date().toISOString(),
    }

    ;(await fs.promises.writeFile(requestPath, JSON.stringify(payload, null, 2), 'utf-8'))
    await pipeline.setMeta({ updatedAt: new Date().toISOString() })

    return { success: true, output: `Source written: ${requestPath}`, outputPath: requestPath }
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` }
  }
}

export async function webWriteIntermediate(params: {
  task_dir: string
}): Promise<ToolResult> {
  try {
    if (!params.task_dir) return { success: false, output: 'Missing required parameter: task_dir' }

    const pipeline = webPipelineFromTaskDir(params.task_dir)
    pipeline.ensureStepDirs()

    const requestPath = path.join(pipeline.stepPath(WEB_STEP_SOURCE), 'request.json')
    if (!(await pathExists(requestPath))) {
      return { success: false, output: 'Missing source request. Run web_write_source first.' }
    }

    const requestPayload = JSON.parse((await fs.promises.readFile(requestPath, 'utf-8'))) as {
      url: string
      max_length?: number
      start_index?: number
      extract_mode?: string
      headers?: Record<string, string>
    }

    const rawResult = await webFetch({
      url: requestPayload.url,
      max_length: requestPayload.max_length,
      start_index: requestPayload.start_index,
      extract_mode: requestPayload.extract_mode,
      headers: requestPayload.headers,
    })

    const intermediatePath = path.join(pipeline.stepPath(WEB_STEP_INTERMEDIATE), 'fetch.json')
    ;(await fs.promises.writeFile(intermediatePath, rawResult, 'utf-8'))

    try {
      const summary = buildSummary(rawResult)
      const parsedPath = path.join(pipeline.stepPath(WEB_STEP_PARSED), 'summary.json')
      ;(await fs.promises.writeFile(parsedPath, JSON.stringify(summary, null, 2), 'utf-8'))

      await pipeline.setMeta({ updatedAt: new Date().toISOString() })
      return {
        success: true,
        output: buildSnippet(JSON.parse(rawResult), intermediatePath),
        outputPath: intermediatePath,
      }
    } catch {
      await pipeline.setMeta({ updatedAt: new Date().toISOString() })
      return { success: true, output: `Intermediate written: ${intermediatePath}`, outputPath: intermediatePath }
    }
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` }
  }
}

export async function webPackTask(params: {
  task_dir: string
  output_path?: string
}): Promise<ToolResult> {
  try {
    if (!params.task_dir) return { success: false, output: 'Missing required parameter: task_dir' }

    const pipeline = webPipelineFromTaskDir(params.task_dir)
    const intermediatePath = path.join(pipeline.stepPath(WEB_STEP_INTERMEDIATE), 'fetch.json')
    if (!(await pathExists(intermediatePath))) {
      return {
        success: false,
        output: 'Missing intermediate fetch.json. Run web_write_intermediate or web_unpack_output first.',
      }
    }

    const outputPath = params.output_path
      ? path.resolve(params.output_path)
      : path.join(pipeline.stepPath(WEB_STEP_OUTPUT), 'result.json')
    ;(await fs.promises.mkdir(path.dirname(outputPath), { recursive: true }))
    ;(await fs.promises.copyFile(intermediatePath, outputPath))

    return { success: true, output: `Packed output to ${outputPath}`, outputPath }
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` }
  }
}

export async function webUnpackTask(params: {
  task_dir: string
  input_path: string
}): Promise<ToolResult> {
  try {
    if (!params.task_dir) return { success: false, output: 'Missing required parameter: task_dir' }
    if (!params.input_path) return { success: false, output: 'Missing required parameter: input_path' }

    const inputPath = path.resolve(params.input_path)
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` }
    }

    const pipeline = webPipelineFromTaskDir(params.task_dir)
    pipeline.ensureStepDirs()

    const rawResult = (await fs.promises.readFile(inputPath, 'utf-8'))

    const sourcePath = path.join(pipeline.stepPath(WEB_STEP_SOURCE), 'input.json')
    ;(await fs.promises.writeFile(sourcePath, rawResult, 'utf-8'))

    const intermediatePath = path.join(pipeline.stepPath(WEB_STEP_INTERMEDIATE), 'fetch.json')
    ;(await fs.promises.writeFile(intermediatePath, rawResult, 'utf-8'))

    try {
      const summary = buildSummary(rawResult)
      const parsedPath = path.join(pipeline.stepPath(WEB_STEP_PARSED), 'summary.json')
      ;(await fs.promises.writeFile(parsedPath, JSON.stringify(summary, null, 2), 'utf-8'))
    } catch {
      // ignore summary parse errors for non-standard input payloads
    }

    await pipeline.setMeta({ updatedAt: new Date().toISOString() })
    return { success: true, output: `Unpacked source into ${intermediatePath}`, outputPath: intermediatePath }
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` }
  }
}

export async function webReadParsed(params: {
  task_dir: string
}): Promise<ToolResult> {
  try {
    if (!params.task_dir) return { success: false, output: 'Missing required parameter: task_dir' }

    const pipeline = webPipelineFromTaskDir(params.task_dir)
    const parsedPath = path.join(pipeline.stepPath(WEB_STEP_PARSED), 'summary.json')
    if (!(await pathExists(parsedPath))) {
      return { success: false, output: 'Missing parsed summary. Run web_write_intermediate first.' }
    }

    const parsed = (await fs.promises.readFile(parsedPath, 'utf-8'))
    return { success: true, output: parsed, outputPath: parsedPath }
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` }
  }
}

export async function webReadSource(params: {
  task_dir: string
}): Promise<ToolResult> {
  try {
    if (!params.task_dir) return { success: false, output: 'Missing required parameter: task_dir' }

    const pipeline = webPipelineFromTaskDir(params.task_dir)
    const sourceDir = pipeline.stepPath(WEB_STEP_SOURCE)

    const requestPath = path.join(sourceDir, 'request.json')
    const inputPath = path.join(sourceDir, 'input.json')

    if ((await pathExists(requestPath))) {
      return { success: true, output: (await fs.promises.readFile(requestPath, 'utf-8')), outputPath: requestPath }
    }
    if ((await pathExists(inputPath))) {
      return { success: true, output: (await fs.promises.readFile(inputPath, 'utf-8')), outputPath: inputPath }
    }

    return { success: false, output: 'Missing source payload. Run web_write_source or web_unpack_output first.' }
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` }
  }
}

export async function handleWebTool(
  toolName: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  switch (toolName) {
    case WEB_INIT_TASK_TOOL:
      return webInitTask(args as Parameters<typeof webInitTask>[0])
    case WEB_WRITE_SOURCE_TOOL:
      return webWriteSource(args as Parameters<typeof webWriteSource>[0])
    case WEB_WRITE_INTERMEDIATE_TOOL:
      return webWriteIntermediate(args as Parameters<typeof webWriteIntermediate>[0])
    case WEB_PACK_TASK_TOOL:
      return webPackTask(args as Parameters<typeof webPackTask>[0])
    case WEB_UNPACK_TASK_TOOL:
      return webUnpackTask(args as Parameters<typeof webUnpackTask>[0])
    case WEB_READ_PARSED_TOOL:
      return webReadParsed(args as Parameters<typeof webReadParsed>[0])
    case WEB_READ_SOURCE_TOOL:
      return webReadSource(args as Parameters<typeof webReadSource>[0])
    case WEB_FETCH_TOOL: {
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

        ;(await fs.promises.mkdir(sessionDir, { recursive: true }))
        ;(await fs.promises.writeFile(outputPath, result, 'utf-8'))

        // Save .md file with clean text for read tool
        const mdFilename = `fetch_${hostname}_${timestamp}.md`
        const mdPath = path.join(sessionDir, mdFilename)

        try {
          const parsed = JSON.parse(result)
          const cleanText = stripSecurityWrapper(parsed.text || '')
          if (cleanText) {
            ;(await fs.promises.writeFile(mdPath, cleanText, 'utf-8'))
          }
          return { success: true, output: buildSnippet(parsed, mdPath), outputPath: mdPath }
        } catch {
          return { success: true, output: `Saved to ${outputPath}`, outputPath }
        }
      } catch (err: any) {
        return { success: false, output: err.message || `${WEB_FETCH_TOOL} failed` }
      }
    }
    default:
      return { success: false, output: `Unknown web tool: ${toolName}` }
  }
}
