import { PDF_DEFAULTS } from "./configs";

export interface PdfPromptOptions {
  objective?: string;
}

const DEFAULT_OBJECTIVE = "Process PDF files with a reproducible four-step pipeline.";

function section(tag: string, lines: string | string[]): string[] {
  const content = Array.isArray(lines) ? lines : [lines];
  return [`<section name="${tag}">`, ...content, "</section>"];
}

export function buildPdfWorkflowPrompt(options: PdfPromptOptions = {}): string {
  const objective = options.objective ?? DEFAULT_OBJECTIVE;

  return [
    "<prompt>",
    ...section("role", "You are a PDF automation agent."),
    "",
    ...section("mission", objective),
    "",
    ...section("pipeline", [
      "1. pdf_init_task",
      "2. pdf_write_source",
      "3. pdf_write_intermediate",
      "4. pdf_pack_document",
    ]),
    "",
    ...section("output", "Return output_path and key validation details."),
    "</prompt>",
  ].join("\n");
}

export const PDF_WORKFLOW_PROMPT = buildPdfWorkflowPrompt();

type Obj = Record<string, unknown>;

export interface PdfStyleGuidePromptOptions {
  includeSourcePreview?: boolean;
  previewCharLimit?: number;
  maxPages?: number;
}

export interface PdfStyleExtractionPromptOptions {
  referencePath?: string;
}

function asObj(value: unknown): Obj {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Obj;
}

function asArr(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === undefined || value === null) return [];
  return [value];
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toStringSafe(value: unknown, fallback = "-"): string {
  if (value === undefined || value === null) return fallback;
  return String(value);
}

