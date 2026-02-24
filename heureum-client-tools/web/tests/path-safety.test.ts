import { describe, expect, it } from 'vitest'
import {
  escapePathForReadHint,
  sanitizeFileToken,
  sanitizePathSegment,
} from '../src/path-safety.js'

describe('path safety helpers', () => {
  it('normalizes hostname-like tokens for filenames', () => {
    expect(sanitizeFileToken('example.com')).toBe('example.com')
    expect(sanitizeFileToken('[::1]')).toBe('1')
  })

  it('avoids Windows reserved basenames', () => {
    expect(sanitizeFileToken('CON')).toBe('CON_')
    expect(sanitizeFileToken('nul')).toBe('nul_')
  })

  it('sanitizes path segments with deterministic hash on unsafe input', () => {
    const safe = sanitizePathSegment('..\\..\\CON', { fallback: 'session' })
    expect(safe).toMatch(/^[\p{L}\p{N}._-]+$/u)
    expect(safe).not.toContain('..')
    expect(safe.toLowerCase()).not.toBe('con')
  })

  it('escapes backslashes and quotes for read hint strings', () => {
    const escaped = escapePathForReadHint('C:\\tmp\\a"b.md')
    expect(escaped).toBe('C:\\\\tmp\\\\a\\"b.md')
  })
})
