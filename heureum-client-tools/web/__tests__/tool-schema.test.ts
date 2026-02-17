import { describe, it, expect, beforeEach, vi } from 'vitest'
import { BOUNDARY_START, BOUNDARY_END } from '../src/content-safety.js'
import {
  stripSecurityWrapper,
  truncateAtWord,
  buildSnippet,
  handleWebTool,
} from '../src/tool-schema.js'
import { fetchCache } from '../src/cache.js'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// --- stripSecurityWrapper ---

describe('stripSecurityWrapper', () => {
  it('extracts content between boundary markers', () => {
    const wrapped =
      `${BOUNDARY_START}\nSource: Web Fetch\n---\nHello world\n${BOUNDARY_END}`
    expect(stripSecurityWrapper(wrapped)).toBe('Hello world')
  })

  it('returns original text when no boundary markers', () => {
    expect(stripSecurityWrapper('plain text')).toBe('plain text')
  })

  it('handles content after BOUNDARY_END missing', () => {
    const partial = `${BOUNDARY_START}\nSource: Web Fetch\n---\nHello world`
    // No BOUNDARY_END → returns from \n---\n to end
    expect(stripSecurityWrapper(partial)).toBe('Hello world')
  })

  it('handles security warning prefix before boundary', () => {
    const wrapped =
      `⚠️ SECURITY WARNING\n\n${BOUNDARY_START}\nSource: Web Fetch\n---\nContent here\n${BOUNDARY_END}`
    expect(stripSecurityWrapper(wrapped)).toBe('Content here')
  })

  it('trims trailing whitespace from content', () => {
    const wrapped =
      `${BOUNDARY_START}\nSource: Web Fetch\n---\nContent   \n\n${BOUNDARY_END}`
    expect(stripSecurityWrapper(wrapped)).toBe('Content')
  })

  it('returns text when no --- separator found', () => {
    const broken = `${BOUNDARY_START}\nno separator here`
    expect(stripSecurityWrapper(broken)).toBe(broken)
  })
})

// --- truncateAtWord ---

describe('truncateAtWord', () => {
  it('returns text as-is when under limit', () => {
    expect(truncateAtWord('short', 100)).toBe('short')
  })

  it('returns text as-is when exactly at limit', () => {
    const text = 'a'.repeat(100)
    expect(truncateAtWord(text, 100)).toBe(text)
  })

  it('truncates at last space before limit', () => {
    const text = 'hello world this is a long sentence'
    const result = truncateAtWord(text, 20)
    expect(result).toBe('hello world this is...')
    expect(result.length).toBeLessThanOrEqual(24) // 20 + '...'
  })

  it('truncates at limit when no good word boundary (space too early)', () => {
    // 'a' + 99 'b's — space is at position 0 (< 80% of 10)
    const text = 'a ' + 'b'.repeat(98)
    const result = truncateAtWord(text, 10)
    // space at index 1, which is < 10 * 0.8 = 8, so falls back to hard cut
    expect(result).toBe('a bbbbbbbb...')
  })

  it('adds ... suffix', () => {
    const text = 'word '.repeat(100)
    const result = truncateAtWord(text, 20)
    expect(result).toMatch(/\.\.\.$/);
  })
})

// --- buildSnippet ---

