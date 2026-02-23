import { describe, it, expect } from 'vitest'
import { BROWSER_TOOLS } from '../src/tool-schema.js'

describe('BROWSER_TOOLS', () => {
  it('should export 18 tool definitions', () => {
    expect(BROWSER_TOOLS).toHaveLength(18)
  })

  it('should have unique names', () => {
    const names = BROWSER_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('all tools have type "function"', () => {
    for (const tool of BROWSER_TOOLS) {
      expect(tool.type).toBe('function')
    }
  })

  it('all tools have display_name and description', () => {
    for (const tool of BROWSER_TOOLS) {
      expect(tool.display_name).toBeTruthy()
      expect(tool.description).toBeTruthy()
    }
  })

  it('all tools have name starting with "browser_"', () => {
    for (const tool of BROWSER_TOOLS) {
      expect(tool.name).toMatch(/^browser_/)
    }
  })

  it('all tools have parameters with type "object"', () => {
    for (const tool of BROWSER_TOOLS) {
      expect(tool.parameters).toBeDefined()
      expect((tool.parameters as Record<string, unknown>).type).toBe('object')
    }
  })

  it('navigate tool has guide', () => {
    const navigate = BROWSER_TOOLS.find((t) => t.name === 'browser_navigate')
    expect(navigate?.guide).toBeTruthy()
    expect(navigate?.guide).toContain('browser')
  })

  it('includes all expected tool names', () => {
    const names = new Set(BROWSER_TOOLS.map((t) => t.name))
    const expected = [
      'browser_navigate',
      'browser_new_tab',
      'browser_click',
      'browser_type',
      'browser_get_content',
      'browser_screenshot',
      'browser_hover',
      'browser_select',
      'browser_evaluate',
      'browser_scroll',
      'browser_key_press',
      'browser_back',
      'browser_forward',
      'browser_reload',
      'browser_get_tabs',
      'browser_switch_tab',
      'browser_close_tab',
      'browser_wait_for',
    ]
    for (const name of expected) {
      expect(names.has(name)).toBe(true)
    }
  })

  it('required params are correct for key tools', () => {
    const navigate = BROWSER_TOOLS.find((t) => t.name === 'browser_navigate')
    expect((navigate?.parameters as any).required).toEqual(['url'])

    const click = BROWSER_TOOLS.find((t) => t.name === 'browser_click')
    expect((click?.parameters as any).required).toEqual(['selector'])

    const type = BROWSER_TOOLS.find((t) => t.name === 'browser_type')
    expect((type?.parameters as any).required).toEqual(['selector', 'text'])

    const getContent = BROWSER_TOOLS.find((t) => t.name === 'browser_get_content')
    expect((getContent?.parameters as any).required).toBeUndefined()

    const evaluate = BROWSER_TOOLS.find((t) => t.name === 'browser_evaluate')
    expect((evaluate?.parameters as any).required).toEqual(['script'])
  })
})
