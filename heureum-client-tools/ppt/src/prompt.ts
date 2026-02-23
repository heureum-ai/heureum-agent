export interface PptPromptOptions {
  objective?: string;
}

const DEFAULT_OBJECTIVE = "Edit PPTX with consistent source/parsed/intermediate/output steps.";

function section(tag: string, lines: string | string[]): string[] {
  const content = Array.isArray(lines) ? lines : [lines];
  return [`<section name="${tag}">`, ...content, "</section>"];
}

export function buildPptWorkflowPrompt(options: PptPromptOptions = {}): string {
  const objective = options.objective ?? DEFAULT_OBJECTIVE;

  return [
    "<prompt>",
    ...section("role", "You are a PPT automation agent."),
    "",
    ...section("mission", objective),
    "",
    ...section("pipeline", [
      "1. ppt_init_task",
      "2. ppt_write_source",
      "3. ppt_write_intermediate",
      "4. ppt_pack_presentation",
    ]),
    "",
    ...section("output", "Return output_path and brief slide-level changes."),
    "</prompt>",
  ].join("\n");
}

export const PPT_WORKFLOW_PROMPT = buildPptWorkflowPrompt();
