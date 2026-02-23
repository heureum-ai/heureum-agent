/**
 * XLSX tool implementations using ExcelJS.
 * 25 tool functions covering read, write, format, structure, conversion, and formulas.
 */
import * as fs from "fs";
import * as path from "path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { pack } from "./pack";
import { unpack } from "./unpack";
import { runSoffice } from "./soffice";
import {
  XlsxPipeline,
  XLSX_STEP_INTERMEDIATE,
  XLSX_STEP_OUTPUT,
  XLSX_STEP_PARSED,
  XLSX_STEP_SOURCE,
  xlsxPipelineFromTaskDir,
} from "./pipeline";
import type { ToolResult } from "./types";

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}


export type { ToolResult, XlsxToolResult } from "./types";

// ─────────────────────────────────────────────
// Pipeline helpers
// ─────────────────────────────────────────────

export async function xlsxInitTask(params: {
  session_id: string;
  task_id: string;
  work_dir?: string;
}): Promise<ToolResult> {
  try {
    if (!params.session_id) return { success: false, output: "Missing required parameter: session_id" };
    if (!params.task_id) return { success: false, output: "Missing required parameter: task_id" };

    const pipeline = new XlsxPipeline({
      sessionId: params.session_id,
      taskType: "xlsx",
      taskId: params.task_id,
      workDir: params.work_dir,
    });
    pipeline.ensureStepDirs();
    await pipeline.setMeta({
      sessionId: params.session_id,
      taskType: "xlsx",
      taskId: params.task_id,
      createdAt: new Date().toISOString(),
    });

    return {
      success: true,
      output: `Task initialized at: ${pipeline.taskDir}`,
      outputPath: pipeline.taskDir,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

export async function xlsxWriteSource(params: {
  task_dir: string;
  input_path?: string;
  create_params?: Omit<Parameters<typeof xlsxCreate>[0], "outputPath">;
}): Promise<ToolResult> {
  try {
    if (!params.task_dir) return { success: false, output: "Missing required parameter: task_dir" };
    if (!params.input_path && !params.create_params) {
      return { success: false, output: "Provide either input_path or create_params" };
    }

    const pipeline = xlsxPipelineFromTaskDir(params.task_dir);
    pipeline.ensureStepDirs();
    const sourceDir = pipeline.stepPath(XLSX_STEP_SOURCE);
    const messages: string[] = [];

    if (params.input_path) {
      const inputPath = path.resolve(params.input_path);
      if (!(await pathExists(inputPath))) {
        return { success: false, output: `Error: File not found: ${inputPath}` };
      }
      const target = path.join(sourceDir, "input.xlsx");
      ;(await fs.promises.copyFile(inputPath, target));
      messages.push(`copied source xlsx -> ${target}`);
    }

    if (params.create_params) {
      const target = path.join(sourceDir, "create.json");
      ;(await fs.promises.writeFile(target, JSON.stringify(params.create_params, null, 2), "utf-8"));
      messages.push(`saved create params -> ${target}`);
    }

    await pipeline.setMeta({ updatedAt: new Date().toISOString() });
    return { success: true, output: `Source written: ${messages.join(", ")}` };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

export async function xlsxWriteIntermediate(params: {
  task_dir: string;
}): Promise<ToolResult> {
  try {
    if (!params.task_dir) return { success: false, output: "Missing required parameter: task_dir" };
    const pipeline = xlsxPipelineFromTaskDir(params.task_dir);
    pipeline.ensureStepDirs();

    const sourceDir = pipeline.stepPath(XLSX_STEP_SOURCE);
    const intermediateDir = pipeline.stepPath(XLSX_STEP_INTERMEDIATE);
    const unpackDir = path.join(intermediateDir, "unpacked");
    ;(await fs.promises.rm(unpackDir, { recursive: true, force: true }));

    const createPath = path.join(sourceDir, "create.json");
    const sourceInputPath = path.join(sourceDir, "input.xlsx");
    let sourceXlsxPath = "";

    if ((await pathExists(createPath))) {
      const payload = JSON.parse((await fs.promises.readFile(createPath, "utf-8"))) as Omit<
        Parameters<typeof xlsxCreate>[0],
        "outputPath"
      >;
      const builtPath = path.join(intermediateDir, "source.xlsx");
      const createResult = await xlsxCreate({
        ...payload,
        outputPath: builtPath,
      });
      if (!createResult.success) {
        return { success: false, output: `Failed to build source xlsx: ${createResult.output}` };
      }
      sourceXlsxPath = builtPath;
    } else if ((await pathExists(sourceInputPath))) {
      sourceXlsxPath = sourceInputPath;
    } else {
      return {
        success: false,
        output: "No source found. Run xlsx_write_source first (input_path or create_params).",
      };
    }

    const [, unpackMsg] = await unpack(sourceXlsxPath, unpackDir, {});
    if (unpackMsg.startsWith("Error")) return { success: false, output: unpackMsg };

    await pipeline.setMeta({ updatedAt: new Date().toISOString() });
    return {
      success: true,
      output: `Intermediate generated at: ${unpackDir}`,
      outputPath: unpackDir,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

export async function xlsxPackTask(params: {
  task_dir: string;
  output_path?: string;
}): Promise<ToolResult> {
  try {
    if (!params.task_dir) return { success: false, output: "Missing required parameter: task_dir" };
    const pipeline = xlsxPipelineFromTaskDir(params.task_dir);
    const unpackDir = path.join(pipeline.stepPath(XLSX_STEP_INTERMEDIATE), "unpacked");
    if (!(await pathExists(unpackDir))) {
      return { success: false, output: "Missing intermediate unpacked folder. Run xlsx_write_intermediate or xlsx_unpack first." };
    }

    const outputPath = params.output_path
      ? path.resolve(params.output_path)
      : path.join(pipeline.stepPath(XLSX_STEP_OUTPUT), "result.xlsx");
    const [, packMsg] = await pack(unpackDir, outputPath, { validate: false });
    if (packMsg.startsWith("Error")) return { success: false, output: packMsg };
    return { success: true, output: packMsg, outputPath };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

export async function xlsxUnpackTask(params: {
  task_dir: string;
  input_path: string;
}): Promise<ToolResult> {
  try {
    if (!params.task_dir) return { success: false, output: "Missing required parameter: task_dir" };
    if (!params.input_path) return { success: false, output: "Missing required parameter: input_path" };

    const inputPath = path.resolve(params.input_path);
    if (!(await pathExists(inputPath))) return { success: false, output: `Error: File not found: ${inputPath}` };

    const pipeline = xlsxPipelineFromTaskDir(params.task_dir);
    pipeline.ensureStepDirs();

    const sourcePath = path.join(pipeline.stepPath(XLSX_STEP_SOURCE), "input.xlsx");
    ;(await fs.promises.copyFile(inputPath, sourcePath));

    const unpackDir = path.join(pipeline.stepPath(XLSX_STEP_INTERMEDIATE), "unpacked");
    ;(await fs.promises.rm(unpackDir, { recursive: true, force: true }));
    const [, unpackMsg] = await unpack(inputPath, unpackDir, {});
    if (unpackMsg.startsWith("Error")) return { success: false, output: unpackMsg };

    return { success: true, output: unpackMsg, outputPath: unpackDir };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

export async function xlsxReadParsed(params: {
  task_dir: string;
}): Promise<ToolResult> {
  try {
    if (!params.task_dir) return { success: false, output: "Missing required parameter: task_dir" };
    const pipeline = xlsxPipelineFromTaskDir(params.task_dir);
    const intermediateDir = pipeline.stepPath(XLSX_STEP_INTERMEDIATE);
    const unpackDir = path.join(intermediateDir, "unpacked");
    if (!(await pathExists(unpackDir))) {
      return { success: false, output: "Missing intermediate unpacked folder. Run xlsx_write_intermediate or xlsx_unpack first." };
    }

    const snapshotPath = path.join(intermediateDir, "_snapshot.xlsx");
    const [, packMsg] = await pack(unpackDir, snapshotPath, { validate: false });
    if (packMsg.startsWith("Error")) return { success: false, output: packMsg };

    const readResult = await xlsxRead({ path: snapshotPath });
    if (!readResult.success) return readResult;

    const parsedPath = path.join(pipeline.stepPath(XLSX_STEP_PARSED), "summary.txt");
    ;(await fs.promises.writeFile(parsedPath, readResult.output, "utf-8"));
    return { success: true, output: readResult.output, outputPath: parsedPath };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

export async function xlsxReadSource(params: {
  task_dir: string;
}): Promise<ToolResult> {
  try {
    if (!params.task_dir) return { success: false, output: "Missing required parameter: task_dir" };
    const pipeline = xlsxPipelineFromTaskDir(params.task_dir);
    const sourceDir = pipeline.stepPath(XLSX_STEP_SOURCE);
    const createPath = path.join(sourceDir, "create.json");
    const inputPath = path.join(sourceDir, "input.xlsx");

    if ((await pathExists(createPath))) {
      return {
        success: true,
        output: (await fs.promises.readFile(createPath, "utf-8")),
        outputPath: createPath,
      };
    }

    if ((await pathExists(inputPath))) {
      const readResult = await xlsxRead({ path: inputPath });
      if (!readResult.success) return readResult;
      return { success: true, output: readResult.output, outputPath: inputPath };
    }

    return { success: false, output: "No source found. Run xlsx_write_source first." };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

function defaultOutputPath(inputPath: string): string {
  const dir = path.dirname(inputPath);
  const ext = path.extname(inputPath);
  const base = path.basename(inputPath, ext);
  return path.join(dir, `${base}_modified${ext}`);
}

function toSofficeUserInstallationUri(profileRoot: string): string {
  const slash = profileRoot.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(slash)) {
    return `file:///${encodeURI(slash)}`;
  }
  const normalized = slash.startsWith("/") ? slash : `/${slash}`;
  return `file://${encodeURI(normalized)}`;
}

/** Parse a cell address like "A1" into { col: 1, row: 1 } */
function parseCellAddress(addr: string): { col: number; row: number } {
  const match = addr.match(/^([A-Z]+)(\d+)$/i);
  if (!match) throw new Error(`Invalid cell address: ${addr}`);
  const colStr = match[1].toUpperCase();
  const row = parseInt(match[2], 10);
  let col = 0;
  for (let i = 0; i < colStr.length; i++) {
    col = col * 26 + (colStr.charCodeAt(i) - 64);
  }
  return { col, row };
}

/** Convert a column number (1-based) to letter(s), e.g. 1 → "A", 27 → "AA" */
function colToLetter(col: number): string {
  let s = "";
  while (col > 0) {
    col--;
    s = String.fromCharCode(65 + (col % 26)) + s;
    col = Math.floor(col / 26);
  }
  return s;
}

/**
 * Expand a range like "A1:C3" into an array of { col, row } pairs.
 * Also accepts a single cell like "B2".
 */
function expandRange(range: string): Array<{ col: number; row: number }> {
  const parts = range.split(":");
  if (parts.length === 1) {
    return [parseCellAddress(parts[0])];
  }
  const start = parseCellAddress(parts[0]);
  const end = parseCellAddress(parts[1]);
  const cells: Array<{ col: number; row: number }> = [];
  for (let r = start.row; r <= end.row; r++) {
    for (let c = start.col; c <= end.col; c++) {
      cells.push({ col: c, row: r });
    }
  }
  return cells;
}

function getCellDisplayValue(cell: ExcelJS.Cell): string {
  if (cell.type === ExcelJS.ValueType.Null) return "";
  if (cell.type === ExcelJS.ValueType.Formula) {
    const fv = cell.value as ExcelJS.CellFormulaValue;
    return `=${fv.formula} → ${fv.result ?? ""}`;
  }
  if (cell.type === ExcelJS.ValueType.RichText) {
    const rv = cell.value as ExcelJS.CellRichTextValue;
    return rv.richText.map((r) => r.text).join("");
  }
  if (cell.value instanceof Date) {
    return cell.value.toISOString();
  }
  return String(cell.value ?? "");
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function getCellHtmlValue(cell: ExcelJS.Cell): string {
  if (cell.type === ExcelJS.ValueType.Null) return "";
  if (cell.type === ExcelJS.ValueType.Formula) {
    const value = cell.value as ExcelJS.CellFormulaValue;
    if (value.result !== undefined && value.result !== null) {
      return String(value.result);
    }
    return `=${value.formula ?? ""}`;
  }
  if (cell.type === ExcelJS.ValueType.RichText) {
    const rich = cell.value as ExcelJS.CellRichTextValue;
    return rich.richText.map((run) => run.text).join("");
  }
  if (cell.type === ExcelJS.ValueType.Hyperlink) {
    const hyperlink = cell.value as ExcelJS.CellHyperlinkValue;
    return String(hyperlink.text ?? hyperlink.hyperlink ?? "");
  }
  if (cell.value instanceof Date) {
    return cell.value.toISOString();
  }
  return String(cell.value ?? "");
}

async function renderWorkbookAsHtml(inputPath: string): Promise<string> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(inputPath);

  const lines: string[] = [];
  lines.push("<!doctype html>");
  lines.push("<html>");
  lines.push("<head>");
  lines.push('  <meta charset="utf-8" />');
  lines.push("  <style>");
  lines.push("    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; padding: 16px; }");
  lines.push("    h2 { margin: 24px 0 8px; }");
  lines.push("    table { border-collapse: collapse; margin-bottom: 20px; width: max-content; min-width: 280px; }");
  lines.push("    th, td { border: 1px solid #d1d5db; padding: 4px 8px; vertical-align: top; }");
  lines.push("    th { background: #f3f4f6; font-weight: 600; }");
  lines.push("  </style>");
  lines.push("</head>");
  lines.push("<body>");

  if (workbook.worksheets.length === 0) {
    lines.push("  <p>No worksheets found.</p>");
  } else {
    for (const sheet of workbook.worksheets) {
      lines.push(`  <h2>${escapeHtml(sheet.name)}</h2>`);
      lines.push("  <table>");

      const maxCol = Math.max(1, sheet.columnCount);
      const rowsWithValues: number[] = [];
      for (let rowNum = 1; rowNum <= sheet.rowCount; rowNum++) {
        if (sheet.getRow(rowNum).hasValues) rowsWithValues.push(rowNum);
      }
      if (rowsWithValues.length === 0) rowsWithValues.push(1);

      for (const rowNum of rowsWithValues) {
        const row = sheet.getRow(rowNum);
        const tag = rowNum === 1 ? "th" : "td";
        lines.push("    <tr>");
        for (let col = 1; col <= maxCol; col++) {
          const cellValue = getCellHtmlValue(row.getCell(col));
          lines.push(`      <${tag}>${escapeHtml(cellValue)}</${tag}>`);
        }
        lines.push("    </tr>");
      }
      lines.push("  </table>");
    }
  }

  lines.push("</body>");
  lines.push("</html>");
  return lines.join("\n");
}

// ─────────────────────────────────────────────
// 1. xlsxRead
// ─────────────────────────────────────────────
export async function xlsxRead(params: {
  path: string;
  sheet?: string;
  range?: string;
  includeStyles?: boolean;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const lines: string[] = [];
    lines.push(`File: ${inputPath}`);
    lines.push(`Sheets: ${workbook.worksheets.map((s) => s.name).join(", ")}`);
    lines.push("");

    const sheets = params.sheet
      ? workbook.worksheets.filter((s) => s.name === params.sheet)
      : workbook.worksheets;

    if (params.sheet && sheets.length === 0) {
      return { success: false, output: `Error: Sheet "${params.sheet}" not found` };
    }

    for (const sheet of sheets) {
      lines.push(`--- Sheet: ${sheet.name} ---`);
      lines.push(`Dimensions: ${sheet.dimensions?.toString() ?? "empty"}`);

      // Merged cells
      const mergedCells = (sheet as any)._merges
        ? Object.keys((sheet as any)._merges)
        : [];
      if (mergedCells.length > 0) {
        lines.push(`Merged cells: ${mergedCells.join(", ")}`);
      }

      lines.push("");

      // Determine range to read
      let startRow = 1;
      let endRow = sheet.rowCount;
      let startCol = 1;
      let endCol = sheet.columnCount;

      if (params.range) {
        const rangeParts = params.range.split(":");
        const s = parseCellAddress(rangeParts[0]);
        startRow = s.row;
        startCol = s.col;
        if (rangeParts.length > 1) {
          const e = parseCellAddress(rangeParts[1]);
          endRow = e.row;
          endCol = e.col;
        } else {
          endRow = s.row;
          endCol = s.col;
        }
      }

      for (let r = startRow; r <= endRow; r++) {
        const row = sheet.getRow(r);
        const cellValues: string[] = [];
        for (let c = startCol; c <= endCol; c++) {
          const cell = row.getCell(c);
          const addr = `${colToLetter(c)}${r}`;
          const display = getCellDisplayValue(cell);
          if (display) {
            let entry = `${addr}: ${display}`;
            if (params.includeStyles && cell.style) {
              const styleInfo: string[] = [];
              if (cell.font?.bold) styleInfo.push("bold");
              if (cell.font?.italic) styleInfo.push("italic");
              if (cell.font?.name) styleInfo.push(`font:${cell.font.name}`);
              if (cell.font?.size) styleInfo.push(`size:${cell.font.size}`);
              if (cell.numFmt) styleInfo.push(`fmt:${cell.numFmt}`);
              if (cell.alignment?.horizontal)
                styleInfo.push(`align:${cell.alignment.horizontal}`);
              if (styleInfo.length > 0) {
                entry += ` [${styleInfo.join(", ")}]`;
              }
            }
            cellValues.push(entry);
          }
        }
        if (cellValues.length > 0) {
          lines.push(`Row ${r}: ${cellValues.join(" | ")}`);
        }
      }
      lines.push("");
    }

    return { success: true, output: lines.join("\n") };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

function hasRenderableStyle(style: Partial<ExcelJS.Style> | undefined): boolean {
  if (!style) return false;
  return Boolean(
    style.numFmt
    || style.font
    || style.fill
    || style.border
    || style.alignment
    || style.protection
  );
}

function serializeStyle(style: Partial<ExcelJS.Style> | undefined): Record<string, unknown> | undefined {
  if (!hasRenderableStyle(style)) return undefined;
  return {
    numFmt: style?.numFmt ?? undefined,
    font: style?.font ?? undefined,
    fill: style?.fill ?? undefined,
    border: style?.border ?? undefined,
    alignment: style?.alignment ?? undefined,
    protection: style?.protection ?? undefined,
  };
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function asString(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

function toInt(value: unknown): number | null {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeTargetPath(target: string): string {
  const withoutLeading = target.replace(/^\//, "");
  const normalized = path.posix.normalize(withoutLeading);
  return normalized.replace(/^\.\//, "");
}

function readXmlText(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    if (obj["#text"] !== undefined) return String(obj["#text"]);
  }
  return "";
}

function normalizeXmlNode(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeXmlNode);
  if (value && typeof value === "object") {
    const input = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(input)) {
      const nextKey = key.startsWith("@_") ? key.slice(2) : key;
      out[nextKey] = normalizeXmlNode(child);
    }
    return out;
  }
  return value;
}

function parseCount(container: Record<string, unknown> | undefined, fallbackLength: number): number {
  if (!container) return fallbackLength;
  const raw = container["@_count"];
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallbackLength;
}

async function extractXlsxXmlStyleArtifacts(
  inputPath: string,
  maxRichTextCells: number,
  maxCellsPerSheet: number,
): Promise<{
  styleSheet: Record<string, unknown> | null;
  sharedStringRichText: {
    totalRichTextStrings: number;
    totalRichTextCells: number;
    truncated: boolean;
    cells: Array<{
      sheet: string;
      cell: string | null;
      sharedStringIndex: number;
      text: string;
      runs: Array<{ text: string; style?: Record<string, unknown> }>;
    }>;
  };
  inlineRichText: {
    totalInlineRichTextCells: number;
    totalInlineRichTextRuns: number;
    truncated: boolean;
    cells: Array<{
      sheet: string;
      cell: string | null;
      text: string;
      runs: Array<{ text: string; style?: Record<string, unknown> }>;
    }>;
  };
  sheetStyleIds: Record<string, {
    totalCellsWithStyleId: number;
    uniqueStyleIdCount: number;
    cellStyleIdsTruncated: boolean;
    rowStyleIds: Array<{ row: number; styleId: number }>;
    columnStyleIds: Array<{ min: number; max: number; styleId: number }>;
    cellStyleIds: Array<{ cell: string | null; styleId: number }>;
  }>;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: false,
    trimValues: false,
    processEntities: false,
  });

  const fileBuffer = await fs.promises.readFile(inputPath);
  const zipInput = new Uint8Array(
    fileBuffer.buffer,
    fileBuffer.byteOffset,
    fileBuffer.byteLength,
  );
  const zip = await JSZip.loadAsync(zipInput);

  let styleSheet: Record<string, unknown> | null = null;
  const stylesXml = await zip.file("xl/styles.xml")?.async("string");
  if (stylesXml) {
    try {
      const parsed = parser.parse(stylesXml) as Record<string, unknown>;
      const root = (parsed?.styleSheet ?? {}) as Record<string, unknown>;

      const numFmtContainer = root.numFmts as Record<string, unknown> | undefined;
      const fontsContainer = root.fonts as Record<string, unknown> | undefined;
      const fillsContainer = root.fills as Record<string, unknown> | undefined;
      const bordersContainer = root.borders as Record<string, unknown> | undefined;
      const cellStyleFormatsContainer = root.cellStyleXfs as Record<string, unknown> | undefined;
      const cellFormatsContainer = root.cellXfs as Record<string, unknown> | undefined;
      const cellStylesContainer = root.cellStyles as Record<string, unknown> | undefined;
      const differentialFormatsContainer = root.dxfs as Record<string, unknown> | undefined;
      const tableStylesContainer = root.tableStyles as Record<string, unknown> | undefined;

      const numFmts = toArray(numFmtContainer?.numFmt).map((entry) => normalizeXmlNode(entry));
      const fonts = toArray(fontsContainer?.font).map((entry) => normalizeXmlNode(entry));
      const fills = toArray(fillsContainer?.fill).map((entry) => normalizeXmlNode(entry));
      const borders = toArray(bordersContainer?.border).map((entry) => normalizeXmlNode(entry));
      const cellStyleFormats = toArray(cellStyleFormatsContainer?.xf).map((entry) => normalizeXmlNode(entry));
      const cellFormats = toArray(cellFormatsContainer?.xf).map((entry) => normalizeXmlNode(entry));
      const cellStyles = toArray(cellStylesContainer?.cellStyle).map((entry) => normalizeXmlNode(entry));
      const differentialFormats = toArray(differentialFormatsContainer?.dxf).map((entry) => normalizeXmlNode(entry));
      const tableStyleItems = toArray(tableStylesContainer?.tableStyle).map((entry) => normalizeXmlNode(entry));

      styleSheet = {
        numFmts: {
          count: parseCount(numFmtContainer, numFmts.length),
          items: numFmts,
        },
        fonts: {
          count: parseCount(fontsContainer, fonts.length),
          items: fonts,
        },
        fills: {
          count: parseCount(fillsContainer, fills.length),
          items: fills,
        },
        borders: {
          count: parseCount(bordersContainer, borders.length),
          items: borders,
        },
        cellStyleFormats: {
          count: parseCount(cellStyleFormatsContainer, cellStyleFormats.length),
          items: cellStyleFormats,
        },
        cellFormats: {
          count: parseCount(cellFormatsContainer, cellFormats.length),
          items: cellFormats,
        },
        cellStyles: {
          count: parseCount(cellStylesContainer, cellStyles.length),
          items: cellStyles,
        },
        differentialFormats: {
          count: parseCount(differentialFormatsContainer, differentialFormats.length),
          items: differentialFormats,
        },
        tableStyles: tableStylesContainer
          ? {
            count: parseCount(tableStylesContainer, tableStyleItems.length),
            defaultTableStyle: asString(tableStylesContainer["@_defaultTableStyle"]) || null,
            defaultPivotStyle: asString(tableStylesContainer["@_defaultPivotStyle"]) || null,
            items: tableStyleItems,
          }
          : null,
        colors: root.colors ? normalizeXmlNode(root.colors) : null,
      };
    } catch (error: any) {
      warnings.push(`Failed to parse xl/styles.xml: ${error?.message ?? String(error)}`);
    }
  } else {
    warnings.push("xl/styles.xml not found in workbook package");
  }

  type SharedStringEntry = {
    text: string;
    runs: Array<{ text: string; style?: Record<string, unknown> }>;
  };
  const sharedStrings: SharedStringEntry[] = [];
  const sharedStringsXml = await zip.file("xl/sharedStrings.xml")?.async("string");
  if (sharedStringsXml) {
    try {
      const sst = parser.parse(sharedStringsXml) as Record<string, unknown>;
      const siEntries = toArray((sst?.sst as Record<string, unknown> | undefined)?.si);
      for (const si of siEntries) {
        const entry = si as Record<string, unknown>;
        const directText = readXmlText(entry.t);
        const runs = toArray(entry.r).map((runValue) => {
          const run = runValue as Record<string, unknown>;
          return {
            text: readXmlText(run.t),
            style: run.rPr ? (normalizeXmlNode(run.rPr) as Record<string, unknown>) : undefined,
          };
        });
        const text = directText || runs.map((run) => run.text).join("");
        sharedStrings.push({ text, runs });
      }
    } catch (error: any) {
      warnings.push(`Failed to parse xl/sharedStrings.xml: ${error?.message ?? String(error)}`);
    }
  }

  const richTextByIndex = new Map<number, SharedStringEntry>();
  for (let i = 0; i < sharedStrings.length; i++) {
    if (sharedStrings[i].runs.length > 0) richTextByIndex.set(i, sharedStrings[i]);
  }

  const richTextCells: Array<{
    sheet: string;
    cell: string | null;
    sharedStringIndex: number;
    text: string;
    runs: Array<{ text: string; style?: Record<string, unknown> }>;
  }> = [];
  let totalRichTextCells = 0;
  let richTextCellTruncated = false;
  const inlineRichTextCells: Array<{
    sheet: string;
    cell: string | null;
    text: string;
    runs: Array<{ text: string; style?: Record<string, unknown> }>;
  }> = [];
  let totalInlineRichTextCells = 0;
  let totalInlineRichTextRuns = 0;
  let inlineRichTextTruncated = false;
  const sheetStyleIds: Record<string, {
    totalCellsWithStyleId: number;
    uniqueStyleIdCount: number;
    cellStyleIdsTruncated: boolean;
    rowStyleIds: Array<{ row: number; styleId: number }>;
    columnStyleIds: Array<{ min: number; max: number; styleId: number }>;
    cellStyleIds: Array<{ cell: string | null; styleId: number }>;
  }> = {};

  const [workbookXml, workbookRelsXml] = await Promise.all([
    zip.file("xl/workbook.xml")?.async("string"),
    zip.file("xl/_rels/workbook.xml.rels")?.async("string"),
  ]);
  if (workbookXml && workbookRelsXml) {
    try {
      const workbook = parser.parse(workbookXml) as Record<string, unknown>;
      const workbookRels = parser.parse(workbookRelsXml) as Record<string, unknown>;
      const sheetEntries = toArray(((workbook?.workbook as Record<string, unknown> | undefined)?.sheets as Record<string, unknown> | undefined)?.sheet);
      const relEntries = toArray(((workbookRels?.Relationships as Record<string, unknown> | undefined)?.Relationship));

      const ridToTarget = new Map<string, string>();
      for (const relEntry of relEntries) {
        const rel = relEntry as Record<string, unknown>;
        const rid = asString(rel["@_Id"]);
        const target = asString(rel["@_Target"]);
        if (rid && target) ridToTarget.set(rid, normalizeTargetPath(target));
      }

      const worksheetTargets = sheetEntries.flatMap((sheetEntry) => {
        const sheet = sheetEntry as Record<string, unknown>;
        const sheetName = asString(sheet["@_name"]) || "Sheet";
        const rid = asString(sheet["@_r:id"]);
        const target = ridToTarget.get(rid);
        if (!target) return [];
        return [{ sheetName, worksheetPath: path.posix.join("xl", target) }];
      });

      const worksheetPayloads = await Promise.all(
        worksheetTargets.map(async ({ sheetName, worksheetPath }) => ({
          sheetName,
          worksheetXml: await zip.file(worksheetPath)?.async("string"),
        })),
      );

      for (const { sheetName, worksheetXml } of worksheetPayloads) {
        if (!worksheetXml) continue;

        const worksheet = parser.parse(worksheetXml) as Record<string, unknown>;
        const worksheetRoot = (worksheet?.worksheet as Record<string, unknown> | undefined) ?? {};
        const rows = toArray((worksheetRoot.sheetData as Record<string, unknown> | undefined)?.row);

        const rowStyleIds: Array<{ row: number; styleId: number }> = [];
        const columnStyleIds: Array<{ min: number; max: number; styleId: number }> = [];
        const cellStyleIds: Array<{ cell: string | null; styleId: number }> = [];
        const uniqueStyleIds = new Set<number>();
        let totalCellsWithStyleId = 0;
        let cellStyleIdsTruncated = false;

        const colsContainers = toArray(worksheetRoot.cols);
        for (const colsEntry of colsContainers) {
          const cols = colsEntry as Record<string, unknown>;
          const colEntries = toArray(cols.col);
          for (const colEntry of colEntries) {
            const col = colEntry as Record<string, unknown>;
            const styleId = toInt(col["@_style"]);
            if (styleId === null) continue;
            const min = Math.max(1, toInt(col["@_min"]) ?? 1);
            const max = Math.max(min, toInt(col["@_max"]) ?? min);
            columnStyleIds.push({ min, max, styleId });
            uniqueStyleIds.add(styleId);
          }
        }

        let fallbackRowNumber = 1;
        for (const rowEntry of rows) {
          const row = rowEntry as Record<string, unknown>;
          const rowNumber = Math.max(1, toInt(row["@_r"]) ?? fallbackRowNumber);
          fallbackRowNumber = rowNumber + 1;
          const rowStyleId = toInt(row["@_s"]);
          if (rowStyleId !== null) {
            rowStyleIds.push({ row: rowNumber, styleId: rowStyleId });
            uniqueStyleIds.add(rowStyleId);
          }

          const cells = toArray(row.c);
          for (const cellEntry of cells) {
            const cell = cellEntry as Record<string, unknown>;
            const cellAddr = asString(cell["@_r"]) || null;
            const cellStyleId = toInt(cell["@_s"]);
            if (cellStyleId !== null) {
              totalCellsWithStyleId += 1;
              uniqueStyleIds.add(cellStyleId);
              if (cellStyleIds.length < maxCellsPerSheet) {
                cellStyleIds.push({ cell: cellAddr, styleId: cellStyleId });
              } else {
                cellStyleIdsTruncated = true;
              }
            }

            const cellType = asString(cell["@_t"]);
            if (cellType === "s") {
              const idx = parseInt(readXmlText(cell.v), 10);
              if (!Number.isFinite(idx)) continue;
              const rich = richTextByIndex.get(idx);
              if (!rich) continue;
              totalRichTextCells += 1;

              if (richTextCells.length < maxRichTextCells) {
                richTextCells.push({
                  sheet: sheetName,
                  cell: cellAddr,
                  sharedStringIndex: idx,
                  text: rich.text,
                  runs: rich.runs,
                });
              } else {
                richTextCellTruncated = true;
              }
              continue;
            }

            if (cellType === "inlineStr") {
              const inline = cell.is as Record<string, unknown> | undefined;
              if (!inline) continue;
              const directText = readXmlText(inline.t);
              const runs = toArray(inline.r).map((runValue) => {
                const run = runValue as Record<string, unknown>;
                return {
                  text: readXmlText(run.t),
                  style: run.rPr ? (normalizeXmlNode(run.rPr) as Record<string, unknown>) : undefined,
                };
              });
              if (runs.length === 0) continue;
              const text = directText || runs.map((run) => run.text).join("");
              totalInlineRichTextCells += 1;
              totalInlineRichTextRuns += runs.length;
              if (inlineRichTextCells.length < maxRichTextCells) {
                inlineRichTextCells.push({
                  sheet: sheetName,
                  cell: cellAddr,
                  text,
                  runs,
                });
              } else {
                inlineRichTextTruncated = true;
              }
            }
          }
        }

        sheetStyleIds[sheetName] = {
          totalCellsWithStyleId,
          uniqueStyleIdCount: uniqueStyleIds.size,
          cellStyleIdsTruncated,
          rowStyleIds,
          columnStyleIds,
          cellStyleIds,
        };
      }
    } catch (error: any) {
      warnings.push(`Failed to map rich-text shared strings to worksheet cells: ${error?.message ?? String(error)}`);
    }
  }

  return {
    styleSheet,
    sharedStringRichText: {
      totalRichTextStrings: richTextByIndex.size,
      totalRichTextCells,
      truncated: richTextCellTruncated,
      cells: richTextCells,
    },
    inlineRichText: {
      totalInlineRichTextCells,
      totalInlineRichTextRuns,
      truncated: inlineRichTextTruncated,
      cells: inlineRichTextCells,
    },
    sheetStyleIds,
    warnings,
  };
}

export async function xlsxExtractStyles(params: {
  path: string;
  sheet?: string;
  max_cells_per_sheet?: number;
  max_rich_text_cells?: number;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const selectedSheets = params.sheet
      ? workbook.worksheets.filter((sheet) => sheet.name === params.sheet)
      : workbook.worksheets;
    if (params.sheet && selectedSheets.length === 0) {
      return { success: false, output: `Error: Sheet "${params.sheet}" not found` };
    }

    const maxCellsPerSheet = Math.max(1, params.max_cells_per_sheet ?? 5000);
    const maxRichTextCells = Math.max(1, params.max_rich_text_cells ?? 1000);
    const xmlArtifacts = await extractXlsxXmlStyleArtifacts(inputPath, maxRichTextCells, maxCellsPerSheet);

    const sheets = selectedSheets.map((sheet) => {
      const rowStyles: Array<{ row: number; style: Record<string, unknown>; styleId?: number }> = [];
      const columnStyles: Array<{ column: string; style: Record<string, unknown>; styleId?: number }> = [];
      const cellStyles: Array<{ cell: string; style: Record<string, unknown>; styleId?: number }> = [];
      const styleHistogram: Record<string, number> = {};
      const styleIdProfile = xmlArtifacts.sheetStyleIds[sheet.name] ?? {
        totalCellsWithStyleId: 0,
        uniqueStyleIdCount: 0,
        cellStyleIdsTruncated: false,
        rowStyleIds: [] as Array<{ row: number; styleId: number }>,
        columnStyleIds: [] as Array<{ min: number; max: number; styleId: number }>,
        cellStyleIds: [] as Array<{ cell: string | null; styleId: number }>,
      };
      const rowStyleIdMap = new Map<number, number>(
        styleIdProfile.rowStyleIds.map((entry) => [entry.row, entry.styleId]),
      );
      const cellStyleIdMap = new Map<string, number>(
        styleIdProfile.cellStyleIds
          .filter((entry): entry is { cell: string; styleId: number } => typeof entry.cell === "string")
          .map((entry) => [entry.cell, entry.styleId]),
      );
      const columnStyleIdFor = (columnIndex: number): number | undefined => {
        for (const ref of styleIdProfile.columnStyleIds) {
          if (columnIndex >= ref.min && columnIndex <= ref.max) return ref.styleId;
        }
        return undefined;
      };

      for (let r = 1; r <= sheet.rowCount; r++) {
        const row = sheet.getRow(r);
        const rowStyle = serializeStyle((row as any).style as Partial<ExcelJS.Style> | undefined);
        if (rowStyle) {
          rowStyles.push({
            row: r,
            style: rowStyle,
            styleId: rowStyleIdMap.get(r),
          });
        }
      }

      for (let c = 1; c <= sheet.columnCount; c++) {
        const col = sheet.getColumn(c);
        const colStyle = serializeStyle(col.style as Partial<ExcelJS.Style> | undefined);
        if (colStyle) {
          columnStyles.push({
            column: colToLetter(c),
            style: colStyle,
            styleId: columnStyleIdFor(c),
          });
        }
      }

      let totalStyledCells = 0;
      let truncated = false;
      for (let r = 1; r <= sheet.rowCount; r++) {
        const row = sheet.getRow(r);
        for (let c = 1; c <= sheet.columnCount; c++) {
          const cell = row.getCell(c);
          const style = serializeStyle(cell.style as Partial<ExcelJS.Style> | undefined);
          if (!style) continue;
          totalStyledCells += 1;
          const styleKey = JSON.stringify(style);
          styleHistogram[styleKey] = (styleHistogram[styleKey] ?? 0) + 1;
          if (cellStyles.length < maxCellsPerSheet) {
            const cellRef = `${colToLetter(c)}${r}`;
            cellStyles.push({
              cell: cellRef,
              style,
              styleId: cellStyleIdMap.get(cellRef),
            });
          } else {
            truncated = true;
          }
        }
      }

      const conditionalFormatting = (
        (sheet as any).conditionalFormattings
        ?? (sheet as any).model?.conditionalFormattings
        ?? []
      );
      const tables = (sheet as any).model?.tables ?? [];

      return {
        name: sheet.name,
        state: sheet.state ?? "visible",
        dimensions: sheet.dimensions?.toString() ?? null,
        defaultRowHeight: sheet.properties?.defaultRowHeight ?? null,
        defaultColWidth: sheet.properties?.defaultColWidth ?? null,
        rowStyles,
        columnStyles,
        cellStyles,
        totalStyledCells,
        cellStylesTruncated: truncated,
        uniqueStyleCount: Object.keys(styleHistogram).length,
        uniqueStyleIdCount: styleIdProfile.uniqueStyleIdCount,
        totalCellsWithStyleId: styleIdProfile.totalCellsWithStyleId,
        styleIdProfile,
        conditionalFormatting,
        tables,
      };
    });

    const output = {
      source: inputPath,
      workbook: {
        created: (workbook as any).created ?? null,
        modified: (workbook as any).modified ?? null,
        properties: workbook.properties ?? {},
        calcProperties: workbook.calcProperties ?? {},
        views: (workbook as any).views ?? [],
        customProperties: (workbook as any).model?.customProperties ?? {},
      },
      ooxml: {
        styleSheet: xmlArtifacts.styleSheet,
        sharedStringRichText: xmlArtifacts.sharedStringRichText,
        inlineRichText: xmlArtifacts.inlineRichText,
        warnings: xmlArtifacts.warnings,
      },
      sheetCount: sheets.length,
      sheets,
    };

    return { success: true, output: JSON.stringify(output, null, 2) };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

/**
 * Unified template style parser entrypoint for XLSX toolkit.
 * Keeps backward compatibility by delegating to xlsxExtractStyles.
 */
export async function parseTemplateStyle(
  params: Parameters<typeof xlsxExtractStyles>[0] & {
    preflightRead?: boolean;
    preflight_read?: boolean;
  },
): Promise<ToolResult> {
  const runPreflight = params.preflightRead ?? params.preflight_read ?? true;
  if (runPreflight) {
    const preflight = await xlsxRead({ path: params.path, range: "A1:A1" });
    if (!preflight.success) {
      return {
        success: false,
        output: `Preflight read failed: ${preflight.output}`,
      };
    }
  }
  return xlsxExtractStyles(params);
}

// ─────────────────────────────────────────────
// 2. xlsxUpdateCells
// ─────────────────────────────────────────────
export async function xlsxUpdateCells(params: {
  path: string;
  updates: Array<{ cell: string; value?: string | number | boolean; formula?: string; sheet?: string }>;
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
    let updatedCount = 0;

    for (const update of params.updates) {
      const sheetName = update.sheet ?? workbook.worksheets[0]?.name;
      const sheet = workbook.getWorksheet(sheetName);
      if (!sheet) {
        return { success: false, output: `Error: Sheet "${sheetName}" not found` };
      }

      const cell = sheet.getCell(update.cell);
      if (update.formula !== undefined) {
        cell.value = { formula: update.formula } as ExcelJS.CellFormulaValue;
      } else if (update.value !== undefined) {
        cell.value = update.value;
      }
      updatedCount++;
    }

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `Updated ${updatedCount} cell(s). Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 3. xlsxInsertRows
// ─────────────────────────────────────────────
export async function xlsxInsertRows(params: {
  path: string;
  sheet?: string;
  startRow: number;
  rows: Array<Array<string | number | boolean | null>>;
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);

    // insertRows: position, values, style inheritance
    sheet.insertRows(params.startRow, params.rows);

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `Inserted ${params.rows.length} row(s) at row ${params.startRow} in sheet "${sheetName}". Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 4. xlsxDeleteRows
// ─────────────────────────────────────────────
export async function xlsxDeleteRows(params: {
  path: string;
  sheet?: string;
  startRow: number;
  count: number;
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);

    sheet.spliceRows(params.startRow, params.count);

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `Deleted ${params.count} row(s) starting at row ${params.startRow} in sheet "${sheetName}". Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 5. xlsxInsertColumns
// ─────────────────────────────────────────────
export async function xlsxInsertColumns(params: {
  path: string;
  sheet?: string;
  startColumn: number;
  columns: Array<Array<string | number | boolean | null>>;
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);

    // spliceColumns(start, deleteCount, ...inserts)
    sheet.spliceColumns(params.startColumn, 0, ...params.columns);

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `Inserted ${params.columns.length} column(s) at column ${params.startColumn} (${colToLetter(params.startColumn)}) in sheet "${sheetName}". Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 6. xlsxDeleteColumns
// ─────────────────────────────────────────────
export async function xlsxDeleteColumns(params: {
  path: string;
  sheet?: string;
  startColumn: number;
  count: number;
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);

    sheet.spliceColumns(params.startColumn, params.count);

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `Deleted ${params.count} column(s) starting at column ${params.startColumn} (${colToLetter(params.startColumn)}) in sheet "${sheetName}". Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 7. xlsxFormatCells
// ─────────────────────────────────────────────
export async function xlsxFormatCells(params: {
  path: string;
  sheet?: string;
  range: string;
  format: {
    font?: {
      name?: string;
      size?: number;
      bold?: boolean;
      italic?: boolean;
      underline?: boolean;
      color?: string;
    };
    fill?: {
      type?: "pattern";
      pattern?: "solid" | "none";
      fgColor?: string;
    };
    border?: {
      top?: { style: string; color?: string };
      bottom?: { style: string; color?: string };
      left?: { style: string; color?: string };
      right?: { style: string; color?: string };
    };
    alignment?: {
      horizontal?: "left" | "center" | "right" | "justify";
      vertical?: "top" | "middle" | "bottom";
      wrapText?: boolean;
    };
    numFmt?: string;
  };
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
    const cells = expandRange(params.range);
    const fmt = params.format;

    for (const { col, row } of cells) {
      const cell = sheet.getRow(row).getCell(col);

      if (fmt.font) {
        const fontObj: Partial<ExcelJS.Font> = { ...cell.font };
        if (fmt.font.name !== undefined) fontObj.name = fmt.font.name;
        if (fmt.font.size !== undefined) fontObj.size = fmt.font.size;
        if (fmt.font.bold !== undefined) fontObj.bold = fmt.font.bold;
        if (fmt.font.italic !== undefined) fontObj.italic = fmt.font.italic;
        if (fmt.font.underline !== undefined) fontObj.underline = fmt.font.underline;
        if (fmt.font.color !== undefined) fontObj.color = { argb: fmt.font.color };
        cell.font = fontObj as ExcelJS.Font;
      }

      if (fmt.fill) {
        cell.fill = {
          type: "pattern",
          pattern: fmt.fill.pattern ?? "solid",
          fgColor: fmt.fill.fgColor ? { argb: fmt.fill.fgColor } : undefined,
        } as ExcelJS.FillPattern;
      }

      if (fmt.border) {
        const borderObj: Partial<ExcelJS.Borders> = {};
        for (const side of ["top", "bottom", "left", "right"] as const) {
          if (fmt.border[side]) {
            borderObj[side] = {
              style: fmt.border[side]!.style as ExcelJS.BorderStyle,
              color: fmt.border[side]!.color ? { argb: fmt.border[side]!.color } : undefined,
            };
          }
        }
        cell.border = borderObj as ExcelJS.Borders;
      }

      if (fmt.alignment) {
        cell.alignment = {
          ...cell.alignment,
          ...fmt.alignment,
        };
      }

      if (fmt.numFmt !== undefined) {
        cell.numFmt = fmt.numFmt;
      }
    }

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `Formatted ${cells.length} cell(s) in range "${params.range}" on sheet "${sheetName}". Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 8. xlsxCreate
// ─────────────────────────────────────────────
export async function xlsxCreate(params: {
  outputPath: string;
  sheets: Array<{
    name: string;
    data: Array<Array<string | number | boolean | null>>;
    columnWidths?: number[];
    freezeRow?: number;
    freezeColumn?: number;
    headerStyle?: boolean;
  }>;
}): Promise<ToolResult> {
  try {
    const workbook = new ExcelJS.Workbook();

    for (const sheetDef of params.sheets) {
      const sheet = workbook.addWorksheet(sheetDef.name);

      // Set data
      for (let r = 0; r < sheetDef.data.length; r++) {
        const rowData = sheetDef.data[r];
        const row = sheet.getRow(r + 1);
        for (let c = 0; c < rowData.length; c++) {
          row.getCell(c + 1).value = rowData[c] as ExcelJS.CellValue;
        }
        row.commit();
      }

      // Column widths
      if (sheetDef.columnWidths) {
        for (let i = 0; i < sheetDef.columnWidths.length; i++) {
          sheet.getColumn(i + 1).width = sheetDef.columnWidths[i];
        }
      }

      // Freeze panes
      if (sheetDef.freezeRow || sheetDef.freezeColumn) {
        sheet.views = [
          {
            state: "frozen",
            xSplit: sheetDef.freezeColumn ?? 0,
            ySplit: sheetDef.freezeRow ?? 0,
          },
        ];
      }

      // Header style (bold first row)
      if (sheetDef.headerStyle && sheetDef.data.length > 0) {
        const headerRow = sheet.getRow(1);
        headerRow.font = { bold: true };
        headerRow.eachCell((cell) => {
          cell.fill = {
            type: "pattern",
            pattern: "solid",
            fgColor: { argb: "FFD9E1F2" },
          };
          cell.border = {
            bottom: { style: "thin" },
          };
        });
      }
    }

    await workbook.xlsx.writeFile(params.outputPath);
    return {
      success: true,
      output: `Created workbook with ${params.sheets.length} sheet(s): ${params.sheets.map((s) => s.name).join(", ")}. Saved to: ${params.outputPath}`,
      outputPath: params.outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 9. xlsxManageSheets
// ─────────────────────────────────────────────
export async function xlsxManageSheets(params: {
  path: string;
  operations: Array<
    | { action: "add"; name: string }
    | { action: "delete"; name: string }
    | { action: "rename"; name: string; newName: string }
    | { action: "copy"; name: string; newName: string }
    | { action: "reorder"; name: string; position: number }
  >;
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
    const results: string[] = [];

    for (const op of params.operations) {
      switch (op.action) {
        case "add": {
          workbook.addWorksheet(op.name);
          results.push(`Added sheet "${op.name}"`);
          break;
        }
        case "delete": {
          const sheet = workbook.getWorksheet(op.name);
          if (!sheet) {
            return { success: false, output: `Error: Sheet "${op.name}" not found` };
          }
          workbook.removeWorksheet(sheet.id);
          results.push(`Deleted sheet "${op.name}"`);
          break;
        }
        case "rename": {
          const sheet = workbook.getWorksheet(op.name);
          if (!sheet) {
            return { success: false, output: `Error: Sheet "${op.name}" not found` };
          }
          sheet.name = (op as any).newName;
          results.push(`Renamed sheet "${op.name}" → "${(op as any).newName}"`);
          break;
        }
        case "copy": {
          const source = workbook.getWorksheet(op.name);
          if (!source) {
            return { success: false, output: `Error: Sheet "${op.name}" not found` };
          }
          const newName = (op as any).newName ?? `${op.name} (Copy)`;
          const newSheet = workbook.addWorksheet(newName);

          // Copy column properties
          source.columns?.forEach((col, i) => {
            if (col.width) newSheet.getColumn(i + 1).width = col.width;
            if (col.style) newSheet.getColumn(i + 1).style = { ...col.style } as ExcelJS.Style;
          });

          // Copy rows (values + styles)
          source.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            const newRow = newSheet.getRow(rowNumber);
            newRow.height = row.height;
            row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
              const newCell = newRow.getCell(colNumber);
              newCell.value = cell.value;
              newCell.style = { ...cell.style } as ExcelJS.Style;
            });
          });

          // Copy merged cells
          const merges = (source as any)._merges ?? (source as any).mergeCells;
          if (merges && typeof merges === "object") {
            for (const key of Object.keys(merges)) {
              try { newSheet.mergeCells(key); } catch { /* skip invalid */ }
            }
          }

          // Copy views (freeze panes etc.)
          if (source.views?.length) {
            newSheet.views = source.views.map((v) => ({ ...v }));
          }

          results.push(`Copied sheet "${op.name}" → "${newName}"`);
          break;
        }
        case "reorder": {
          const sheet = workbook.getWorksheet(op.name);
          if (!sheet) {
            return { success: false, output: `Error: Sheet "${op.name}" not found` };
          }
          const targetPos = (op as any).position as number;
          // ExcelJS orderNo controls sheet tab order
          (sheet as any).orderNo = targetPos;
          results.push(`Moved sheet "${op.name}" to position ${targetPos}`);
          break;
        }
      }
    }

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `${results.join(". ")}. Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 10. xlsxConvert
// ─────────────────────────────────────────────
export async function xlsxConvert(params: {
  path: string;
  format: "csv" | "html";
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const absPath = path.resolve(inputPath);
    const rawFormat = String(params.format ?? "").toLowerCase();
    if (rawFormat !== "csv" && rawFormat !== "html") {
      return {
        success: false,
        output: `Error: Unsupported format "${rawFormat}". Supported formats: csv, html`,
      };
    }
    const format = rawFormat as "csv" | "html";

    const baseName = path.basename(inputPath, path.extname(inputPath));
    const outDir = params.outputPath
      ? path.dirname(path.resolve(params.outputPath))
      : path.dirname(absPath);
    await fs.promises.mkdir(outDir, { recursive: true });

    const outputPath = params.outputPath
      ? path.resolve(params.outputPath)
      : path.join(outDir, `${baseName}.${format}`);

    if (format === "csv") {
      const csvResult = await xlsxCsvIo({
        action: "write",
        path: absPath,
        csvPath: outputPath,
      });
      if (!csvResult.success) return csvResult;
    } else {
      const html = await renderWorkbookAsHtml(absPath);
      await fs.promises.writeFile(outputPath, html, "utf-8");
    }

    if (!(await pathExists(outputPath))) {
      return {
        success: false,
        output: `Error: Failed to create ${format.toUpperCase()} output: ${outputPath}`,
      };
    }

    return {
      success: true,
      output: `Converted to ${format.toUpperCase()}. Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 11. xlsxMergeCells
// ─────────────────────────────────────────────
export async function xlsxMergeCells(params: {
  path: string;
  sheet?: string;
  operations: Array<{ action: "merge" | "unmerge"; range: string }>;
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
    const results: string[] = [];

    for (const op of params.operations) {
      if (op.action === "merge") {
        sheet.mergeCells(op.range);
        results.push(`Merged ${op.range}`);
      } else {
        sheet.unMergeCells(op.range);
        results.push(`Unmerged ${op.range}`);
      }
    }

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `${results.join(". ")} in sheet "${sheetName}". Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 12. xlsxSortData
// ─────────────────────────────────────────────
export async function xlsxSortData(params: {
  path: string;
  sheet?: string;
  range: string;
  sortBy: Array<{ column: string; order: "asc" | "desc" }>;
  hasHeader?: boolean;
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
    const rangeParts = params.range.split(":");
    const rangeStart = parseCellAddress(rangeParts[0]);
    const rangeEnd = parseCellAddress(rangeParts[1]);

    const hasHeader = params.hasHeader ?? false;
    const dataStartRow = hasHeader ? rangeStart.row + 1 : rangeStart.row;

    // Collect row data with styles
    const rowsData: Array<{
      values: Map<number, ExcelJS.CellValue>;
      styles: Map<number, Partial<ExcelJS.Style>>;
    }> = [];

    for (let r = dataStartRow; r <= rangeEnd.row; r++) {
      const row = sheet.getRow(r);
      const values = new Map<number, ExcelJS.CellValue>();
      const styles = new Map<number, Partial<ExcelJS.Style>>();
      for (let c = rangeStart.col; c <= rangeEnd.col; c++) {
        const cell = row.getCell(c);
        values.set(c, cell.value);
        styles.set(c, { ...cell.style });
      }
      rowsData.push({ values, styles });
    }

    // Sort
    const sortColumns = params.sortBy.map((s) => ({
      col: parseCellAddress(s.column + "1").col,
      order: s.order,
    }));

    // Extract a sortable primitive from ExcelJS CellValue
    function sortableValue(v: ExcelJS.CellValue): string | number | Date | null {
      if (v == null) return null;
      if (v instanceof Date) return v;
      if (typeof v === "number" || typeof v === "boolean") return Number(v);
      if (typeof v === "string") return v;
      // Formula object: { formula, result }
      if (typeof v === "object" && "result" in v) {
        const r = (v as any).result;
        if (r instanceof Date) return r;
        if (typeof r === "number") return r;
        if (r != null) return String(r);
        return null;
      }
      // RichText: { richText: [{text}] }
      if (typeof v === "object" && "richText" in v) {
        return ((v as any).richText as any[]).map((seg: any) => seg.text ?? "").join("");
      }
      return String(v);
    }

    rowsData.sort((a, b) => {
      for (const { col, order } of sortColumns) {
        const va = sortableValue(a.values.get(col));
        const vb = sortableValue(b.values.get(col));
        // Nulls sort last
        if (va == null && vb == null) continue;
        if (va == null) return order === "desc" ? -1 : 1;
        if (vb == null) return order === "desc" ? 1 : -1;
        let cmp: number;
        if (va instanceof Date && vb instanceof Date) {
          cmp = va.getTime() - vb.getTime();
        } else if (typeof va === "number" && typeof vb === "number") {
          cmp = va - vb;
        } else {
          const sa = String(va);
          const sb = String(vb);
          const na = Number(sa);
          const nb = Number(sb);
          if (!isNaN(na) && !isNaN(nb) && sa !== "" && sb !== "") {
            cmp = na - nb;
          } else {
            cmp = sa.localeCompare(sb);
          }
        }
        if (cmp !== 0) return order === "desc" ? -cmp : cmp;
      }
      return 0;
    });

    // Write sorted data back
    for (let i = 0; i < rowsData.length; i++) {
      const r = dataStartRow + i;
      const row = sheet.getRow(r);
      const { values, styles } = rowsData[i];
      for (let c = rangeStart.col; c <= rangeEnd.col; c++) {
        const cell = row.getCell(c);
        cell.value = values.get(c) ?? null;
        cell.style = (styles.get(c) ?? {}) as ExcelJS.Style;
      }
    }

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `Sorted ${rowsData.length} row(s) in range "${params.range}" by ${params.sortBy.map((s) => `${s.column} ${s.order}`).join(", ")}. Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 13. xlsxAutoFilter
// ─────────────────────────────────────────────
export async function xlsxAutoFilter(params: {
  path: string;
  sheet?: string;
  action?: "set" | "remove";
  range?: string;
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const action = params.action ?? "set";

    if (action === "set" && !params.range) {
      return { success: false, output: `Error: range is required when action is "set"` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);

    if (action === "remove") {
      sheet.autoFilter = undefined as any;
    } else {
      sheet.autoFilter = params.range!;
    }

    await workbook.xlsx.writeFile(outputPath);
    const msg = action === "remove"
      ? `Removed auto filter from sheet "${sheetName}".`
      : `Set auto filter on range "${params.range}" in sheet "${sheetName}".`;
    return {
      success: true,
      output: `${msg} Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 14. xlsxDataValidation
// ─────────────────────────────────────────────
export async function xlsxDataValidation(params: {
  path: string;
  sheet?: string;
  action?: "apply" | "remove";
  range: string;
  validation?: {
    type: "list" | "whole" | "decimal" | "date" | "textLength" | "custom";
    formulae: string[];
    operator?: "between" | "notBetween" | "equal" | "notEqual" | "greaterThan" | "lessThan" | "greaterThanOrEqual" | "lessThanOrEqual";
    allowBlank?: boolean;
    showDropDown?: boolean;
    showErrorMessage?: boolean;
    errorTitle?: string;
    error?: string;
    showInputMessage?: boolean;
    promptTitle?: string;
    prompt?: string;
  };
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const action = params.action ?? "apply";

    if (action === "apply" && !params.validation) {
      return { success: false, output: `Error: validation is required for "apply" action` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
    const cells = expandRange(params.range);

    if (action === "remove") {
      for (const { col, row } of cells) {
        const cell = sheet.getRow(row).getCell(col);
        cell.dataValidation = {} as any;
      }
      await workbook.xlsx.writeFile(outputPath);
      return {
        success: true,
        output: `Removed data validation from ${cells.length} cell(s) in range "${params.range}". Saved to: ${outputPath}`,
        outputPath,
      };
    }

    // action === "apply"
    const v = params.validation!;
    for (const { col, row } of cells) {
      const cell = sheet.getRow(row).getCell(col);
      cell.dataValidation = {
        type: v.type,
        formulae: v.formulae,
        operator: v.operator,
        allowBlank: v.allowBlank ?? true,
        showDropDown: v.showDropDown,
        showErrorMessage: v.showErrorMessage ?? true,
        errorTitle: v.errorTitle,
        error: v.error,
        showInputMessage: v.showInputMessage,
        promptTitle: v.promptTitle,
        prompt: v.prompt,
      } as ExcelJS.DataValidation;
    }

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `Applied ${v.type} validation to ${cells.length} cell(s) in range "${params.range}". Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 15. xlsxConditionalFormatting
// ─────────────────────────────────────────────
export async function xlsxConditionalFormatting(params: {
  path: string;
  sheet?: string;
  action?: "add" | "remove" | "list";
  range?: string;
  rules?: Array<{
    type: "cellIs" | "expression" | "colorScale" | "dataBar" | "iconSet" | "top10" | "aboveAverage" | "containsText";
    operator?: "greaterThan" | "lessThan" | "between" | "equal" | "notEqual" | "greaterThanOrEqual" | "lessThanOrEqual";
    formulae?: (string | number)[];
    text?: string;
    priority: number;
    style?: {
      font?: { bold?: boolean; italic?: boolean; color?: string };
      fill?: { bgColor?: string };
    };
  }>;
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const action = params.action ?? "add";

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    if (action === "list") {
      const cfEntries = (sheet as any).conditionalFormattings ?? (sheet as any)._conditionalFormattings ?? [];
      const lines: string[] = [`Conditional formatting rules in sheet "${sheetName}":`];
      if (Array.isArray(cfEntries) && cfEntries.length > 0) {
        for (const entry of cfEntries) {
          const ref = entry.ref ?? entry.sqref ?? "(unknown range)";
          const rules = entry.rules ?? [];
          lines.push(`  Range: ${ref} (${rules.length} rule(s))`);
          for (const rule of rules) {
            lines.push(`    - type: ${rule.type ?? "?"}, priority: ${rule.priority ?? "?"}`);
          }
        }
      } else {
        lines.push("  (no conditional formatting rules)");
      }
      return { success: true, output: lines.join("\n") };
    }

    if (action === "remove") {
      if (params.range) {
        // Remove rules matching the specified range
        const cf = (sheet as any).conditionalFormattings ?? (sheet as any)._conditionalFormattings;
        if (Array.isArray(cf)) {
          const before = cf.length;
          const filtered = cf.filter((entry: any) => {
            const ref = entry.ref ?? entry.sqref ?? "";
            return ref !== params.range;
          });
          if ((sheet as any).conditionalFormattings) {
            (sheet as any).conditionalFormattings = filtered;
          } else {
            (sheet as any)._conditionalFormattings = filtered;
          }
          const removed = before - filtered.length;
          const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
          await workbook.xlsx.writeFile(outputPath);
          return {
            success: true,
            output: `Removed ${removed} conditional formatting entry(ies) for range "${params.range}". Saved to: ${outputPath}`,
            outputPath,
          };
        }
      }
      // Remove all
      (sheet as any).conditionalFormattings = [];
      (sheet as any)._conditionalFormattings = [];
      const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
      await workbook.xlsx.writeFile(outputPath);
      return {
        success: true,
        output: `Removed all conditional formatting from sheet "${sheetName}". Saved to: ${outputPath}`,
        outputPath,
      };
    }

    // action === "add"
    if (!params.range || !params.rules || params.rules.length === 0) {
      return { success: false, output: `Error: range and rules are required for "add" action` };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);

    const cfRules: any[] = params.rules.map((rule) => {
      const cfRule: any = {
        type: rule.type,
        priority: rule.priority,
      };
      if (rule.operator) cfRule.operator = rule.operator;
      if (rule.formulae) cfRule.formulae = rule.formulae;
      if (rule.text) cfRule.text = rule.text;
      if (rule.style) {
        cfRule.style = {};
        if (rule.style.font) {
          cfRule.style.font = { ...rule.style.font };
          if (rule.style.font.color) {
            cfRule.style.font.color = { argb: rule.style.font.color };
          }
        }
        if (rule.style.fill) {
          cfRule.style.fill = {
            type: "pattern",
            pattern: "solid",
            bgColor: rule.style.fill.bgColor ? { argb: rule.style.fill.bgColor } : undefined,
          };
        }
      }
      return cfRule;
    });

    sheet.addConditionalFormatting({
      ref: params.range,
      rules: cfRules,
    });

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `Applied ${params.rules.length} conditional formatting rule(s) to range "${params.range}". Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 16. xlsxSetSheetProperties
// ─────────────────────────────────────────────
export async function xlsxSetSheetProperties(params: {
  path: string;
  sheet?: string;
  properties: {
    freezeRow?: number;
    freezeColumn?: number;
    columnWidths?: Array<{ column: string | number; width: number }>;
    rowHeights?: Array<{ row: number; height: number }>;
    tabColor?: string;
    showGridLines?: boolean;
    defaultColWidth?: number;
    defaultRowHeight?: number;
  };
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
    const props = params.properties;
    const changes: string[] = [];

    // Build views object incrementally to avoid overwrites
    let baseView: Record<string, any> = sheet.views?.length ? { ...sheet.views[0] } : {};

    // Freeze panes
    if (props.freezeRow !== undefined || props.freezeColumn !== undefined) {
      baseView.state = "frozen";
      baseView.xSplit = props.freezeColumn ?? 0;
      baseView.ySplit = props.freezeRow ?? 0;
      changes.push(`Freeze panes: row=${props.freezeRow ?? 0}, col=${props.freezeColumn ?? 0}`);
    }

    // Grid lines
    if (props.showGridLines !== undefined) {
      baseView.showGridLines = props.showGridLines;
      changes.push(`Grid lines: ${props.showGridLines}`);
    }

    // Apply views if any view-related property was set
    if (props.freezeRow !== undefined || props.freezeColumn !== undefined || props.showGridLines !== undefined) {
      sheet.views = [baseView as any];
    }

    // Column widths
    if (props.columnWidths) {
      for (const cw of props.columnWidths) {
        const colNum = typeof cw.column === "string"
          ? parseCellAddress(cw.column + "1").col
          : cw.column;
        sheet.getColumn(colNum).width = cw.width;
      }
      changes.push(`Set ${props.columnWidths.length} column width(s)`);
    }

    // Row heights
    if (props.rowHeights) {
      for (const rh of props.rowHeights) {
        sheet.getRow(rh.row).height = rh.height;
      }
      changes.push(`Set ${props.rowHeights.length} row height(s)`);
    }

    // Tab color
    if (props.tabColor) {
      sheet.properties.tabColor = { argb: props.tabColor };
      changes.push(`Tab color: ${props.tabColor}`);
    }

    // Default column width
    if (props.defaultColWidth !== undefined) {
      sheet.properties.defaultColWidth = props.defaultColWidth;
      changes.push(`Default col width: ${props.defaultColWidth}`);
    }

    // Default row height
    if (props.defaultRowHeight !== undefined) {
      sheet.properties.defaultRowHeight = props.defaultRowHeight;
      changes.push(`Default row height: ${props.defaultRowHeight}`);
    }

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `Updated sheet "${sheetName}": ${changes.join(", ")}. Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 17. xlsxProtectSheet
// ─────────────────────────────────────────────
export async function xlsxProtectSheet(params: {
  path: string;
  sheet?: string;
  action: "protect" | "unprotect";
  password?: string;
  options?: {
    selectLockedCells?: boolean;
    selectUnlockedCells?: boolean;
    formatCells?: boolean;
    formatColumns?: boolean;
    formatRows?: boolean;
    insertColumns?: boolean;
    insertRows?: boolean;
    insertHyperlinks?: boolean;
    deleteColumns?: boolean;
    deleteRows?: boolean;
    sort?: boolean;
    autoFilter?: boolean;
  };
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);

    if (params.action === "protect") {
      await sheet.protect(params.password ?? "", params.options ?? {});
    } else {
      sheet.unprotect();
    }

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `${params.action === "protect" ? "Protected" : "Unprotected"} sheet "${sheetName}". Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 18. xlsxAddImage
// ─────────────────────────────────────────────
export async function xlsxAddImage(params: {
  path: string;
  sheet?: string;
  image: {
    filePath?: string;
    base64?: string;
    extension: "png" | "jpeg" | "gif";
  };
  position: {
    from: { col: number; row: number };
    to: { col: number; row: number };
  };
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);

    let imageId: number;
    if (params.image.filePath) {
      if (!(await pathExists(params.image.filePath))) {
        return { success: false, output: `Error: Image file not found: ${params.image.filePath}` };
      }
      imageId = workbook.addImage({
        filename: params.image.filePath,
        extension: params.image.extension,
      });
    } else if (params.image.base64) {
      imageId = workbook.addImage({
        base64: params.image.base64,
        extension: params.image.extension,
      });
    } else {
      return { success: false, output: "Error: Either filePath or base64 must be provided for the image" };
    }

    sheet.addImage(imageId, {
      tl: { col: params.position.from.col, row: params.position.from.row } as any,
      br: { col: params.position.to.col, row: params.position.to.row } as any,
    });

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `Added image to sheet "${sheetName}". Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 19. xlsxNamedRanges
// ─────────────────────────────────────────────
export async function xlsxNamedRanges(params: {
  path: string;
  operations: Array<
    | { action: "add"; name: string; range: string }
    | { action: "delete"; name: string }
    | { action: "list" }
  >;
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
    const results: string[] = [];
    let modified = false;

    for (const op of params.operations) {
      switch (op.action) {
        case "add": {
          workbook.definedNames.add(op.range, op.name);
          results.push(`Added named range "${op.name}" → ${op.range}`);
          modified = true;
          break;
        }
        case "delete": {
          const dn = workbook.definedNames as any;
          if (typeof dn.removeAllNames === "function") {
            dn.removeAllNames(op.name);
          } else if (typeof dn.remove === "function") {
            dn.remove(op.name);
          }
          results.push(`Deleted named range "${op.name}"`);
          modified = true;
          break;
        }
        case "list": {
          const dn = workbook.definedNames as any;
          // ExcelJS stores defined names internally as a matrix of name → ranges
          let found = false;
          if (typeof dn.getRanges === "function") {
            // Try iterating known names from the model
            const model = dn.model;
            if (Array.isArray(model)) {
              for (const entry of model) {
                const name = entry.name ?? entry.Name ?? "(unnamed)";
                const ranges = entry.ranges ?? entry.range ?? [];
                const rangeStr = Array.isArray(ranges) ? ranges.join(", ") : String(ranges);
                results.push(`  ${name}: ${rangeStr}`);
                found = true;
              }
            } else if (model && typeof model === "object") {
              for (const [name, value] of Object.entries(model)) {
                results.push(`  ${name}: ${JSON.stringify(value)}`);
                found = true;
              }
            }
          }
          // Fallback: try to list via forEach on matrixMap
          if (!found && dn.matrixMap) {
            for (const [name, matrix] of Object.entries(dn.matrixMap)) {
              results.push(`  ${name}`);
              found = true;
            }
          }
          if (!found) {
            results.push("  (no named ranges)");
          }
          break;
        }
      }
    }

    if (modified) {
      await workbook.xlsx.writeFile(outputPath);
      return {
        success: true,
        output: `${results.join("\n")}. Saved to: ${outputPath}`,
        outputPath,
      };
    }
    return { success: true, output: results.join("\n") };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 20. xlsxRemoveDuplicates
// ─────────────────────────────────────────────
export async function xlsxRemoveDuplicates(params: {
  path: string;
  sheet?: string;
  range: string;
  columns?: string[];
  keepFirst?: boolean;
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
    const rangeParts = params.range.split(":");
    const rangeStart = parseCellAddress(rangeParts[0]);
    const rangeEnd = parseCellAddress(rangeParts[1]);

    // Determine which columns to check for duplicates
    const checkCols = params.columns
      ? params.columns.map((c) => parseCellAddress(c + "1").col)
      : Array.from({ length: rangeEnd.col - rangeStart.col + 1 }, (_, i) => rangeStart.col + i);

    const keepFirst = params.keepFirst ?? true;

    // Collect all rows with their keys
    const rowEntries: { row: number; key: string }[] = [];
    for (let r = rangeStart.row; r <= rangeEnd.row; r++) {
      const row = sheet.getRow(r);
      const key = checkCols.map((c) => String(row.getCell(c).value ?? "")).join("|||");
      rowEntries.push({ row: r, key });
    }

    const duplicateRows: number[] = [];

    if (keepFirst) {
      // Keep first occurrence, mark subsequent duplicates for deletion
      const seen = new Set<string>();
      for (const entry of rowEntries) {
        if (seen.has(entry.key)) {
          duplicateRows.push(entry.row);
        } else {
          seen.add(entry.key);
        }
      }
    } else {
      // Keep last occurrence, mark earlier duplicates for deletion
      // Traverse from end to find which to keep
      const seenFromEnd = new Set<string>();
      const keepRows = new Set<number>();
      for (let i = rowEntries.length - 1; i >= 0; i--) {
        if (!seenFromEnd.has(rowEntries[i].key)) {
          seenFromEnd.add(rowEntries[i].key);
          keepRows.add(rowEntries[i].row);
        }
      }
      // Count occurrences to find keys with duplicates
      const keyCounts = new Map<string, number>();
      for (const entry of rowEntries) {
        keyCounts.set(entry.key, (keyCounts.get(entry.key) ?? 0) + 1);
      }
      for (const entry of rowEntries) {
        if ((keyCounts.get(entry.key) ?? 0) > 1 && !keepRows.has(entry.row)) {
          duplicateRows.push(entry.row);
        }
      }
    }

    // Delete duplicate rows from bottom to top to maintain row indices
    for (let i = duplicateRows.length - 1; i >= 0; i--) {
      sheet.spliceRows(duplicateRows[i], 1);
    }

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `Removed ${duplicateRows.length} duplicate row(s) from range "${params.range}". Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 21. xlsxFindReplace
// ─────────────────────────────────────────────
export async function xlsxFindReplace(params: {
  path: string;
  sheet?: string;
  find: string;
  replace: string;
  options?: {
    matchCase?: boolean;
    matchEntireCell?: boolean;
    useRegex?: boolean;
  };
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
    const opts = params.options ?? {};
    let totalReplacements = 0;
    const affectedCells: string[] = [];

    const sheets = params.sheet
      ? [workbook.getWorksheet(params.sheet)].filter(Boolean) as ExcelJS.Worksheet[]
      : workbook.worksheets;

    if (params.sheet && sheets.length === 0) {
      return { success: false, output: `Error: Sheet "${params.sheet}" not found` };
    }

    for (const sheet of sheets) {
      sheet.eachRow((row, rowNumber) => {
        row.eachCell((cell, colNumber) => {
          // Extract string representation from various cell types
          let val: string | null = null;
          let isDirectString = false;

          if (typeof cell.value === "string") {
            val = cell.value;
            isDirectString = true;
          } else if (typeof cell.value === "number") {
            val = String(cell.value);
          } else if (cell.value instanceof Date) {
            val = cell.value.toISOString();
          } else if (cell.value != null && typeof cell.value === "object") {
            if ("richText" in cell.value) {
              // RichText — join text segments
              val = ((cell.value as any).richText as any[]).map((seg: any) => seg.text ?? "").join("");
            } else if ("result" in cell.value && (cell.value as any).result != null) {
              // Formula — search in the result value
              val = String((cell.value as any).result);
            } else if ("text" in cell.value) {
              // Hyperlink — search in the text
              val = (cell.value as any).text ?? "";
            }
          }

          if (val == null) return;

          let matched = false;

          if (opts.matchEntireCell) {
            const eq = opts.matchCase ? val === params.find : val.toLowerCase() === params.find.toLowerCase();
            if (eq) {
              cell.value = params.replace;
              matched = true;
            }
          } else if (opts.useRegex) {
            const flags = opts.matchCase ? "g" : "gi";
            const regex = new RegExp(params.find, flags);
            const replaced = val.replace(regex, params.replace);
            if (replaced !== val) {
              if (isDirectString || typeof cell.value === "number") {
                // Try to keep as number if replacement is numeric
                const num = Number(replaced);
                cell.value = (!isNaN(num) && !isDirectString) ? num : replaced;
              } else {
                cell.value = replaced;
              }
              matched = true;
            }
          } else {
            const flags = opts.matchCase ? "g" : "gi";
            const escaped = params.find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const regex = new RegExp(escaped, flags);
            const replaced = val.replace(regex, params.replace);
            if (replaced !== val) {
              if (isDirectString || typeof cell.value === "number") {
                const num = Number(replaced);
                cell.value = (!isNaN(num) && !isDirectString) ? num : replaced;
              } else {
                cell.value = replaced;
              }
              matched = true;
            }
          }

          if (matched) {
            totalReplacements++;
            if (affectedCells.length < 20) {
              affectedCells.push(`${sheet.name}!${colToLetter(colNumber)}${rowNumber}`);
            }
          }
        });
      });
    }

    await workbook.xlsx.writeFile(outputPath);
    const cellList = affectedCells.length > 0
      ? ` Cells: ${affectedCells.join(", ")}${totalReplacements > 20 ? "..." : ""}`
      : "";
    return {
      success: true,
      output: `Replaced ${totalReplacements} occurrence(s) of "${params.find}" with "${params.replace}".${cellList} Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 22. xlsxHyperlink
// ─────────────────────────────────────────────
export async function xlsxHyperlink(params: {
  path: string;
  sheet?: string;
  operations: Array<{
    cell: string;
    action: "add" | "remove";
    target?: string;
    text?: string;
    tooltip?: string;
  }>;
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
    const results: string[] = [];

    for (const op of params.operations) {
      const cell = sheet.getCell(op.cell);
      if (op.action === "add") {
        if (!op.target) {
          return { success: false, output: `Error: target is required for add action on cell ${op.cell}` };
        }
        cell.value = {
          text: op.text ?? op.target,
          hyperlink: op.target,
          tooltip: op.tooltip,
        } as ExcelJS.CellHyperlinkValue;
        results.push(`Added hyperlink to ${op.cell} → ${op.target}`);
      } else {
        // Remove hyperlink by setting value to plain text
        const currentText = typeof cell.value === "object" && cell.value !== null && "text" in cell.value
          ? (cell.value as any).text
          : String(cell.value ?? "");
        cell.value = currentText;
        results.push(`Removed hyperlink from ${op.cell}`);
      }
    }

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `${results.join(". ")}. Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 23. xlsxAddChart (via LibreOffice macro)
// ─────────────────────────────────────────────
// NOTE:
// chart/pivot/recalc features depend on soffice.
// If full OS-independent behavior is required, run these features in a server-side container.
export async function xlsxAddChart(params: {
  path: string;
  sheet?: string;
  chart: {
    type: "bar" | "line" | "pie" | "scatter" | "area" | "column";
    title?: string;
    dataRange: string;
    categoryRange?: string;
    position: {
      from: { col: number; row: number };
      to: { col: number; row: number };
    };
  };
  outputPath?: string;
}): Promise<ToolResult> {
  // ExcelJS does NOT support chart creation.
  // We use a LibreOffice Basic macro to create charts reliably.
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);

    // Copy input to output first if different
    const absInput = path.resolve(inputPath);
    const absOutput = path.resolve(outputPath);
    if (absInput !== absOutput) {
      ;(await fs.promises.copyFile(absInput, absOutput));
    }

    // Map chart type to LibreOffice chart type constant
    const loChartTypes: Record<string, string> = {
      bar: "com.sun.star.chart.BarDiagram",
      column: "com.sun.star.chart.BarDiagram",
      line: "com.sun.star.chart.LineDiagram",
      pie: "com.sun.star.chart.PieDiagram",
      scatter: "com.sun.star.chart.XYDiagram",
      area: "com.sun.star.chart.AreaDiagram",
    };

    const chartType = loChartTypes[params.chart.type] ?? loChartTypes.bar;
    const sheetName = params.sheet ?? "";
    const title = params.chart.title ?? "";
    const dataRange = params.chart.dataRange;
    const pos = params.chart.position;

    // Build a LibreOffice Basic macro to insert the chart
    const macro = `
Sub InsertChart()
  Dim oDoc As Object
  Dim oSheet As Object
  Dim oCharts As Object
  Dim oRange(0) As New com.sun.star.table.CellRangeAddress

  oDoc = ThisComponent
  If "${toBasicString(sheetName)}" = "" Then
    oSheet = oDoc.Sheets.getByIndex(0)
  Else
    oSheet = oDoc.Sheets.getByName("${toBasicString(sheetName)}")
  End If

  Dim oCellRange As Object
  oCellRange = oSheet.getCellRangeByName("${toBasicString(dataRange)}")
  oRange(0).Sheet = oSheet.RangeAddress.Sheet
  oRange(0).StartColumn = oCellRange.RangeAddress.StartColumn
  oRange(0).StartRow = oCellRange.RangeAddress.StartRow
  oRange(0).EndColumn = oCellRange.RangeAddress.EndColumn
  oRange(0).EndRow = oCellRange.RangeAddress.EndRow

  Dim oRect As New com.sun.star.awt.Rectangle
  oRect.X = ${pos.from.col * 2000}
  oRect.Y = ${pos.from.row * 1500}
  oRect.Width = ${(pos.to.col - pos.from.col) * 2000}
  oRect.Height = ${(pos.to.row - pos.from.row) * 1500}

  oCharts = oSheet.Charts
  oCharts.addNewByName("Chart1", oRect, oRange(), True, True)

  Dim oChart As Object
  oChart = oCharts.getByName("Chart1").getEmbeddedObject()
  oChart.Diagram = oChart.createInstance("${chartType}")

  If "${toBasicString(title)}" <> "" Then
    oChart.HasMainTitle = True
    oChart.Title.String = "${toBasicString(title)}"
  End If

  oDoc.store()
  oDoc.close(True)
End Sub
`;

    // Write macro to temp file, execute via LibreOffice
    const tmpProfileRoot = (await fs.promises.mkdtemp(
      path.join(require("os").tmpdir(), "lo-chart-profile-")
    ));
    const tmpMacroDir = path.join(tmpProfileRoot, "user", "basic", "Standard");
    const macroFile = path.join(tmpMacroDir, "ChartMacro.xba");

    const wrappedMacro = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">
<script:module xmlns:script="http://openoffice.org/2000/script" script:name="ChartMacro" script:language="StarBasic">
${macro}
</script:module>`;

    if (!(await pathExists(tmpMacroDir))) {
      ;(await fs.promises.mkdir(tmpMacroDir, { recursive: true }));
    }
    ;(await fs.promises.writeFile(macroFile, wrappedMacro, "utf-8"));

    const result = runSoffice(
      [
        "--headless",
        "--norestore",
        `-env:UserInstallation=${toSofficeUserInstallationUri(tmpProfileRoot)}`,
        "vnd.sun.star.script:Standard.ChartMacro.InsertChart?language=Basic&location=application",
        absOutput,
      ],
      { timeout: 30000 }
    );

    // Clean up macro
    try { (await fs.promises.unlink(macroFile)); } catch { /* ignore */ }
    try { (await fs.promises.rm(tmpProfileRoot, { recursive: true, force: true })); } catch { /* ignore */ }

    if (result.status !== 0 && result.status !== 124) {
      return {
        success: false,
        output: `Error: Chart creation via LibreOffice failed. ${(result.stderr || "").trim()}`,
      };
    }

    return {
      success: true,
      output: `Added ${params.chart.type} chart to sheet "${sheetName || "(first)"}". Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 24. xlsxPivotSummary
// ─────────────────────────────────────────────
// NOTE:
// chart/pivot/recalc features depend on soffice.
// If full OS-independent behavior is required, run these features in a server-side container.
export async function xlsxPivotSummary(params: {
  path: string;
  sheet?: string;
  dataRange: string;
  config: {
    rowFields: number[];
    valueFields: Array<{
      column: number;
      aggregation: "sum" | "count" | "average" | "min" | "max";
    }>;
  };
  engine?: "soffice" | "summary";
  outputSheet?: string;
  outputPath?: string;
}): Promise<ToolResult> {
  const engine = params.engine ?? "soffice";
  if (engine === "summary") {
    return createPivotSummarySheet(params);
  }
  return createPivotTableWithSoffice(params);
}

function toBasicString(value: string): string {
  return value.replaceAll('"', '""');
}

function toSofficeGeneralFunction(agg: "sum" | "count" | "average" | "min" | "max"): "SUM" | "COUNT" | "AVERAGE" | "MIN" | "MAX" {
  switch (agg) {
    case "sum":
      return "SUM";
    case "count":
      return "COUNT";
    case "average":
      return "AVERAGE";
    case "min":
      return "MIN";
    case "max":
      return "MAX";
  }
}

async function createPivotTableWithSoffice(params: {
  path: string;
  sheet?: string;
  dataRange: string;
  config: {
    rowFields: number[];
    valueFields: Array<{
      column: number;
      aggregation: "sum" | "count" | "average" | "min" | "max";
    }>;
  };
  outputSheet?: string;
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }
    if (!params.config.valueFields || params.config.valueFields.length === 0) {
      return { success: false, output: "Error: config.valueFields must include at least one value field" };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);
    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    const rangeParts = params.dataRange.split(":");
    if (rangeParts.length !== 2) {
      return { success: false, output: `Error: dataRange must be a start:end range, got "${params.dataRange}"` };
    }
    const rangeStart = parseCellAddress(rangeParts[0]);
    const rangeEnd = parseCellAddress(rangeParts[1]);
    if (rangeEnd.col < rangeStart.col || rangeEnd.row < rangeStart.row) {
      return { success: false, output: `Error: Invalid dataRange "${params.dataRange}"` };
    }
    if (rangeEnd.row <= rangeStart.row) {
      return { success: false, output: "Error: dataRange must include header row plus at least one data row" };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
    const outSheetName = params.outputSheet ?? "PivotTable";
    const sourceSheetName = sheetName;

    const toPivotFieldIndex = (sheetColumn: number) => {
      const rel = sheetColumn - rangeStart.col;
      if (rel < 0 || rel > (rangeEnd.col - rangeStart.col)) {
        throw new Error(`Column ${sheetColumn} is outside dataRange ${params.dataRange}`);
      }
      return rel;
    };

    const rowFieldIndexes = params.config.rowFields.map(toPivotFieldIndex);
    const valueSpecs = params.config.valueFields.map((vf) => ({
      fieldIndex: toPivotFieldIndex(vf.column),
      functionName: toSofficeGeneralFunction(vf.aggregation),
    }));

    const duplicateValueField = new Set<number>();
    for (const spec of valueSpecs) {
      if (duplicateValueField.has(spec.fieldIndex)) {
        return {
          success: false,
          output: "Error: Duplicate valueFields on the same source column are not supported in soffice pivot mode. Use one aggregation per column or use engine=\"summary\".",
        };
      }
      duplicateValueField.add(spec.fieldIndex);
    }

    const absInput = path.resolve(inputPath);
    const absOutput = path.resolve(outputPath);
    if (absInput !== absOutput) {
      ;(await fs.promises.copyFile(absInput, absOutput));
    }

    const rowLines = rowFieldIndexes
      .map(
        (fieldIdx, position) => `  oField = oFields.getByIndex(${fieldIdx})
  oField.Orientation = com.sun.star.sheet.DataPilotFieldOrientation.ROW
  oField.Position = ${position}`
      )
      .join("\n");

    const valueLines = valueSpecs
      .map(
        (valueSpec, position) => `  oField = oFields.getByIndex(${valueSpec.fieldIndex})
  oField.Orientation = com.sun.star.sheet.DataPilotFieldOrientation.DATA
  oField.Function = com.sun.star.sheet.GeneralFunction.${valueSpec.functionName}
  oField.Position = ${position}`
      )
      .join("\n");

    const macro = `
Sub CreatePivotTable()
  Dim oDoc As Object
  Dim oSrcSheet As Object
  Dim oOutSheet As Object
  Dim oTables As Object
  Dim oDesc As Object
  Dim oFields As Object
  Dim oField As Object
  Dim oTarget As Object
  Dim i As Integer
  Dim outName As String

  oDoc = ThisComponent
  oSrcSheet = oDoc.Sheets.getByName("${toBasicString(sourceSheetName)}")
  outName = "${toBasicString(outSheetName)}"

  If oDoc.Sheets.hasByName(outName) Then
    oDoc.Sheets.removeByName(outName)
  End If

  oDoc.Sheets.insertNewByName(outName, oDoc.Sheets.getCount())
  oOutSheet = oDoc.Sheets.getByName(outName)
  oTables = oOutSheet.getDataPilotTables()
  oDesc = oTables.createDataPilotDescriptor()

  oDesc.setSourceRange(oSrcSheet.getCellRangeByName("${toBasicString(params.dataRange)}").RangeAddress)
  oFields = oDesc.getDataPilotFields()

  For i = 0 To oFields.getCount() - 1
    oField = oFields.getByIndex(i)
    oField.Orientation = com.sun.star.sheet.DataPilotFieldOrientation.HIDDEN
  Next i

${rowLines || "  ' no row fields"}
${valueLines}

  oTarget = oOutSheet.getCellByPosition(0, 0).CellAddress
  oTables.insertNewByName("PivotTable1", oTarget, oDesc)
  oDoc.store()
  oDoc.close(True)
End Sub
`;

    const tmpProfileRoot = (await fs.promises.mkdtemp(
      path.join(require("os").tmpdir(), "lo-pivot-profile-")
    ));
    const tmpMacroDir = path.join(tmpProfileRoot, "user", "basic", "Standard");
    const macroFile = path.join(tmpMacroDir, "PivotMacro.xba");
    const wrappedMacro = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">
<script:module xmlns:script="http://openoffice.org/2000/script" script:name="PivotMacro" script:language="StarBasic">
${macro}
</script:module>`;

    if (!(await pathExists(tmpMacroDir))) {
      ;(await fs.promises.mkdir(tmpMacroDir, { recursive: true }));
    }
    ;(await fs.promises.writeFile(macroFile, wrappedMacro, "utf-8"));

    const result = runSoffice(
      [
        "--headless",
        "--norestore",
        `-env:UserInstallation=${toSofficeUserInstallationUri(tmpProfileRoot)}`,
        "vnd.sun.star.script:Standard.PivotMacro.CreatePivotTable?language=Basic&location=application",
        absOutput,
      ],
      { timeout: 45000 }
    );

    try { (await fs.promises.unlink(macroFile)); } catch { /* ignore */ }
    try { (await fs.promises.rm(tmpProfileRoot, { recursive: true, force: true })); } catch { /* ignore */ }

    if (result.status !== 0 && result.status !== 124) {
      return {
        success: false,
        output: `Error: PivotTable creation via LibreOffice failed. ${(result.stderr || "").trim()}`,
      };
    }

    return {
      success: true,
      output: `Created PivotTable on sheet "${outSheetName}" using LibreOffice. Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

async function createPivotSummarySheet(params: {
  path: string;
  sheet?: string;
  dataRange: string;
  config: {
    rowFields: number[];
    valueFields: Array<{
      column: number;
      aggregation: "sum" | "count" | "average" | "min" | "max";
    }>;
  };
  outputSheet?: string;
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
    const rangeParts = params.dataRange.split(":");
    const rangeStart = parseCellAddress(rangeParts[0]);
    const rangeEnd = parseCellAddress(rangeParts[1]);

    // Read header row
    const headerRow = sheet.getRow(rangeStart.row);
    const headers: string[] = [];
    for (let c = rangeStart.col; c <= rangeEnd.col; c++) {
      headers.push(String(headerRow.getCell(c).value ?? `Col${c}`));
    }

    // Read data rows
    const dataRows: Array<(string | number | null)[]> = [];
    for (let r = rangeStart.row + 1; r <= rangeEnd.row; r++) {
      const row = sheet.getRow(r);
      const rowData: (string | number | null)[] = [];
      for (let c = rangeStart.col; c <= rangeEnd.col; c++) {
        const val = row.getCell(c).value;
        rowData.push(val == null ? null : typeof val === "number" ? val : String(val));
      }
      dataRows.push(rowData);
    }

    // Group by rowFields
    const groups = new Map<string, Array<(string | number | null)[]>>();
    for (const row of dataRows) {
      const key = params.config.rowFields
        .map((colIdx) => String(row[colIdx - rangeStart.col] ?? ""))
        .join("|||");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(row);
    }

    // Create output sheet
    const outSheetName = params.outputSheet ?? "PivotSummary";
    let outSheet = workbook.getWorksheet(outSheetName);
    if (outSheet) {
      workbook.removeWorksheet(outSheet.id);
    }
    outSheet = workbook.addWorksheet(outSheetName);

    // Write headers
    const outHeaders = [
      ...params.config.rowFields.map((i) => headers[i - rangeStart.col]),
      ...params.config.valueFields.map(
        (vf) => `${headers[vf.column - rangeStart.col]}_${vf.aggregation}`
      ),
    ];
    const hRow = outSheet.getRow(1);
    outHeaders.forEach((h, i) => { hRow.getCell(i + 1).value = h; });
    hRow.font = { bold: true };

    // Write summary rows
    let outRowNum = 2;
    for (const [key, rows] of groups) {
      const outRow = outSheet.getRow(outRowNum++);
      const keyParts = key.split("|||");
      keyParts.forEach((k, i) => { outRow.getCell(i + 1).value = k; });

      params.config.valueFields.forEach((vf, vi) => {
        const colOffset = vf.column - rangeStart.col;
        const values = rows
          .map((r) => r[colOffset])
          .filter((v): v is number => typeof v === "number");

        let result: number;
        switch (vf.aggregation) {
          case "sum":
            result = values.reduce((a, b) => a + b, 0);
            break;
          case "count":
            result = values.length;
            break;
          case "average":
            result = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;
            break;
          case "min":
            result = values.length > 0 ? Math.min(...values) : 0;
            break;
          case "max":
            result = values.length > 0 ? Math.max(...values) : 0;
            break;
        }
        outRow.getCell(keyParts.length + vi + 1).value = result;
      });
    }

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `Created pivot summary with ${groups.size} group(s) in sheet "${outSheetName}". Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 25. xlsxSheetState
// ─────────────────────────────────────────────
export async function xlsxSheetState(params: {
  path: string;
  operations: Array<{ sheet: string; state: "visible" | "hidden" | "veryHidden" }>;
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
    const results: string[] = [];

    // Apply operations
    for (const op of params.operations) {
      const sheet = workbook.getWorksheet(op.sheet);
      if (!sheet) {
        return { success: false, output: `Error: Sheet "${op.sheet}" not found` };
      }
      sheet.state = op.state;
      results.push(`"${op.sheet}" → ${op.state}`);
    }

    // Validate: at least one sheet must be visible
    const visibleCount = workbook.worksheets.filter((s) => s.state === "visible").length;
    if (visibleCount === 0) {
      return { success: false, output: `Error: At least one sheet must remain visible` };
    }

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `Updated sheet states: ${results.join(", ")}. Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 26. xlsxRowColVisibility
// ─────────────────────────────────────────────
export async function xlsxRowColVisibility(params: {
  path: string;
  sheet?: string;
  operations: Array<{ type: "row" | "column"; start: number; end?: number; hidden: boolean }>;
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
    const results: string[] = [];

    for (const op of params.operations) {
      const end = op.end ?? op.start;
      if (op.type === "row") {
        for (let i = op.start; i <= end; i++) {
          sheet.getRow(i).hidden = op.hidden;
        }
        results.push(`Row ${op.start}${end > op.start ? `-${end}` : ""} → ${op.hidden ? "hidden" : "visible"}`);
      } else {
        for (let i = op.start; i <= end; i++) {
          sheet.getColumn(i).hidden = op.hidden;
        }
        results.push(`Col ${colToLetter(op.start)}${end > op.start ? `-${colToLetter(end)}` : ""} → ${op.hidden ? "hidden" : "visible"}`);
      }
    }

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `Updated visibility: ${results.join(", ")}. Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 27. xlsxWorkbookProperties
// ─────────────────────────────────────────────
export async function xlsxWorkbookProperties(params: {
  path: string;
  action?: "set" | "get";
  properties?: {
    creator?: string;
    lastModifiedBy?: string;
    created?: string;
    modified?: string;
    title?: string;
    subject?: string;
    description?: string;
    keywords?: string;
    category?: string;
    company?: string;
    manager?: string;
    calcProperties?: { fullCalcOnLoad?: boolean };
  };
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const action = params.action ?? "set";

    if (action === "get") {
      const lines: string[] = ["Workbook Properties:"];
      if (workbook.creator) lines.push(`  Creator: ${workbook.creator}`);
      if (workbook.lastModifiedBy) lines.push(`  Last Modified By: ${workbook.lastModifiedBy}`);
      if (workbook.created) lines.push(`  Created: ${workbook.created instanceof Date ? workbook.created.toISOString() : workbook.created}`);
      if (workbook.modified) lines.push(`  Modified: ${workbook.modified instanceof Date ? workbook.modified.toISOString() : workbook.modified}`);
      if (workbook.title) lines.push(`  Title: ${workbook.title}`);
      if (workbook.subject) lines.push(`  Subject: ${workbook.subject}`);
      if (workbook.description) lines.push(`  Description: ${workbook.description}`);
      if (workbook.keywords) lines.push(`  Keywords: ${workbook.keywords}`);
      if (workbook.category) lines.push(`  Category: ${workbook.category}`);
      if ((workbook as any).company) lines.push(`  Company: ${(workbook as any).company}`);
      if ((workbook as any).manager) lines.push(`  Manager: ${(workbook as any).manager}`);
      return { success: true, output: lines.join("\n") };
    }

    // action === "set"
    if (!params.properties) {
      return { success: false, output: `Error: properties are required for "set" action` };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
    const p = params.properties;
    const changes: string[] = [];

    if (p.creator !== undefined) { workbook.creator = p.creator; changes.push("creator"); }
    if (p.lastModifiedBy !== undefined) { workbook.lastModifiedBy = p.lastModifiedBy; changes.push("lastModifiedBy"); }
    if (p.created !== undefined) { workbook.created = new Date(p.created); changes.push("created"); }
    if (p.modified !== undefined) { workbook.modified = new Date(p.modified); changes.push("modified"); }
    if (p.title !== undefined) { workbook.title = p.title; changes.push("title"); }
    if (p.subject !== undefined) { workbook.subject = p.subject; changes.push("subject"); }
    if (p.description !== undefined) { workbook.description = p.description; changes.push("description"); }
    if (p.keywords !== undefined) { workbook.keywords = p.keywords; changes.push("keywords"); }
    if (p.category !== undefined) { workbook.category = p.category; changes.push("category"); }
    if (p.company !== undefined) { (workbook as any).company = p.company; changes.push("company"); }
    if (p.manager !== undefined) { (workbook as any).manager = p.manager; changes.push("manager"); }
    if (p.calcProperties) {
      workbook.calcProperties = { ...workbook.calcProperties, ...p.calcProperties };
      changes.push("calcProperties");
    }

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `Updated workbook properties: ${changes.join(", ")}. Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 28. xlsxComment
// ─────────────────────────────────────────────
export async function xlsxComment(params: {
  path: string;
  sheet?: string;
  action: "add" | "remove" | "list";
  comments?: Array<{ cell: string; text?: string; author?: string }>;
  range?: string;
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    if (params.action === "list") {
      const lines: string[] = [`Comments in sheet "${sheetName}":`];
      const range = params.range ? expandRange(params.range) : null;

      const extractNoteText = (note: any): string | null => {
        if (!note) return null;
        if (typeof note === "string") return note || null;
        if (note.texts) {
          const text = note.texts.map((t: any) => t.text ?? "").join("");
          return text || null;
        }
        const s = JSON.stringify(note);
        return s && s !== "{}" ? s : null;
      };

      if (range) {
        for (const { col, row } of range) {
          const cell = sheet.getRow(row).getCell(col);
          const noteText = extractNoteText(cell.note);
          if (noteText) {
            lines.push(`  ${colToLetter(col)}${row}: ${noteText}`);
          }
        }
      } else {
        sheet.eachRow((row, rowNumber) => {
          row.eachCell((cell, colNumber) => {
            const noteText = extractNoteText(cell.note);
            if (noteText) {
              lines.push(`  ${colToLetter(colNumber)}${rowNumber}: ${noteText}`);
            }
          });
        });
      }

      if (lines.length === 1) lines.push("  (no comments found)");
      return { success: true, output: lines.join("\n") };
    }

    if (!params.comments || params.comments.length === 0) {
      return { success: false, output: `Error: comments array is required for "${params.action}" action` };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
    const results: string[] = [];

    for (const comment of params.comments) {
      const cell = sheet.getCell(comment.cell);
      if (params.action === "add") {
        if (comment.author) {
          cell.note = {
            texts: [{ text: comment.text ?? "" }],
            margins: { insetmode: "auto", inset: [0.13, 0.13, 0.25, 0.25] },
          } as any;
          (cell.note as any).author = comment.author;
        } else {
          cell.note = comment.text ?? "";
        }
        results.push(`Added comment to ${comment.cell}`);
      } else {
        (cell as any).note = undefined;
        results.push(`Removed comment from ${comment.cell}`);
      }
    }

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `${results.join(". ")}. Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 29. xlsxCellProtection
// ─────────────────────────────────────────────
export async function xlsxCellProtection(params: {
  path: string;
  sheet?: string;
  operations: Array<{ range: string; locked?: boolean; hidden?: boolean }>;
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
    let totalCells = 0;

    for (const op of params.operations) {
      const cells = expandRange(op.range);
      for (const { col, row } of cells) {
        const cell = sheet.getRow(row).getCell(col);
        cell.protection = {
          locked: op.locked ?? true,
          hidden: op.hidden ?? false,
        };
        totalCells++;
      }
    }

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `Updated protection on ${totalCells} cell(s) in ${params.operations.length} range(s). Note: Use xlsx_protect_sheet to enable sheet protection for cell locks to take effect. Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 30. xlsxPageSetup
// ─────────────────────────────────────────────
export async function xlsxPageSetup(params: {
  path: string;
  sheet?: string;
  action?: "set" | "get";
  settings?: {
    paperSize?: number;
    orientation?: "portrait" | "landscape";
    margins?: { top?: number; bottom?: number; left?: number; right?: number; header?: number; footer?: number };
    fitToPage?: boolean;
    fitToWidth?: number;
    fitToHeight?: number;
    scale?: number;
    printArea?: string;
    printTitlesRow?: string;
    printTitlesColumn?: string;
    horizontalCentered?: boolean;
    verticalCentered?: boolean;
    showGridLines?: boolean;
    showRowColHeaders?: boolean;
    pageOrder?: "downThenOver" | "overThenDown";
    blackAndWhite?: boolean;
    draft?: boolean;
  };
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    const action = params.action ?? "set";

    if (action === "get") {
      const ps = sheet.pageSetup;
      const lines: string[] = [`Page setup for sheet "${sheetName}":`];
      if (ps.paperSize) lines.push(`  Paper size: ${ps.paperSize}`);
      if (ps.orientation) lines.push(`  Orientation: ${ps.orientation}`);
      if (ps.fitToPage !== undefined) lines.push(`  Fit to page: ${ps.fitToPage}`);
      if (ps.fitToWidth) lines.push(`  Fit to width: ${ps.fitToWidth}`);
      if (ps.fitToHeight) lines.push(`  Fit to height: ${ps.fitToHeight}`);
      if (ps.scale) lines.push(`  Scale: ${ps.scale}`);
      if (ps.printArea) lines.push(`  Print area: ${ps.printArea}`);
      if (ps.printTitlesRow) lines.push(`  Print titles row: ${ps.printTitlesRow}`);
      if (ps.printTitlesColumn) lines.push(`  Print titles column: ${ps.printTitlesColumn}`);
      if (ps.horizontalCentered) lines.push(`  Horizontal centered: ${ps.horizontalCentered}`);
      if (ps.verticalCentered) lines.push(`  Vertical centered: ${ps.verticalCentered}`);
      if (ps.showGridLines !== undefined) lines.push(`  Show grid lines: ${ps.showGridLines}`);
      if (ps.showRowColHeaders !== undefined) lines.push(`  Show row/col headers: ${ps.showRowColHeaders}`);
      if (ps.pageOrder) lines.push(`  Page order: ${ps.pageOrder}`);
      if (ps.blackAndWhite) lines.push(`  Black and white: ${ps.blackAndWhite}`);
      if (ps.draft) lines.push(`  Draft: ${ps.draft}`);
      const margins = ps.margins;
      if (margins) {
        lines.push(`  Margins: top=${margins.top}, bottom=${margins.bottom}, left=${margins.left}, right=${margins.right}, header=${margins.header}, footer=${margins.footer}`);
      }
      return { success: true, output: lines.join("\n") };
    }

    // action === "set"
    if (!params.settings) {
      return { success: false, output: `Error: settings are required for "set" action` };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
    const s = params.settings;
    const changes: string[] = [];

    if (s.paperSize !== undefined) { sheet.pageSetup.paperSize = s.paperSize; changes.push("paperSize"); }
    if (s.orientation !== undefined) { sheet.pageSetup.orientation = s.orientation; changes.push("orientation"); }
    if (s.fitToPage !== undefined) { sheet.pageSetup.fitToPage = s.fitToPage; changes.push("fitToPage"); }
    if (s.fitToWidth !== undefined) { sheet.pageSetup.fitToWidth = s.fitToWidth; changes.push("fitToWidth"); }
    if (s.fitToHeight !== undefined) { sheet.pageSetup.fitToHeight = s.fitToHeight; changes.push("fitToHeight"); }
    if (s.scale !== undefined) { sheet.pageSetup.scale = s.scale; changes.push("scale"); }
    if (s.printArea !== undefined) { sheet.pageSetup.printArea = s.printArea; changes.push("printArea"); }
    if (s.printTitlesRow !== undefined) { sheet.pageSetup.printTitlesRow = s.printTitlesRow; changes.push("printTitlesRow"); }
    if (s.printTitlesColumn !== undefined) { sheet.pageSetup.printTitlesColumn = s.printTitlesColumn; changes.push("printTitlesColumn"); }
    if (s.horizontalCentered !== undefined) { sheet.pageSetup.horizontalCentered = s.horizontalCentered; changes.push("horizontalCentered"); }
    if (s.verticalCentered !== undefined) { sheet.pageSetup.verticalCentered = s.verticalCentered; changes.push("verticalCentered"); }
    if (s.showGridLines !== undefined) { sheet.pageSetup.showGridLines = s.showGridLines; changes.push("showGridLines"); }
    if (s.showRowColHeaders !== undefined) { sheet.pageSetup.showRowColHeaders = s.showRowColHeaders; changes.push("showRowColHeaders"); }
    if (s.pageOrder !== undefined) { sheet.pageSetup.pageOrder = s.pageOrder; changes.push("pageOrder"); }
    if (s.blackAndWhite !== undefined) { sheet.pageSetup.blackAndWhite = s.blackAndWhite; changes.push("blackAndWhite"); }
    if (s.draft !== undefined) { sheet.pageSetup.draft = s.draft; changes.push("draft"); }
    if (s.margins) {
      const current = sheet.pageSetup.margins ?? { top: 0.75, bottom: 0.75, left: 0.7, right: 0.7, header: 0.3, footer: 0.3 };
      sheet.pageSetup.margins = {
        top: s.margins.top ?? current.top,
        bottom: s.margins.bottom ?? current.bottom,
        left: s.margins.left ?? current.left,
        right: s.margins.right ?? current.right,
        header: s.margins.header ?? current.header,
        footer: s.margins.footer ?? current.footer,
      };
      changes.push("margins");
    }

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `Updated page setup for sheet "${sheetName}": ${changes.join(", ")}. Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 31. xlsxHeaderFooter
// ─────────────────────────────────────────────
export async function xlsxHeaderFooter(params: {
  path: string;
  sheet?: string;
  action?: "set" | "get";
  settings?: {
    oddHeader?: string;
    oddFooter?: string;
    evenHeader?: string;
    evenFooter?: string;
    firstHeader?: string;
    firstFooter?: string;
    differentFirst?: boolean;
    differentOddEven?: boolean;
  };
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    const action = params.action ?? "set";

    // Ensure headerFooter object exists
    if (!sheet.headerFooter) {
      (sheet as any).headerFooter = {};
    }

    if (action === "get") {
      const hf = sheet.headerFooter ?? {};
      const lines: string[] = [`Header/Footer for sheet "${sheetName}":`];
      if (hf.oddHeader) lines.push(`  Odd header: ${hf.oddHeader}`);
      if (hf.oddFooter) lines.push(`  Odd footer: ${hf.oddFooter}`);
      if (hf.evenHeader) lines.push(`  Even header: ${hf.evenHeader}`);
      if (hf.evenFooter) lines.push(`  Even footer: ${hf.evenFooter}`);
      if (hf.firstHeader) lines.push(`  First header: ${hf.firstHeader}`);
      if (hf.firstFooter) lines.push(`  First footer: ${hf.firstFooter}`);
      if (hf.differentFirst) lines.push(`  Different first: ${hf.differentFirst}`);
      if (hf.differentOddEven) lines.push(`  Different odd/even: ${hf.differentOddEven}`);
      lines.push("");
      lines.push("Format codes: &L(left) &C(center) &R(right) &P(page#) &N(total pages) &D(date) &T(time) &F(filename) &A(sheet name)");
      return { success: true, output: lines.join("\n") };
    }

    // action === "set"
    if (!params.settings) {
      return { success: false, output: `Error: settings are required for "set" action` };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
    const s = params.settings;
    const hf = sheet.headerFooter;
    const changes: string[] = [];

    if (s.oddHeader !== undefined) { hf.oddHeader = s.oddHeader; changes.push("oddHeader"); }
    if (s.oddFooter !== undefined) { hf.oddFooter = s.oddFooter; changes.push("oddFooter"); }
    if (s.evenHeader !== undefined) { hf.evenHeader = s.evenHeader; changes.push("evenHeader"); }
    if (s.evenFooter !== undefined) { hf.evenFooter = s.evenFooter; changes.push("evenFooter"); }
    if (s.firstHeader !== undefined) { hf.firstHeader = s.firstHeader; changes.push("firstHeader"); }
    if (s.firstFooter !== undefined) { hf.firstFooter = s.firstFooter; changes.push("firstFooter"); }
    if (s.differentFirst !== undefined) { hf.differentFirst = s.differentFirst; changes.push("differentFirst"); }
    if (s.differentOddEven !== undefined) { hf.differentOddEven = s.differentOddEven; changes.push("differentOddEven"); }

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `Updated header/footer for sheet "${sheetName}": ${changes.join(", ")}. Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 32. xlsxOutlineGroup
// ─────────────────────────────────────────────
export async function xlsxOutlineGroup(params: {
  path: string;
  sheet?: string;
  operations: Array<{ type: "row" | "column"; start: number; end: number; outlineLevel: number; collapsed?: boolean }>;
  outlineProperties?: { summaryBelow?: boolean; summaryRight?: boolean };
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
    const results: string[] = [];

    if (params.outlineProperties) {
      sheet.properties.outlineProperties = {
        ...sheet.properties.outlineProperties,
        ...params.outlineProperties,
      };
      results.push(`Set outline properties`);
    }

    for (const op of params.operations) {
      if (op.type === "row") {
        for (let i = op.start; i <= op.end; i++) {
          const row = sheet.getRow(i);
          row.outlineLevel = op.outlineLevel;
          if (op.collapsed !== undefined) {
            (row as any).hidden = op.collapsed;
          }
        }
        results.push(`Rows ${op.start}-${op.end} → outline level ${op.outlineLevel}${op.collapsed ? " (collapsed)" : ""}`);
      } else {
        for (let i = op.start; i <= op.end; i++) {
          const col = sheet.getColumn(i);
          col.outlineLevel = op.outlineLevel;
          if (op.collapsed !== undefined) {
            col.hidden = op.collapsed;
          }
        }
        results.push(`Cols ${colToLetter(op.start)}-${colToLetter(op.end)} → outline level ${op.outlineLevel}${op.collapsed ? " (collapsed)" : ""}`);
      }
    }

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `Updated outline groups: ${results.join(", ")}. Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 33. xlsxDuplicateRow
// ─────────────────────────────────────────────
export async function xlsxDuplicateRow(params: {
  path: string;
  sheet?: string;
  rowNumber: number;
  count?: number;
  insert?: boolean;
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
    const count = params.count ?? 1;
    const insert = params.insert ?? true;

    sheet.duplicateRow(params.rowNumber, count, insert);

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `Duplicated row ${params.rowNumber} (${count} time(s), insert=${insert}) in sheet "${sheetName}". Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 34. xlsxTable
// ─────────────────────────────────────────────
export async function xlsxTable(params: {
  path: string;
  sheet?: string;
  action: "add" | "get" | "remove" | "list";
  table?: {
    name: string;
    ref: string;
    headerRow?: boolean;
    totalsRow?: boolean;
    style?: {
      theme?: string;
      showRowStripes?: boolean;
      showColumnStripes?: boolean;
      showFirstColumn?: boolean;
      showLastColumn?: boolean;
    };
    columns: Array<{
      name: string;
      filterButton?: boolean;
      totalsRowLabel?: string;
      totalsRowFunction?: "none" | "average" | "countNums" | "count" | "max" | "min" | "stdDev" | "var" | "sum" | "custom";
      totalsRowFormula?: string;
    }>;
    rows: any[][];
  };
  tableName?: string;
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    switch (params.action) {
      case "list": {
        const tableMap = (sheet as any)._tables ?? (sheet as any).tables;
        const lines: string[] = [`Tables in sheet "${sheetName}":`];
        if (tableMap && typeof tableMap === "object") {
          const entries = tableMap instanceof Map ? Array.from(tableMap.entries()) : Object.entries(tableMap);
          if (entries.length === 0) {
            lines.push("  (no tables)");
          } else {
            for (const [key, table] of entries) {
              const t = table as any;
              lines.push(`  ${t.name ?? key}: ref=${t.ref ?? t.tableRef ?? "?"}`);
            }
          }
        } else {
          lines.push("  (no tables)");
        }
        return { success: true, output: lines.join("\n") };
      }

      case "get": {
        if (!params.tableName) {
          return { success: false, output: `Error: tableName is required for "get" action` };
        }
        const table = sheet.getTable(params.tableName) as any;
        if (!table) {
          return { success: false, output: `Error: Table "${params.tableName}" not found` };
        }
        const t = table.table ?? table;
        const lines: string[] = [
          `Table: ${t.name}`,
          `  Ref: ${t.ref}`,
          `  Header row: ${t.headerRow ?? true}`,
          `  Totals row: ${t.totalsRow ?? false}`,
          `  Columns: ${(t.columns ?? []).map((c: any) => c.name).join(", ")}`,
          `  Rows: ${t.rows?.length ?? 0}`,
        ];
        if (t.style) {
          lines.push(`  Style theme: ${t.style.theme ?? "(none)"}`);
        }
        return { success: true, output: lines.join("\n") };
      }

      case "remove": {
        if (!params.tableName) {
          return { success: false, output: `Error: tableName is required for "remove" action` };
        }
        sheet.removeTable(params.tableName);
        const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
        await workbook.xlsx.writeFile(outputPath);
        return {
          success: true,
          output: `Removed table "${params.tableName}" from sheet "${sheetName}". Saved to: ${outputPath}`,
          outputPath,
        };
      }

      case "add": {
        if (!params.table) {
          return { success: false, output: `Error: table definition is required for "add" action` };
        }

        // Validate table name: no spaces, cannot start with number
        const tName = params.table.name;
        if (/\s/.test(tName)) {
          return { success: false, output: `Error: Table name "${tName}" cannot contain spaces` };
        }
        if (/^\d/.test(tName)) {
          return { success: false, output: `Error: Table name "${tName}" cannot start with a number` };
        }

        sheet.addTable({
          name: params.table.name,
          ref: params.table.ref,
          headerRow: params.table.headerRow ?? true,
          totalsRow: params.table.totalsRow ?? false,
          style: (params.table.style ?? {}) as any,
          columns: params.table.columns,
          rows: params.table.rows,
        });

        const outputPath = params.outputPath ?? defaultOutputPath(inputPath);
        await workbook.xlsx.writeFile(outputPath);
        return {
          success: true,
          output: `Added table "${tName}" at ${params.table.ref} with ${params.table.columns.length} column(s) and ${params.table.rows.length} row(s). Saved to: ${outputPath}`,
          outputPath,
        };
      }
    }
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 35. xlsxCsvIo
// ─────────────────────────────────────────────
export async function xlsxCsvIo(params: {
  action: "read" | "write";
  path: string;
  csvPath: string;
  options?: {
    sheetName?: string;
    delimiter?: string;
    encoding?: string;
    dateFormats?: string[];
    dateFormat?: string;
    dateUTC?: boolean;
    sheetId?: number;
    includeEmptyRows?: boolean;
  };
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    if (params.action === "read") {
      // CSV → XLSX
      if (!(await pathExists(params.csvPath))) {
        return { success: false, output: `Error: CSV file not found: ${params.csvPath}` };
      }

      const workbook = new ExcelJS.Workbook();
      const csvOptions: any = {};
      const parserOpts: any = {};
      if (params.options?.delimiter) parserOpts.delimiter = params.options.delimiter;
      if (Object.keys(parserOpts).length > 0) csvOptions.parserOptions = parserOpts;
      if (params.options?.dateFormats) csvOptions.dateFormats = params.options.dateFormats;
      if (params.options?.dateUTC !== undefined) csvOptions.dateUTC = params.options.dateUTC;
      if (params.options?.includeEmptyRows !== undefined) csvOptions.includeEmptyRows = params.options.includeEmptyRows;

      await workbook.csv.readFile(params.csvPath, csvOptions);

      // Rename default sheet if sheetName provided
      if (params.options?.sheetName && workbook.worksheets.length > 0) {
        workbook.worksheets[0].name = params.options.sheetName;
      }

      const outputPath = params.outputPath ?? params.path;
      await workbook.xlsx.writeFile(outputPath);

      const rowCount = workbook.worksheets[0]?.rowCount ?? 0;
      return {
        success: true,
        output: `Converted CSV to XLSX (${rowCount} rows). Saved to: ${outputPath}`,
        outputPath,
      };
    } else {
      // XLSX → CSV
      if (!(await pathExists(params.path))) {
        return { success: false, output: `Error: XLSX file not found: ${params.path}` };
      }

      const workbook = new ExcelJS.Workbook();
      await workbook.xlsx.readFile(params.path);

      const csvOptions: any = {};
      const fmtOpts: any = {};
      if (params.options?.delimiter) fmtOpts.delimiter = params.options.delimiter;
      if (Object.keys(fmtOpts).length > 0) csvOptions.formatterOptions = fmtOpts;
      if (params.options?.dateFormat) csvOptions.dateFormat = params.options.dateFormat;
      if (params.options?.dateUTC !== undefined) csvOptions.dateUTC = params.options.dateUTC;
      if (params.options?.encoding) csvOptions.encoding = params.options.encoding;
      if (params.options?.includeEmptyRows !== undefined) csvOptions.includeEmptyRows = params.options.includeEmptyRows;
      if (params.options?.sheetId !== undefined) csvOptions.sheetId = params.options.sheetId;
      if (params.options?.sheetName) csvOptions.sheetName = params.options.sheetName;

      const outputCsvPath = params.csvPath;
      await workbook.csv.writeFile(outputCsvPath, csvOptions);

      return {
        success: true,
        output: `Converted XLSX to CSV. Saved to: ${outputCsvPath}`,
        outputPath: outputCsvPath,
      };
    }
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 36. xlsxBackgroundImage
// ─────────────────────────────────────────────
export async function xlsxBackgroundImage(params: {
  path: string;
  sheet?: string;
  image: {
    filePath?: string;
    base64?: string;
    extension: "png" | "jpeg" | "gif";
  };
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    const outputPath = params.outputPath ?? defaultOutputPath(inputPath);

    let imageId: number;
    if (params.image.filePath) {
      if (!(await pathExists(params.image.filePath))) {
        return { success: false, output: `Error: Image file not found: ${params.image.filePath}` };
      }
      imageId = workbook.addImage({
        filename: params.image.filePath,
        extension: params.image.extension,
      });
    } else if (params.image.base64) {
      imageId = workbook.addImage({
        base64: params.image.base64,
        extension: params.image.extension,
      });
    } else {
      return { success: false, output: "Error: Either filePath or base64 must be provided for the image" };
    }

    sheet.addBackgroundImage(imageId);

    await workbook.xlsx.writeFile(outputPath);
    return {
      success: true,
      output: `Set background image on sheet "${sheetName}". Saved to: ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ─────────────────────────────────────────────
// 37. xlsxFormula
// ─────────────────────────────────────────────

/**
 * Translate a formula's cell references when filling from a master cell to a target cell.
 * E.g., master at B2 with formula "SUM(A1:A10)" filled to C3 → "SUM(B2:B11)"
 * Supports absolute references ($A$1 stays fixed, $A1 shifts row only, A$1 shifts col only).
 */
function translateFormula(
  formula: string,
  masterCol: number,
  masterRow: number,
  targetCol: number,
  targetRow: number
): string {
  const dCol = targetCol - masterCol;
  const dRow = targetRow - masterRow;

  // Match cell references like A1, $A1, A$1, $A$1, AA123, etc.
  return formula.replace(
    /(\$?)([A-Z]{1,3})(\$?)(\d+)/gi,
    (_match, colLock: string, colStr: string, rowLock: string, rowStr: string) => {
      let col = 0;
      const upper = colStr.toUpperCase();
      for (let i = 0; i < upper.length; i++) {
        col = col * 26 + (upper.charCodeAt(i) - 64);
      }
      let row = parseInt(rowStr, 10);

      if (!colLock) col += dCol;
      if (!rowLock) row += dRow;

      // Clamp to valid ranges
      if (col < 1) col = 1;
      if (row < 1) row = 1;

      const newColStr = colToLetter(col);
      return `${colLock}${newColStr}${rowLock}${row}`;
    }
  );
}

export async function xlsxFormula(params: {
  path: string;
  sheet?: string;
  action: "set" | "fill" | "array" | "clear" | "list";
  // For "set": insert formulas into specific cells
  formulas?: Array<{ cell: string; formula: string; result?: string | number | boolean }>;
  // For "fill": apply a master formula across a range with auto reference translation
  fill?: {
    masterCell: string;
    formula: string;
    fillRange: string; // e.g., "B2:B20" — master cell should be top-left corner
    result?: string | number | boolean; // cached result for master cell
  };
  // For "array": insert a CSE array formula
  array?: {
    range: string; // result range, e.g., "D1:D5"
    formula: string;
  };
  // For "clear": remove formulas, keeping cached values
  clearRange?: string; // e.g., "A1:C10"
  // For "list": list all formulas
  listRange?: string; // optional range to limit listing
  outputPath?: string;
}): Promise<ToolResult> {
  try {
    const inputPath = params.path;
    if (!(await pathExists(inputPath))) {
      return { success: false, output: `Error: File not found: ${inputPath}` };
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(inputPath);

    const sheetName = params.sheet ?? workbook.worksheets[0]?.name;
    const sheet = workbook.getWorksheet(sheetName);
    if (!sheet) {
      return { success: false, output: `Error: Sheet "${sheetName}" not found` };
    }

    const needsWrite = params.action !== "list";
    const outputPath = needsWrite
      ? (params.outputPath ?? defaultOutputPath(inputPath))
      : undefined;

    switch (params.action) {
      case "set": {
        if (!params.formulas || params.formulas.length === 0) {
          return { success: false, output: 'Error: "formulas" array is required for "set" action' };
        }

        for (const f of params.formulas) {
          const cell = sheet.getCell(f.cell);
          const formulaValue: any = { formula: f.formula };
          if (f.result !== undefined) formulaValue.result = f.result;
          cell.value = formulaValue;
        }

        // Auto-set fullCalcOnLoad
        workbook.calcProperties = { ...(workbook.calcProperties ?? {}), fullCalcOnLoad: true };

        await workbook.xlsx.writeFile(outputPath!);
        return {
          success: true,
          output: `Set ${params.formulas.length} formula(s) on sheet "${sheetName}". fullCalcOnLoad enabled. Saved to: ${outputPath}`,
          outputPath,
        };
      }

      case "fill": {
        if (!params.fill) {
          return { success: false, output: 'Error: "fill" object is required for "fill" action' };
        }

        const { masterCell, formula, fillRange } = params.fill;
        const master = parseCellAddress(masterCell);
        const rangeCells = expandRange(fillRange);
        if (rangeCells.length === 0) {
          return { success: false, output: `Error: Invalid fill range: ${fillRange}` };
        }

        let count = 0;
        for (const rc of rangeCells) {
          const translated = translateFormula(formula, master.col, master.row, rc.col, rc.row);
          const cell = sheet.getCell(rc.row, rc.col);
          const formulaValue: any = { formula: translated };
          if (rc.col === master.col && rc.row === master.row && params.fill.result !== undefined) {
            formulaValue.result = params.fill.result;
          }
          cell.value = formulaValue;
          count++;
        }

        workbook.calcProperties = { ...(workbook.calcProperties ?? {}), fullCalcOnLoad: true };

        await workbook.xlsx.writeFile(outputPath!);
        return {
          success: true,
          output: `Filled ${count} cell(s) in range ${fillRange} with formula "${formula}" (auto-translated references). fullCalcOnLoad enabled. Saved to: ${outputPath}`,
          outputPath,
        };
      }

      case "array": {
        if (!params.array) {
          return { success: false, output: 'Error: "array" object is required for "array" action' };
        }

        const { range, formula } = params.array;
        const rangeParts = range.split(":");
        const topLeft = rangeParts[0];

        // Set the master cell with the array formula
        const cell = sheet.getCell(topLeft);
        cell.value = {
          formula: formula,
          ref: range,
          shareType: "array",
        } as any;

        workbook.calcProperties = { ...(workbook.calcProperties ?? {}), fullCalcOnLoad: true };

        await workbook.xlsx.writeFile(outputPath!);
        return {
          success: true,
          output: `Set array formula {${formula}} over range ${range}. fullCalcOnLoad enabled. Saved to: ${outputPath}`,
          outputPath,
        };
      }

      case "clear": {
        if (!params.clearRange) {
          return { success: false, output: 'Error: "clearRange" is required for "clear" action' };
        }

        const cells = expandRange(params.clearRange);
        let cleared = 0;
        for (const rc of cells) {
          const cell = sheet.getCell(rc.row, rc.col);
          if (cell.type === ExcelJS.ValueType.Formula) {
            const fv = cell.value as ExcelJS.CellFormulaValue;
            // Keep the cached result value
            cell.value = fv.result ?? null;
            cleared++;
          }
        }

        await workbook.xlsx.writeFile(outputPath!);
        return {
          success: true,
          output: `Cleared ${cleared} formula(s) in range ${params.clearRange} (cached values preserved). Saved to: ${outputPath}`,
          outputPath,
        };
      }

      case "list": {
        const targetCells = params.listRange
          ? expandRange(params.listRange)
          : null;

        const formulas: Array<{ cell: string; formula: string; result: any }> = [];

        if (targetCells) {
          for (const rc of targetCells) {
            const cell = sheet.getCell(rc.row, rc.col);
            if (cell.type === ExcelJS.ValueType.Formula) {
              const fv = cell.value as ExcelJS.CellFormulaValue;
              formulas.push({
                cell: `${colToLetter(rc.col)}${rc.row}`,
                formula: fv.formula,
                result: fv.result ?? null,
              });
            }
          }
        } else {
          // Scan entire sheet
          sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
            row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
              if (cell.type === ExcelJS.ValueType.Formula) {
                const fv = cell.value as ExcelJS.CellFormulaValue;
                formulas.push({
                  cell: `${colToLetter(colNumber)}${rowNumber}`,
                  formula: fv.formula,
                  result: fv.result ?? null,
                });
              }
            });
          });
        }

        const lines = formulas.map(
          (f) => `${f.cell}: =${f.formula} → ${f.result ?? "(no cached result)"}`
        );

        return {
          success: true,
          output: formulas.length > 0
            ? `Found ${formulas.length} formula(s) on sheet "${sheetName}":\n${lines.join("\n")}`
            : `No formulas found on sheet "${sheetName}"${params.listRange ? ` in range ${params.listRange}` : ""}.`,
        };
      }

      default:
        return { success: false, output: `Error: Unknown action "${params.action}"` };
    }
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}