function trimPreview(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... (${text.length - maxChars} more chars)`;
}

function topUsagePairs(usageMap: Obj, maxItems = 3): string {
  const entries = Object.entries(usageMap)
    .map(([key, value]) => [key, toNumber(value, 0)] as const)
    .sort((lhs, rhs) => rhs[1] - lhs[1])
    .slice(0, maxItems);
  if (entries.length === 0) return "-";
  return entries.map(([key, count]) => `${key}:${count}`).join(", ");
}

/**
 * Build style guide prompt from pdf_extract_styles output JSON.
 */
export function buildPdfStyleGuidePrompt(
  extractedStyles: Record<string, unknown>,
  sourcePreview?: string,
  options: PdfStyleGuidePromptOptions = {},
): string {
  const includeSourcePreview = options.includeSourcePreview ?? true;
  const previewCharLimit = Math.max(800, options.previewCharLimit ?? 5000);
  const maxPages = Math.max(1, options.maxPages ?? 20);

  const root = asObj(extractedStyles);
  const capabilities = asObj(root.capabilities);
  const pages = asArr(root.pages).map(asObj);
  const lines: string[] = [];

  const hasPreview = includeSourcePreview && typeof sourcePreview === "string" && sourcePreview.trim().length > 0;
  const offset = hasPreview ? 1 : 0;
  const pageSectionNo = 2 + offset;
  const typographySectionNo = 3 + offset;
  const skeletonSectionNo = 4 + offset;
  const notesSectionNo = 5 + offset;

  lines.push("# [STYLE SYSTEM] PDF Document Style Guide");
  lines.push("");
  lines.push("> This guide summarizes run-level text style and layout signals extracted from a reference PDF.");
  lines.push("> Because PDF extraction is inherently lossy, reproduce styles within the reliably detectable range.");
  lines.push("");

  lines.push("## 1. Document Snapshot");
  lines.push("");
  lines.push(`- source: ${toStringSafe(root.source)}`);
  lines.push(`- page_count: ${toNumber(root.page_count, 0)}`);
  lines.push(`- extracted_pages: ${toNumber(root.extracted_pages, pages.length)}`);
  lines.push(`- capabilities.bbox: ${toStringSafe(capabilities.bbox, "false")}`);
  lines.push(`- capabilities.font: ${toStringSafe(capabilities.font, "false")}`);
  lines.push(`- capabilities.size: ${toStringSafe(capabilities.size, "false")}`);
  lines.push(`- capabilities.rotation: ${toStringSafe(capabilities.rotation, "false")}`);
  lines.push(`- capabilities.color: ${toStringSafe(capabilities.color, "unknown")}`);
  lines.push("");

  if (hasPreview) {
    lines.push("## 2. Source Text Preview");
    lines.push("");
    lines.push("```text");
    lines.push(trimPreview(sourcePreview!, previewCharLimit));
    lines.push("```");
    lines.push("");
  }

  lines.push(`## ${pageSectionNo}. Page-wise Style Profile`);
  lines.push("");
  lines.push("| page | width | height | totalRuns | lineCount | topFonts | topSizes | runsTruncated |");
  lines.push("|------|-------|--------|-----------|-----------|----------|----------|---------------|");
  for (const page of pages.slice(0, maxPages)) {
    lines.push(
      `| ${toNumber(page.page_number, 0)} | ${toNumber(page.width, 0)} | ${toNumber(page.height, 0)} | ${toNumber(page.total_run_count, 0)} | ${toNumber(page.line_count, 0)} | ${topUsagePairs(asObj(page.font_usage))} | ${topUsagePairs(asObj(page.size_usage))} | ${page.runs_truncated ? "Y" : "N"} |`,
    );
  }
  if (pages.length === 0) {
    lines.push("| - | - | - | - | - | - | - | - |");
  }
  lines.push("");

  const globalFontUsage: Obj = {};
  const globalSizeUsage: Obj = {};
  for (const page of pages) {
    for (const [font, count] of Object.entries(asObj(page.font_usage))) {
      globalFontUsage[font] = toNumber(globalFontUsage[font], 0) + toNumber(count, 0);
    }
    for (const [size, count] of Object.entries(asObj(page.size_usage))) {
      globalSizeUsage[size] = toNumber(globalSizeUsage[size], 0) + toNumber(count, 0);
    }
  }

  lines.push(`## ${typographySectionNo}. Global Typography Patterns`);
  lines.push("");
  lines.push(`- Top font usage: ${topUsagePairs(globalFontUsage, 8)}`);
  lines.push(`- Top size usage: ${topUsagePairs(globalSizeUsage, 8)}`);
  lines.push("");

  lines.push(`## ${skeletonSectionNo}. PDF Operation Skeleton`);
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify({
    path: "<input.pdf>",
    operations: [
      { tool: "parseTemplateStyle", params: { includeRuns: true, maxRunsPerPage: 5000 } },
      { tool: "extractText", params: { pages: [1] } },
    ],
  }, null, 2));
  lines.push("```");
  lines.push("");

  lines.push(`## ${notesSectionNo}. Notes`);
  lines.push("");
  lines.push("1. PDF extraction is text-object based and does not fully reconstruct original drawing commands.");
  lines.push("2. Color data can be partial or unavailable, so semantic correction may still be required.");
  lines.push("3. Line grouping is coordinate-estimated and can be inaccurate on complex layouts.");
  lines.push("4. Add per-page manual verification for multi-column or rotated-text documents.");
  lines.push("5. Documents with many runs may be truncated by maxRunsPerPage sampling.");
  lines.push("");

  return [
    "<prompt>",
    ...section("style_guide_markdown", lines),
    "</prompt>",
  ].join("\n");
}

/**
 * Prompt template describing the PDF style extraction workflow.
 */
export function buildPdfStyleExtractionPrompt(
  options: PdfStyleExtractionPromptOptions = {},
): string {
  const referencePath = options.referencePath ?? PDF_DEFAULTS.prompts.styleGuideReferencePath;
  return [
    "<prompt>",
    ...section("role", "You are a PDF style-template analysis agent."),
    "",
    ...section("mission", `Extract style system from reference PDF \`${referencePath}\` and produce a reusable style guide.`),
    "",
    ...section("workflow", [
      `1. parseTemplateStyle("${referencePath}", { includeRuns: true, maxRunsPerPage: 5000 })`,
      `2. extractText("${referencePath}")`,
      "3. buildPdfStyleGuidePrompt(extractedStyles, sourcePreview)",
    ]),
    "",
    ...section("output", [
      "- Page-wise style profile (font/size/line density)",
      "- Capability limitations summary",
      "- Reusable analysis skeleton",
    ]),
    "</prompt>",
  ].join("\n");
}

export const PDF_STYLE_EXTRACTION_PROMPT = buildPdfStyleExtractionPrompt();
