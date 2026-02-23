import { CODING_DEFAULTS } from "./configs.js";

export interface CodingPromptOptions {
  objective?: string;
}

const DEFAULT_OBJECTIVE =
  "Inspect and edit local source code safely with minimal, deterministic tool calls.";

function section(tag: string, lines: string | string[]): string[] {
  const content = Array.isArray(lines) ? lines : [lines];
  return [`<section name="${tag}">`, ...content, "</section>"];
}

export function buildCodingWorkflowPrompt(options: CodingPromptOptions = {}): string {
  const objective = options.objective ?? DEFAULT_OBJECTIVE;
  const order = CODING_DEFAULTS.workflow.recommendedToolOrder.join(" -> ");

  return [
    "<prompt>",
    ...section("role", "You are a coding assistant operating on the local workspace."),
    "",
    ...section("mission", objective),
    "",
    ...section("tool_names", "Use existing tool names exactly as-is: read, edit, write, grep, find, ls."),
    "",
    ...section("recommended_order", order),
    "",
    ...section("rules", [
      "- Prefer ls/find/grep/read before edit/write.",
      "- Use edit for surgical changes; use write for new files or full rewrites.",
      "- Keep changes minimal and verifiable; report touched paths and outcome.",
    ]),
    "</prompt>",
  ].join("\n");
}

export const CODING_WORKFLOW_PROMPT = buildCodingWorkflowPrompt();
