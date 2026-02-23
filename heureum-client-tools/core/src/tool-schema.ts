import type { ToolDefinition } from './types.js'

const ASK_QUESTION_GUIDE =
  '<tool_guide name="ask_question">\n'
  + 'Use ask_question when you need a user decision before proceeding.\n'
  + 'Provide clear, mutually exclusive choices and set allow_user_input\n'
  + 'to true when a custom answer may be needed.\n'
  + '</tool_guide>'

export const ASK_QUESTION_TOOL: ToolDefinition = {
  type: 'function',
  name: 'ask_question',
  display_name: 'Question',
  description:
    'Ask the user a multiple-choice question when you need clarification or a decision.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user' },
      choices: {
        type: 'array',
        items: {
          oneOf: [
            { type: 'string' },
            {
              type: 'object',
              properties: {
                label: { type: 'string' },
                description: { type: 'string' },
              },
              required: ['label'],
            },
          ],
        },
        description: 'List of choices. Each can be a string or {label, description?}.',
      },
      allow_user_input: {
        type: 'boolean',
        description: 'Whether to allow free-text input',
        default: false,
      },
    },
    required: ['question', 'choices'],
  },
  guide: ASK_QUESTION_GUIDE,
}

export function buildSelectCwdTool(cwd: string | null | undefined): ToolDefinition {
  const cwdStatus = cwd
    ? `Current working directory is: ${cwd}.`
    : 'No working directory is currently set.'
  return {
    type: 'function',
    name: 'select_cwd',
    display_name: 'Select Directory',
    description:
      'Open a native folder picker to select the working directory for local tools. '
      + `${cwdStatus} Call this before running local command tools when needed.`,
    parameters: {
      type: 'object',
      properties: {},
      required: [],
    },
  }
}
