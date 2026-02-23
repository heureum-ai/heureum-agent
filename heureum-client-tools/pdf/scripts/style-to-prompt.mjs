/**
 * PDF 스타일 JSON -> 스타일 가이드 프롬프트 생성 스크립트
 *
 * 내부 함수(parseTemplateStyle, extractText, buildPdfStyleGuidePrompt)만 사용한다.
 *
 * Usage:
 *   node scripts/style-to-prompt.mjs <input.pdf|style.json>
 */

import fs from "node:fs";
import path from "node:path";

async function loadData(inputPath, mod) {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === ".json") {
    const raw = fs.readFileSync(inputPath, "utf8");
    return { extractedStyles: JSON.parse(raw), sourcePreview: null };
  }

  if (!fs.existsSync(inputPath)) {
    throw new Error(`File not found: ${inputPath}`);
  }

  const styleRes = await mod.parseTemplateStyle(inputPath, {
    includeRuns: true,
    maxRunsPerPage: 5000,
  });
  if (!styleRes.success) {
    throw new Error(`parseTemplateStyle failed: ${styleRes.output}`);
  }
  const extractedStyles = JSON.parse(styleRes.output);

  const textRes = await mod.extractText(inputPath);
  if (!textRes.success) {
    throw new Error(`extractText failed: ${textRes.output}`);
  }

  return { extractedStyles, sourcePreview: textRes.output };
}

async function main() {
  const mod = await import("../dist/index.js");
  const {
    PDF_DEFAULTS,
    buildPdfStyleGuidePrompt,
  } = mod;

  const defaultRef = PDF_DEFAULTS?.prompts?.styleGuideReferencePath;
  const inputArg = process.argv[2] || defaultRef || "./assets/style-reference.pdf";
  const inputPath = path.resolve(inputArg);

  console.log(`[*] Input: ${inputPath}`);
  const { extractedStyles, sourcePreview } = await loadData(inputPath, mod);
  const prompt = buildPdfStyleGuidePrompt(extractedStyles, sourcePreview, {
    includeSourcePreview: true,
  });

  console.log("════════════════════════════════════════════════");
  console.log(" 생성된 PDF 스타일 가이드 프롬프트");
  console.log("════════════════════════════════════════════════\n");
  console.log(prompt);
  console.log("\n════════════════════════════════════════════════\n");

  const outPath = path.resolve("./output/style-guide-prompt.md");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, prompt, "utf8");
  console.log(`[*] Saved: ${outPath}`);
}

main().catch((err) => {
  console.error("[error]", err?.stack || err?.message || String(err));
  process.exit(1);
});

