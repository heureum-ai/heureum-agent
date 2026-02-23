import { describe, expect, it } from 'vitest'

import { MOBILE_TOOLS } from '../src/tool-schema.js'
import { MOBILE_TOOL_NAMES, isMobileToolName } from '../src/tools.js'

describe('mobile tools', () => {
  it('has matching mobile tool names', () => {
    const names = new Set(MOBILE_TOOLS.map((tool) => tool.name))
    expect(names).toEqual(MOBILE_TOOL_NAMES)
  })

  it('checks mobile tool names', () => {
    expect(isMobileToolName('get_device_info')).toBe(true)
    expect(isMobileToolName('unknown_tool')).toBe(false)
  })
})

