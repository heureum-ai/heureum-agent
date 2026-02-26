import { createCodingToolset, toolsList as codingToolsList, CODING_SKILLS, type SkillDefinition } from '@heureum/coding'
import { handleBashTool, toolsList as bashToolsList, BASH_SKILLS } from '@heureum/bash'
import { handleDocxTool, toolsList as docxToolsList, DOCX_SKILLS } from '@heureum/docx'
import { handlePdfTool, toolsList as pdfToolsList, PDF_SKILLS } from '@heureum/pdf'
import { handlePptTool, PPT_TOOLS as PPT_TOOL_DEFINITIONS, PPT_SKILLS } from '@heureum/ppt'
import { handleXlsxTool, toolsList as xlsxToolsList, XLSX_SKILLS } from '@heureum/xlsx'
import { handleMdTool, toolsList as mdToolsList, MD_SKILLS } from '@heureum/md'
import { handleHwpxTool, toolsList as hwpxToolsList, HWPX_SKILLS } from '@heureum/hwpx'
import { handleWebTool, WEB_TOOLS as WEB_TOOL_DEFINITIONS, WEB_SKILLS } from '@heureum/web'
import { BROWSER_TOOLS as BROWSER_TOOL_DEFINITIONS, BROWSER_SKILLS } from '@heureum/browser'
import { CORE_SKILLS, buildSelectCwdTool } from '@heureum/core-tools'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as os from 'node:os'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

interface ToolDefinition {
  type: string
  name: string
  description?: string
  display_name: string
  parameters?: Record<string, any>
  guide?: string
}

type ToolExecutionResult = {
  success: boolean
  output: string
  images?: Array<{ data: string; mimeType: string }>
  outputPath?: string
}

type ToolPolicyLike = {
  allow?: string[]
  deny?: string[]
}

export type ToolPolicyPipelineStep = {
  policy?: ToolPolicyLike
  label: string
}

export type ToolPolicyPipelineContext = {
  profilePolicy?: ToolPolicyLike
  providerProfilePolicy?: ToolPolicyLike
  globalPolicy?: ToolPolicyLike
  globalProviderPolicy?: ToolPolicyLike
  agentPolicy?: ToolPolicyLike
  agentProviderPolicy?: ToolPolicyLike
  groupPolicy?: ToolPolicyLike
  runtimePolicy?: ToolPolicyLike
  sandboxPolicy?: ToolPolicyLike
  subagentPolicy?: ToolPolicyLike
  modelProvider?: string
}

const TOOL_POLICY_PATTERN_CACHE = new Map<string, RegExp>()

function normalizeToolName(name: string): string {
  return name.trim().toLowerCase()
}

function parsePolicyList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined
  const parts = raw
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
  return parts.length > 0 ? parts : undefined
}

function resolvePolicyFromEnv(prefix: string): ToolPolicyLike | undefined {
  const allow = parsePolicyList(process.env[`${prefix}_ALLOW`])
  const deny = parsePolicyList(process.env[`${prefix}_DENY`])
  if (!allow && !deny) return undefined
  return { allow, deny }
}

function resolvePolicy(
  explicit: ToolPolicyLike | undefined,
  envPrefix: string,
): ToolPolicyLike | undefined {
  return explicit ?? resolvePolicyFromEnv(envPrefix)
}

