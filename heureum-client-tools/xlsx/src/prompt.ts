import { XLSX_DEFAULTS } from "./configs";

export interface XlsxPromptOptions {
  objective?: string;
}

const DEFAULT_OBJECTIVE = "Edit workbooks with predictable source/parsed/intermediate/output flow.";

function section(tag: string, lines: string | string[]): string[] {
  const content = Array.isArray(lines) ? lines : [lines];
  return [`<section name="${tag}">`, ...content, "</section>"];
}

export function buildXlsxWorkflowPrompt(options: XlsxPromptOptions = {}): string {
  const objective = options.objective ?? DEFAULT_OBJECTIVE;

  return [
    "<prompt>",
    ...section("role", "You are an XLSX automation agent."),
    "",
    ...section("mission", objective),
    "",
    ...section("pipeline", [
      "1. xlsx_init_task",
      "2. xlsx_write_source",
      "3. xlsx_write_intermediate",
      "4. xlsx_pack_workbook",
    ]),
    "",
    ...section("output", "Return output_path and workbook-level validation notes."),
    "</prompt>",
  ].join("\n");
}

export const XLSX_WORKFLOW_PROMPT = buildXlsxWorkflowPrompt();

type Obj = Record<string, unknown>;

export interface XlsxStyleGuidePromptOptions {
  includeSourcePreview?: boolean;
  maxSheets?: number;
  previewLineLimit?: number;
}

