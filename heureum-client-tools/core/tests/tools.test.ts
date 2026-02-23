import { describe, expect, it } from 'vitest'

import { ASK_QUESTION_TOOL } from '../src/tool-schema.js'
import { CORE_TOOL_NAMES, isCoreToolName } from '../src/tools.js'

describe('core tools', () => {
  it('includes ask_question in core tool names', () => {
    expect(CORE_TOOL_NAMES.has(ASK_QUESTION_TOOL.name)).toBe(true)
  })

  it('checks core tool names', () => {
    expect(isCoreToolName('ask_question')).toBe(true)
    expect(isCoreToolName('unknown_tool')).toBe(false)
  })
})

