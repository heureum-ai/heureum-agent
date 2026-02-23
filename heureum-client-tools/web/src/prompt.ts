export interface WebPromptOptions {
  objective?: string
}

const DEFAULT_OBJECTIVE = 'Fetch and sanitize web content with persisted pipeline artifacts.'

function section(tag: string, lines: string | string[]): string[] {
  const content = Array.isArray(lines) ? lines : [lines]
  return [`<section name="${tag}">`, ...content, "</section>"]
}

export function buildWebWorkflowPrompt(options: WebPromptOptions = {}): string {
  const objective = options.objective ?? DEFAULT_OBJECTIVE

  return [
    "<prompt>",
    ...section("role", "You are a web content automation agent."),
    "",
    ...section("mission", objective),
    "",
    ...section("pipeline", [
      "1. web_init_task",
      "2. web_write_source",
      "3. web_write_intermediate",
      "4. web_pack_output",
    ]),
    "",
    ...section("output", "Return output_path and extraction metadata."),
    "</prompt>",
  ].join('\n')
}

export const WEB_WORKFLOW_PROMPT = buildWebWorkflowPrompt()