export function buildDefaultToolPolicyPipelineSteps(
  params?: ToolPolicyPipelineContext,
): ToolPolicyPipelineStep[] {
  return [
    {
      policy: resolvePolicy(params?.profilePolicy, 'HEUREUM_TOOLS_PROFILE'),
      label: 'tools.profile',
    },
    {
      policy: resolvePolicy(params?.providerProfilePolicy, 'HEUREUM_TOOLS_PROVIDER_PROFILE'),
      label: 'tools.byProvider.profile',
    },
    {
      policy: resolvePolicy(params?.globalPolicy, 'HEUREUM_TOOLS'),
      label: 'tools.global',
    },
    {
      policy: resolvePolicy(params?.globalProviderPolicy, 'HEUREUM_TOOLS_BY_PROVIDER'),
      label: 'tools.byProvider.global',
    },
    {
      policy: resolvePolicy(params?.agentPolicy, 'HEUREUM_AGENT_TOOLS'),
      label: 'tools.agent',
    },
    {
      policy: resolvePolicy(params?.agentProviderPolicy, 'HEUREUM_AGENT_TOOLS_BY_PROVIDER'),
      label: 'tools.byProvider.agent',
    },
    {
      policy: resolvePolicy(params?.groupPolicy, 'HEUREUM_GROUP_TOOLS'),
      label: 'tools.group',
    },
    { policy: params?.runtimePolicy, label: 'tools.runtime' },
    {
      policy: resolvePolicy(params?.sandboxPolicy, 'HEUREUM_SANDBOX_TOOLS'),
      label: 'tools.sandbox',
    },
    {
      policy: resolvePolicy(params?.subagentPolicy, 'HEUREUM_SUBAGENT_TOOLS'),
      label: 'tools.subagent',
    },
  ]
}

function toPatternRegex(pattern: string): RegExp {
  const normalized = normalizeToolName(pattern)
  const cached = TOOL_POLICY_PATTERN_CACHE.get(normalized)
  if (cached) {
    return cached
  }
  const escaped = normalized.replace(/[.+?^${}()|[\]\\]/g, '\\$&')
  const regex = new RegExp(`^${escaped.replace(/\*/g, '.*')}$`)
  TOOL_POLICY_PATTERN_CACHE.set(normalized, regex)
  return regex
}

function matchesToolPattern(toolName: string, pattern: string): boolean {
  return toPatternRegex(pattern).test(normalizeToolName(toolName))
}

export function isToolAllowedByPolicyName(toolName: string, policy?: ToolPolicyLike): boolean {
  if (!policy) return true
  const deny = policy.deny?.filter((entry) => entry.trim().length > 0) ?? []
  if (deny.some((pattern) => matchesToolPattern(toolName, pattern))) {
    return false
  }
  const allow = policy.allow?.filter((entry) => entry.trim().length > 0) ?? []
  if (allow.length === 0) {
    return true
  }
  return allow.some((pattern) => matchesToolPattern(toolName, pattern))
}

export function filterToolsByPolicy(tools: ToolDefinition[], policy?: ToolPolicyLike): ToolDefinition[] {
  if (!policy) return tools
  return tools.filter((tool) => isToolAllowedByPolicyName(tool.name, policy))
}

export function applyToolPolicyPipeline(params: {
  tools: ToolDefinition[]
  steps: ToolPolicyPipelineStep[]
}): ToolDefinition[] {
  let filtered = params.tools
  for (const step of params.steps) {
    if (!step.policy) continue
    filtered = filterToolsByPolicy(filtered, step.policy)
  }
  return filtered
}

function isGeminiProvider(modelProvider?: string): boolean {
  const normalized = modelProvider?.trim().toLowerCase() ?? ''
  return normalized.includes('google') || normalized.includes('gemini')
}

function isAnthropicProvider(modelProvider?: string): boolean {
  const normalized = modelProvider?.trim().toLowerCase() ?? ''
  return normalized.includes('anthropic') || normalized.includes('google-antigravity')
}

function extractEnumValues(schema: unknown): unknown[] | undefined {
  if (!schema || typeof schema !== 'object') return undefined
  const record = schema as Record<string, unknown>
  if (Array.isArray(record.enum)) return record.enum
  if ('const' in record) return [record.const]
  const variants = Array.isArray(record.anyOf)
    ? record.anyOf
    : Array.isArray(record.oneOf)
      ? record.oneOf
      : null
  if (!variants) return undefined
  const values = variants.flatMap((variant) => extractEnumValues(variant) ?? [])
  return values.length > 0 ? values : undefined
}

