import * as fs from "fs";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { xlsxFormula } from "../../src/tools";
import { fixture } from "../helpers";

describe("Preview: formula actions behavior", () => {
  it("fills formulas with translated refs and enables fullCalcOnLoad", async () => {
    const sourcePath = fixture("preview_formula_fill_source.xlsx");
    const outputPath = fixture("preview_formula_fill_output.xlsx");

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.getCell("A1").value = "Value";
    sheet.getCell("A2").value = 2;
    sheet.getCell("A3").value = 3;
    sheet.getCell("A4").value = 4;
    sheet.getCell("D1").value = 10;
    await workbook.xlsx.writeFile(sourcePath);

    const result = await xlsxFormula({
      path: sourcePath,
      sheet: "Sheet1",
      action: "fill",
      fill: {
        masterCell: "B2",
        formula: "A2*$D$1",
        fillRange: "B2:B4",
        result: 20,
      },
      outputPath,
    });

    expect(result.success).toBe(true);

    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.readFile(outputPath);
    const out = reopened.getWorksheet("Sheet1")!;

    const b2 = out.getCell("B2").value as ExcelJS.CellFormulaValue;
    const b3 = out.getCell("B3").value as ExcelJS.CellFormulaValue;
    const b4 = out.getCell("B4").value as ExcelJS.CellFormulaValue;

    expect(b2.formula).toBe("A2*$D$1");
    expect(b3.formula).toBe("A3*$D$1");
    expect(b4.formula).toBe("A4*$D$1");
    expect(b2.result).toBe(20);

    const zip = await JSZip.loadAsync(await fs.promises.readFile(outputPath));
    const workbookXml = await zip.file("xl/workbook.xml")!.async("string");
    expect(workbookXml).toContain('fullCalcOnLoad="1"');
  });

  it("clears formulas while preserving cached results", async () => {
    const sourcePath = fixture("preview_formula_clear_source.xlsx");
    const withFormulaPath = fixture("preview_formula_clear_with_formula.xlsx");
    const clearedPath = fixture("preview_formula_clear_output.xlsx");

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Sheet1");
    sheet.getCell("A1").value = 10;
    sheet.getCell("A2").value = 20;
    await workbook.xlsx.writeFile(sourcePath);

    const setResult = await xlsxFormula({
      path: sourcePath,
      sheet: "Sheet1",
      action: "set",
      formulas: [{ cell: "B1", formula: "SUM(A1:A2)", result: 30 }],
      outputPath: withFormulaPath,
    });
    expect(setResult.success).toBe(true);

    const clearResult = await xlsxFormula({
      path: withFormulaPath,
      sheet: "Sheet1",
      action: "clear",
      clearRange: "B1",
      outputPath: clearedPath,
    });
    expect(clearResult.success).toBe(true);

    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.readFile(clearedPath);
    const cell = reopened.getWorksheet("Sheet1")!.getCell("B1");

    expect(cell.value).toBe(30);
    expect(cell.type).not.toBe(ExcelJS.ValueType.Formula);
  });
});
