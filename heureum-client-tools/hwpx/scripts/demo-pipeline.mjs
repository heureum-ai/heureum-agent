/**
 * Demo: Markdown -> XML -> HWPX pipeline.
 *
 * Usage:
 *   node scripts/demo-pipeline.mjs [output_path]
 */

import fs from 'node:fs';
import path from 'node:path';

const DEMO_MARKDOWN = `# 업무 처리 규정(시범)

## 제1장 총칙

### 제1조(목적)
이 규정은 기관 내 업무 처리 기준을 명확히 하여 업무 효율성과 책임성을 높이는 것을 목적으로 합니다.

### 제2조(적용범위)
이 규정은 본 기관의 모든 부서와 임직원에게 적용합니다.

## 제2장 업무 절차

### 제3조(기안)
1. 담당자는 업무 내용을 기안서로 작성합니다.
2. 기안서에는 근거, 시행일, 담당부서를 명시합니다.

### 제4조(결재)
결재 단계는 다음 표에 따릅니다.

| 구분 | 결재 단계 | 결재권자 | 비고 |
| --- | --- | --- | --- |
| 일반문서 | 2단계 | 과장 | - |
| 중요문서 | 3단계 | 국장 | 합의 포함 |
| 대외문서 | 4단계 | 기관장 | 법무 검토 |

## 제3장 문서 관리

### 제5조(보존기간)
- 영구: 법규, 조례, 인사 기록
- 10년: 일반 행정 문서
- 5년: 참고 자료

## 부칙

### 제1조(시행일)
이 규정은 2026년 3월 1일부터 시행합니다.
`;

async function main() {
  const mod = await import('../dist/index.js');
  const { HwpxPipeline } = mod;

  const outputPath = path.resolve(process.argv[2] || './output/demo-pipeline.hwpx');
  const taskRoot = path.resolve('./output/pipeline-tasks');
  if (!fs.existsSync(taskRoot)) fs.mkdirSync(taskRoot, { recursive: true });

  const taskId = `demo_${Date.now()}`;
  const pipeline = new HwpxPipeline({
    sessionId: 'demo_pipeline',
    taskType: 'hwpx',
    taskId,
    workDir: taskRoot,
  });

  console.log('[info] Step 1/3: write markdown');
  const ast = await pipeline.writeMarkdown(DEMO_MARKDOWN);
  console.log('[info] Top-level AST nodes:', Array.isArray(ast.children) ? ast.children.length : 0);

  console.log('[info] Step 2/3: generate xml');
  await pipeline.writeXml(ast, {
    documentOptions: {
      marginTop: 5669,     // 20mm
      marginBottom: 4252,  // 15mm
      marginLeft: 4252,    // 15mm
      marginRight: 4252,   // 15mm
    },
  });

  console.log('[info] Step 3/3: pack hwpx');
  const packedPath = await pipeline.pack();

  const outDir = path.dirname(outputPath);
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(packedPath, outputPath);

  console.log('[done] HWPX created');
  console.log('[path]', outputPath);
  console.log('[task]', pipeline.taskDir);
}

main().catch((err) => {
  console.error('[error]', err?.stack || err?.message || String(err));
  process.exit(1);
});

