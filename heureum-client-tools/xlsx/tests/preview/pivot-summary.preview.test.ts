import * as fs from "fs";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { xlsxPivotSummary } from "../../src/tools";
import { fixture } from "../helpers";

describe("Preview: pivot summary boundaries", () => {
  it("writes deterministic grouped aggregates as plain worksheet output", async () => {
    const sourcePath = fixture("preview_pivot_summary_source.xlsx");
    const outputPath = fixture("preview_pivot_summary_output.xlsx");

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Data");
    sheet.addRow(["Item", "Amount", "Category"]);
    sheet.addRow(["A", 10, "Group1"]);
    sheet.addRow(["B", 20, "Group1"]);
    sheet.addRow(["C", 5, "Group2"]);
    sheet.addRow(["D", 15, "Group2"]);
    await workbook.xlsx.writeFile(sourcePath);

    const result = await xlsxPivotSummary({
      path: sourcePath,
      engine: "summary",
      sheet: "Data",
      dataRange: "A1:C5",
      config: {
        rowFields: [3],
        valueFields: [
          { column: 2, aggregation: "sum" },
          { column: 2, aggregation: "average" },
          { column: 2, aggregation: "count" },
        ],
      },
      outputSheet: "PivotSummary",
      outputPath,
    });

    expect(result.success).toBe(true);

    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.readFile(outputPath);
    const out = reopened.getWorksheet("PivotSummary");
    expect(out).toBeDefined();

    expect(out!.getCell("A1").value).toBe("Category");
    expect(out!.getCell("B1").value).toBe("Amount_sum");
    expect(out!.getCell("C1").value).toBe("Amount_average");
    expect(out!.getCell("D1").value).toBe("Amount_count");

    const rows = [2, 3]
      .map((rowNo) => ({
        key: String(out!.getCell(`A${rowNo}`).value),
        sum: Number(out!.getCell(`B${rowNo}`).value),
        average: Number(out!.getCell(`C${rowNo}`).value),
        count: Number(out!.getCell(`D${rowNo}`).value),
      }))
      .sort((a, b) => a.key.localeCompare(b.key));

    expect(rows).toEqual([
      { key: "Group1", sum: 30, average: 15, count: 2 },
      { key: "Group2", sum: 20, average: 10, count: 2 },
    ]);

    const zip = await JSZip.loadAsync(await fs.promises.readFile(outputPath));
    const hasPivotParts = Object.keys(zip.files).some(
      (name) => name.startsWith("xl/pivotTables/") || name.includes("pivotCache")
    );

    // Current behavior: summary sheet only, no native PivotTable objects.
    expect(hasPivotParts).toBe(false);
  });
});
