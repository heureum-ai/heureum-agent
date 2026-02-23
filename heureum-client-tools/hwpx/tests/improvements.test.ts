/**
 * Tests for 6 improvements:
 * 1. Multi-section support (section_index)
 * 2. Cross-run find/replace
 * 3. Image insertion
 * 4. Header/footer
 * 5. Font registration (font_name)
 * 6. Table creation (insert_table)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';
import { createHwpx } from '../src/writer.js';
import {
  hwpxFindReplace,
  hwpxInsertText,
  hwpxSetCharFormat,
  hwpxSetParaFormat,
  hwpxSetPageLayout,
  hwpxEditTableCell,
  hwpxInsertImage,
  hwpxSetHeaderFooter,
  hwpxInsertTable,
} from '../src/tools.js';

const TMP_DIR = path.join(__dirname, '__tmp_improvements__');

function tmpPath(name: string): string {
  return path.join(TMP_DIR, name);
}

async function readZipFile(hwpxPath: string, innerPath: string): Promise<string> {
  const buf = fs.readFileSync(hwpxPath);
  const zip = await JSZip.loadAsync(buf);
  const file = zip.file(innerPath);
  if (!file) throw new Error(`${innerPath} not found in ${hwpxPath}`);
  return file.async('string');
}

async function zipHasFile(hwpxPath: string, innerPath: string): Promise<boolean> {
  const buf = fs.readFileSync(hwpxPath);
  const zip = await JSZip.loadAsync(buf);
  return zip.file(innerPath) !== null;
}

async function createSampleHwpx(name: string, markdown: string): Promise<string> {
  const buf = await createHwpx(markdown);
  const filePath = tmpPath(name);
  fs.writeFileSync(filePath, buf);
  return filePath;
}

/** Create a tiny 1x1 red PNG for image insertion tests */
function createTestPng(name: string): string {
  const filePath = tmpPath(name);
  // Minimal valid PNG: 1x1 red pixel
  const png = Buffer.from([
    0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A, // PNG signature
    0x00, 0x00, 0x00, 0x0D, 0x49, 0x48, 0x44, 0x52, // IHDR chunk
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xDE, 0x00, 0x00, 0x00, 0x0C, 0x49, 0x44, 0x41, // IDAT chunk
    0x54, 0x08, 0xD7, 0x63, 0xF8, 0xCF, 0xC0, 0x00,
    0x00, 0x00, 0x02, 0x00, 0x01, 0xE2, 0x21, 0xBC,
    0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4E, // IEND chunk
    0x44, 0xAE, 0x42, 0x60, 0x82,
  ]);
  fs.writeFileSync(filePath, png);
  return filePath;
}

