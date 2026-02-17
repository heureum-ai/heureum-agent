/**
 * E2E test: exercise all 12 DOCX tools on a real file end-to-end.
 * Run: npx tsx __tests__/e2e-all-tools.ts
 */
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { createTestDocxFile } from "./helpers/create-test-docx";
import {
  docxCreate,
  docxRead,
  docxRedline,
  docxAddComment,
  docxValidate,
  docxSimplify,
  docxAcceptChanges,
  docxConvert,
  docxDeleteParagraph,
  docxReviewChanges,
  docxInsertImage,
  docxConvertToImages,
} from "../src/tools";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "e2e-all-"));
let step = 0;
let failures = 0;

function log(tool: string, result: { success: boolean; output: string; outputPath?: string }) {
  step++;
  const status = result.success ? "OK" : "FAIL";
  if (!result.success) failures++;
  console.log(`\n[${step}] ${tool} — ${status}`);
  const lines = result.output.split("\n");
  for (const line of lines.slice(0, 5)) {
    console.log(`    ${line}`);
  }
  if (lines.length > 5) console.log(`    ... (${lines.length - 5} more lines)`);
  if (result.outputPath) console.log(`    -> ${result.outputPath}`);
  return result;
}

async function main() {
  console.log(`=== E2E: All 12 DOCX Tools ===`);
  console.log(`Temp dir: ${TMP}\n`);

  // --- Prepare: JSZip으로 확실한 DOCX 생성 ---
  const base = path.join(TMP, "base.docx");
  await createTestDocxFile(base, {
    paragraphs: [
      { text: "Hello World" },
      { text: "This is the first paragraph of our test document." },
      { text: "Second paragraph with some important text.", bold: true },
      { text: "Third paragraph to be deleted later." },
      { text: "Fourth paragraph, the final one." },
    ],
  });
  console.log("Base DOCX created via JSZip.");

  // 1. docxCreate — 새 문서 생성
  const created = path.join(TMP, "created.docx");
  log("docxCreate", await docxCreate({
    outputPath: created,
    content: [
      { type: "paragraph", text: "Created by docxCreate", heading: 1 },
      { type: "paragraph", text: "A simple test paragraph." },
    ],
  }));

  // 2. docxRead — 문서 읽기
  log("docxRead", await docxRead({ path: base }));

  // 3. docxRedline — tracked change 적용
  const redlined = path.join(TMP, "redlined.docx");
  log("docxRedline", await docxRedline({
    path: base,
    changes: [{ find: "important", replace: "critical" }],
    author: "Reviewer",
    outputPath: redlined,
  }));

  // 4. docxAddComment — 코멘트 추가
  const commented = path.join(TMP, "commented.docx");
  log("docxAddComment", await docxAddComment({
    path: redlined,
    paragraphIndex: 1,
    text: "Please review this paragraph.",
    author: "Editor",
    outputPath: commented,
  }));

  // 5. docxValidate — 검증
  log("docxValidate", await docxValidate({ path: commented }));

  // 6. docxSimplify — 단순화
  const simplified = path.join(TMP, "simplified.docx");
  log("docxSimplify", await docxSimplify({ path: commented, outputPath: simplified }));

  // 7. docxDeleteParagraph — 단락 삭제
  const deleted = path.join(TMP, "deleted.docx");
  log("docxDeleteParagraph", await docxDeleteParagraph({
    path: simplified,
    paragraphIndices: [3],
    author: "Claude",
    outputPath: deleted,
  }));

  // 8. docxReviewChanges — restore a deletion
  const reviewed = path.join(TMP, "reviewed.docx");
  log("docxReviewChanges", await docxReviewChanges({
    path: deleted,
    action: "restore",
    changeIndex: 0,
    author: "Claude",
    outputPath: reviewed,
  }));

  // 9. docxInsertImage — 이미지 삽입
  const testPng = path.join(TMP, "test.png");
  fs.writeFileSync(testPng, Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
    "base64"
  ));
  const withImage = path.join(TMP, "with-image.docx");
  log("docxInsertImage", await docxInsertImage({
    path: reviewed,
    imagePath: testPng,
    paragraphIndex: 0,
    width: 200,
    height: 200,
    altText: "Test image",
    outputPath: withImage,
  }));

  // 10. docxConvert — PDF 변환
  log("docxConvert", await docxConvert({ path: withImage, format: "pdf" }));

  // 11. docxConvertToImages — 페이지별 이미지
  const imagesDir = path.join(TMP, "images");
  log("docxConvertToImages", await docxConvertToImages({
    path: withImage,
    format: "png",
    dpi: 72,
    outputDir: imagesDir,
  }));

  // 12. docxAcceptChanges — tracked change 수락
  const accepted = path.join(TMP, "accepted.docx");
  log("docxAcceptChanges", await docxAcceptChanges({
    path: withImage,
    outputPath: accepted,
  }));

  // Summary
  console.log(`\n=== Summary: ${step - failures} passed, ${failures} failed out of ${step} ===`);

  console.log("\nGenerated files:");
  for (const f of fs.readdirSync(TMP).sort()) {
    const full = path.join(TMP, f);
    const stat = fs.statSync(full);
    if (stat.isFile()) {
      console.log(`  ${f} (${(stat.size / 1024).toFixed(1)} KB)`);
    } else {
      console.log(`  ${f}/ (${fs.readdirSync(full).length} files)`);
    }
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  process.exit(failures > 0 ? 1 : 0);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
