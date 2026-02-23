import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export interface SkillDefinition {
  name: string
  description: string
  tools: string[]
  workflowPrompt: string
}

export function parseSkillMd(raw: string): SkillDefinition {
  const parts = raw.split('---')
  if (parts.length < 3) return { name: '', description: '', tools: [], workflowPrompt: raw }
  const frontmatter = parts[1]
  const body = parts.slice(2).join('---').trim()
  const meta: Record<string, string> = {}
  for (const line of frontmatter.trim().split('\n')) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return {
    name: meta.name ?? '',
    description: meta.description ?? '',
    tools: (meta.tools ?? '').split(',').map(s => s.trim()).filter(Boolean),
    workflowPrompt: body,
  }
}

/**
 * Dynamically discover and load all skills from skills/{name}/SKILL.md.
 *
 * Works both bundled (dist/index.js → ../skills/) and unbundled (skills/ → .).
 */
export function loadSkills(): SkillDefinition[] {
  const skillsDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'skills')
  if (!existsSync(skillsDir)) return []
  const skills: SkillDefinition[] = []
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    try {
      const raw = readFileSync(resolve(skillsDir, entry.name, 'SKILL.md'), 'utf-8')
      skills.push(parseSkillMd(raw))
    } catch {
      // No SKILL.md in this subdirectory, skip
    }
  }
  return skills
}
