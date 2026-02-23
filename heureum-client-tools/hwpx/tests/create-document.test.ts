/**
 * Tests for hwpxCreateDocument — structured document creation.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';
import { hwpxCreateDocument } from '../src/tools.js';

const OUT_DIR = path.resolve(__dirname, '../output/create-document');

beforeAll(() => {
  if (fs.existsSync(OUT_DIR)) {
    fs.rmSync(OUT_DIR, { recursive: true, force: true });
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
});

function outPath(name: string): string {
  return path.join(OUT_DIR, name);
}

/** Create a tiny 1x1 blue PNG for image tests */
function createTestPng(): string {
  const filePath = path.join(OUT_DIR, 'test-image.png');
  if (fs.existsSync(filePath)) return filePath;
  const png = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41,
    0x54, 0x08, 0xd7, 0x63, 0x60, 0x60, 0xf8, 0x0f,
    0x00, 0x00, 0x02, 0x00, 0x01, 0xe2, 0x21, 0xbc,
    0x33, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
  ]);
  fs.writeFileSync(filePath, png);
  return filePath;
}

async function loadSection(hwpxPath: string): Promise<string> {
  const buf = fs.readFileSync(hwpxPath);
  const zip = await JSZip.loadAsync(buf);
  const f = zip.file('Contents/section0.xml');
  return f ? f.async('string') : '';
}

async function loadHeader(hwpxPath: string): Promise<string> {
  const buf = fs.readFileSync(hwpxPath);
  const zip = await JSZip.loadAsync(buf);
  const f = zip.file('Contents/header.xml');
  return f ? f.async('string') : '';
}

async function loadContentHpf(hwpxPath: string): Promise<string> {
  const buf = fs.readFileSync(hwpxPath);
  const zip = await JSZip.loadAsync(buf);
  const f = zip.file('Contents/content.hpf');
  return f ? f.async('string') : '';
}