function mergePropertySchemas(existing: unknown, incoming: unknown): unknown {
  if (!existing) return incoming
  if (!incoming) return existing

  const existingEnum = extractEnumValues(existing)
  const incomingEnum = extractEnumValues(incoming)
  if (!existingEnum && !incomingEnum) return existing

  const values = Array.from(new Set([...(existingEnum ?? []), ...(incomingEnum ?? [])]))
  const merged: Record<string, unknown> = {}
  for (const source of [existing, incoming]) {
    if (!source || typeof source !== 'object') continue
    const record = source as Record<string, unknown>
    for (const key of ['title', 'description', 'default']) {
      if (!(key in merged) && key in record) {
        merged[key] = record[key]
      }
    }
  }
  const typeSet = new Set(values.map((value) => typeof value))
  if (typeSet.size === 1) {
    merged.type = Array.from(typeSet)[0]
  }
  merged.enum = values
  return merged
}

const GEMINI_STRIP_KEYS = new Set([
  '$defs',
  '$ref',
  'allOf',
  'anyOf',
  'oneOf',
  'if',
  'then',
  'else',
  'not',
  'patternProperties',
  'unevaluatedProperties',
  'contains',
  'dependentSchemas',
  'dependentRequired',
])

function cleanSchemaForGemini(schema: unknown): unknown {
  if (Array.isArray(schema)) {
    return schema.map((entry) => cleanSchemaForGemini(entry))
  }
  if (!schema || typeof schema !== 'object') {
    return schema
  }
  const record = schema as Record<string, unknown>
  const next: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(record)) {
    if (GEMINI_STRIP_KEYS.has(key)) continue
    next[key] = cleanSchemaForGemini(value)
  }
  return next
}

function normalizeToolParametersSchema(
  schema: Record<string, unknown>,
  modelProvider?: string,
): Record<string, unknown> {
  const gemini = isGeminiProvider(modelProvider)
  const anthropic = isAnthropicProvider(modelProvider)
  if ('type' in schema && 'properties' in schema && !Array.isArray(schema.anyOf) && !Array.isArray(schema.oneOf)) {
    return (gemini && !anthropic ? cleanSchemaForGemini(schema) : schema) as Record<string, unknown>
  }

  if (
    !('type' in schema)
    && (typeof schema.properties === 'object' || Array.isArray(schema.required))
    && !Array.isArray(schema.anyOf)
    && !Array.isArray(schema.oneOf)
  ) {
    const schemaWithType: Record<string, unknown> = { ...schema, type: 'object' }
    return (gemini && !anthropic
      ? cleanSchemaForGemini(schemaWithType)
      : schemaWithType) as Record<string, unknown>
  }

  const variantKey = Array.isArray(schema.anyOf)
    ? 'anyOf'
    : Array.isArray(schema.oneOf)
      ? 'oneOf'
      : null
  if (!variantKey) {
    return (gemini && !anthropic ? cleanSchemaForGemini(schema) : schema) as Record<string, unknown>
  }

  const variants = schema[variantKey] as unknown[]
  const mergedProperties: Record<string, unknown> = {}
  const requiredCounts = new Map<string, number>()
  let objectVariants = 0

  for (const entry of variants) {
    if (!entry || typeof entry !== 'object') continue
    const props = (entry as { properties?: unknown }).properties
    if (!props || typeof props !== 'object') continue
    objectVariants += 1
    for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
      if (!(key in mergedProperties)) {
        mergedProperties[key] = value
      } else {
        mergedProperties[key] = mergePropertySchemas(mergedProperties[key], value)
      }
    }
    const required = Array.isArray((entry as { required?: unknown }).required)
      ? (entry as { required: unknown[] }).required
      : []
    for (const key of required) {
      if (typeof key !== 'string') continue
      requiredCounts.set(key, (requiredCounts.get(key) ?? 0) + 1)
    }
  }

  const baseRequired = Array.isArray(schema.required)
    ? schema.required.filter((key): key is string => typeof key === 'string')
    : undefined
  const mergedRequired = baseRequired && baseRequired.length > 0
    ? baseRequired
    : objectVariants > 0
      ? Array.from(requiredCounts.entries())
        .filter(([, count]) => count === objectVariants)
        .map(([key]) => key)
      : undefined

  const flattenedSchema: Record<string, unknown> = {
    type: 'object',
    ...(typeof schema.title === 'string' ? { title: schema.title } : {}),
    ...(typeof schema.description === 'string' ? { description: schema.description } : {}),
    properties:
      Object.keys(mergedProperties).length > 0 ? mergedProperties : (schema.properties ?? {}),
    ...(mergedRequired && mergedRequired.length > 0 ? { required: mergedRequired } : {}),
    additionalProperties: 'additionalProperties' in schema ? schema.additionalProperties : true,
  }

  return (gemini && !anthropic
    ? cleanSchemaForGemini(flattenedSchema)
    : flattenedSchema) as Record<string, unknown>
}