beforeAll(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

// ═══════════════════════════════════════════════════════
// 1. section_index support
// ═══════════════════════════════════════════════════════

describe('section_index support', () => {
  it('find_replace should accept section_index=0 (default behavior)', async () => {
    const src = await createSampleHwpx('si-fr.hwpx', 'Hello world');
    const out = tmpPath('si-fr-out.hwpx');
    const r = await hwpxFindReplace({
      path: src,
      find: 'Hello',
      replace: 'Hi',
      section_index: 0,
      output_path: out,
    });
    expect(r.success).toBe(true);
    expect(r.output).toContain('1 occurrence');
    const section = await readZipFile(out, 'Contents/section0.xml');
    expect(section).toContain('Hi world');
  });

  it('insert_text should accept section_index param', async () => {
    const src = await createSampleHwpx('si-it.hwpx', 'Base text');
    const out = tmpPath('si-it-out.hwpx');
    const r = await hwpxInsertText({
      path: src,
      text: 'New paragraph',
      section_index: 0,
      output_path: out,
    });
    expect(r.success).toBe(true);
    const section = await readZipFile(out, 'Contents/section0.xml');
    expect(section).toContain('New paragraph');
  });

  it('set_char_format should accept section_index param', async () => {
    const src = await createSampleHwpx('si-cf.hwpx', 'Bold me');
    const out = tmpPath('si-cf-out.hwpx');
    const r = await hwpxSetCharFormat({
      path: src,
      bold: true,
      section_index: 0,
      output_path: out,
    });
    expect(r.success).toBe(true);
    expect(r.output).toContain('run(s)');
  });

  it('set_para_format should accept section_index param', async () => {
    const src = await createSampleHwpx('si-pf.hwpx', 'Center me');
    const out = tmpPath('si-pf-out.hwpx');
    const r = await hwpxSetParaFormat({
      path: src,
      alignment: 'CENTER',
      section_index: 0,
      output_path: out,
    });
    expect(r.success).toBe(true);
    expect(r.output).toContain('paragraph(s)');
  });

  it('set_page_layout should accept section_index param', async () => {
    const src = await createSampleHwpx('si-pl.hwpx', 'Layout test');
    const out = tmpPath('si-pl-out.hwpx');
    const r = await hwpxSetPageLayout({
      path: src,
      margin_top: 20,  // mm
      section_index: 0,
      output_path: out,
    });
    expect(r.success).toBe(true);
    const section = await readZipFile(out, 'Contents/section0.xml');
    // 20mm * 283.46 = 5669
    expect(section).toContain('top="5669"');
  });

  it('edit_table_cell should accept section_index param', async () => {
    const src = await createSampleHwpx('si-tc.hwpx', '| A | B |\n| --- | --- |\n| a1 | b1 |');
    const out = tmpPath('si-tc-out.hwpx');
    const r = await hwpxEditTableCell({
      path: src,
      row: 1,
      col: 0,
      text: 'CHANGED',
      section_index: 0,
      output_path: out,
    });
    expect(r.success).toBe(true);
    const section = await readZipFile(out, 'Contents/section0.xml');
    expect(section).toContain('CHANGED');
  });
});

// ═══════════════════════════════════════════════════════
// 2. Cross-run find/replace
// ═══════════════════════════════════════════════════════

describe('Cross-run find/replace', () => {
  it('should replace text within a single run', async () => {
    const src = await createSampleHwpx('cr-single.hwpx', 'Hello world');
    const out = tmpPath('cr-single-out.hwpx');
    const r = await hwpxFindReplace({
      path: src,
      find: 'Hello',
      replace: 'Goodbye',
      output_path: out,
    });
    expect(r.success).toBe(true);
    expect(r.output).toContain('1 occurrence');
  });

  it('should handle cross-run text when bolding creates split runs', async () => {
    // Create a doc, bold part of it to split into multiple runs
    const src = await createSampleHwpx('cr-split.hwpx', '프로젝트 보고서 제출');
    const mid = tmpPath('cr-split-mid.hwpx');
    // Bold just "보고서" - this may create multiple runs
    await hwpxSetCharFormat({
      path: src,
      target_text: '보고서',
      bold: true,
      output_path: mid,
    });

    const out = tmpPath('cr-split-out.hwpx');
    const r = await hwpxFindReplace({
      path: mid,
      find: '프로젝트 보고서 제출',
      replace: '프로젝트 리포트 완료',
      output_path: out,
    });
    // Should succeed via cross-run matching
    expect(r.success).toBe(true);
  });

  it('should support case_sensitive=false', async () => {
    const src = await createSampleHwpx('cr-case.hwpx', 'Hello HELLO hello');
    const out = tmpPath('cr-case-out.hwpx');
    const r = await hwpxFindReplace({
      path: src,
      find: 'hello',
      replace: 'hi',
      case_sensitive: false,
      output_path: out,
    });
    expect(r.success).toBe(true);
    expect(r.output).toContain('3 occurrence');
  });
});

// ═══════════════════════════════════════════════════════
// 3. Image insertion
// ═══════════════════════════════════════════════════════

describe('hwpxInsertImage', () => {
  it('should insert an image into the document', async () => {
    const src = await createSampleHwpx('img-basic.hwpx', 'Document with image');
    const imgPath = createTestPng('test-image.png');
    const out = tmpPath('img-basic-out.hwpx');

    const r = await hwpxInsertImage({
      path: src,
      image_path: imgPath,
      width_mm: 50,
      height_mm: 40,
      output_path: out,
    });

    expect(r.success).toBe(true);
    expect(r.output).toContain('Image inserted');

    // Verify image binary is in the ZIP
    const hasBinData = await zipHasFile(out, 'BinData/image1.png');
    expect(hasBinData).toBe(true);

    // Verify header has binItem
    const header = await readZipFile(out, 'Contents/header.xml');
    expect(header).toContain('binItem');
    expect(header).toContain('format="PNG"');

    // Verify section has pic element
    const section = await readZipFile(out, 'Contents/section0.xml');
    expect(section).toContain('hp:pic');
    expect(section).toContain('hp:img');
  });

  it('should return error for non-existent image', async () => {
    const src = await createSampleHwpx('img-err.hwpx', 'Test');
    const r = await hwpxInsertImage({
      path: src,
      image_path: '/nonexistent/image.png',
    });
    expect(r.success).toBe(false);
    expect(r.output).toContain('not found');
  });

  it('should accept section_index param', async () => {
    const src = await createSampleHwpx('img-si.hwpx', 'Test');
    const imgPath = createTestPng('test-image2.png');
    const out = tmpPath('img-si-out.hwpx');

    const r = await hwpxInsertImage({
      path: src,
      image_path: imgPath,
      section_index: 0,
      output_path: out,
    });
    expect(r.success).toBe(true);
  });

  it('should support text_wrap for image positioning', async () => {
    const src = await createSampleHwpx('img-wrap.hwpx', 'Test');
    const imgPath = createTestPng('test-image-wrap.png');
    const out = tmpPath('img-wrap-out.hwpx');

    const r = await hwpxInsertImage({
      path: src,
      image_path: imgPath,
      text_wrap: 'BEHIND_TEXT',
      output_path: out,
    });
    expect(r.success).toBe(true);

    const section = await readZipFile(out, 'Contents/section0.xml');
    expect(section).toContain('textWrap="BEHIND_TEXT"');
    expect(section).toContain('treatAsChar="0"');
  });
});

// ═══════════════════════════════════════════════════════
// 4. Header/Footer
// ═══════════════════════════════════════════════════════

describe('hwpxSetHeaderFooter', () => {
  it('should set a header in the document', async () => {
    const src = await createSampleHwpx('hf-header.hwpx', 'Document content');
    const out = tmpPath('hf-header-out.hwpx');

    const r = await hwpxSetHeaderFooter({
      path: src,
      type: 'header',
      text: '프로젝트 보고서',
      alignment: 'CENTER',
      output_path: out,
    });

    expect(r.success).toBe(true);
    expect(r.output).toContain('Header set');

    const section = await readZipFile(out, 'Contents/section0.xml');
    expect(section).toContain('hp:header');
    expect(section).toContain('프로젝트 보고서');
  });

  it('should set a footer in the document', async () => {
    const src = await createSampleHwpx('hf-footer.hwpx', 'Document content');
    const out = tmpPath('hf-footer-out.hwpx');

    const r = await hwpxSetHeaderFooter({
      path: src,
      type: 'footer',
      text: 'Page 1',
      output_path: out,
    });

    expect(r.success).toBe(true);
    const section = await readZipFile(out, 'Contents/section0.xml');
    expect(section).toContain('hp:footer');
    expect(section).toContain('Page 1');
  });

  it('should support structured footer content with auto page numbers', async () => {
    const src = await createSampleHwpx('hf-footer-structured.hwpx', 'Document content');
    const out = tmpPath('hf-footer-structured-out.hwpx');

    const r = await hwpxSetHeaderFooter({
      path: src,
      type: 'footer',
      content: {
        table: {
          rows: [['법제처', '{{PAGE}} / {{TOTAL_PAGE}}', '국가법령정보센터']],
          columnWidths: [12756, 25512, 12756],
        },
      },
      output_path: out,
    });

    expect(r.success).toBe(true);
    const section = await readZipFile(out, 'Contents/section0.xml');
    expect(section).toContain('hp:footer');
    expect(section).toContain('hp:tbl');
    expect(section).toContain('numType="PAGE"');
    expect(section).toContain('numType="TOTAL_PAGE"');
  });

  it('should replace existing header', async () => {
    const src = await createSampleHwpx('hf-replace.hwpx', 'Content');
    const mid = tmpPath('hf-replace-mid.hwpx');

    // Set initial header
    await hwpxSetHeaderFooter({
      path: src,
      type: 'header',
      text: 'Old Header',
      output_path: mid,
    });

    // Replace with new header
    const out = tmpPath('hf-replace-out.hwpx');
    const r = await hwpxSetHeaderFooter({
      path: mid,
      type: 'header',
      text: 'New Header',
      output_path: out,
    });

    expect(r.success).toBe(true);
    const section = await readZipFile(out, 'Contents/section0.xml');
    expect(section).not.toContain('Old Header');
    expect(section).toContain('New Header');
  });

  it('should set both header and footer', async () => {
    const src = await createSampleHwpx('hf-both.hwpx', 'Content');
    const mid = tmpPath('hf-both-mid.hwpx');

    await hwpxSetHeaderFooter({
      path: src,
      type: 'header',
      text: 'Header Text',
      output_path: mid,
    });

    const out = tmpPath('hf-both-out.hwpx');
    const r = await hwpxSetHeaderFooter({
      path: mid,
      type: 'footer',
      text: 'Footer Text',
      output_path: out,
    });

    expect(r.success).toBe(true);
    const section = await readZipFile(out, 'Contents/section0.xml');
    expect(section).toContain('Header Text');
    expect(section).toContain('Footer Text');
  });
});

// ═══════════════════════════════════════════════════════
// 5. Font registration (font_name)
// ═══════════════════════════════════════════════════════

describe('font_name support in hwpxSetCharFormat', () => {
  it('should register a new font and apply it', async () => {
    const src = await createSampleHwpx('fn-register.hwpx', 'Font test text');
    const out = tmpPath('fn-register-out.hwpx');

    const r = await hwpxSetCharFormat({
      path: src,
      font_name: '맑은 고딕',
      output_path: out,
    });

    expect(r.success).toBe(true);

    // Verify font is registered in header
    const header = await readZipFile(out, 'Contents/header.xml');
    expect(header).toContain('맑은 고딕');
  });

  it('should combine font_name with other char format options', async () => {
    const src = await createSampleHwpx('fn-combo.hwpx', 'Styled text');
    const out = tmpPath('fn-combo-out.hwpx');

    const r = await hwpxSetCharFormat({
      path: src,
      font_name: '나눔고딕',
      bold: true,
      font_size: 14,
      text_color: '#FF0000',
      output_path: out,
    });

    expect(r.success).toBe(true);
    const header = await readZipFile(out, 'Contents/header.xml');
    expect(header).toContain('나눔고딕');
    expect(header).toContain('bold="1"');
    expect(header).toContain('height="1400"');
    expect(header).toContain('textColor="#FF0000"');
  });

  it('should reuse existing font if already registered', async () => {
    const src = await createSampleHwpx('fn-reuse.hwpx', 'First\n\nSecond');
    const mid = tmpPath('fn-reuse-mid.hwpx');

    // First call registers the font
    await hwpxSetCharFormat({
      path: src,
      target_text: 'First',
      font_name: '나눔바른고딕',
      output_path: mid,
    });

    // Second call should reuse the same font
    const out = tmpPath('fn-reuse-out.hwpx');
    const r = await hwpxSetCharFormat({
      path: mid,
      target_text: 'Second',
      font_name: '나눔바른고딕',
      output_path: out,
    });

    expect(r.success).toBe(true);
    const header = await readZipFile(out, 'Contents/header.xml');
    // Count occurrences of the font face - should appear once per fontface lang section, not duplicated
    const faceMatches = header.match(/face="나눔바른고딕"/g);
    // There are 7 fontface lang sections, so expect 7 entries (one per lang)
    expect(faceMatches).not.toBeNull();
    // Each lang section should have exactly one entry
    const firstCallHeader = await readZipFile(mid, 'Contents/header.xml');
    const firstCount = (firstCallHeader.match(/face="나눔바른고딕"/g) || []).length;
    const secondCount = (header.match(/face="나눔바른고딕"/g) || []).length;
    expect(secondCount).toBe(firstCount); // No duplicates added
  });
});

// ═══════════════════════════════════════════════════════
// 6. Table creation (insert_table)
// ═══════════════════════════════════════════════════════

describe('hwpxInsertTable', () => {
  it('should insert a new table with headers and data', async () => {
    const src = await createSampleHwpx('tbl-basic.hwpx', 'Document before table');
    const out = tmpPath('tbl-basic-out.hwpx');

    const r = await hwpxInsertTable({
      path: src,
      rows: 3,
      cols: 3,
      headers: ['Name', 'Age', 'City'],
      data: [
        ['Alice', '30', 'Seoul'],
        ['Bob', '25', 'Busan'],
      ],
      output_path: out,
    });

    expect(r.success).toBe(true);
    expect(r.output).toContain('Table inserted (3x3)');

    const section = await readZipFile(out, 'Contents/section0.xml');
    expect(section).toContain('hp:tbl');
    expect(section).toContain('Name');
    expect(section).toContain('Alice');
    expect(section).toContain('Seoul');
    expect(section).toContain('rowCnt="3"');
    expect(section).toContain('colCnt="3"');
  });

  it('should insert an empty table with no headers/data', async () => {
    const src = await createSampleHwpx('tbl-empty.hwpx', 'Empty table test');
    const out = tmpPath('tbl-empty-out.hwpx');

    const r = await hwpxInsertTable({
      path: src,
      rows: 2,
      cols: 2,
      output_path: out,
    });

    expect(r.success).toBe(true);
    const section = await readZipFile(out, 'Contents/section0.xml');
    expect(section).toContain('hp:tbl');
  });

  it('should be editable after insertion', async () => {
    const src = await createSampleHwpx('tbl-edit.hwpx', 'Editable table');
    const mid = tmpPath('tbl-edit-mid.hwpx');

    // Insert table
    await hwpxInsertTable({
      path: src,
      rows: 2,
      cols: 2,
      headers: ['H1', 'H2'],
      data: [['d1', 'd2']],
      output_path: mid,
    });

    // Edit a cell in the inserted table
    const out = tmpPath('tbl-edit-out.hwpx');
    const r = await hwpxEditTableCell({
      path: mid,
      row: 1,
      col: 0,
      text: 'MODIFIED',
      output_path: out,
    });

    expect(r.success).toBe(true);
    const section = await readZipFile(out, 'Contents/section0.xml');
    expect(section).toContain('MODIFIED');
  });

  it('should accept section_index param', async () => {
    const src = await createSampleHwpx('tbl-si.hwpx', 'Section test');
    const out = tmpPath('tbl-si-out.hwpx');

    const r = await hwpxInsertTable({
      path: src,
      rows: 2,
      cols: 2,
      section_index: 0,
      output_path: out,
    });
    expect(r.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════
// Combined workflow: all improvements together
// ═══════════════════════════════════════════════════════

describe('Combined improvements workflow', () => {
  it('should chain all new features in sequence', async () => {
    // Step 1: Create base document
    const src = await createSampleHwpx('combo.hwpx', '# 보고서\n\n내용입니다.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |');
    const comboDoc = src;

    // Step 2: Set header
    await hwpxSetHeaderFooter({
      path: comboDoc,
      type: 'header',
      text: '기밀 문서',
      output_path: comboDoc,
    });

    // Step 3: Set footer
    await hwpxSetHeaderFooter({
      path: comboDoc,
      type: 'footer',
      text: '(주)유레움',
      output_path: comboDoc,
    });

    // Step 4: Change font
    await hwpxSetCharFormat({
      path: comboDoc,
      font_name: '맑은 고딕',
      font_size: 12,
      output_path: comboDoc,
    });

    // Step 5: Insert image
    const imgPath = createTestPng('combo-img.png');
    await hwpxInsertImage({
      path: comboDoc,
      image_path: imgPath,
      width_mm: 80,
      height_mm: 60,
      output_path: comboDoc,
    });

    // Step 6: Insert new table
    const r = await hwpxInsertTable({
      path: comboDoc,
      rows: 3,
      cols: 2,
      headers: ['항목', '값'],
      data: [
        ['매출', '1000'],
        ['비용', '500'],
      ],
      output_path: comboDoc,
    });

    expect(r.success).toBe(true);

    // Verify final document
    const section = await readZipFile(comboDoc, 'Contents/section0.xml');
    const header = await readZipFile(comboDoc, 'Contents/header.xml');

    // Header/footer present
    expect(section).toContain('기밀 문서');
    expect(section).toContain('(주)유레움');

    // Font registered
    expect(header).toContain('맑은 고딕');

    // Image embedded
    expect(section).toContain('hp:pic');
    const hasBin = await zipHasFile(comboDoc, 'BinData/image1.png');
    expect(hasBin).toBe(true);

    // New table present with data
    expect(section).toContain('항목');
    expect(section).toContain('매출');
  });
});
