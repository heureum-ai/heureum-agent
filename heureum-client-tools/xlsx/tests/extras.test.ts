import ExcelJS from "exceljs";
import * as fs from "fs";
import { describe, expect, it } from "vitest";
import {
    xlsxConvert,
    xlsxCsvIo,
    xlsxDuplicateRow,
    xlsxHeaderFooter,
    xlsxHyperlink,
    xlsxNamedRanges,
    xlsxOutlineGroup,
    xlsxPageSetup,
} from "../src/tools";
import { createSampleWorkbook, fixture } from "./helpers";

describe("XLSX Extra Features", () => {
  it("should handle page setup and headers/footers", async () => {
    const src = fixture("page_hf.xlsx");
    const out = fixture("page_hf_out.xlsx");
    await createSampleWorkbook(src);

    await xlsxPageSetup({
      path: src,
      action: "set",
      settings: { orientation: "landscape" },
      outputPath: out,
    });

    await xlsxHeaderFooter({
      path: out,
      action: "set",
      settings: { oddHeader: "&CMy Report" },
      outputPath: out,
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    expect(wb.getWorksheet(1)!.pageSetup.orientation).toBe("landscape");
  });

  it("should handle hyperlinks and named ranges", async () => {
    const src = fixture("links_names.xlsx");
    const out = fixture("links_names_out.xlsx");
    await createSampleWorkbook(src);

    await xlsxHyperlink({
      path: src,
      operations: [{ cell: "A10", action: "add", target: "https://example.com", text: "Link" }],
      outputPath: out,
    });

    await xlsxNamedRanges({
      path: out,
      operations: [{ action: "add", name: "MyRange", range: "A1:B2" }],
      outputPath: out,
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    // Success implies it worked
    expect((wb.getWorksheet(1)!.getCell("A10").value as any).text).toBe("Link");
  });

  it("should handle CSV IO and conversion", async () => {
    const src = fixture("io_conv.xlsx");
    const csvOut = fixture("output.csv");
    await createSampleWorkbook(src);

    // Write CSV
    await xlsxCsvIo({ action: "write", path: src, csvPath: csvOut });
    expect(fs.existsSync(csvOut)).toBe(true);

    // Convert to HTML
    const htmlOut = fixture("output.html");
    await xlsxConvert({ path: src, format: "html", outputPath: htmlOut });
    expect(fs.existsSync(htmlOut)).toBe(true);
  });

  it("should handle outlines and row duplication", async () => {
    const src = fixture("structure.xlsx");
    const out = fixture("structure_out.xlsx");
    await createSampleWorkbook(src);

    await xlsxOutlineGroup({
      path: src,
      operations: [{ type: "row", start: 2, end: 3, outlineLevel: 1 }],
      outputPath: out,
    });

    await xlsxDuplicateRow({
      path: out,
      rowNumber: 2,
      count: 1,
      insert: true,
      outputPath: out,
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(out);
    expect(wb.getWorksheet(1)!.getRow(2).outlineLevel).toBe(1);
  });
});
