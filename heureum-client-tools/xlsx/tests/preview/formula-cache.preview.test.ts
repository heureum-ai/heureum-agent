import * as fs from "fs";
import ExcelJS from "exceljs";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { fixture } from "../helpers";

describe("Preview: no-soffice formula cache", () => {
  it("stores formula and cached result without server-side recalculation", async () => {
    const outputPath = fixture("preview_formula_cache.xlsx");

    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1");
    ws.getCell("A1").value = 10;
    ws.getCell("A2").value = 20;
    ws.getCell("B1").value = { formula: "SUM(A1:A2)", result: 30 } as ExcelJS.CellFormulaValue;

    // Preview mode: keep cached value and avoid forced full recalc on open.
    wb.calcProperties = { ...(wb.calcProperties ?? {}), fullCalcOnLoad: false };
    await wb.xlsx.writeFile(outputPath);

    const reopened = new ExcelJS.Workbook();
    await reopened.xlsx.readFile(outputPath);
    const formulaValue = reopened.getWorksheet("Sheet1")!.getCell("B1").value as ExcelJS.CellFormulaValue;
    expect(formulaValue.formula).toBe("SUM(A1:A2)");
    expect(formulaValue.result).toBe(30);

    const zip = await JSZip.loadAsync(await fs.promises.readFile(outputPath));
    const sheetXml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
    const workbookXml = await zip.file("xl/workbook.xml")!.async("string");

    expect(sheetXml).toContain("<f>SUM(A1:A2)</f>");
    expect(sheetXml).toContain("<v>30</v>");
    expect(workbookXml).not.toContain('fullCalcOnLoad="1"');
  });
});
