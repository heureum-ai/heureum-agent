/**
 * HWPX 스타일 JSON -> 스타일 가이드 프롬프트 생성 래퍼 스크립트
 *
 * 실제 프롬프트 생성 로직은 src/prompt.ts(buildHwpxStyleGuidePrompt)에 위치한다.
 *
 * Usage:
 *   node scripts/style-to-prompt.mjs <input>
 *
 * input:
 *   - .hwpx 파일 경로: hwpx_extract_styles 호출 후 프롬프트 생성
 *   - .json 파일 경로: 이미 추출된 스타일 JSON 로드 후 프롬프트 생성
 */

import fs from "node:fs";
import path from "node:path";

async function tryExtractMarkdownWithInternalFunction(HwpxPipeline, hwpxPath) {
  const taskWorkDir = path.resolve("./output/.style_prompt_tasks");
  if (!fs.existsSync(taskWorkDir)) {
    fs.mkdirSync(taskWorkDir, { recursive: true });
  }
  const pipeline = new HwpxPipeline({
    sessionId: "style_extractor",
    taskType: "hwpx",
    taskId: `to_markdown_${Date.now()}`,
    workDir: taskWorkDir,
  });

  try {
    return await pipeline.toMarkdown(hwpxPath);
  } finally {
    if (fs.existsSync(pipeline.taskDir)) {
      fs.rmSync(pipeline.taskDir, { recursive: true, force: true });
    }
  }
}

async function loadExtractedStyles(inputPath, parseTemplateStyle, HwpxPipeline) {
  const ext = path.extname(inputPath).toLowerCase();
  if (ext === ".json") {
    const raw = fs.readFileSync(inputPath, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") {
      throw new Error("Invalid JSON: object root required");
    }
    parsed.sourcePath = parsed.sourcePath || inputPath;
    return parsed;
  }

  if (!fs.existsSync(inputPath)) {
    throw new Error(`File not found: ${inputPath}`);
  }
  if (fs.statSync(inputPath).isDirectory()) {
    throw new Error("Directory input is not supported. Use .hwpx file or extracted .json");
  }
  if (typeof parseTemplateStyle !== "function") {
    throw new Error("parseTemplateStyle is required for .hwpx input");
  }
  if (typeof HwpxPipeline !== "function") {
    throw new Error("HwpxPipeline is required for .hwpx input");
  }

  const extractRes = await parseTemplateStyle({
    path: inputPath,
    include_all_sections: true,
  });
  if (!extractRes.success) {
    throw new Error(`hwpx_extract_styles failed: ${extractRes.output}`);
  }

  const styles = JSON.parse(extractRes.output);
  styles.sourcePath = inputPath;

  const markdown = await tryExtractMarkdownWithInternalFunction(HwpxPipeline, inputPath);
  if (!markdown) {
    throw new Error("Failed to extract markdown via HwpxPipeline.toMarkdown()");
  }
  styles.markdownContent = markdown;
  styles.markdownSource = "HwpxPipeline.toMarkdown";

  return styles;
}

async function main() {
  const mod = await import("../dist/index.js");
  const { parseTemplateStyle, HwpxPipeline, buildHwpxStyleGuidePrompt, HWPX_DEFAULTS } = mod;
  if (typeof buildHwpxStyleGuidePrompt !== "function") {
    throw new Error("buildHwpxStyleGuidePrompt export not found. Build toolkit first.");
  }
  const defaultRef = HWPX_DEFAULTS?.prompts?.styleGuideReferencePath;
  const inputArg = process.argv[2] || defaultRef || "./assets/행정업무_운영혁신_시행규칙_20230628_부칙포함.hwpx";
  const inputPath = path.resolve(inputArg);

  console.log(`[*] Input: ${inputPath}`);
  const styles = await loadExtractedStyles(inputPath, parseTemplateStyle, HwpxPipeline);
  const prompt = buildHwpxStyleGuidePrompt(styles);

  console.log("════════════════════════════════════════════════");
  console.log(" 생성된 스타일 가이드 프롬프트");
  console.log("════════════════════════════════════════════════\n");
  console.log(prompt);
  console.log("\n════════════════════════════════════════════════\n");

  const outPath = path.resolve("./output/style-guide-prompt.md");
  const outDir = path.dirname(outPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(outPath, prompt, "utf8");
  console.log(`[*] Saved: ${outPath}`);
}

main().catch((err) => {
  console.error("[error]", err?.stack || err?.message || String(err));
  process.exit(1);
});
