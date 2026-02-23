/**
 * Sample HWPX file generator.
 * Creates real .hwpx files in hwpx/output/ directory for manual inspection.
 * Files persist after test run (no cleanup).
 *
 * Two generation paths:
 * A) Pipeline: markdown → AST → XML → hwpx dir → .hwpx (step-by-step)
 * B) Single-call: markdown → .hwpx (then edit tools)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  hwpxCreateMarkdown,
  hwpxInitTask,
  hwpxWriteMarkdown,
  hwpxWriteXml,
  hwpxPack,
  hwpxSetCharFormat,
  hwpxSetParaFormat,
  hwpxSetPageLayout,
  hwpxEditTableCell,
  hwpxSetMetadata,
  hwpxFindReplace,
  hwpxInsertText,
  hwpxInsertImage,
  hwpxSetHeaderFooter,
  hwpxInsertTable,
} from '../src/tools.js';

const OUT_DIR = path.resolve(__dirname, '../output');

const LEGACY_CHAIN_OUTPUTS = [
  'original.hwpx',
  'char-format.hwpx',
  'para-format.hwpx',
  'page-layout.hwpx',
  'table-edit.hwpx',
  'find-replace.hwpx',
  'insert-text.hwpx',
  'header.hwpx',
  'footer.hwpx',
  'font.hwpx',
  'image.hwpx',
  'new-table.hwpx',
  'final.hwpx',
];

beforeAll(() => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  for (const file of LEGACY_CHAIN_OUTPUTS) {
    const filePath = path.join(OUT_DIR, file);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  }
});

function out(name: string): string {
  return path.join(OUT_DIR, name);
}

/** Create a tiny 1x1 red PNG for image tests */
function createTestPng(): string {
  const filePath = out('test-image.png');
  if (fs.existsSync(filePath)) return filePath;
  const png = Buffer.from([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41,
    0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
    0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC,
    0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E,
    0x44, 0xAE, 0x42, 0x60, 0x82,
  ]);
  fs.writeFileSync(filePath, png);
  return filePath;
}

const MD = `# 프로젝트 보고서

## 개요

이 문서는 HWPX 도구 테스트용 보고서입니다. **굵은 글씨**와 *기울임*이 포함됩니다.

## 데이터

| 항목 | 값 | 비고 |
| --- | --- | --- |
| 매출 | 1000만원 | 전년 대비 증가 |
| 비용 | 500만원 | 절감 성공 |
| 이익 | 500만원 | 목표 달성 |

## 결론

모든 목표를 달성하였습니다.

- 항목 1
- 항목 2
- 항목 3`;

// ═══════════════════════════════════════════════════════
// A) Pipeline: markdown → AST → XML → hwpx dir → .hwpx
// ═══════════════════════════════════════════════════════

describe('Pipeline: markdown → xml → hwpx', () => {
  const taskDir = out('pipeline-task/sess/hwpx/task1');

  it('step1: init_task → 폴더 구조 생성', async () => {
    const r = await hwpxInitTask({
      session_id: 'sess',
      task_id: 'task1',
      work_dir: out('pipeline-task'),
    });
    expect(r.success).toBe(true);
    expect(r.output).toContain('Task initialized');
  });

  it('step2: write_markdown → AST 파싱', async () => {
    const r = await hwpxWriteMarkdown({
      task_dir: taskDir,
      markdown: MD,
      persist_intermediate: true,
    });
    expect(r.success).toBe(true);
    expect(r.output).toContain('Markdown saved and parsed');

    // AST 파일 생성 확인
    const astPath = path.join(taskDir, 'output/ast.json');
    expect(fs.existsSync(astPath)).toBe(true);
  });

  it('step3: write_xml → HWPX XML 생성', async () => {
    const r = await hwpxWriteXml({
      task_dir: taskDir,
      margin_top: 10,
      margin_bottom: 10,
      margin_left: 15,
      margin_right: 15,
      persist_intermediate: true,
    });
    expect(r.success).toBe(true);
    expect(r.output).toContain('XML generated');

    // XML 파일들 생성 확인
    const hwpxDir = path.join(taskDir, 'output/hwpx');
    expect(fs.existsSync(path.join(hwpxDir, 'Contents/section0.xml'))).toBe(true);
    expect(fs.existsSync(path.join(hwpxDir, 'Contents/header.xml'))).toBe(true);
  });

  it('step4: pack → .hwpx ZIP 생성', async () => {
    const r = await hwpxPack({ task_dir: taskDir });
    expect(r.success).toBe(true);
    expect(r.output).toContain('packed successfully');

    // .hwpx 파일 생성 확인
    const hwpxPath = path.join(taskDir, 'output/result.hwpx');
    expect(fs.existsSync(hwpxPath)).toBe(true);

    // output 디렉토리에도 복사
    fs.copyFileSync(hwpxPath, out('pipeline-result.hwpx'));
  });
});