function normalizeToolDefinitionParameters(
  tool: ToolDefinition,
  options?: { modelProvider?: string },
): ToolDefinition {
  const schema =
    tool.parameters && typeof tool.parameters === 'object'
      ? (tool.parameters as Record<string, unknown>)
      : undefined
  if (!schema) return tool
  return {
    ...tool,
    parameters: normalizeToolParametersSchema(schema, options?.modelProvider),
  }
}

const MARKDOWN_EXTS = new Set(['.md', '.markdown'])
const XML_EXTS = new Set(['.xml', '.rels'])
const MAX_SYNTAX_SCAN_FILES = 2000

function isMarkdownPath(filePath: string): boolean {
  return MARKDOWN_EXTS.has(path.extname(filePath).toLowerCase())
}

function isXmlPath(filePath: string): boolean {
  return XML_EXTS.has(path.extname(filePath).toLowerCase())
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

function resolveCandidatePath(rawPath: string, cwd?: string): string {
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(cwd ?? process.cwd(), rawPath)
}

function looksLikeUrl(value: string): boolean {
  return /^[a-zA-Z][a-zA-Z\d+.-]*:\/\//.test(value)
}

function normalizeRelativePathArg(value: string, cwd: string): string {
  const trimmed = value.trim()
  if (trimmed.length === 0 || looksLikeUrl(trimmed) || path.isAbsolute(trimmed)) {
    return value
  }
  return path.resolve(cwd, value)
}

function normalizeArgKey(key: string): string {
  return key.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase()
}

function isLikelyPathArgKey(key: string): boolean {
  const normalized = normalizeArgKey(key)
  return /(^|_)(path|paths|dir|dirs|directory|directories|workdir|work_dir|working_directory)(_|$)/.test(normalized)
}

function normalizeToolExecutionArgs(
  _toolName: string,
  args: Record<string, unknown>,
  cwd?: string,
): Record<string, unknown> {
  const normalized = { ...args }
  if (!cwd) return normalized

  const hasSessionTaskContext =
    typeof normalized.session_id === 'string'
    && normalized.session_id.trim().length > 0
    && typeof normalized.task_id === 'string'
    && normalized.task_id.trim().length > 0

  // Keep a consistent runtime contract: cwd aliases are auto-filled when omitted.
  if (hasSessionTaskContext && typeof normalized.work_dir !== 'string') {
    normalized.work_dir = cwd
  }
  if (typeof normalized.working_directory !== 'string') {
    normalized.working_directory = cwd
  }
  if (typeof normalized.workdir !== 'string') {
    normalized.workdir = cwd
  }

  for (const [key, value] of Object.entries(normalized)) {
    if (!isLikelyPathArgKey(key)) continue
    if (typeof value === 'string') {
      normalized[key] = normalizeRelativePathArg(value, cwd)
      continue
    }
    if (Array.isArray(value)) {
      normalized[key] = value.map((entry) =>
        typeof entry === 'string' ? normalizeRelativePathArg(entry, cwd) : entry)
    }
  }

  return normalized
}

type ProcessResult = {
  code: number | null
  stderr: string
  spawnError?: string
}

async function runProcess(
  command: string,
  args: string[],
  stdin?: string,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let settled = false
    let stderr = ''
    const finish = (result: ProcessResult) => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const child = spawn(command, args, { stdio: ['pipe', 'ignore', 'pipe'] })
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => {
      finish({ code: null, stderr, spawnError: error.message })
    })
    child.on('close', (code) => {
      finish({ code, stderr })
    })

    if (child.stdin) {
      try {
        if (stdin !== undefined) child.stdin.end(stdin)
        else child.stdin.end()
      } catch {
        // no-op
      }
    }
  })
}

