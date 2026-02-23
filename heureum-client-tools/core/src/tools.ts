export const ASK_QUESTION_TOOL_NAME = 'ask_question' as const
export const SELECT_CWD_TOOL_NAME = 'select_cwd' as const

export const CORE_TOOL_NAMES = new Set<string>([
  ASK_QUESTION_TOOL_NAME,
  SELECT_CWD_TOOL_NAME,
])

export function isCoreToolName(name: string): boolean {
  return CORE_TOOL_NAMES.has(name)
}