export interface XlsxStyleExtractionPromptOptions {
  referencePath?: string;
  sheet?: string;
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

function truncateLines(text: string, maxLines: number): string {
  const lines = text.split(/\r?\n/);
  if (lines.length <= maxLines) return text;
  return [...lines.slice(0, maxLines), `... (${lines.length - maxLines} more lines)`].join("\n");
}

/**
 * Build style guide prompt from xlsx_extract_styles output JSON.
 */
export function buildXlsxStyleGuidePrompt(
  extractedStyles: Record<string, unknown>,
  sourcePreview?: string,
  options: XlsxStyleGuidePromptOptions = {},
): string {
  const includeSourcePreview = options.includeSourcePreview ?? true;
  const maxSheets = Math.max(1, options.maxSheets ?? 20);
  const previewLineLimit = Math.max(10, options.previewLineLimit ?? 160);

  const root = asObj(extractedStyles);
  const workbook = asObj(root.workbook);
  const ooxml = asObj(root.ooxml);
  const styleSheet = asObj(ooxml.styleSheet);
  const shared = asObj(ooxml.sharedStringRichText);
  const inline = asObj(ooxml.inlineRichText);
  const sheets = asArr(root.sheets).map(asObj);
  const lines: string[] = [];

  const hasPreview = includeSourcePreview && typeof sourcePreview === "string" && sourcePreview.trim().length > 0;
  const offset = hasPreview ? 1 : 0;
  const styleTableSectionNo = 2 + offset;
  const sheetSectionNo = 3 + offset;
  const richTextSectionNo = 4 + offset;
  const skeletonSectionNo = 5 + offset;
  const notesSectionNo = 6 + offset;

  lines.push("# [STYLE SYSTEM] XLSX Workbook Style Guide");
  lines.push("");
  lines.push("> This guide is generated from style and structure extracted from a reference XLSX workbook.");
  lines.push("> Author new data content while reusing the style patterns and worksheet structure.");
  lines.push("");

  lines.push("## 1. Workbook Snapshot");
  lines.push("");
  lines.push(`- source: ${toStringSafe(root.source)}`);
  lines.push(`- sheetCount: ${toNumber(root.sheetCount, sheets.length)}`);
  lines.push(`- workbook.created: ${toStringSafe(workbook.created, "null")}`);
  lines.push(`- workbook.modified: ${toStringSafe(workbook.modified, "null")}`);
  lines.push("");

  if (hasPreview) {
    lines.push("## 2. Source Sheet Text Preview");
    lines.push("");
    lines.push("```text");
    lines.push(truncateLines(sourcePreview!, previewLineLimit));
    lines.push("```");
    lines.push("");
  }

  lines.push(`## ${styleTableSectionNo}. OOXML Style Tables`);
  lines.push("");
  lines.push(`- numFmts: ${toNumber(asObj(styleSheet.numFmts).count, 0)}`);
  lines.push(`- fonts: ${toNumber(asObj(styleSheet.fonts).count, 0)}`);
  lines.push(`- fills: ${toNumber(asObj(styleSheet.fills).count, 0)}`);
  lines.push(`- borders: ${toNumber(asObj(styleSheet.borders).count, 0)}`);
  lines.push(`- cellStyleFormats(cellStyleXfs): ${toNumber(asObj(styleSheet.cellStyleFormats).count, 0)}`);
  lines.push(`- cellFormats(cellXfs): ${toNumber(asObj(styleSheet.cellFormats).count, 0)}`);
  lines.push(`- cellStyles: ${toNumber(asObj(styleSheet.cellStyles).count, 0)}`);
  lines.push(`- differentialFormats(dxfs): ${toNumber(asObj(styleSheet.differentialFormats).count, 0)}`);
  lines.push(`- tableStyles: ${toNumber(asObj(styleSheet.tableStyles).count, 0)}`);
  lines.push("");

  lines.push(`## ${sheetSectionNo}. Sheet-wise Style Profile`);
  lines.push("");
  lines.push("| sheet | rowStyles | columnStyles | sampledCellStyles | totalStyledCells | cellsWithStyleId | uniqueStyleCount | uniqueStyleIdCount | CF rules | tables | truncated | styleIdTrunc |");
  lines.push("|-------|-----------|--------------|-------------------|------------------|------------------|------------------|--------------------|----------|--------|-----------|--------------|");
  for (const sheet of sheets.slice(0, maxSheets)) {
    const rowStyles = asArr(sheet.rowStyles);
    const columnStyles = asArr(sheet.columnStyles);
    const cellStyles = asArr(sheet.cellStyles);
    const cf = asArr(sheet.conditionalFormatting);
    const tables = asArr(sheet.tables);
    const styleIdProfile = asObj(sheet.styleIdProfile);
    lines.push(`| ${toStringSafe(sheet.name)} | ${rowStyles.length} | ${columnStyles.length} | ${cellStyles.length} | ${toNumber(sheet.totalStyledCells, 0)} | ${toNumber(sheet.totalCellsWithStyleId, 0)} | ${toNumber(sheet.uniqueStyleCount, 0)} | ${toNumber(sheet.uniqueStyleIdCount, toNumber(styleIdProfile.uniqueStyleIdCount, 0))} | ${cf.length} | ${tables.length} | ${sheet.cellStylesTruncated ? "Y" : "N"} | ${styleIdProfile.cellStyleIdsTruncated ? "Y" : "N"} |`);
  }
  if (sheets.length === 0) {
    lines.push("| - | - | - | - | - | - | - | - | - | - | - | - |");
  }
  lines.push("");

  lines.push(`## ${richTextSectionNo}. Rich Text / Run Styles`);
  lines.push("");
  lines.push(`- totalRichTextStrings: ${toNumber(shared.totalRichTextStrings, 0)}`);
  lines.push(`- sharedRichTextCells: ${toNumber(shared.totalRichTextCells, 0)} / sampled=${asArr(shared.cells).length} / truncated=${shared.truncated ? "Y" : "N"}`);
  lines.push(`- inlineRichTextCells: ${toNumber(inline.totalInlineRichTextCells, 0)} / sampled=${asArr(inline.cells).length} / truncated=${inline.truncated ? "Y" : "N"}`);
  lines.push(`- inlineRichTextRuns: ${toNumber(inline.totalInlineRichTextRuns, 0)}`);
  const firstRich = asObj(asArr(shared.cells)[0]);
  if (Object.keys(firstRich).length > 0) {
    lines.push(`- first sample: ${toStringSafe(firstRich.sheet)}!${toStringSafe(firstRich.cell)} / runs=${asArr(firstRich.runs).length}`);
  }
  lines.push("");

  lines.push(`## ${skeletonSectionNo}. xlsx_create_workbook Call Skeleton`);
  lines.push("");
  lines.push("```json");
  lines.push(JSON.stringify({
    outputPath: "<output.xlsx>",
    sheets: [
      {
        name: "<Sheet1>",
        headerStyle: true,
        data: [
          ["<Header1>", "<Header2>"],
          ["<Value1>", "<Value2>"],
        ],
      },
    ],
  }, null, 2));
  lines.push("```");
  lines.push("");

  lines.push(`## ${notesSectionNo}. Notes`);
  lines.push("");
  lines.push("1. Style samples (cellStyles) may be partial due to extraction limits.");
  lines.push("2. Rich-text cell samples can also be partial due to sampling limits.");
  lines.push("3. If style distribution differs by sheet, define separate templates per sheet.");
  lines.push("4. Validate number formats (numFmt) separately from rendered display strings.");
  lines.push("5. Update conditional formatting and table rules when data ranges change.");
  lines.push("");

  const warnings = asArr(ooxml.warnings).map((w) => toStringSafe(w, ""));
  if (warnings.length > 0) {
    lines.push("### Extraction Warnings");
    lines.push("");
    for (const warning of warnings) lines.push(`- ${warning}`);
    lines.push("");
  }

  return [
    "<prompt>",
    ...section("style_guide_markdown", lines),
    "</prompt>",
  ].join("\n");
}

/**
 * Prompt template describing the XLSX style extraction workflow.
 */
export function buildXlsxStyleExtractionPrompt(
  options: XlsxStyleExtractionPromptOptions = {},
): string {
  const referencePath = options.referencePath ?? XLSX_DEFAULTS.prompts.styleGuideReferencePath;
  const sheetPart = options.sheet ? `, sheet: "${options.sheet}"` : "";
  return [
    "<prompt>",
    ...section("role", "You are an XLSX style-template analysis agent."),
    "",
    ...section("mission", `Extract style system from reference workbook \`${referencePath}\` and produce a reusable style guide.`),
    "",
    ...section("workflow", [
      `1. parseTemplateStyle({ path: "${referencePath}"${sheetPart} })`,
      `2. xlsxRead({ path: "${referencePath}", includeStyles: true${sheetPart} })`,
      "3. buildXlsxStyleGuidePrompt(extractedStyles, sourcePreview)",
    ]),
    "",
    ...section("output", [
      "- Workbook style tables summary",
      "- Sheet-wise style profile",
      "- styleId fidelity profile (row/column/cell refs)",
      "- Rich-text run style summary (sharedStrings + inlineStr)",
      "- Reusable creation/edit skeleton",
    ]),
    "</prompt>",
  ].join("\n");
}

export const XLSX_STYLE_EXTRACTION_PROMPT = buildXlsxStyleExtractionPrompt();
