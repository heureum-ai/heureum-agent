import { describe, expect, it } from 'vitest';
import { buildHwpxStyleExtractionPrompt, buildHwpxStyleGuidePrompt } from '../src/prompt.js';
import type { ExtractedStyles } from '../src/types.js';
import { HWPX_DEFAULTS } from '../src/configs.js';

describe('buildHwpxStyleGuidePrompt', () => {
  it('builds style guide prompt from sparse ExtractedStyles', () => {
    const styles: ExtractedStyles = {
      metadata: { title: '샘플 문서', language: 'ko' },
      fonts: [{ id: 0, face: '맑은 고딕' }],
      charProperties: [{ id: 0, fontRef: 0, fontSize: 10, textColor: '#000000' }],
      paraProperties: [{ id: 0, alignment: 'JUSTIFY', lineSpacing: 130 }],
      styles: [{ id: 0, name: 'Normal', paraPrIDRef: 0, charPrIDRef: 0 }],
      pageLayout: {
        width: 59528,
        height: 84189,
        margins: { top: 8504, bottom: 8504, left: 7086, right: 7086 },
      },
      usage: {
        paragraphCount: 12,
        runCount: 30,
        tableCount: 2,
        styleUsage: { 0: 12 },
        paraPrUsage: { 0: 12 },
        charPrUsage: { 0: 30 },
      },
    };

    const prompt = buildHwpxStyleGuidePrompt(styles);
    expect(prompt).toContain('[STYLE SYSTEM] HWPX 문서 서식 가이드');
    expect(prompt).toContain('샘플 문서');
    expect(prompt).toContain('## 2. 페이지 설정');
    expect(prompt).toContain('## 9. hwpx_create_document 호출 골격');
    expect(prompt).toContain('"font": "맑은 고딕"');
  });

  it('adds section summary for multi-section profile', () => {
    const styles: ExtractedStyles = {
      styles: [{ id: 0, name: 'Normal' }],
      effectiveStyles: [{ id: 0, name: 'Normal' }],
      sections: [
        { sectionPath: 'Contents/section0.xml', usage: { paragraphCount: 3, runCount: 5, tableCount: 0 } },
        { sectionPath: 'Contents/section1.xml', usage: { paragraphCount: 2, runCount: 4, tableCount: 1 } },
      ],
      sectionCount: 2,
    };

    const prompt = buildHwpxStyleGuidePrompt(styles);
    expect(prompt).toContain('## 8. 섹션별 요약');
    expect(prompt).toContain('Contents/section0.xml');
    expect(prompt).toContain('## 10. hwpx_create_document 호출 골격');
  });

  it('includes markdown structure and tone summary when markdownContent exists', () => {
    const styles: ExtractedStyles = {
      markdownSource: 'hwpx_read_markdown',
      markdownContent: [
        '<p style="text-align: center"><span style="font-weight:700"># 제목</span></p>',
        '',
        '<span style="font-family: 바탕">이 문서는 시범 문서입니다.</span>',
        '관련 사항을 안내합니다.',
        '',
        '- 항목 1',
        '- 항목 2',
      ].join('\n'),
    };

    const prompt = buildHwpxStyleGuidePrompt(styles);
    expect(prompt).toContain('원문 문단 구조/문장 톤 요약');
    expect(prompt).toContain('우세한 종결 어미 톤');
    expect(prompt).toContain('변환 경로: hwpx_read_markdown');
    expect(prompt).toContain('참조 문서 텍스트(마크다운 추출)');
    expect(prompt).toContain('이 문서는 시범 문서입니다.');
    expect(prompt).not.toContain('<span');
    expect(prompt).not.toContain('<p style=');
  });

  it('uses config-managed default reference path for style extraction prompt', () => {
    const prompt = buildHwpxStyleExtractionPrompt();
    expect(prompt).toContain(HWPX_DEFAULTS.prompts.styleGuideReferencePath);
    expect(prompt).toContain('parseTemplateStyle');
  });
});