let xmllintAvailable: boolean | null = null

async function hasXmllint(): Promise<boolean> {
  if (xmllintAvailable !== null) return xmllintAvailable
  const result = await runProcess('xmllint', ['--version'])
  xmllintAvailable = !result.spawnError
  return xmllintAvailable
}

async function validateXmlContent(xmlText: string): Promise<string | null> {
  if (!(await hasXmllint())) return null
  const result = await runProcess('xmllint', ['--noout', '-'], xmlText)
  if (result.spawnError) return null
  if (result.code === 0) return null
  return (result.stderr || 'Invalid XML syntax').trim()
}

async function validateXmlFile(filePath: string): Promise<string | null> {
  if (!(await hasXmllint())) return null
  const result = await runProcess('xmllint', ['--noout', filePath])
  if (result.spawnError) return null
  if (result.code === 0) return null
  return (result.stderr || `Invalid XML syntax: ${filePath}`).trim()
}

async function validateMarkdownFile(filePath: string): Promise<string | null> {
  const validation = await handleMdTool('md_validate_document', {
    path: filePath,
    profile: 'strict',
  })

  if (!validation.success) {
    return validation.output || `Markdown validation failed: ${filePath}`
  }

  try {
    const payload = JSON.parse(validation.output) as {
      issues?: Array<{ code?: string; severity?: string; message?: string }>
    }
    const parseError = payload.issues?.find((issue) =>
      issue?.code === 'parse-error' || issue?.severity === 'error'
    )
    if (parseError) {
      return parseError.message || `Invalid Markdown syntax: ${filePath}`
    }
    return null
  } catch {
    return `Markdown validation output parse failed: ${filePath}`
  }
}

async function validateMarkdownContent(markdownText: string): Promise<string | null> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'md-syntax-'))
  const tmpFile = path.join(tmpDir, 'input.md')
  try {
    await fs.writeFile(tmpFile, markdownText, 'utf-8')
    return await validateMarkdownFile(tmpFile)
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true })
  }
}

async function collectSyntaxFiles(rootDir: string): Promise<string[]> {
  const out: string[] = []
  const stack = [rootDir]

  while (stack.length > 0 && out.length < MAX_SYNTAX_SCAN_FILES) {
    const current = stack.pop()
    if (!current) break
    let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        stack.push(fullPath)
        continue
      }
      if (!entry.isFile()) continue
      if (isMarkdownPath(fullPath) || isXmlPath(fullPath)) {
        out.push(fullPath)
        if (out.length >= MAX_SYNTAX_SCAN_FILES) break
      }
    }
  }

  return out
}

async function validatePathSyntax(targetPath: string): Promise<string[]> {
  const resolved = path.resolve(targetPath)
  if (!(await pathExists(resolved))) return []

  const stat = await fs.stat(resolved)
  const files = stat.isDirectory()
    ? await collectSyntaxFiles(resolved)
    : [resolved]

  const errors: string[] = []
  for (const filePath of files) {
    if (isMarkdownPath(filePath)) {
      const error = await validateMarkdownFile(filePath)
      if (error) errors.push(`[markdown] ${filePath}: ${error}`)
      continue
    }
    if (isXmlPath(filePath)) {
      const error = await validateXmlFile(filePath)
      if (error) errors.push(`[xml] ${filePath}: ${error}`)
    }
  }
  return errors
}

function readStringArg(args: Record<string, unknown>, key: string): string | null {
  const value = args[key]
  return typeof value === 'string' && value.trim().length > 0 ? value : null
}

