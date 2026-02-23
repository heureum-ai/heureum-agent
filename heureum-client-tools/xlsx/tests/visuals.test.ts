import ExcelJS from "exceljs";
import * as fs from "fs";
import { describe, expect, it } from "vitest";
import {
    xlsxAddImage,
    xlsxBackgroundImage,
    xlsxCellProtection,
    xlsxComment,
    xlsxConditionalFormatting,
    xlsxFormatCells
} from "../src/tools";
import { createSampleWorkbook, fixture } from "./helpers";

describe("XLSX Visuals & Formatting", () => {
  it("should apply formatting and conditional rules", async () => {
    const src = fixture("visuals.xlsx");
    const out = fixture("visuals_out.xlsx");
    await createSampleWorkbook(src);

    // Format
    await xlsxFormatCells({
      path: src,
      range: "A1:C1",
      format: { font: { bold: true, color: "FF0000" } },
      outputPath: out,
    });

    // Conditional
    await xlsxConditionalFormatting({
      path: out,
      action: "add",
      range: "B2:B4",
      rules: [{ type: "cellIs", operator: "greaterThan", formulae: [15], priority: 1, style: { fill: { bgColor: "FFFF00" } } }],
      outputPath: out,
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    expect(wb.getWorksheet(1)!.getCell("A1").font.bold).toBe(true);
  });

  it("should handle comments and protection", async () => {
    const src = fixture("prot_comm.xlsx");
    const out = fixture("prot_comm_out.xlsx");
    await createSampleWorkbook(src);

    await xlsxComment({
      path: src,
      action: "add",
      comments: [{ cell: "A1", text: "Hello" }],
      outputPath: out,
    });

    await xlsxCellProtection({
      path: out,
      operations: [{ range: "A2", locked: false }],
      outputPath: out,
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    expect(wb.getWorksheet(1)!.getCell("A2").protection?.locked).toBe(false);
  });

  it("should handle images and backgrounds", async () => {
    const src = fixture("images.xlsx");
    const out = fixture("images_out.xlsx");
    await createSampleWorkbook(src);

    const pngBase64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

    await xlsxBackgroundImage({
      path: src,
      image: { base64: pngBase64, extension: "png" },
      outputPath: out,
    });

    await xlsxAddImage({
      path: out,
      image: { base64: pngBase64, extension: "png" },
      position: { from: { col: 5, row: 5 }, to: { col: 10, row: 10 } },
      outputPath: out,
    });

    expect(fs.existsSync(out)).toBe(true);
  });
});
