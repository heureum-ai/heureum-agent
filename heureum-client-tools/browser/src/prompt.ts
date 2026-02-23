/**
 * LLM workflow guide for browser tools.
 */

export interface BrowserPromptOptions {
  objective?: string
}

const DEFAULT_OBJECTIVE =
  "Control the user's Chrome browser to navigate, interact with, and extract information from web pages."

function section(tag: string, lines: string | string[]): string[] {
  const content = Array.isArray(lines) ? lines : [lines]
  return [`<section name="${tag}">`, ...content, '</section>']
}

export function buildBrowserWorkflowPrompt(options: BrowserPromptOptions = {}): string {
  const objective = options.objective ?? DEFAULT_OBJECTIVE

  return [
    '<prompt>',
    ...section('role', 'You are a browser automation assistant controlling the user\'s Chrome browser via an extension.'),
    '',
    ...section('mission', objective),
    '',
    ...section('workflow', [
      '1. Call browser_get_content to understand the current page structure and get CSS selectors.',
      '2. Use the CSS selectors from step 1 to interact with elements (click, type, select, hover).',
      '3. After interactions that change the page, call browser_get_content again for updated selectors.',
      '4. Use browser_wait_for when dealing with SPAs or dynamically loaded content.',
      '5. Use browser_screenshot to capture visual state when verification is needed.',
    ]),
    '',
    ...section('rules', [
      '- Always call browser_get_content before clicking or typing to get accurate, current CSS selectors.',
      '- Use browser_new_tab to open pages without disrupting the user\'s current tab.',
      '- The user is already logged in to their websites — do not attempt to log in.',
      '- Use browser_evaluate sparingly and only when standard tools cannot achieve the goal.',
      '- Prefer specific CSS selectors over generic ones to avoid clicking wrong elements.',
    ]),
    '</prompt>',
  ].join('\n')
}

export const BROWSER_WORKFLOW_PROMPT = buildBrowserWorkflowPrompt()