async function runPreSyntaxValidation(
  args: Record<string, unknown>,
  cwd?: string,
): Promise<string[]> {
  const errors: string[] = []

  const markdownText = readStringArg(args, 'markdown')
  if (markdownText !== null) {
    const error = await validateMarkdownContent(markdownText)
    if (error) errors.push(`[markdown-content] ${error}`)
  }

  const content = readStringArg(args, 'content')
  const pathHint = readStringArg(args, 'path') ?? readStringArg(args, 'output_path')
  if (content !== null && pathHint) {
    if (isMarkdownPath(pathHint)) {
      const error = await validateMarkdownContent(content)
      if (error) errors.push(`[markdown-content] ${error}`)
    } else if (isXmlPath(pathHint)) {
      const error = await validateXmlContent(content)
      if (error) errors.push(`[xml-content] ${error}`)
    }
  }

  const pathKeys = ['input_path', 'path', 'source_path']
  for (const key of pathKeys) {
    const rawPath = readStringArg(args, key)
    if (!rawPath) continue
    const resolved = resolveCandidatePath(rawPath, cwd)
    if (!(await pathExists(resolved))) continue

    if (isMarkdownPath(resolved)) {
      const error = await validateMarkdownFile(resolved)
      if (error) errors.push(`[markdown-pre] ${resolved}: ${error}`)
    } else if (isXmlPath(resolved)) {
      const error = await validateXmlFile(resolved)
      if (error) errors.push(`[xml-pre] ${resolved}: ${error}`)
    }
  }

  return errors
}

async function runPostSyntaxValidation(
  args: Record<string, unknown>,
  outputPath: string | undefined,
  cwd?: string,
): Promise<string[]> {
  const targets = new Set<string>()

  if (outputPath) targets.add(resolveCandidatePath(outputPath, cwd))

  const outputPathArg = readStringArg(args, 'output_path')
  if (outputPathArg) targets.add(resolveCandidatePath(outputPathArg, cwd))

  const directPathArg = readStringArg(args, 'path')
  if (directPathArg) targets.add(resolveCandidatePath(directPathArg, cwd))

  const taskDirArg = readStringArg(args, 'task_dir')
  if (taskDirArg) targets.add(resolveCandidatePath(taskDirArg, cwd))

  const errors: string[] = []
  for (const target of targets) {
    const targetErrors = await validatePathSyntax(target)
    if (targetErrors.length > 0) errors.push(...targetErrors)
  }

  return errors
}

const codingToolset = createCodingToolset()
const CODING_TOOLS = codingToolsList()
const BASH_TOOLS = bashToolsList()
const DOCX_TOOLS: ToolDefinition[] = docxToolsList().map((tool) => ({ ...tool, type: 'function' } as ToolDefinition))
const PDF_TOOLS = pdfToolsList()
const PPT_TOOLS = PPT_TOOL_DEFINITIONS
const XLSX_TOOLS = xlsxToolsList()
const MD_TOOLS = mdToolsList()
const HWPX_TOOLS = hwpxToolsList()
const WEB_TOOLS = WEB_TOOL_DEFINITIONS

/** The non-bash coding tools (read, edit, write, grep, find, ls). */
export const NON_BASH_CODING_TOOLS = CODING_TOOLS
export const CODING_TOOL_NAMES = new Set(NON_BASH_CODING_TOOLS.map(t => t.name))
export const BASH_TOOL_NAMES = new Set(BASH_TOOLS.map(t => t.name))
export const DOCX_TOOL_NAMES = new Set(DOCX_TOOLS.map(t => t.name))
export const PDF_TOOL_NAMES = new Set(PDF_TOOLS.map(t => t.name))
export const PPT_TOOL_NAMES = new Set(PPT_TOOLS.map(t => t.name))
export const XLSX_TOOL_NAMES = new Set(XLSX_TOOLS.map(t => t.name))
export const MD_TOOL_NAMES = new Set(MD_TOOLS.map(t => t.name))
export const HWPX_TOOL_NAMES = new Set(HWPX_TOOLS.map(t => t.name))
export const WEB_TOOL_NAMES = new Set(WEB_TOOLS.map(t => t.name))

const BASE_EXECUTABLE_TOOLS: ToolDefinition[] = [
  ...(BASH_TOOLS as ToolDefinition[]),
  ...(NON_BASH_CODING_TOOLS as ToolDefinition[]),
  ...DOCX_TOOLS,
  ...(PDF_TOOLS as ToolDefinition[]),
  ...(PPT_TOOLS as ToolDefinition[]),
  ...(XLSX_TOOLS as ToolDefinition[]),
  ...(MD_TOOLS as ToolDefinition[]),
  ...(HWPX_TOOLS as ToolDefinition[]),
  ...(WEB_TOOLS as ToolDefinition[]),
]