describe('buildSnippet', () => {
  const outputPath = '/tmp/web_fetch_example_123.json'

  it('builds header with metadata', () => {
    const parsed = { title: 'My Page', url: 'https://example.com', status: 200, total_length: 5000, text: '' }
    const result = buildSnippet(parsed, outputPath)
    expect(result).toContain('[web_fetch] My Page')
    expect(result).toContain('URL: https://example.com')
    expect(result).toContain('Status: 200 | 5000 chars')
    expect(result).toContain(`Saved to ${outputPath}`)
  })

  it('returns header only when no text', () => {
    const parsed = { title: 'Page', url: 'https://x.com', status: 200, total_length: 0 }
    const result = buildSnippet(parsed, outputPath)
    expect(result).not.toContain('---')
    expect(result).not.toContain('Truncated')
  })

  it('includes full content for short pages', () => {
    const content = 'Short page content'
    const parsed = {
      title: 'Short',
      url: 'https://x.com',
      status: 200,
      total_length: content.length,
      text: content, // no boundary wrapper
    }
    const result = buildSnippet(parsed, outputPath)
    expect(result).toContain('---\nShort page content\n---')
    expect(result).not.toContain('Truncated')
  })

  it('truncates long content and adds read hint', () => {
    const content = 'word '.repeat(1000) // 5000 chars
    const parsed = {
      title: 'Long',
      url: 'https://x.com',
      status: 200,
      total_length: 5000,
      text: content,
    }
    const result = buildSnippet(parsed, outputPath)
    expect(result).toContain('...\n---')
    expect(result).toContain(`[Truncated. Use read(path="${outputPath}") for full content.]`)
  })

  it('strips security wrapper before building snippet', () => {
    const inner = 'Actual page content here'
    const wrapped = `${BOUNDARY_START}\nSource: Web Fetch\n---\n${inner}\n${BOUNDARY_END}`
    const parsed = {
      title: 'Wrapped',
      url: 'https://x.com',
      status: 200,
      total_length: inner.length,
      text: wrapped,
    }
    const result = buildSnippet(parsed, outputPath)
    expect(result).toContain(inner)
    expect(result).not.toContain(BOUNDARY_START)
    expect(result).not.toContain(BOUNDARY_END)
  })

  it('uses Untitled as default title', () => {
    const parsed = { url: 'https://x.com', status: 200, total_length: 0 }
    const result = buildSnippet(parsed, outputPath)
    expect(result).toContain('[web_fetch] Untitled')
  })
})

// --- handleWebTool integration ---

describe('handleWebTool', () => {
  beforeEach(() => {
    fetchCache.clear()
  })

  it('returns snippet with metadata for real fetch', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-test-'))
    try {
      const result = await handleWebTool('web_fetch', {
        url: 'https://example.com',
        working_directory: tmpDir,
        session_id: 'test-session',
      })
      expect(result.success).toBe(true)
      expect(result.output).toContain('[web_fetch]')
      expect(result.output).toContain('URL: https://example.com')
      expect(result.output).toContain('Status: 200')
      expect(result.output).toContain('Saved to')
      // Should contain content snippet between --- markers
      expect(result.output).toContain('---')
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('saves JSON file to working directory', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-test-'))
    try {
      await handleWebTool('web_fetch', {
        url: 'https://example.com',
        working_directory: tmpDir,
        session_id: 'sid',
      })
      const sessionDir = path.join(tmpDir, 'tmp', 'sid')
      const files = fs.readdirSync(sessionDir)
      expect(files.length).toBe(1)
      expect(files[0]).toMatch(/^web_fetch_example_com_\d+\.json$/)

      const saved = JSON.parse(fs.readFileSync(path.join(sessionDir, files[0]), 'utf-8'))
      expect(saved.url).toBe('https://example.com')
      expect(saved.status).toBe(200)
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('returns raw result when no working directory', async () => {
    const result = await handleWebTool('web_fetch', { url: 'https://example.com' })
    expect(result.success).toBe(true)
    // Without workingDir, returns raw JSON
    const parsed = JSON.parse(result.output)
    expect(parsed.url).toBe('https://example.com')
    expect(parsed.status).toBe(200)
  })

  it('returns error for unknown tool', async () => {
    const result = await handleWebTool('unknown_tool', {})
    expect(result.success).toBe(false)
    expect(result.output).toContain('Unknown web tool')
  })

  it('handles invalid URL gracefully', async () => {
    const result = await handleWebTool('web_fetch', { url: 'not-a-url' })
    // webFetch may return success with error status or throw — either is acceptable
    expect(typeof result.success).toBe('boolean')
    expect(typeof result.output).toBe('string')
    expect(result.output.length).toBeGreaterThan(0)
  })
})
