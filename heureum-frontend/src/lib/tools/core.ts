import type { ToolDefinition } from '../../types';

export const ASK_QUESTION_TOOL: ToolDefinition = {
  type: 'function',
  name: 'ask_question',
  display_name: 'Question',
  description:
    'Ask the user a multiple-choice question when you need clarification or when the user needs to make a decision before proceeding. Present clear choices and optionally allow free-text input.',
  parameters: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'The question to ask the user' },
      choices: {
        type: 'array',
        items: { type: 'string' },
        description: 'List of choices the user can select from',
      },
      allow_user_input: {
        type: 'boolean',
        description:
          'Whether to allow the user to type a custom answer instead of choosing from the list',
        default: false,
      },
    },
    required: ['question', 'choices'],
  },
  guide:
    '<tool_guide name="ask_question">\n'
    + 'You have an ask_question tool for gathering user input through multiple-choice questions.\n'
    + '\n'
    + 'Use this tool when:\n'
    + '- The user\'s request is vague or requires clarification before you can proceed.\n'
    + '- There are multiple valid approaches and the user should choose.\n'
    + '\n'
    + 'When using this tool:\n'
    + '- Provide clear, distinct choices that cover the likely options.\n'
    + '- Set allow_user_input to true when the user might want a custom answer\n'
    + 'beyond your listed choices.\n'
    + '\n'
    + 'Prefer this tool over plain-text questions when you need user input.\n'
    + 'Interactive choices are easier for users to respond to and keep the UI consistent.\n'
    + '</tool_guide>',
};