export function getExecutableTools(params?: ToolPolicyPipelineContext): ToolDefinition[] {
  const steps = buildDefaultToolPolicyPipelineSteps(params)
  const filtered = applyToolPolicyPipeline({ tools: BASE_EXECUTABLE_TOOLS, steps })
  return filtered.map((tool) => normalizeToolDefinitionParameters(tool, { modelProvider: params?.modelProvider }))
}

export function getExecutableToolNameSet(params?: ToolPolicyPipelineContext): Set<string> {
  return new Set(getExecutableTools(params).map((tool) => tool.name))
}

export const EXECUTABLE_TOOLS: ToolDefinition[] = getExecutableTools()

// --- browser tools (from @heureum/browser package) ---

const BROWSER_TOOLS = BROWSER_TOOL_DEFINITIONS as ToolDefinition[]
export const BROWSER_TOOL_NAMES = new Set(BROWSER_TOOLS.map(t => t.name))

// --- getTools: context-based full list ---

export function getTools(context?: { cwd?: string | null; policy?: ToolPolicyPipelineContext }): ToolDefinition[] {
  return [
    ...getExecutableTools(context?.policy),
    buildSelectCwdTool(context?.cwd ?? null),
    ...BROWSER_TOOLS,
  ]
}

/**
 * Unified tool dispatcher for coding + document + web tools.
 * Browser tools are handled by a separate browser IPC channel.
 */
export async function handleToolExecution(
  toolName: string,
  args: Record<string, unknown>,
  cwd?: string,
  policy?: ToolPolicyPipelineContext,
): Promise<ToolExecutionResult> {
  const executionArgs = normalizeToolExecutionArgs(toolName, args, cwd)
  const allowedTools = getExecutableToolNameSet(policy)
  if (!allowedTools.has(toolName)) {
    return { success: false, output: `Tool is not allowed by policy: ${toolName}` }
  }

  const preValidationErrors = await runPreSyntaxValidation(executionArgs, cwd)
  if (preValidationErrors.length > 0) {
    return {
      success: false,
      output:
        '[Syntax validation failed before save]\n'
        + preValidationErrors.join('\n'),
    }
  }

  let rawResult: {
    success: boolean
    output: string
    images?: Array<{ data: string; mimeType: string }>
    outputPath?: string
  } | null = null

  if (CODING_TOOL_NAMES.has(toolName)) {
    rawResult = await codingToolset.execute(toolName, { ...executionArgs, working_directory: cwd })
  } else if (BASH_TOOL_NAMES.has(toolName)) {
    rawResult = await handleBashTool(toolName, executionArgs)
  } else if (DOCX_TOOL_NAMES.has(toolName)) {
    rawResult = await handleDocxTool(toolName, executionArgs)
  } else if (PDF_TOOL_NAMES.has(toolName)) {
    rawResult = await handlePdfTool(toolName, executionArgs)
  } else if (PPT_TOOL_NAMES.has(toolName)) {
    rawResult = await handlePptTool(toolName, executionArgs)
  } else if (XLSX_TOOL_NAMES.has(toolName)) {
    rawResult = await handleXlsxTool(toolName, executionArgs)
  } else if (MD_TOOL_NAMES.has(toolName)) {
    rawResult = await handleMdTool(toolName, executionArgs)
  } else if (HWPX_TOOL_NAMES.has(toolName)) {
    rawResult = await handleHwpxTool(toolName, executionArgs)
  } else if (WEB_TOOL_NAMES.has(toolName)) {
    rawResult = await handleWebTool(toolName, executionArgs)
  }

  if (!rawResult) {
    return { success: false, output: `Unknown tool: ${toolName}` }
  }

  if (!rawResult.success) {
    return {
      success: false,
      output: rawResult.output,
      images: rawResult.images,
      outputPath: rawResult.outputPath,
    }
  }

  const postValidationErrors = await runPostSyntaxValidation(executionArgs, rawResult.outputPath, cwd)
  if (postValidationErrors.length > 0) {
    return {
      success: false,
      output:
        `${rawResult.output}\n\n`
        + '[Syntax validation failed after save]\n'
        + postValidationErrors.join('\n'),
      images: rawResult.images,
      outputPath: rawResult.outputPath,
    }
  }

  return {
    success: rawResult.success,
    output: rawResult.output,
    images: rawResult.images,
    outputPath: rawResult.outputPath,
  }
}

