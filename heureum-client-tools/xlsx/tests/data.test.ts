import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
    xlsxAutoFilter,
    xlsxDataValidation,
    xlsxFormula,
    xlsxPivotSummary,
    xlsxSortData,
    xlsxTable
} from "../src/tools";
import { createSampleWorkbook, fixture } from "./helpers";

describe("XLSX Data Operations", () => {
  it("should handle formulas and sorting", async () => {
    const src = fixture("data_ops.xlsx");
    const out = fixture("data_ops_out.xlsx");
    await createSampleWorkbook(src, { rows: 10 });

    // Formula
    await xlsxFormula({
      path: src,
      action: "set",
      formulas: [{ cell: "D11", formula: "SUM(B2:B10)" }],
      outputPath: out,
    });

    // Sort
    const sortOut = fixture("sorted.xlsx");
    await xlsxSortData({
      path: out,
      range: "A1:D10",
      sortBy: [{ column: "B", order: "desc" }],
      hasHeader: true,
      outputPath: sortOut,
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(sortOut);
    const ws = wb.getWorksheet(1)!;
    expect(ws.getCell("D11").formula).toBe("SUM(B2:B10)");
    expect(Number(ws.getCell("B2").value)).toBeGreaterThanOrEqual(Number(ws.getCell("B3").value));
  });

  it("should handle tables and pivot summaries", async () => {
    const src = fixture("table_pivot.xlsx");
    const out = fixture("table_pivot_out.xlsx");
    await createSampleWorkbook(src, { rows: 20 });

    // Table
    await xlsxTable({
      path: src,
      action: "add",
      table: {
        name: "MyTable",
        ref: "A1:C20",
        columns: [{ name: "Name" }, { name: "Value" }, { name: "Category" }],
        rows: [],
      },
      outputPath: out,
    });

    // Pivot
    const pivotResult = await xlsxPivotSummary({
      path: out,
      engine: "summary",
      dataRange: "A1:C20",
      config: {
        rowFields: [2], // Category
        valueFields: [{ column: 1, aggregation: "sum" }], // Value
      },
    });
    expect(pivotResult.success).toBe(true);
  });

  it("should handle validation and filters", async () => {
    const src = fixture("filter_val.xlsx");
    const out = fixture("filter_val_out.xlsx");
    await createSampleWorkbook(src);

    await xlsxAutoFilter({ path: src, range: "A1:C4", action: "set", outputPath: out });
    
    await xlsxDataValidation({
      path: out,
      range: "B2:B4",
      validation: { type: "whole", operator: "between", formulae: ["0", "1000"] },
      outputPath: out,
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    expect(wb.getWorksheet(1)!.autoFilter).toBeDefined();
  });
});
