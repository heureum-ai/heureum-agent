import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { WEB_DEFAULTS } from './configs.js'
import { sanitizePathSegment } from './path-safety.js'
import type { TaskContext } from './types.js'

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}


export type WebTaskContext = TaskContext

const DEFAULT_CACHE_DIR_NAME = WEB_DEFAULTS.runtime.cacheDirName

export const WEB_STEP_SOURCE = 'steps/01_source'
export const WEB_STEP_PARSED = 'steps/02_parsed'
export const WEB_STEP_INTERMEDIATE = 'steps/03_intermediate'
export const WEB_STEP_OUTPUT = 'steps/04_output'

export function resolveWebWorkDir(workDir?: string): string {
  if (workDir) return workDir
  const home = os.homedir()
  const cacheParent = path.join(home, '.cache')
  if (fs.existsSync(cacheParent)) {
    return path.join(cacheParent, DEFAULT_CACHE_DIR_NAME)
  }
  return path.join(os.tmpdir(), DEFAULT_CACHE_DIR_NAME)
}

export class WebPipeline {
  private readonly _taskDir: string

  constructor(ctx: WebTaskContext) {
    const base = resolveWebWorkDir(ctx.workDir)
    const sessionId = sanitizePathSegment(ctx.sessionId, { fallback: 'session' })
    const taskType = sanitizePathSegment(ctx.taskType, { fallback: 'task' })
    const taskId = sanitizePathSegment(ctx.taskId, { fallback: 'task' })
    this._taskDir = path.join(base, sessionId, taskType, taskId)
  }

  get taskDir(): string {
    return this._taskDir
  }

  stepPath(rel: string): string {
    return path.join(this._taskDir, rel)
  }

  ensureStepDirs(): void {
    fs.mkdirSync(this.stepPath(WEB_STEP_SOURCE), { recursive: true })
    fs.mkdirSync(this.stepPath(WEB_STEP_PARSED), { recursive: true })
    fs.mkdirSync(this.stepPath(WEB_STEP_INTERMEDIATE), { recursive: true })
    fs.mkdirSync(this.stepPath(WEB_STEP_OUTPUT), { recursive: true })
  }

  async getMeta(): Promise<Record<string, unknown>> {
    const metaPath = this.stepPath('meta.json')
    if (!(await pathExists(metaPath))) return {}
    return JSON.parse((await fs.promises.readFile(metaPath, 'utf-8')))
  }

  async setMeta(data: Record<string, unknown>): Promise<void> {
    ;(await fs.promises.mkdir(this._taskDir, { recursive: true }))
    const metaPath = this.stepPath('meta.json')
    const existing = (await pathExists(metaPath))
      ? JSON.parse((await fs.promises.readFile(metaPath, 'utf-8')))
      : {}
    ;(await fs.promises.writeFile(metaPath, JSON.stringify({ ...existing, ...data }, null, 2), 'utf-8'))
  }
}

export function webPipelineFromTaskDir(taskDir: string): WebPipeline {
  const norm = path.resolve(taskDir)
  const parts = norm.split(path.sep)
  if (parts.length < 4) {
    throw new Error(`Invalid task_dir: ${taskDir}`)
  }
  const taskId = parts[parts.length - 1]
  const taskType = parts[parts.length - 2]
  const sessionId = parts[parts.length - 3]
  const workDir = parts.slice(0, parts.length - 3).join(path.sep) || path.sep
  return new WebPipeline({ sessionId, taskType, taskId, workDir })
}