// ---------------------------------------------------------------------------
// Skill registry — OpenClaw "catalog + lazy read" pattern
// ---------------------------------------------------------------------------

export interface SkillsSnapshot {
  version: string | null
  prompt: string
  skills: Array<{
    name: string
    description: string
    location: string
    tools: string[]
    body?: string
  }>
}

const SKILLS_CACHE_DIR = path.join(os.homedir(), '.cache', 'heureum-skills')

const ALL_SKILLS: SkillDefinition[] = [
  ...(CORE_SKILLS as SkillDefinition[]),
  ...CODING_SKILLS,
  ...BASH_SKILLS,
  ...DOCX_SKILLS,
  ...WEB_SKILLS,
  ...PDF_SKILLS,
  ...PPT_SKILLS,
  ...XLSX_SKILLS,
  ...MD_SKILLS,
  ...HWPX_SKILLS,
  ...BROWSER_SKILLS,
]

/**
 * Compute a version hash from all workflow prompts for cache invalidation.
 */
function computeSkillsVersionHash(): string {
  const hash = createHash('sha256')
  for (const skill of ALL_SKILLS) {
    hash.update(skill.name)
    hash.update(skill.workflowPrompt)
  }
  return hash.digest('hex').slice(0, 16)
}

/**
 * Write SKILL.md files to ~/.cache/heureum-skills/{name}/SKILL.md
 * so the model can `read` them on demand.
 * Only rewrites files when the content has changed (hash comparison).
 */
export async function writeSkillFiles(): Promise<void> {
  const versionHash = computeSkillsVersionHash()
  const versionFile = path.join(SKILLS_CACHE_DIR, '.version')

  // Check if the cached version matches
  try {
    const existingVersion = await fs.readFile(versionFile, 'utf-8')
    if (existingVersion.trim() === versionHash) {
      return // All files are up to date
    }
  } catch {
    // Version file doesn't exist — write all files
  }

  for (const skill of ALL_SKILLS) {
    const dir = path.join(SKILLS_CACHE_DIR, skill.name)
    await fs.mkdir(dir, { recursive: true })
    await fs.writeFile(path.join(dir, 'SKILL.md'), skill.workflowPrompt, 'utf-8')
  }

  // Write version marker
  await fs.mkdir(SKILLS_CACHE_DIR, { recursive: true })
  await fs.writeFile(versionFile, versionHash, 'utf-8')
}

/**
 * Build the <available_skills> prompt block (OpenClaw catalog style).
 */
function buildSkillsCatalog(): string {
  const lines = ['<available_skills>']
  lines.push('Below is the list of available skill packages. When you need to use')
  lines.push('tools from a skill, first read its SKILL.md file to learn the workflow.')
  lines.push('')
  for (const skill of ALL_SKILLS) {
    const loc = path.join(SKILLS_CACHE_DIR, skill.name, 'SKILL.md')
    lines.push(`<skill name="${skill.name}" description="${skill.description}" location="${loc}">`)
    lines.push(`  tools: ${skill.tools.join(', ')}`)
    lines.push('</skill>')
  }
  lines.push('</available_skills>')
  return lines.join('\n')
}

/**
 * Get the full skills snapshot for the server request.
 */
export function getSkillsSnapshot(): SkillsSnapshot {
  return {
    version: computeSkillsVersionHash(),
    prompt: buildSkillsCatalog(),
    skills: ALL_SKILLS.map(skill => ({
      name: skill.name,
      description: skill.description,
      location: path.join(SKILLS_CACHE_DIR, skill.name, 'SKILL.md'),
      tools: skill.tools,
      body: skill.workflowPrompt,
    })),
  }
}
