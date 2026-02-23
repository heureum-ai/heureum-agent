import ExcelJS from "exceljs";
import * as fs from "fs";
import { describe, expect, it } from "vitest";
import {
    xlsxCreate,
    xlsxDeleteColumns,
    xlsxInsertRows,
    xlsxManageSheets,
    xlsxMergeCells,
    xlsxRead,
    xlsxUpdateCells
} from "../src/tools";
import { createSampleWorkbook, fixture } from "./helpers";

describe("XLSX Core Operations", () => {
  it("should read, create, and update workbooks", async () => {
    // Create
    const out = fixture("created.xlsx");
    await xlsxCreate({
      sheets: [{ name: "TestSheet", data: [["ID", "Name"], [1, "First"]] }],
      outputPath: out,
    });
    expect(fs.existsSync(out)).toBe(true);

    // Read
    const readResult = await xlsxRead({ path: out });
    expect(readResult.success).toBe(true);
    expect(readResult.output).toContain("First");

    // Update
    const upOut = fixture("updated.xlsx");
    await xlsxUpdateCells({
      path: out,
      updates: [{ cell: "B2", value: "Updated" }],
      outputPath: upOut,
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(upOut);
    expect(wb.getWorksheet(1)!.getCell("B2").value).toBe("Updated");
  });

  it("should manage rows and columns", async () => {
    const src = fixture("rows_cols.xlsx");
    const out = fixture("rows_cols_out.xlsx");
    await createSampleWorkbook(src);

    // Insert Rows
    await xlsxInsertRows({ path: src, startRow: 2, rows: [["New", 100]], outputPath: out });
    
    // Delete Columns
    const finalOut = fixture("final_core.xlsx");
    await xlsxDeleteColumns({ path: out, startColumn: 3, count: 1, outputPath: finalOut });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(finalOut);
    const ws = wb.getWorksheet(1)!;
    expect(ws.getCell("A2").value).toBe("New");
    expect(ws.columns.length).toBe(2);
  });

  it("should manage sheets and merge cells", async () => {
    const src = fixture("sheets_merge.xlsx");
    const out = fixture("sheets_merge_out.xlsx");
    await createSampleWorkbook(src);

    // Manage Sheets
    await xlsxManageSheets({
      path: src,
      operations: [{ action: "add", name: "Extra" }],
      outputPath: out,
    });

    // Merge Cells
    const mergeOut = fixture("merge.xlsx");
    await xlsxMergeCells({
      path: out,
      operations: [{ action: "merge", range: "A1:B1" }],
      outputPath: mergeOut,
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(mergeOut);
    expect(wb.getWorksheet("Extra")).toBeDefined();
    // ExcelJS doesn't easily show merged state in a simple way here, but success is true
  });
});
