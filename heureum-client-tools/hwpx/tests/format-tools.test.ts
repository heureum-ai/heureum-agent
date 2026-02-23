import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';
import { createHwpx } from '../src/writer.js';
import {
  hwpxSetCharFormat,
  hwpxSetParaFormat,
  hwpxSetPageLayout,
  hwpxEditTableCell,
} from '../src/tools.js';

const TMP_DIR = path.join(__dirname, '__tmp_format_tools__');

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

beforeAll(async () => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

async function createSampleHwpx(name: string, markdown: string): Promise<string> {
  const buf = await createHwpx(markdown);
  const filePath = tmpPath(name);
  fs.writeFileSync(filePath, buf);
  return filePath;
}

// ════════════════════════════════════════════════════════
// 1. hwpx_set_char_format
// ════════════════════════════════════════════════════════

describe('hwpxSetCharFormat', () => {
  it('should apply bold and change charPrIDRef', async () => {
    const src = await createSampleHwpx('cf-bold.hwpx', 'Hello world');
    const out = tmpPath('cf-bold-out.hwpx');
    const result = await hwpxSetCharFormat({ path: src, bold: true, output_path: out });

    expect(result.success).toBe(true);
    const section = await readZipFile(out, 'Contents/section0.xml');
    // The run should no longer reference charPrIDRef="0" (body text without bold)
    // It should reference a charPr with bold
    const header = await readZipFile(out, 'Contents/header.xml');
    const runMatch = section.match(/charPrIDRef="(\d+)"[^>]*><hp:t>Hello world<\/hp:t>/);
    expect(runMatch).not.toBeNull();
    const charPrId = runMatch![1];
    // The referenced charPr should have bold="1"
    const charPrRe = new RegExp(`<hh:charPr\\s+id="${charPrId}"[^>]*>`);
    const charPrMatch = header.match(charPrRe);
    expect(charPrMatch).not.toBeNull();
    expect(charPrMatch![0]).toContain('bold="1"');
  });

  it('should apply font_size and add new charPr to header', async () => {
    const src = await createSampleHwpx('cf-fontsize.hwpx', 'Test text');
    const out = tmpPath('cf-fontsize-out.hwpx');
    const result = await hwpxSetCharFormat({ path: src, font_size: 14, output_path: out });

    expect(result.success).toBe(true);
    const header = await readZipFile(out, 'Contents/header.xml');
    // Should contain a charPr with height="1400" (14 * 100)
    expect(header).toContain('height="1400"');
  });

  it('should apply text_color', async () => {
    const src = await createSampleHwpx('cf-color.hwpx', 'Colored text');
    const out = tmpPath('cf-color-out.hwpx');
    const result = await hwpxSetCharFormat({ path: src, text_color: '#FF0000', output_path: out });

    expect(result.success).toBe(true);
    const header = await readZipFile(out, 'Contents/header.xml');
    expect(header).toContain('textColor="#FF0000"');
  });

  it('should only modify runs matching target_text', async () => {
    const src = await createSampleHwpx('cf-target.hwpx', 'Keep this normal\n\nMake this bold');
    const out = tmpPath('cf-target-out.hwpx');
    const result = await hwpxSetCharFormat({
      path: src,
      target_text: 'Make this bold',
      bold: true,
      output_path: out,
    });

    expect(result.success).toBe(true);
    const section = await readZipFile(out, 'Contents/section0.xml');
    // "Keep this normal" should still have charPrIDRef="0"
    const keepMatch = section.match(/charPrIDRef="(\d+)"[^>]*><hp:t>Keep this normal<\/hp:t>/);
    expect(keepMatch).not.toBeNull();
    expect(keepMatch![1]).toBe('0');

    // "Make this bold" should have a different charPrIDRef
    const boldMatch = section.match(/charPrIDRef="(\d+)"[^>]*><hp:t>Make this bold<\/hp:t>/);
    expect(boldMatch).not.toBeNull();
    expect(boldMatch![1]).not.toBe('0');
  });

  it('should only modify runs in specified paragraph_index', async () => {
    const src = await createSampleHwpx('cf-pidx.hwpx', 'First para\n\nSecond para\n\nThird para');
    const out = tmpPath('cf-pidx-out.hwpx');
    const result = await hwpxSetCharFormat({
      path: src,
      paragraph_index: 1,
      italic: true,
      output_path: out,
    });

    expect(result.success).toBe(true);
    const section = await readZipFile(out, 'Contents/section0.xml');
    // First para should be unchanged
    const firstMatch = section.match(/charPrIDRef="(\d+)"[^>]*><hp:t>First para<\/hp:t>/);
    expect(firstMatch![1]).toBe('0');
    // Second para should be modified
    const secondMatch = section.match(/charPrIDRef="(\d+)"[^>]*><hp:t>Second para<\/hp:t>/);
    expect(secondMatch![1]).not.toBe('0');
    // Third para should be unchanged
    const thirdMatch = section.match(/charPrIDRef="(\d+)"[^>]*><hp:t>Third para<\/hp:t>/);
    expect(thirdMatch![1]).toBe('0');
  });
});

// ════════════════════════════════════════════════════════
// 2. hwpx_set_para_format
// ════════════════════════════════════════════════════════

describe('hwpxSetParaFormat', () => {
  it('should change alignment and add new paraPr', async () => {
    const src = await createSampleHwpx('pf-align.hwpx', 'Center me');
    const out = tmpPath('pf-align-out.hwpx');
    const result = await hwpxSetParaFormat({
      path: src,
      alignment: 'CENTER',
      output_path: out,
    });

    expect(result.success).toBe(true);
    const header = await readZipFile(out, 'Contents/header.xml');
    expect(header).toContain('horizontal="CENTER"');

    const section = await readZipFile(out, 'Contents/section0.xml');
    // Find the run containing "Center me" and then look at its parent paragraph's paraPrIDRef
    // Extract the paragraph that directly contains "Center me"
    const paraBlocks = [...section.matchAll(/<hp:p\s[^>]*paraPrIDRef="(\d+)"[^>]*>[\s\S]*?<\/hp:p>/g)];
    const targetPara = paraBlocks.find(m => m[0].includes('Center me'));
    expect(targetPara).not.toBeUndefined();
    expect(targetPara![1]).not.toBe('0');
  });

  it('should change line_spacing', async () => {
    const src = await createSampleHwpx('pf-ls.hwpx', 'Spaced text');
    const out = tmpPath('pf-ls-out.hwpx');
    const result = await hwpxSetParaFormat({
      path: src,
      line_spacing: 200,
      output_path: out,
    });

    expect(result.success).toBe(true);
    const header = await readZipFile(out, 'Contents/header.xml');
    expect(header).toContain('value="200"');
  });

  it('should apply to specific paragraph_index', async () => {
    const src = await createSampleHwpx('pf-idx.hwpx', 'Para one\n\nPara two\n\nPara three');
    const out = tmpPath('pf-idx-out.hwpx');
    const result = await hwpxSetParaFormat({
      path: src,
      paragraph_index: 0,
      alignment: 'RIGHT',
      output_path: out,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('1 paragraph');
  });

  it('should apply to paragraphs matching target_text', async () => {
    const src = await createSampleHwpx('pf-target.hwpx', 'Normal text\n\nCenter this');
    const out = tmpPath('pf-target-out.hwpx');
    const result = await hwpxSetParaFormat({
      path: src,
      target_text: 'Center this',
      alignment: 'CENTER',
      output_path: out,
    });

    expect(result.success).toBe(true);
    expect(result.output).toContain('1 paragraph');
  });
});

// ════════════════════════════════════════════════════════
// 3. hwpx_set_page_layout
// ════════════════════════════════════════════════════════

describe('hwpxSetPageLayout', () => {
  it('should change margins (mm input)', async () => {
    const src = await createSampleHwpx('pl-margin.hwpx', 'Page layout test');
    const out = tmpPath('pl-margin-out.hwpx');
    const result = await hwpxSetPageLayout({
      path: src,
      margin_top: 20,    // mm
      margin_bottom: 20,  // mm
      output_path: out,
    });

    expect(result.success).toBe(true);
    const section = await readZipFile(out, 'Contents/section0.xml');
    const marginMatch = section.match(/<hp:margin[^>]*>/);
    expect(marginMatch).not.toBeNull();
    // 20mm * 283.46 = 5669
    expect(marginMatch![0]).toContain('top="5669"');
    expect(marginMatch![0]).toContain('bottom="5669"');
  });

  it('should change page width and height (mm input)', async () => {
    const src = await createSampleHwpx('pl-size.hwpx', 'Page size test');
    const out = tmpPath('pl-size-out.hwpx');
    const result = await hwpxSetPageLayout({
      path: src,
      page_width: 250,   // mm
      page_height: 320,  // mm
      output_path: out,
    });

    expect(result.success).toBe(true);
    const section = await readZipFile(out, 'Contents/section0.xml');
    // 250mm * (7200/25.4) = 70866, 320mm * (7200/25.4) = 90709
    expect(section).toContain('width="70866"');
    expect(section).toContain('height="90709"');
  });

  it('should convert mm to HWPUNIT for left margin', async () => {
    const src = await createSampleHwpx('pl-mm.hwpx', 'mm test');
    const out = tmpPath('pl-mm-out.hwpx');
    const result = await hwpxSetPageLayout({
      path: src,
      margin_left: 20,  // mm
      output_path: out,
    });

    expect(result.success).toBe(true);
    const section = await readZipFile(out, 'Contents/section0.xml');
    // 20mm * 283.46 = 5669 (rounded)
    const marginMatch = section.match(/<hp:margin[^>]*>/);
    expect(marginMatch).not.toBeNull();
    expect(marginMatch![0]).toContain('left="5669"');
  });

  it('should change header and footer margins (mm input)', async () => {
    const src = await createSampleHwpx('pl-hf.hwpx', 'Header footer test');
    const out = tmpPath('pl-hf-out.hwpx');
    const result = await hwpxSetPageLayout({
      path: src,
      margin_header: 5,  // mm
      margin_footer: 5,  // mm
      output_path: out,
    });

    expect(result.success).toBe(true);
    const section = await readZipFile(out, 'Contents/section0.xml');
    const marginMatch = section.match(/<hp:margin[^>]*>/);
    expect(marginMatch).not.toBeNull();
    // 5mm * 283.46 = 1417
    expect(marginMatch![0]).toContain('header="1417"');
    expect(marginMatch![0]).toContain('footer="1417"');
  });
});

// ════════════════════════════════════════════════════════
// 4. hwpx_edit_table_cell
// ════════════════════════════════════════════════════════

describe('hwpxEditTableCell', () => {
  const TABLE_MD = '| A | B | C |\n| --- | --- | --- |\n| a1 | b1 | c1 |\n| a2 | b2 | c2 |';

  it('should replace cell text', async () => {
    const src = await createSampleHwpx('tc-text.hwpx', TABLE_MD);
    const out = tmpPath('tc-text-out.hwpx');
    const result = await hwpxEditTableCell({
      path: src,
      row: 1,
      col: 0,
      text: 'REPLACED',
      output_path: out,
    });

    expect(result.success).toBe(true);
    const section = await readZipFile(out, 'Contents/section0.xml');
    expect(section).toContain('REPLACED');
    expect(section).not.toContain('>a1<');
  });

  it('should apply background_color via borderFill', async () => {
    const src = await createSampleHwpx('tc-bg.hwpx', TABLE_MD);
    const out = tmpPath('tc-bg-out.hwpx');
    const result = await hwpxEditTableCell({
      path: src,
      row: 0,
      col: 0,
      background_color: '#FFFF00',
      output_path: out,
    });

    expect(result.success).toBe(true);
    const header = await readZipFile(out, 'Contents/header.xml');
    // Should have a new borderFill with fillBrush
    expect(header).toContain('faceColor="#FFFF00"');

    const section = await readZipFile(out, 'Contents/section0.xml');
    // The cell should reference the new borderFill
    const cellMatch = section.match(/<hp:tc[^>]*borderFillIDRef="(\d+)"[^>]*>[\s\S]*?<hp:cellAddr\s+colAddr="0"\s+rowAddr="0"/);
    expect(cellMatch).not.toBeNull();
    // Should reference a borderFill with id > 2 (existing ones are 1 and 2)
    expect(Number(cellMatch![1])).toBeGreaterThan(2);
  });

  it('should merge cells rightward (merge_right)', async () => {
    const src = await createSampleHwpx('tc-mr.hwpx', TABLE_MD);
    const out = tmpPath('tc-mr-out.hwpx');
    const result = await hwpxEditTableCell({
      path: src,
      row: 0,
      col: 0,
      merge_right: 1,
      output_path: out,
    });

    expect(result.success).toBe(true);
    const section = await readZipFile(out, 'Contents/section0.xml');
    // Should have colSpan="2" for the merged cell
    expect(section).toContain('colSpan="2"');
    // The first row should have 2 cells instead of 3
    const firstTr = section.match(/<hp:tr>([\s\S]*?)<\/hp:tr>/);
    expect(firstTr).not.toBeNull();
    const cellCount = (firstTr![1].match(/<hp:tc\s/g) || []).length;
    expect(cellCount).toBe(2);
  });

  it('should merge cells downward (merge_down)', async () => {
    const src = await createSampleHwpx('tc-md.hwpx', TABLE_MD);
    const out = tmpPath('tc-md-out.hwpx');
    const result = await hwpxEditTableCell({
      path: src,
      row: 0,
      col: 0,
      merge_down: 1,
      output_path: out,
    });

    expect(result.success).toBe(true);
    const section = await readZipFile(out, 'Contents/section0.xml');
    // Should have rowSpan="2" for the merged cell
    expect(section).toContain('rowSpan="2"');
    // Second row should have one fewer cell
    const trs = [...section.matchAll(/<hp:tr>([\s\S]*?)<\/hp:tr>/g)];
    expect(trs.length).toBe(3);
    const secondRowCells = (trs[1][1].match(/<hp:tc\s/g) || []).length;
    expect(secondRowCells).toBe(2);
  });

  it('should return error for out-of-range row', async () => {
    const src = await createSampleHwpx('tc-err.hwpx', TABLE_MD);
    const result = await hwpxEditTableCell({
      path: src,
      row: 99,
      col: 0,
    });
    expect(result.success).toBe(false);
    expect(result.output).toContain('out of range');
  });
});
