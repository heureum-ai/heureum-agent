import { describe, it, expect } from 'vitest'
import {
  BROWSER_PAGE_TOOLS,
  BROWSER_MUTATING_TOOLS,
  BROWSER_READ_ONLY_TOOLS,
  BROWSER_POLL_TOOLS,
  ALL_BROWSER_TOOL_NAMES,
  isBrowserToolName,
  prepareBrowserCommand,
} from '../src/tools.js'

describe('Classification sets', () => {
  it('ALL_BROWSER_TOOL_NAMES contains 18 entries', () => {
    expect(ALL_BROWSER_TOOL_NAMES.size).toBe(18)
  })

  it('BROWSER_PAGE_TOOLS contains expected tools', () => {
    expect(BROWSER_PAGE_TOOLS.has('browser_navigate')).toBe(true)
    expect(BROWSER_PAGE_TOOLS.has('browser_click')).toBe(true)
    expect(BROWSER_PAGE_TOOLS.has('browser_get_content')).toBe(true)
    expect(BROWSER_PAGE_TOOLS.has('browser_new_tab')).toBe(true)
    expect(BROWSER_PAGE_TOOLS.has('browser_back')).toBe(true)
    expect(BROWSER_PAGE_TOOLS.has('browser_forward')).toBe(true)
    expect(BROWSER_PAGE_TOOLS.has('browser_reload')).toBe(true)
    expect(BROWSER_PAGE_TOOLS.has('browser_switch_tab')).toBe(true)
  })

  it('BROWSER_MUTATING_TOOLS contains state-changing tools', () => {
    expect(BROWSER_MUTATING_TOOLS.has('browser_click')).toBe(true)
    expect(BROWSER_MUTATING_TOOLS.has('browser_type')).toBe(true)
    expect(BROWSER_MUTATING_TOOLS.has('browser_select')).toBe(true)
    expect(BROWSER_MUTATING_TOOLS.has('browser_evaluate')).toBe(true)
    expect(BROWSER_MUTATING_TOOLS.has('browser_key_press')).toBe(true)
    expect(BROWSER_MUTATING_TOOLS.has('browser_close_tab')).toBe(true)
  })

  it('BROWSER_READ_ONLY_TOOLS does not overlap with mutating (except click in page tools)', () => {
    for (const tool of BROWSER_MUTATING_TOOLS) {
      expect(BROWSER_READ_ONLY_TOOLS.has(tool)).toBe(false)
    }
  })

  it('BROWSER_POLL_TOOLS contains only browser_wait_for', () => {
    expect(BROWSER_POLL_TOOLS.size).toBe(1)
    expect(BROWSER_POLL_TOOLS.has('browser_wait_for')).toBe(true)
  })

  it('every tool is in at least one classification', () => {
    for (const name of ALL_BROWSER_TOOL_NAMES) {
      const inAny =
        BROWSER_PAGE_TOOLS.has(name) ||
        BROWSER_MUTATING_TOOLS.has(name) ||
        BROWSER_READ_ONLY_TOOLS.has(name) ||
        BROWSER_POLL_TOOLS.has(name)
      expect(inAny).toBe(true)
    }
  })
})

describe('isBrowserToolName', () => {
  it('returns true for valid browser tool names', () => {
    expect(isBrowserToolName('browser_navigate')).toBe(true)
    expect(isBrowserToolName('browser_screenshot')).toBe(true)
    expect(isBrowserToolName('browser_wait_for')).toBe(true)
  })

  it('returns false for non-browser tool names', () => {
    expect(isBrowserToolName('read')).toBe(false)
    expect(isBrowserToolName('web_fetch')).toBe(false)
    expect(isBrowserToolName('browser_unknown')).toBe(false)
  })
})

describe('prepareBrowserCommand', () => {
  it('strips browser_ prefix to create action', () => {
    const { action, params } = prepareBrowserCommand('browser_navigate', { url: 'https://example.com' })
    expect(action).toBe('navigate')
    expect(params).toEqual({ url: 'https://example.com' })
  })

  it('handles click tool', () => {
    const { action, params } = prepareBrowserCommand('browser_click', { selector: '#btn' })
    expect(action).toBe('click')
    expect(params).toEqual({ selector: '#btn' })
  })

  it('handles tool with no params', () => {
    const { action, params } = prepareBrowserCommand('browser_get_content', {})
    expect(action).toBe('get_content')
    expect(params).toEqual({})
  })

  it('copies params to avoid mutation', () => {
    const original = { url: 'test' }
    const { params } = prepareBrowserCommand('browser_navigate', original)
    params.extra = 'added'
    expect(original).not.toHaveProperty('extra')
  })
})