describe('hwpxCreateDocument', () => {

  // 1. Basic paragraph
  it('creates a document with a basic paragraph', async () => {
    const p = outPath('01-basic.hwpx');
    const r = await hwpxCreateDocument({
      output_path: p,
      content: [
        { paragraph: { text: 'Hello World' } },
      ],
    });
    expect(r.success).toBe(true);
    expect(fs.existsSync(p)).toBe(true);

    const section = await loadSection(p);
    expect(section).toContain('Hello World');
  });

  // 2. Heading levels 1-6
  it('creates headings 1 through 6', async () => {
    const p = outPath('02-headings.hwpx');
    const r = await hwpxCreateDocument({
      output_path: p,
      content: [
        { paragraph: { text: 'H1 Title', heading: 1 } },
        { paragraph: { text: 'H2 Subtitle', heading: 2 } },
        { paragraph: { text: 'H3 Section', heading: 3 } },
        { paragraph: { text: 'H4 Sub-section', heading: 4 } },
        { paragraph: { text: 'H5 Minor', heading: 5 } },
        { paragraph: { text: 'H6 Smallest', heading: 6 } },
      ],
    });
    expect(r.success).toBe(true);

    const header = await loadHeader(p);
    // H1 = 22pt → height=2200
    expect(header).toContain('height="2200"');
    // H2 = 16pt → height=1600
    expect(header).toContain('height="1600"');
    // H3 = 14pt → height=1400
    expect(header).toContain('height="1400"');
  });

  // 3. Bold/italic/underline/color/fontSize
  it('applies bold, italic, underline, color, fontSize', async () => {
    const p = outPath('03-char-format.hwpx');
    const r = await hwpxCreateDocument({
      output_path: p,
      content: [
        { paragraph: { text: 'Bold', bold: true } },
        { paragraph: { text: 'Italic', italic: true } },
        { paragraph: { text: 'Underline', underline: true } },
        { paragraph: { text: 'Red', color: '#FF0000' } },
        { paragraph: { text: 'Big', fontSize: 24 } },
      ],
    });
    expect(r.success).toBe(true);

    const header = await loadHeader(p);
    expect(header).toContain('bold="1"');
    expect(header).toContain('italic="1"');
    expect(header).toContain('underline="1"');
    expect(header).toContain('textColor="#FF0000"');
    expect(header).toContain('height="2400"'); // 24pt
  });

  // 4. Alignment (CENTER, RIGHT, JUSTIFY)
  it('applies paragraph alignment', async () => {
    const p = outPath('04-alignment.hwpx');
    const r = await hwpxCreateDocument({
      output_path: p,
      content: [
        { paragraph: { text: 'Center', alignment: 'CENTER' } },
        { paragraph: { text: 'Right', alignment: 'RIGHT' } },
        { paragraph: { text: 'Justify', alignment: 'JUSTIFY' } },
      ],
    });
    expect(r.success).toBe(true);

    const header = await loadHeader(p);
    expect(header).toContain('horizontal="CENTER"');
    expect(header).toContain('horizontal="RIGHT"');
  });

  // 5. Bullet and numbered lists
  it('creates bullet and numbered lists', async () => {
    const p = outPath('05-lists.hwpx');
    const r = await hwpxCreateDocument({
      output_path: p,
      content: [
        { paragraph: { text: 'Item A', bullet: true } },
        { paragraph: { text: 'Item B', bullet: true } },
        { paragraph: { text: 'First', numbered: true } },
        { paragraph: { text: 'Second', numbered: true } },
        { paragraph: { text: 'Third', numbered: true } },
      ],
    });
    expect(r.success).toBe(true);

    const section = await loadSection(p);
    expect(section).toContain('• Item A');
    expect(section).toContain('• Item B');
    expect(section).toContain('1. First');
    expect(section).toContain('2. Second');
    expect(section).toContain('3. Third');
  });

  // 6. Page break (standalone + paragraph)
  it('inserts page breaks', async () => {
    const p = outPath('06-pagebreak.hwpx');
    const r = await hwpxCreateDocument({
      output_path: p,
      content: [
        { paragraph: { text: 'Page 1' } },
        { pageBreak: true },
        { paragraph: { text: 'Page 2' } },
        { paragraph: { text: 'Page 3 top', pageBreak: true } },
      ],
    });
    expect(r.success).toBe(true);

    const header = await loadHeader(p);
    expect(header).toContain('pageBreakBefore="1"');
  });

  // 7. Table with headerRow + headerBackground
  it('creates a table with header styling', async () => {
    const p = outPath('07-table-header.hwpx');
    const r = await hwpxCreateDocument({
      output_path: p,
      content: [
        {
          table: {
            rows: [
              ['Name', 'Score'],
              ['Alice', '95'],
              ['Bob', '87'],
            ],
            headerRow: true,
            headerBackground: '#1565C0',
          },
        },
      ],
    });
    expect(r.success).toBe(true);

    const section = await loadSection(p);
    expect(section).toContain('hp:tbl');
    expect(section).toContain('Alice');
    expect(section).toContain('header="1"');

    const header = await loadHeader(p);
    expect(header).toContain('#1565C0');
  });

  // 8. Table with custom columnWidths (mm input)
  it('creates a table with custom column widths', async () => {
    const p = outPath('08-table-colwidths.hwpx');
    const r = await hwpxCreateDocument({
      output_path: p,
      content: [
        {
          table: {
            rows: [
              ['Wide', 'Narrow'],
              ['Content A', 'B'],
            ],
            columnWidths: [100, 50],  // mm
          },
        },
      ],
    });
    expect(r.success).toBe(true);

    const section = await loadSection(p);
    // 100mm * 283.46 = 28346, 50mm * 283.46 = 14173
    expect(section).toContain('width="28346"');
    expect(section).toContain('width="14173"');
  });

  // 9. Image insertion
  it('inserts an image', async () => {
    const imgPath = createTestPng();
    const p = outPath('09-image.hwpx');
    const r = await hwpxCreateDocument({
      output_path: p,
      content: [
        { paragraph: { text: 'Before image' } },
        { image: { path: imgPath, width_mm: 80, height_mm: 60 } },
        { paragraph: { text: 'After image' } },
      ],
    });
    expect(r.success).toBe(true);

    const buf = fs.readFileSync(p);
    const zip = await JSZip.loadAsync(buf);
    // Check BinData exists (filter out directory entries)
    const binFiles = Object.keys(zip.files).filter(f => f.startsWith('BinData/') && !zip.files[f].dir);
    expect(binFiles.length).toBe(1);

    const section = await loadSection(p);
    expect(section).toContain('hp:pic');
  });

  it('supports image text_wrap option', async () => {
    const imgPath = createTestPng();
    const p = outPath('09b-image-wrap.hwpx');
    const r = await hwpxCreateDocument({
      output_path: p,
      content: [
        { image: { path: imgPath, width_mm: 40, height_mm: 20, text_wrap: 'BEHIND_TEXT' } },
      ],
    });
    expect(r.success).toBe(true);

    const section = await loadSection(p);
    expect(section).toContain('textWrap="BEHIND_TEXT"');
    expect(section).toContain('treatAsChar="0"');
  });

  // 10. Custom font + default fontSize
  it('uses custom font and fontSize', async () => {
    const p = outPath('10-custom-font.hwpx');
    const r = await hwpxCreateDocument({
      output_path: p,
      content: [
        { paragraph: { text: 'Custom font text' } },
      ],
      font: '나눔고딕',
      font_size: 12,
    });
    expect(r.success).toBe(true);

    const header = await loadHeader(p);
    expect(header).toContain('나눔고딕');
    expect(header).toContain('height="1200"'); // 12pt
  });

  // 11. Custom margins (mm)
  it('applies custom margins', async () => {
    const p = outPath('11-margins.hwpx');
    const r = await hwpxCreateDocument({
      output_path: p,
      content: [{ paragraph: { text: 'Margins test' } }],
      margin: { top: 20, bottom: 20, left: 25, right: 25 },
    });
    expect(r.success).toBe(true);

    const section = await loadSection(p);
    // 20mm ≈ 5669 HU
    expect(section).toMatch(/top="566[0-9]"/);
    // 25mm ≈ 7087 HU
    expect(section).toMatch(/left="708[0-9]"/);
  });

  // 12. Header and footer text
  it('adds header and footer', async () => {
    const p = outPath('12-header-footer.hwpx');
    const r = await hwpxCreateDocument({
      output_path: p,
      content: [{ paragraph: { text: 'Body text' } }],
      header: 'My Organization',
      footer: '© 2026',
    });
    expect(r.success).toBe(true);

    const section = await loadSection(p);
    expect(section).toContain('hp:header');
    expect(section).toContain('My Organization');
    expect(section).toContain('hp:footer');
    expect(section).toContain('© 2026');
  });

  it('supports structured footer with table and auto page fields', async () => {
    const p = outPath('12b-structured-footer.hwpx');
    const r = await hwpxCreateDocument({
      output_path: p,
      content: [{ paragraph: { text: 'Body text' } }],
      footer: {
        table: {
          rows: [['법제처', '{{PAGE}} / {{TOTAL_PAGE}}', '국가법령정보센터']],
          columnWidths: [12756, 25512, 12756],
        },
      },
    });
    expect(r.success).toBe(true);

    const section = await loadSection(p);
    expect(section).toContain('hp:footer');
    expect(section).toContain('hp:tbl');
    expect(section).toContain('numType="PAGE"');
    expect(section).toContain('numType="TOTAL_PAGE"');
    expect(section).not.toContain('{{PAGE}}');
  });

  // 13. Mixed content (paragraph + table + image)
  it('handles mixed content blocks', async () => {
    const imgPath = createTestPng();
    const p = outPath('13-mixed.hwpx');
    const r = await hwpxCreateDocument({
      output_path: p,
      content: [
        { paragraph: { text: 'Introduction', heading: 1, color: '#1A237E', alignment: 'CENTER' } },
        { paragraph: { text: 'Some body text here.' } },
        {
          table: {
            rows: [
              ['Metric', 'Value'],
              ['Users', '1M'],
            ],
            headerRow: true,
            headerBackground: '#0D47A1',
          },
        },
        { image: { path: imgPath } },
        { paragraph: { text: 'Conclusion', heading: 2 } },
      ],
      title: 'Mixed Document',
    });
    expect(r.success).toBe(true);

    const section = await loadSection(p);
    expect(section).toContain('Introduction');
    expect(section).toContain('hp:tbl');
    expect(section).toContain('hp:pic');
    expect(section).toContain('Conclusion');
  });

  // 14. Empty content array → valid HWPX
  it('creates valid HWPX with empty content', async () => {
    const p = outPath('14-empty.hwpx');
    const r = await hwpxCreateDocument({
      output_path: p,
      content: [],
    });
    expect(r.success).toBe(true);

    const buf = fs.readFileSync(p);
    const zip = await JSZip.loadAsync(buf);
    expect(zip.file('mimetype')).not.toBeNull();
    expect(zip.file('Contents/section0.xml')).not.toBeNull();
    expect(zip.file('Contents/header.xml')).not.toBeNull();
  });

  // 15. Page sizes (A4, B5, letter)
  it('supports different page sizes', async () => {
    for (const size of ['a4', 'b5', 'letter'] as const) {
      const p = outPath(`15-${size}.hwpx`);
      const r = await hwpxCreateDocument({
        output_path: p,
        content: [{ paragraph: { text: `${size} page` } }],
        page_size: size,
      });
      expect(r.success).toBe(true);
    }

    // Verify B5 dimensions
    const b5Section = await loadSection(outPath('15-b5.hwpx'));
    expect(b5Section).toContain('width="51592"');
    expect(b5Section).toContain('height="72852"');

    // Verify Letter dimensions
    const letterSection = await loadSection(outPath('15-letter.hwpx'));
    expect(letterSection).toContain('width="61200"');
    expect(letterSection).toContain('height="79200"');
  });

  // 16. Line spacing
  it('applies line spacing', async () => {
    const p = outPath('16-linespacing.hwpx');
    const r = await hwpxCreateDocument({
      output_path: p,
      content: [
        { paragraph: { text: 'Tight spacing', lineSpacing: 120 } },
        { paragraph: { text: 'Wide spacing', lineSpacing: 200 } },
      ],
    });
    expect(r.success).toBe(true);

    const header = await loadHeader(p);
    expect(header).toContain('value="120"');
    expect(header).toContain('value="200"');
  });

  // 17. Spacing before/after (mm input)
  it('applies spacing before and after', async () => {
    const p = outPath('17-spacing.hwpx');
    const r = await hwpxCreateDocument({
      output_path: p,
      content: [
        { paragraph: { text: 'With spacing', spacing: { before: 3, after: 2 } } },  // mm
      ],
    });
    expect(r.success).toBe(true);

    const header = await loadHeader(p);
    // 3mm * 283.46 = 850, 2mm * 283.46 = 567
    expect(header).toContain('value="850"');
    expect(header).toContain('value="567"');
  });

  // 18. Mixed runs + negative hanging indent
  it('supports mixed runs in one paragraph and negative indent', async () => {
    const p = outPath('18-mixed-runs-indent.hwpx');
    const r = await hwpxCreateDocument({
      output_path: p,
      content: [
        {
          paragraph: {
            runs: [
              { text: '제1조(목적)', fontSize: 10, fontName: '한양견고딕' },
              { text: ' 이 규칙은 필요한 사항을 정한다.', fontSize: 10, fontName: '한양신명조' },
              { text: ' <개정 2023. 6. 28.>', fontSize: 9, color: '#0000FF', fontName: '한양신명조' },
            ],
            indent: -7,  // mm (negative = hanging indent)
            lineSpacing: 130,
          },
        },
      ],
    });
    expect(r.success).toBe(true);

    const section = await loadSection(p);
    expect(section).toContain('제1조(목적)');
    expect(section).toContain('이 규칙은 필요한 사항을 정한다.');
    expect(section).toContain('&lt;개정 2023. 6. 28.&gt;');
    // Mixed run should create at least 3 run elements in the target paragraph.
    expect((section.match(/<hp:run charPrIDRef="/g) || []).length).toBeGreaterThanOrEqual(4);

    const header = await loadHeader(p);
    // -7mm * 283.46 = -1984
    expect(header).toContain('value="-1984"');
    expect(header).toContain('face="한양견고딕"');
    expect(header).toContain('face="한양신명조"');
  });

  // 19. lineBreak generation inside paragraph
  it('supports lineBreak in runs', async () => {
    const p = outPath('19-linebreak.hwpx');
    const r = await hwpxCreateDocument({
      output_path: p,
      content: [
        {
          paragraph: {
            runs: [
              { text: '첫째 줄', lineBreak: true },
              { text: '둘째 줄' },
            ],
          },
        },
      ],
    });
    expect(r.success).toBe(true);
    const section = await loadSection(p);
    expect(section).toContain('<hp:lineBreak/>');
    expect(section).toContain('첫째 줄');
    expect(section).toContain('둘째 줄');
  });

  // 20. Directional cell border options
  it('supports directional table borders', async () => {
    const p = outPath('20-table-directional-border.hwpx');
    const r = await hwpxCreateDocument({
      output_path: p,
      content: [
        {
          table: {
            rows: [['제목']],
            cellBorder: {
              topBorderType: 'NONE',
              bottomBorderType: 'SOLID',
              leftBorderType: 'NONE',
              rightBorderType: 'NONE',
            },
          },
        },
      ],
    });
    expect(r.success).toBe(true);
    const header = await loadHeader(p);
    expect(header).toContain('<hh:topBorder type="NONE"');
    expect(header).toContain('<hh:bottomBorder type="SOLID"');
    expect(header).toContain('<hh:leftBorder type="NONE"');
    expect(header).toContain('<hh:rightBorder type="NONE"');
  });

  // 21. Image manifest item registration in content.hpf
  it('adds image entries to content.hpf manifest', async () => {
    const p = outPath('21-image-manifest.hwpx');
    const imgPath = createTestPng();
    const r = await hwpxCreateDocument({
      output_path: p,
      content: [
        { image: { path: imgPath, width_mm: 30, height_mm: 20 } },
      ],
    });
    expect(r.success).toBe(true);

    const hpf = await loadContentHpf(p);
    expect(hpf).toContain('href="BinData/image');
    expect(hpf).toContain('media-type="image/png"');
    expect(hpf).toContain('isEmbeded="1"');
  });
});
