export interface MdPromptOptions {
  objective?: string;
  validationProfile?: "gfm" | "commonmark" | "strict";
  includeChecklist?: boolean;
}

const DEFAULT_OBJECTIVE = "Create or edit Markdown files with deterministic pipeline steps.";
const DEFAULT_VALIDATION_PROFILE = "gfm";

function section(tag: string, lines: string | string[]): string[] {
  const content = Array.isArray(lines) ? lines : [lines];
  return [`<section name="${tag}">`, ...content, "</section>"];
}

export function buildMdWorkflowPrompt(options: MdPromptOptions = {}): string {
  const objective = options.objective ?? DEFAULT_OBJECTIVE;
  const validationProfile = options.validationProfile ?? DEFAULT_VALIDATION_PROFILE;
  const includeChecklist = options.includeChecklist ?? true;

  const checklist = includeChecklist
    ? [
        "",
        ...section("checklist", [
          "- Use structured blocks first (heading/paragraph/list/table/code/quote/image).",
          "- Use paragraph runs for mixed inline syntax (bold, italic, strikethrough, underline, highlight, sub/sup, links, footnotes).",
          "- Use definition_list/footnote/html/raw_markdown blocks when extended syntax is needed.",
          "- When editing sections, prefer md_update_section selector or md_transform_document for deterministic edits.",
          "- Run md_validate_document before finalizing; profile=" + validationProfile + ".",
          "- If headings changed, regenerate TOC with md_generate_toc.",
        ]),
      ]
    : [];

  return [
    "<prompt>",
    ...section("role", "You are a Markdown automation agent."),
    "",
    ...section("mission", objective),
    "",
    ...section("pipeline", [
      "1. md_init_task",
      "2. md_write_source",
      "3. md_write_intermediate",
      "4. md_read_parsed (optional quality check)",
      "5. md_validate_document (optional lint/compat check)",
      "6. md_pack_document",
    ]),
    "",
    ...section("edit_tools", [
      "- md_append_content / md_update_section / md_transform_document",
      "- md_manage_frontmatter / md_format_document / md_diff_document",
      "- md_extract_outline / md_extract_style_profile / md_generate_toc",
    ]),
    "",
    ...section("output", "Return output_path and a short summary of applied edits."),
    ...checklist,
    "",
    "</prompt>",
  ].join("\n");
}

export const MD_WORKFLOW_PROMPT = buildMdWorkflowPrompt();
