/**
 * End-to-end workflow tests.
 * Validates the full pipeline: markdown ↔ remark AST ↔ XML ↔ hwpx dir ↔ hwpx (ZIP)
 * and verifies that all 16 tools chain together correctly.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';
import {
  hwpxCreateMarkdown,
  hwpxInitTask,
  hwpxWriteMarkdown,
  hwpxWriteXml,
  hwpxPack,
  hwpxUnpack,
  hwpxReadXml,
  hwpxReadMarkdown,
  hwpxSetMetadata,
  hwpxFindReplace,
  hwpxInsertText,
  hwpxMergeDocuments,
  hwpxSetCharFormat,
  hwpxSetParaFormat,
  hwpxSetPageLayout,
  hwpxEditTableCell,
} from '../src/tools.js';

const TMP_DIR = path.join(__dirname, '__tmp_workflow__');

function tmpPath(...segments: string[]): string {
  return path.join(TMP_DIR, ...segments);
}

async function readZipFile(hwpxPath: string, innerPath: string): Promise<string> {
  const buf = fs.readFileSync(hwpxPath);
  const zip = await JSZip.loadAsync(buf);
  const file = zip.file(innerPath);
  if (!file) throw new Error(`${innerPath} not found in ${hwpxPath}`);
  return file.async('string');
}

beforeAll(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ════════════════════════════════════════════════════════
// 1. Forward Pipeline: markdown → AST → XML → hwpx dir → .hwpx
// ════════════════════════════════════════════════════════

describe('Forward Pipeline', () => {
  const taskDir = tmpPath('forward', 'sess1', 'hwpx', 'task1');
  const MD = `# 보고서 제목

본문 첫 번째 문단입니다. **굵은 글씨**와 *기울임*이 포함됩니다.

두 번째 문단입니다.

| 이름 | 점수 | 등급 |
| --- | --- | --- |
| 홍길동 | 95 | A |
| 김철수 | 80 | B |
| 이영희 | 72 | C |

- 항목 1
- 항목 2
- 항목 3`;

  it('Step 1: init_task → 폴더 구조 생성', async () => {
    const result = await hwpxInitTask({
      session_id: 'sess1',
      task_id: 'task1',
      work_dir: tmpPath('forward'),
    });
    expect(result.success).toBe(true);
    expect(fs.existsSync(path.join(taskDir, 'output'))).toBe(true);
    expect(fs.existsSync(path.join(taskDir, 'output'))).toBe(true);
  });

  it('Step 2: write_markdown → AST 파싱', async () => {
    const result = await hwpxWriteMarkdown({ task_dir: taskDir, markdown: MD, persist_intermediate: true });
    expect(result.success).toBe(true);

    const mdFile = path.join(taskDir, 'output/input.md');
    const astFile = path.join(taskDir, 'output/ast.json');
    expect(fs.existsSync(mdFile)).toBe(true);
    expect(fs.existsSync(astFile)).toBe(true);

    const ast = JSON.parse(fs.readFileSync(astFile, 'utf-8'));
    expect(ast.type).toBe('root');
    expect(ast.children.length).toBeGreaterThan(0);
  });

  it('Step 3: write_xml → XML 파일 생성', async () => {
    const result = await hwpxWriteXml({ task_dir: taskDir, persist_intermediate: true });
    expect(result.success).toBe(true);

    const xmlDir = path.join(taskDir, 'output/hwpx');
    expect(fs.existsSync(path.join(xmlDir, 'Contents/section0.xml'))).toBe(true);
    expect(fs.existsSync(path.join(xmlDir, 'Contents/header.xml'))).toBe(true);
    expect(fs.existsSync(path.join(xmlDir, 'Contents/content.hpf'))).toBe(true);

    const section = fs.readFileSync(path.join(xmlDir, 'Contents/section0.xml'), 'utf-8');
    expect(section).toContain('보고서 제목');
    expect(section).toContain('<hp:tbl');
  });

  it('Step 4: pack → .hwpx ZIP 생성', async () => {
    const result = await hwpxPack({ task_dir: taskDir });
    expect(result.success).toBe(true);

    const hwpxPath = path.join(taskDir, 'output/result.hwpx');
    expect(fs.existsSync(hwpxPath)).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(hwpxPath));
    expect(zip.file('mimetype')).not.toBeNull();
    expect(zip.file('Contents/section0.xml')).not.toBeNull();
  });
});

// ════════════════════════════════════════════════════════
// 2. Reverse Pipeline: .hwpx → unpack → XML → AST → markdown
// ════════════════════════════════════════════════════════

describe('Reverse Pipeline', () => {
  const srcPath = tmpPath('reverse-src.hwpx');
  const taskDir = tmpPath('reverse', 'sess2', 'hwpx', 'task2');

  it('Setup: 원본 .hwpx 생성', async () => {
    const result = await hwpxCreateMarkdown({
      markdown: '# 역방향 테스트\n\n원본 내용입니다.\n\n**강조된 텍스트**와 일반 텍스트.',
      output_path: srcPath,
    });
    expect(result.success).toBe(true);
  });

  it('Step 1: init + unpack → 폴더에 압축 해제', async () => {
    await hwpxInitTask({ session_id: 'sess2', task_id: 'task2', work_dir: tmpPath('reverse') });
    const result = await hwpxUnpack({ task_dir: taskDir, input_path: srcPath });
    expect(result.success).toBe(true);

    const xmlDir = path.join(taskDir, 'output/hwpx');
    expect(fs.existsSync(path.join(xmlDir, 'Contents/section0.xml'))).toBe(true);
  });

  it('Step 2: read_xml → AST 추출', async () => {
    const result = await hwpxReadXml({ task_dir: taskDir });
    expect(result.success).toBe(true);

    const astFile = path.join(taskDir, 'output/ast.json');
    const ast = JSON.parse(fs.readFileSync(astFile, 'utf-8'));
    expect(ast.type).toBe('root');
  });

  it('Step 3: read_markdown → 마크다운 복원', async () => {
    const result = await hwpxReadMarkdown({ task_dir: taskDir });
    expect(result.success).toBe(true);
    expect(result.output).toContain('역방향 테스트');
    expect(result.output).toContain('원본 내용');
  });
});

// ════════════════════════════════════════════════════════
// 3. Single-Call + Edit Chain: create → 서식 → 표 → 메타데이터
// ════════════════════════════════════════════════════════

describe('Single-Call + Edit Chain', () => {
  const chainDoc = tmpPath('chain-doc.hwpx');

  const MD = `# 프로젝트 보고서

## 개요

이 문서는 테스트용 보고서입니다. 모든 도구를 순서대로 적용합니다.

## 데이터

| 항목 | 값 | 비고 |
| --- | --- | --- |
| 매출 | 1000만원 | 전년 대비 증가 |
| 비용 | 500만원 | 절감 성공 |
| 이익 | 500만원 | 목표 달성 |

## 결론

모든 목표를 달성하였습니다.`;

  it('Step 0: create_markdown → 원본 .hwpx', async () => {
    const result = await hwpxCreateMarkdown({ markdown: MD, output_path: chainDoc });
    expect(result.success).toBe(true);
    expect(fs.existsSync(chainDoc)).toBe(true);
  });

  it('Step 1: set_char_format → 제목 볼드+색상 적용', async () => {
    const result = await hwpxSetCharFormat({
      path: chainDoc,
      target_text: '프로젝트 보고서',
      text_color: '#0000FF',
      output_path: chainDoc,
    });
    expect(result.success).toBe(true);

    const header = await readZipFile(chainDoc, 'Contents/header.xml');
    expect(header).toContain('textColor="#0000FF"');
  });

  it('Step 2: set_para_format → 결론 문단 가운데 정렬', async () => {
    const result = await hwpxSetParaFormat({
      path: chainDoc,
      target_text: '모든 목표를',
      alignment: 'CENTER',
      output_path: chainDoc,
    });
    expect(result.success).toBe(true);

    const header = await readZipFile(chainDoc, 'Contents/header.xml');
    expect(header).toContain('horizontal="CENTER"');
  });

  it('Step 3: set_page_layout → A4 여백 20mm로 변경', async () => {
    const result = await hwpxSetPageLayout({
      path: chainDoc,
      margin_top: 20,
      margin_bottom: 20,
      margin_left: 25,
      margin_right: 25,
      output_path: chainDoc,
    });
    expect(result.success).toBe(true);

    const section = await readZipFile(chainDoc, 'Contents/section0.xml');
    // 20mm = 5669 HU, 25mm = 7087 HU (rounded)
    expect(section).toMatch(/top="5669"/);
    expect(section).toMatch(/left="708[67]"/);
  });

  it('Step 4: edit_table_cell → 셀 배경색 + 텍스트 변경', async () => {
    const result = await hwpxEditTableCell({
      path: chainDoc,
      table_index: 0,
      row: 0,
      col: 0,
      text: '구분',
      background_color: '#E8F0FE',
      output_path: chainDoc,
    });
    expect(result.success).toBe(true);

    const section = await readZipFile(chainDoc, 'Contents/section0.xml');
    expect(section).toContain('구분');

    const header = await readZipFile(chainDoc, 'Contents/header.xml');
    expect(header).toContain('#E8F0FE');
  });

  it('Step 5: find_replace → 텍스트 치환', async () => {
    const result = await hwpxFindReplace({
      path: chainDoc,
      find: '500만원',
      replace: '550만원',
      output_path: chainDoc,
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('2 occurrence');

    const section = await readZipFile(chainDoc, 'Contents/section0.xml');
    expect(section).toContain('550만원');
    expect(section).not.toContain('>500만원<');
  });

  it('Step 6: insert_text → 문단 추가', async () => {
    const result = await hwpxInsertText({
      path: chainDoc,
      text: '※ 본 보고서는 자동 생성되었습니다.\n작성일: 2026-02-21',
      output_path: chainDoc,
    });
    expect(result.success).toBe(true);
    expect(result.output).toContain('2 paragraph');

    const section = await readZipFile(chainDoc, 'Contents/section0.xml');
    expect(section).toContain('자동 생성');
    expect(section).toContain('2026-02-21');
  });

  it('Step 7: set_metadata → 문서 속성 설정', async () => {
    const result = await hwpxSetMetadata({
      path: chainDoc,
      title: '프로젝트 보고서 (최종)',
      author: '홍길동',
      subject: '분기별 프로젝트 현황',
      keywords: '보고서, 프로젝트, 2026',
      output_path: chainDoc,
    });
    expect(result.success).toBe(true);

    const hpf = await readZipFile(chainDoc, 'Contents/content.hpf');
    expect(hpf).toContain('프로젝트 보고서 (최종)');
    expect(hpf).toContain('홍길동');
    expect(hpf).toContain('보고서, 프로젝트, 2026');
  });

  it('최종 파일 무결성 검증', async () => {
    const buf = fs.readFileSync(chainDoc);
    const zip = await JSZip.loadAsync(buf);

    // 모든 필수 파일 존재
    const requiredFiles = [
      'mimetype',
      'Contents/header.xml',
      'Contents/section0.xml',
      'Contents/content.hpf',
    ];
    for (const f of requiredFiles) {
      expect(zip.file(f), `Missing: ${f}`).not.toBeNull();
    }

    // 7단계 편집 결과가 모두 반영됐는지 확인
    const section = await readZipFile(chainDoc, 'Contents/section0.xml');
    const header = await readZipFile(chainDoc, 'Contents/header.xml');

    expect(header).toContain('textColor="#0000FF"');       // Step 1
    expect(header).toContain('horizontal="CENTER"');       // Step 2
    expect(section).toMatch(/top="5669"/);                 // Step 3
    expect(header).toContain('#E8F0FE');                   // Step 4
    expect(section).toContain('550만원');                   // Step 5
    expect(section).toContain('자동 생성');                 // Step 6
  });
});

// ════════════════════════════════════════════════════════
// 4. Round-Trip: create → edit → read back → verify
// ════════════════════════════════════════════════════════

describe('Round-Trip: create → edit → read back', () => {
  const original = tmpPath('rt-original.hwpx');
  const edited = tmpPath('rt-edited.hwpx');
  const taskDir = tmpPath('roundtrip', 'sess3', 'hwpx', 'task3');

  it('생성 → 편집 → 읽기 → 내용 검증', async () => {
    // 1. 생성
    await hwpxCreateMarkdown({
      markdown: '# 라운드트립 테스트\n\n원본 텍스트입니다.',
      output_path: original,
    });

    // 2. 편집: 텍스트 치환 + 서식 적용
    await hwpxFindReplace({
      path: original,
      find: '원본 텍스트',
      replace: '수정된 텍스트',
      output_path: edited,
    });
    await hwpxSetCharFormat({
      path: edited,
      target_text: '수정된 텍스트',
      bold: true,
      font_size: 14,
    });

    // 3. 역방향 파이프라인으로 읽기
    await hwpxInitTask({ session_id: 'sess3', task_id: 'task3', work_dir: tmpPath('roundtrip') });
    await hwpxUnpack({ task_dir: taskDir, input_path: edited });
    await hwpxReadXml({ task_dir: taskDir });
    const mdResult = await hwpxReadMarkdown({ task_dir: taskDir });

    // 4. 검증: 치환된 텍스트가 마크다운에 반영
    expect(mdResult.success).toBe(true);
    expect(mdResult.output).toContain('라운드트립 테스트');
    expect(mdResult.output).toContain('수정된 텍스트');
    expect(mdResult.output).not.toContain('원본 텍스트');
  });
});

// ════════════════════════════════════════════════════════
// 5. Merge + Edit: 여러 문서 병합 후 서식 적용
// ════════════════════════════════════════════════════════

describe('Merge + Edit Chain', () => {
  const doc1 = tmpPath('merge-doc1.hwpx');
  const doc2 = tmpPath('merge-doc2.hwpx');
  const merged = tmpPath('merge-combined.hwpx');
  const final = tmpPath('merge-final.hwpx');

  it('두 문서 병합 → 서식 적용 → 검증', async () => {
    // 1. 두 문서 생성
    await hwpxCreateMarkdown({
      markdown: '# 1장: 서론\n\n프로젝트 배경을 설명합니다.',
      output_path: doc1,
    });
    await hwpxCreateMarkdown({
      markdown: '# 2장: 본론\n\n핵심 내용을 다룹니다.',
      output_path: doc2,
    });

    // 2. 병합
    const mergeResult = await hwpxMergeDocuments({
      input_paths: [doc1, doc2],
      output_path: merged,
    });
    expect(mergeResult.success).toBe(true);

    // 3. 병합 문서에 서식 적용
    await hwpxSetCharFormat({
      path: merged,
      target_text: '프로젝트 배경',
      italic: true,
      text_color: '#666666',
      output_path: final,
    });
    await hwpxSetPageLayout({
      path: final,
      margin_top: 30,
      margin_bottom: 30,
    });

    // 4. 검증
    const section = await readZipFile(final, 'Contents/section0.xml');
    expect(section).toContain('1장');
    expect(section).toContain('2장');
    expect(section).toContain('프로젝트 배경');
    expect(section).toContain('핵심 내용');
    expect(section).toMatch(/top="8504"/); // 30mm

    const header = await readZipFile(final, 'Contents/header.xml');
    expect(header).toContain('textColor="#666666"');
  });
});

// ════════════════════════════════════════════════════════
// 6. Table Edit Chain: 표 생성 → 셀 편집 → 병합 → 배경색
// ════════════════════════════════════════════════════════

describe('Table Edit Chain', () => {
  const tableDoc = tmpPath('tbl-doc.hwpx');

  const TABLE_MD = `# 실적표

| 구분 | 1분기 | 2분기 | 3분기 | 4분기 |
| --- | --- | --- | --- | --- |
| 매출 | 100 | 120 | 130 | 150 |
| 비용 | 80 | 85 | 90 | 95 |
| 이익 | 20 | 35 | 40 | 55 |`;

  it('Step 0: 표 포함 문서 생성', async () => {
    const result = await hwpxCreateMarkdown({ markdown: TABLE_MD, output_path: tableDoc });
    expect(result.success).toBe(true);
  });

  it('Step 1: 헤더 행 배경색 적용', async () => {
    // 첫 번째 행의 모든 열에 배경색 적용
    for (let col = 0; col < 5; col++) {
      const result = await hwpxEditTableCell({
        path: tableDoc,
        row: 0,
        col,
        background_color: '#4285F4',
        output_path: tableDoc,
      });
      expect(result.success).toBe(true);
    }

    const header = await readZipFile(tableDoc, 'Contents/header.xml');
    expect(header).toContain('#4285F4');
  });

  it('Step 2: 셀 텍스트 수정', async () => {
    const result = await hwpxEditTableCell({
      path: tableDoc,
      row: 3,
      col: 4,
      text: '55 (+15)',
      output_path: tableDoc,
    });
    expect(result.success).toBe(true);

    const section = await readZipFile(tableDoc, 'Contents/section0.xml');
    expect(section).toContain('55 (+15)');
  });

  it('Step 3: 셀 병합 (merge_right)', async () => {
    // "구분" 셀을 오른쪽으로 1칸 병합
    const result = await hwpxEditTableCell({
      path: tableDoc,
      row: 0,
      col: 0,
      merge_right: 1,
      text: '구분/분기',
      output_path: tableDoc,
    });
    expect(result.success).toBe(true);

    const section = await readZipFile(tableDoc, 'Contents/section0.xml');
    expect(section).toContain('colSpan="2"');
    expect(section).toContain('구분/분기');
  });
});

// ════════════════════════════════════════════════════════
// 7. Pipeline Forward → Direct Edit → Pipeline Read (Hybrid)
// ════════════════════════════════════════════════════════

describe('Hybrid: Pipeline + Direct Edit + Pipeline Read', () => {
  const fwdTaskDir = tmpPath('hybrid-fwd', 'sess4', 'hwpx', 'task4');
  const revTaskDir = tmpPath('hybrid-rev', 'sess5', 'hwpx', 'task5');
  const editedPath = tmpPath('hybrid-edited.hwpx');

  it('파이프라인 생성 → 직접편집 → 파이프라인 읽기', async () => {
    // 1. Forward pipeline
    await hwpxInitTask({ session_id: 'sess4', task_id: 'task4', work_dir: tmpPath('hybrid-fwd') });
    await hwpxWriteMarkdown({ task_dir: fwdTaskDir, markdown: '# 하이브리드\n\n원문 내용' });
    await hwpxWriteXml({ task_dir: fwdTaskDir });
    const packResult = await hwpxPack({ task_dir: fwdTaskDir });
    expect(packResult.success).toBe(true);

    const hwpxPath = path.join(fwdTaskDir, 'output/result.hwpx');

    // 2. Direct edit tools
    await hwpxSetCharFormat({
      path: hwpxPath,
      bold: true,
      font_size: 12,
      output_path: editedPath,
    });
    await hwpxSetPageLayout({
      path: editedPath,
      margin_left: 30,
      margin_right: 30,
    });
    await hwpxSetMetadata({
      path: editedPath,
      title: '하이브리드 문서',
      author: '테스트',
    });

    // 3. Reverse pipeline (read back)
    await hwpxInitTask({ session_id: 'sess5', task_id: 'task5', work_dir: tmpPath('hybrid-rev') });
    await hwpxUnpack({ task_dir: revTaskDir, input_path: editedPath });
    await hwpxReadXml({ task_dir: revTaskDir });
    const mdResult = await hwpxReadMarkdown({ task_dir: revTaskDir });

    expect(mdResult.success).toBe(true);
    expect(mdResult.output).toContain('하이브리드');
    expect(mdResult.output).toContain('원문 내용');

    // Verify edits persisted
    const header = await readZipFile(editedPath, 'Contents/header.xml');
    expect(header).toContain('height="1200"'); // 12pt
    expect(header).toContain('bold="1"');

    const section = await readZipFile(editedPath, 'Contents/section0.xml');
    expect(section).toMatch(/left="850[34]"/); // 30mm

    const hpf = await readZipFile(editedPath, 'Contents/content.hpf');
    expect(hpf).toContain('하이브리드 문서');
  });
});
