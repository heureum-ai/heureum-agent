import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';
import { hwpxCreateDocument, hwpxExtractStyles, parseTemplateStyle } from '../src/tools.js';
import { parseBorderFillXml, parseTableXml } from '../src/formatter.js';

const TMP_DIR = path.join(__dirname, '__tmp_extract_styles__');

function tmpPath(name: string): string {
  return path.join(TMP_DIR, name);
}

beforeAll(() => {
  fs.mkdirSync(TMP_DIR, { recursive: true });
});

afterAll(() => {
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
});

describe('formatter reverse parsing', () => {
  it('parseTableXml joins multiple hp:t text nodes in a cell', () => {
    const tableXml = `
<hp:tbl id="1" rowCnt="1" colCnt="1" borderFillIDRef="1">
  <hp:sz width="10000"/>
  <hp:tr>
    <hp:tc borderFillIDRef="1">
      <hp:subList>
        <hp:p id="10" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
          <hp:run charPrIDRef="0"><hp:t>첫</hp:t></hp:run>
          <hp:run charPrIDRef="0"><hp:t>째</hp:t></hp:run>
        </hp:p>
      </hp:subList>
      <hp:cellAddr colAddr="0" rowAddr="0"/>
      <hp:cellSpan colSpan="1" rowSpan="1"/>
      <hp:cellSz width="10000" height="1000"/>
    </hp:tc>
  </hp:tr>
</hp:tbl>`;

    const parsed = parseTableXml(tableXml);
    expect(parsed.rows[0][0].text).toBe('첫째');
  });

  it('parseBorderFillXml extracts side border properties and fill color', () => {
    const borderFillXml = `
<hh:borderFill id="7" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">
  <hh:leftBorder type="SOLID" width="0.12 mm" color="#111111"/>
  <hh:rightBorder type="DOTTED" width="0.2 mm" color="#222222"/>
  <hh:topBorder type="DASHED" width="0.3 mm" color="#333333"/>
  <hh:bottomBorder type="NONE" width="0.12 mm" color="#444444"/>
  <hh:fillBrush>
    <hh:windowBrush faceColor="#EEEEEE" hatchColor="none" alpha="0"/>
  </hh:fillBrush>
</hh:borderFill>`;

    const parsed = parseBorderFillXml(borderFillXml);
    expect(parsed.id).toBe(7);
    expect(parsed.backgroundColor).toBe('#EEEEEE');
    expect(parsed.top.type).toBe('DASHED');
    expect(parsed.right.color).toBe('#222222');
  });
});

describe('hwpxExtractStyles', () => {
  it('returns style profile JSON with layout and header/footer', async () => {
    const hwpxPath = tmpPath('style-profile.hwpx');
    const create = await hwpxCreateDocument({
      output_path: hwpxPath,
      title: '스타일 추출 테스트',
      margin: { top: 25, bottom: 25, left: 20, right: 20 },
      header: { text: '상단', autoPageNum: true },
      footer: { text: '하단', autoTotalPages: true },
      content: [
        {
          paragraph: {
            text: '본문 텍스트',
            bold: true,
            underline: true,
            color: '#0055AA',
            fontSize: 13,
            alignment: 'CENTER',
            lineSpacing: 160,
            spacing: { before: 100, after: 200 },
          },
        },
      ],
    });
    expect(create.success).toBe(true);

    const extracted = await hwpxExtractStyles({ path: hwpxPath });
    expect(extracted.success).toBe(true);

    const profile = JSON.parse(extracted.output) as Record<string, any>;
    expect(profile.metadata?.title).toBe('스타일 추출 테스트');
    expect(Array.isArray(profile.fonts)).toBe(true);
    expect(profile.fonts.length).toBeGreaterThan(0);
    expect(Array.isArray(profile.charProperties)).toBe(true);
    expect(profile.charProperties.length).toBeGreaterThan(0);
    expect(Array.isArray(profile.paraProperties)).toBe(true);
    expect(profile.paraProperties.length).toBeGreaterThan(0);
    expect(Array.isArray(profile.borderFills)).toBe(true);
    expect(profile.borderFills.length).toBeGreaterThan(0);
    expect(Array.isArray(profile.styles)).toBe(true);
    expect(profile.styles.length).toBeGreaterThan(0);
    expect(Array.isArray(profile.effectiveStyles)).toBe(true);
    expect(profile.effectiveStyles.length).toBeGreaterThan(0);
    expect(profile.usage?.paragraphCount).toBeGreaterThan(0);
    expect(profile.usage?.runCount).toBeGreaterThan(0);
    expect(profile.usage?.styleUsage).toBeTruthy();
    expect(profile.pageLayout?.width).toBeGreaterThan(0);
    expect(profile.pageLayout?.margins?.top).toBeGreaterThan(0);
    expect(profile.headerFooter?.header?.text).toContain('상단');
    expect(profile.headerFooter?.footer?.text).toContain('하단');

    const unified = await parseTemplateStyle({ path: hwpxPath });
    expect(unified.success).toBe(true);
  });

  it('returns per-section usage when include_all_sections=true', async () => {
    const hwpxPath = tmpPath('style-profile-sections.hwpx');
    const create = await hwpxCreateDocument({
      output_path: hwpxPath,
      content: [{ paragraph: { text: '섹션 통계' } }],
    });
    expect(create.success).toBe(true);

    const extracted = await hwpxExtractStyles({ path: hwpxPath, include_all_sections: true });
    expect(extracted.success).toBe(true);
    const profile = JSON.parse(extracted.output) as Record<string, any>;
    expect(profile.sectionCount).toBeGreaterThan(0);
    expect(Array.isArray(profile.sections)).toBe(true);
    expect(profile.sections[0]?.usage?.paragraphCount).toBeGreaterThan(0);
  });

  it('parses self-closing subject meta without bleeding into following tags', async () => {
    const hwpxPath = tmpPath('style-profile-subject.hwpx');
    const create = await hwpxCreateDocument({
      output_path: hwpxPath,
      title: '메타 subject 파싱 테스트',
      content: [{ paragraph: { text: '본문' } }],
    });
    expect(create.success).toBe(true);

    const zip = await JSZip.loadAsync(fs.readFileSync(hwpxPath));
    const hpfFile = zip.file('Contents/content.hpf');
    expect(hpfFile).toBeTruthy();
    const hpfXml = await hpfFile!.async('string');

    const patched = hpfXml.replace(
      '<opf:meta name="subject" content="text"/>',
      '<opf:meta name="subject" content="프로젝트 개요"/>',
    );
    zip.file('Contents/content.hpf', patched);
    fs.writeFileSync(hwpxPath, await zip.generateAsync({ type: 'nodebuffer' }));

    const extracted = await hwpxExtractStyles({ path: hwpxPath });
    expect(extracted.success).toBe(true);

    const profile = JSON.parse(extracted.output) as Record<string, any>;
    expect(profile.metadata?.subject).toBe('프로젝트 개요');
    expect(String(profile.metadata?.subject ?? '')).not.toContain('<opf:meta');
  });
});