// ═══════════════════════════════════════════════════════
// B) Single-call + 전체 편집 도구 체이닝
// ═══════════════════════════════════════════════════════

describe('Single-call + Edit Chain', () => {
  const editDoc = out('edit-chain.hwpx');

  it('step0: 원본 문서 생성 (create_markdown)', async () => {
    const r = await hwpxCreateMarkdown({ markdown: MD, output_path: editDoc });
    expect(r.success).toBe(true);
  });

  it('step1: 글자 서식 (set_char_format)', async () => {
    const r = await hwpxSetCharFormat({
      path: editDoc,
      target_text: '프로젝트 보고서',
      bold: true,
      text_color: '#0000FF',
      font_size: 20,
      output_path: editDoc,
    });
    expect(r.success).toBe(true);
  });

  it('step2: 문단 서식 (set_para_format)', async () => {
    const r = await hwpxSetParaFormat({
      path: editDoc,
      target_text: '모든 목표를',
      alignment: 'CENTER',
      line_spacing: 200,
      output_path: editDoc,
    });
    expect(r.success).toBe(true);
  });

  it('step3: 용지 설정 (set_page_layout)', async () => {
    const r = await hwpxSetPageLayout({
      path: editDoc,
      margin_top: 25,
      margin_bottom: 25,
      margin_left: 30,
      margin_right: 30,
      output_path: editDoc,
    });
    expect(r.success).toBe(true);
  });

  it('step4: 표 편집 (edit_table_cell)', async () => {
    const target = editDoc;

    // 헤더 행 배경색
    for (let c = 0; c < 3; c++) {
      await hwpxEditTableCell({
        path: target,
        row: 0,
        col: c,
        background_color: '#4285F4',
        output_path: target,
      });
    }

    // 셀 텍스트 수정
    const r = await hwpxEditTableCell({
      path: target,
      row: 1,
      col: 1,
      text: '1,200만원',
      output_path: target,
    });
    expect(r.success).toBe(true);
  });

  it('step5: 찾기/바꾸기 (find_replace)', async () => {
    const r = await hwpxFindReplace({
      path: editDoc,
      find: '500만원',
      replace: '550만원',
      output_path: editDoc,
    });
    expect(r.success).toBe(true);
  });

  it('step6: 텍스트 삽입 (insert_text)', async () => {
    const r = await hwpxInsertText({
      path: editDoc,
      text: '※ 본 보고서는 자동 생성되었습니다.\n작성일: 2026-02-21\n작성자: AI Agent',
      output_path: editDoc,
    });
    expect(r.success).toBe(true);
  });

  it('step7: 머리글 설정 (set_header_footer - header)', async () => {
    const r = await hwpxSetHeaderFooter({
      path: editDoc,
      type: 'header',
      text: '(주)유레움 - 기밀',
      alignment: 'RIGHT',
      output_path: editDoc,
    });
    expect(r.success).toBe(true);
  });

  it('step8: 바닥글 설정 (set_header_footer - footer)', async () => {
    const r = await hwpxSetHeaderFooter({
      path: editDoc,
      type: 'footer',
      text: 'Confidential Document',
      alignment: 'CENTER',
      output_path: editDoc,
    });
    expect(r.success).toBe(true);
  });

  it('step9: 폰트 변경 (set_char_format - font_name)', async () => {
    const r = await hwpxSetCharFormat({
      path: editDoc,
      target_text: '개요',
      font_name: '맑은 고딕',
      font_size: 16,
      bold: true,
      output_path: editDoc,
    });
    expect(r.success).toBe(true);
  });

  it('step10: 이미지 삽입 (insert_image)', async () => {
    const imgPath = createTestPng();
    const r = await hwpxInsertImage({
      path: editDoc,
      image_path: imgPath,
      width_mm: 80,
      height_mm: 60,
      output_path: editDoc,
    });
    expect(r.success).toBe(true);
  });

  it('step11: 새 표 삽입 (insert_table)', async () => {
    const r = await hwpxInsertTable({
      path: editDoc,
      rows: 4,
      cols: 3,
      headers: ['분기', '매출', '성장률'],
      data: [
        ['Q1', '250만원', '+5%'],
        ['Q2', '300만원', '+20%'],
        ['Q3', '450만원', '+50%'],
      ],
      output_path: editDoc,
    });
    expect(r.success).toBe(true);
  });

  it('step12: 메타데이터 (set_metadata) → 최종', async () => {
    const r = await hwpxSetMetadata({
      path: editDoc,
      title: '프로젝트 보고서 (최종)',
      author: '홍길동',
      subject: '분기별 프로젝트 현황',
      keywords: '보고서, 프로젝트, 2026',
      output_path: editDoc,
    });
    expect(r.success).toBe(true);
  });
});
