import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { PDFDocument, StandardFonts } from "pdf-lib";
import { extractStyles, parseTemplateStyle } from "../src/tools";

const TMP_DIR = path.join(__dirname, "__tmp_extract_styles__");

beforeAll(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

async function createPdf(filePath: string): Promise<void> {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([400, 300]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  page.drawText("Hello Style Extraction", {
    x: 40,
    y: 220,
    size: 18,
    font,
  });
  fs.writeFileSync(filePath, await pdf.save());
}

describe("pdf_extract_styles", () => {
  it("extracts run-level style information from PDF text", async () => {
    const pdfPath = path.join(TMP_DIR, "sample.pdf");
    await createPdf(pdfPath);

    const result = await extractStyles(pdfPath, { includeRuns: true });
    expect(result.success).toBe(true);

    const json = JSON.parse(result.output) as Record<string, any>;
    expect(json.page_count).toBe(1);
    expect(Array.isArray(json.pages)).toBe(true);
    expect(json.pages[0].total_run_count).toBeGreaterThan(0);
    expect(Array.isArray(json.pages[0].runs)).toBe(true);

    const unified = await parseTemplateStyle(pdfPath, { includeRuns: true });
    expect(unified.success).toBe(true);
  });
});
