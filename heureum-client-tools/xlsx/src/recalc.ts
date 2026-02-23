/**
 * Excel formula recalculation with LibreOffice.
 * Ported from skills/xlsx/scripts/recalc.py
 *
 * NOTE:
 * chart/pivot/recalc features depend on soffice.
 * If full OS-independent behavior is required, run these features in a server-side container.
 */
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as child_process from "child_process";
import JSZip from "jszip";
import { XMLParser } from "fast-xml-parser";
import { getSofficeEnv } from "./soffice";

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}


const MACRO_DIR_MACOS = "~/Library/Application Support/LibreOffice/4/user/basic/Standard";
const MACRO_DIR_LINUX = "~/.config/libreoffice/4/user/basic/Standard";
const MACRO_FILENAME = "Module1.xba";

const RECALCULATE_MACRO = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE script:module PUBLIC "-//OpenOffice.org//DTD OfficeDocument 1.0//EN" "module.dtd">
<script:module xmlns:script="http://openoffice.org/2000/script" script:name="Module1" script:language="StarBasic">
    Sub RecalculateAndSave()
      ThisComponent.calculateAll()
      ThisComponent.store()
      ThisComponent.close(True)
    End Sub
</script:module>`;

const EXCEL_ERRORS = ["#VALUE!", "#DIV/0!", "#REF!", "#NAME?", "#NULL!", "#NUM!", "#N/A"];

function expandHomeDir(inputPath: string): string {
  if (!inputPath.startsWith("~")) return inputPath;
  return path.join(os.homedir(), inputPath.slice(1));
}

function hasGtimeout(): boolean {
  try {
    const result = child_process.spawnSync("gtimeout", ["--version"], {
      encoding: "utf-8",
      timeout: 1000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function setupLibreOfficeMacro(): boolean {
  const macroDir = expandHomeDir(
    process.platform === "darwin" ? MACRO_DIR_MACOS : MACRO_DIR_LINUX
  );
  const macroFile = path.join(macroDir, MACRO_FILENAME);

  if (fs.existsSync(macroFile)) {
    const content = fs.readFileSync(macroFile, "utf-8");
    if (content.includes("RecalculateAndSave")) {
      return true;
    }
  }

  if (!fs.existsSync(macroDir)) {
    child_process.spawnSync("soffice", ["--headless", "--terminate_after_init"], {
      encoding: "utf-8",
      timeout: 10000,
      env: getSofficeEnv(),
    });
    fs.mkdirSync(macroDir, { recursive: true });
  }

  try {
    fs.writeFileSync(macroFile, RECALCULATE_MACRO, "utf-8");
    return true;
  } catch {
    return false;
  }
}

function toArray<T>(value: T | T[] | undefined | null): T[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function asString(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

function normalizeTargetPath(target: string): string {
  const withoutLeading = target.replace(/^\//, "");
  const normalized = path.posix.normalize(withoutLeading);
  return normalized.replace(/^\.\//, "");
}

async function inspectWorkbook(xlsxPath: string): Promise<{
  totalErrors: number;
  errorSummary: Record<string, { count: number; locations: string[] }>;
  totalFormulas: number;
}> {
  const buffer = (await fs.promises.readFile(xlsxPath));
  const zip = await JSZip.loadAsync(buffer);

  const parser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: "@_",
    parseTagValue: false,
    trimValues: false,
    processEntities: false,
  });

  const sharedStringsXml = await zip.file("xl/sharedStrings.xml")?.async("string");
  const sharedStrings: string[] = [];
  if (sharedStringsXml) {
    const sst = parser.parse(sharedStringsXml);
    const siEntries = toArray(sst?.sst?.si);
    for (const si of siEntries) {
      if (typeof si?.t === "string" || typeof si?.t === "number") {
        sharedStrings.push(String(si.t));
      } else {
        const runs = toArray(si?.r);
        const parts: string[] = [];
        for (const run of runs) {
          if (run?.t !== undefined) parts.push(String(run.t));
        }
        sharedStrings.push(parts.join(""));
      }
    }
  }

  const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
  const workbookRelsXml = await zip.file("xl/_rels/workbook.xml.rels")?.async("string");

  if (!workbookXml || !workbookRelsXml) {
    return {
      totalErrors: 0,
      errorSummary: {},
      totalFormulas: 0,
    };
  }

  const workbook = parser.parse(workbookXml);
  const workbookRels = parser.parse(workbookRelsXml);

  const sheetEntries = toArray(workbook?.workbook?.sheets?.sheet);
  const relEntries = toArray(workbookRels?.Relationships?.Relationship);

  const ridToTarget = new Map<string, string>();
  for (const rel of relEntries) {
    const rid = asString(rel?.["@_Id"]);
    const target = asString(rel?.["@_Target"]);
    if (rid && target) {
      ridToTarget.set(rid, normalizeTargetPath(target));
    }
  }

  const errorDetails: Record<string, string[]> = Object.fromEntries(
    EXCEL_ERRORS.map((error) => [error, []])
  );
  let totalErrors = 0;
  let totalFormulas = 0;

  for (const sheet of sheetEntries) {
    const sheetName = asString(sheet?.["@_name"]) || "Sheet";
    const rid = asString(sheet?.["@_r:id"]);
    const target = ridToTarget.get(rid);
    if (!target) continue;

    const worksheetPath = path.posix.join("xl", target);
    const worksheetXml = await zip.file(worksheetPath)?.async("string");
    if (!worksheetXml) continue;

    const worksheet = parser.parse(worksheetXml);
    const rows = toArray(worksheet?.worksheet?.sheetData?.row);

    for (const row of rows) {
      const cells = toArray(row?.c);
      for (const cell of cells) {
        const coordinate = asString(cell?.["@_r"]);

        const hasFormula = cell?.f !== undefined;
        if (hasFormula) {
          totalFormulas += 1;
        }

        const cellType = asString(cell?.["@_t"]);
        const rawValue = cell?.v;
        const inlineValue = cell?.is?.t;

        const candidateValues: string[] = [];
        if (rawValue !== undefined) {
          if (cellType === "s") {
            const idx = parseInt(asString(rawValue), 10);
            if (idx >= 0 && idx < sharedStrings.length) {
              candidateValues.push(sharedStrings[idx]);
            }
          } else {
            candidateValues.push(asString(rawValue));
          }
        }
        if (inlineValue !== undefined) {
          candidateValues.push(asString(inlineValue));
        }

        for (const candidate of candidateValues) {
          for (const errType of EXCEL_ERRORS) {
            if (!candidate.includes(errType)) continue;
            const location = `${sheetName}!${coordinate}`;
            errorDetails[errType].push(location);
            totalErrors += 1;
            break;
          }
        }
      }
    }
  }

  const errorSummary: Record<string, { count: number; locations: string[] }> = {};
  for (const errType of EXCEL_ERRORS) {
    const locations = errorDetails[errType];
    if (locations.length > 0) {
      errorSummary[errType] = {
        count: locations.length,
        locations: locations.slice(0, 20),
      };
    }
  }

  return {
    totalErrors,
    errorSummary,
    totalFormulas,
  };
}

export type RecalcResult =
  | { error: string }
  | {
      status: "success" | "errors_found";
      total_errors: number;
      error_summary: Record<string, { count: number; locations: string[] }>;
      total_formulas: number;
    };

type CommandResult = {
  status: number;
  stdout: string;
  stderr: string;
  error?: NodeJS.ErrnoException;
};

async function runCommand(
  command: string,
  args: string[],
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {}
): Promise<CommandResult> {
  return await new Promise((resolve) => {
    const child = child_process.spawn(command, args, {
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf-8");
    child.stderr?.setEncoding("utf-8");
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });

    let killedByTimeout = false;
    let timer: NodeJS.Timeout | undefined;
    if (options.timeoutMs && options.timeoutMs > 0) {
      timer = setTimeout(() => {
        killedByTimeout = true;
        child.kill("SIGKILL");
      }, options.timeoutMs);
    }

    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({ status: 1, stdout, stderr, error: error as NodeJS.ErrnoException });
    });

    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ status: killedByTimeout ? 124 : (code ?? 1), stdout, stderr });
    });
  });
}

export async function recalc(filePath: string, timeoutSeconds: number = 30): Promise<RecalcResult> {
  if (!(await pathExists(filePath))) {
    return { error: `File ${filePath} does not exist` };
  }

  const absPath = path.resolve(filePath);

  if (!setupLibreOfficeMacro()) {
    return { error: "Failed to setup LibreOffice macro" };
  }

  const sofficeArgs = [
    "--headless",
    "--norestore",
    "vnd.sun.star.script:Standard.Module1.RecalculateAndSave?language=Basic&location=application",
    absPath,
  ];

  let command = "soffice";
  let args = sofficeArgs;

  if (process.platform === "linux") {
    command = "timeout";
    args = [String(timeoutSeconds), "soffice", ...sofficeArgs];
  } else if (process.platform === "darwin" && hasGtimeout()) {
    command = "gtimeout";
    args = [String(timeoutSeconds), "soffice", ...sofficeArgs];
  }

  const result = await runCommand(command, args, {
    env: getSofficeEnv(),
    timeoutMs: timeoutSeconds * 1000 + 5000,
  });

  const status = result.status;
  if (status !== 0 && status !== 124) {
    const errorMessage = (result.stderr || "Unknown error during recalculation").trim();
    if (errorMessage.includes("Module1") || !errorMessage.includes("RecalculateAndSave")) {
      return { error: "LibreOffice macro not configured properly" };
    }
    return { error: errorMessage };
  }

  try {
    const inspected = await inspectWorkbook(filePath);
    return {
      status: inspected.totalErrors === 0 ? "success" : "errors_found",
      total_errors: inspected.totalErrors,
      error_summary: inspected.errorSummary,
      total_formulas: inspected.totalFormulas,
    };
  } catch (error: any) {
    return { error: error?.message ?? String(error) };
  }
}
