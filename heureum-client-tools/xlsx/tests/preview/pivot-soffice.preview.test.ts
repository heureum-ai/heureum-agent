import * as childProcess from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { xlsxPivotSummary } from "../../src/tools";
import { fixture } from "../helpers";

function toUserInstallationUri(profileRoot: string): string {
  const slash = profileRoot.replace(/\\/g, "/");
  if (/^[A-Za-z]:\//.test(slash)) {
    return `file:///${encodeURI(slash)}`;
  }
  const normalized = slash.startsWith("/") ? slash : `/${slash}`;
  return `file://${encodeURI(normalized)}`;
}

function hasSofficePivotRuntime(): boolean {
  const profileRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lo-pivot-probe-"));
  try {
    const result = childProcess.spawnSync(
      "soffice",
      [
        "--headless",
        "--norestore",
        `-env:UserInstallation=${toUserInstallationUri(profileRoot)}`,
        "--terminate_after_init",
      ],
      { encoding: "utf-8", timeout: 5000 }
    );
    return result.status === 0;
  } catch {
    return false;
  } finally {
    fs.rmSync(profileRoot, { recursive: true, force: true });
  }
}

const describeWithSoffice = hasSofficePivotRuntime() ? describe : describe.skip;

describeWithSoffice("Preview: soffice pivot table", () => {
  it("creates native pivot parts in workbook package", async () => {
    const sourcePath = fixture("preview_pivot_soffice_source.xlsx");
    const outputPath = fixture("preview_pivot_soffice_output.xlsx");

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Data");
    ws.addRow(["Region", "Amount", "Category"]);
    ws.addRow(["Seoul", 120, "A"]);
    ws.addRow(["Seoul", 80, "B"]);
    ws.addRow(["Busan", 50, "A"]);
    ws.addRow(["Busan", 30, "B"]);
    await wb.xlsx.writeFile(sourcePath);

    const result = await xlsxPivotSummary({
      path: sourcePath,
      engine: "soffice",
      sheet: "Data",
      dataRange: "A1:C5",
      config: {
        rowFields: [1],
        valueFields: [{ column: 2, aggregation: "sum" }],
      },
      outputSheet: "PivotTable",
      outputPath,
    });

    expect(result.success, result.output).toBe(true);
    expect(fs.existsSync(outputPath)).toBe(true);

    const zip = await JSZip.loadAsync(await fs.promises.readFile(outputPath));
    const files = Object.keys(zip.files);
    expect(files.some((name) => name.startsWith("xl/pivotTables/"))).toBe(true);
    expect(files.some((name) => name.startsWith("xl/pivotCache/"))).toBe(true);

    const workbookXml = await zip.file("xl/workbook.xml")?.async("string");
    expect(workbookXml).toContain("<pivotCaches");
  }, 30000);
});
