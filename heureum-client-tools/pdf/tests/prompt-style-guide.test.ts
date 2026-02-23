import { describe, expect, it } from "vitest";
import {
  buildPdfStyleExtractionPrompt,
  buildPdfStyleGuidePrompt,
} from "../src/prompt";
import { PDF_DEFAULTS } from "../src/configs";

describe("pdf style guide prompt", () => {
  it("builds guide sections from extracted style json", () => {
    const prompt = buildPdfStyleGuidePrompt(
      {
        source: "/tmp/sample.pdf",
        page_count: 2,
        extracted_pages: 2,
        capabilities: { bbox: true, font: true, size: true, rotation: true, color: "partial" },
        pages: [
          {
            page_number: 1,
            width: 595,
            height: 842,
            total_run_count: 120,
            line_count: 35,
            font_usage: { Helvetica: 80, "Times-Roman": 40 },
            size_usage: { "10": 90, "14": 30 },
            runs_truncated: false,
          },
        ],
      },
      "Page 1 preview text...",
      { includeSourcePreview: true },
    );

    expect(prompt).toContain("[STYLE SYSTEM] PDF Document Style Guide");
    expect(prompt).toContain("## 2. Source Text Preview");
    expect(prompt).toContain("## 3. Page-wise Style Profile");
    expect(prompt).toContain("## 4. Global Typography Patterns");
    expect(prompt).toContain("## 5. PDF Operation Skeleton");
  });

  it("uses config-managed default reference path in extraction prompt", () => {
    const prompt = buildPdfStyleExtractionPrompt();
    expect(prompt).toContain(PDF_DEFAULTS.prompts.styleGuideReferencePath);
    expect(prompt).toContain("parseTemplateStyle");
    expect(prompt).toContain("buildPdfStyleGuidePrompt");
  });
});
