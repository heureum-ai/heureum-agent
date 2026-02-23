/**
 * Generate word/styles.xml for DOCX documents.
 * Defines Normal, Heading1-6, ListParagraph, Quote, CodeBlock, TableGrid styles.
 */

import { DOCX_DEFAULTS, ptToHalfPt } from './configs.js';
import { escapeXml } from './template.js';

export interface StylesOptions {
  defaultFont?: string;
  defaultFontSizePt?: number;
}

export function buildStylesXml(opts?: StylesOptions): string {
  const font = opts?.defaultFont ?? DOCX_DEFAULTS.document.fontName;
  const sizePt = opts?.defaultFontSizePt ?? DOCX_DEFAULTS.document.fontSizePt;
  const sizeHp = ptToHalfPt(sizePt);

  const headings = Object.entries(DOCX_DEFAULTS.document.headingSizesPt).map(
    ([level, hPt]) => {
      const hSizeHp = ptToHalfPt(hPt);
      const spaceBefore = level === '1' ? 480 : level === '2' ? 360 : 240;
      const spaceAfter = level === '1' ? 240 : 120;
      return `
  <w:style w:type="paragraph" w:styleId="Heading${level}">
    <w:name w:val="heading ${level}"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:uiPriority w:val="9"/>
    <w:qFormat/>
    <w:pPr>
      <w:keepNext/>
      <w:keepLines/>
      <w:spacing w:before="${spaceBefore}" w:after="${spaceAfter}" w:line="259" w:lineRule="auto"/>
      <w:outlineLvl w:val="${Number(level) - 1}"/>
    </w:pPr>
    <w:rPr>
      <w:b/>
      <w:bCs/>
      <w:sz w:val="${hSizeHp}"/>
      <w:szCs w:val="${hSizeHp}"/>
    </w:rPr>
  </w:style>`;
    },
  );

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
          xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:docDefaults>
    <w:rPrDefault>
      <w:rPr>
        <w:rFonts w:ascii="${escapeXml(font)}" w:eastAsia="${escapeXml(font)}" w:hAnsi="${escapeXml(font)}" w:cs="Times New Roman"/>
        <w:sz w:val="${sizeHp}"/>
        <w:szCs w:val="${sizeHp}"/>
        <w:lang w:val="en-US" w:eastAsia="ko-KR"/>
      </w:rPr>
    </w:rPrDefault>
    <w:pPrDefault>
      <w:pPr>
        <w:spacing w:after="${ptToHalfPt(DOCX_DEFAULTS.paragraph.spacingAfterPt) * 10}" w:line="${Math.round(DOCX_DEFAULTS.paragraph.lineSpacingPercent * 240 / 100)}" w:lineRule="auto"/>
      </w:pPr>
    </w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/>
    <w:qFormat/>
    <w:pPr>
      <w:spacing w:after="${Math.round(DOCX_DEFAULTS.paragraph.spacingAfterPt * 20)}" w:line="${Math.round(DOCX_DEFAULTS.paragraph.lineSpacingPercent * 240 / 100)}" w:lineRule="auto"/>
    </w:pPr>
  </w:style>
  <w:style w:type="character" w:default="1" w:styleId="DefaultParagraphFont">
    <w:name w:val="Default Paragraph Font"/>
    <w:uiPriority w:val="1"/>
    <w:semiHidden/>
    <w:unhideWhenUsed/>
  </w:style>
  <w:style w:type="table" w:default="1" w:styleId="TableNormal">
    <w:name w:val="Normal Table"/>
    <w:uiPriority w:val="99"/>
    <w:semiHidden/>
    <w:unhideWhenUsed/>
    <w:tblPr>
      <w:tblInd w:w="0" w:type="dxa"/>
      <w:tblCellMar>
        <w:top w:w="${DOCX_DEFAULTS.table.cellMarginTop}" w:type="dxa"/>
        <w:left w:w="${DOCX_DEFAULTS.table.cellMarginLeft}" w:type="dxa"/>
        <w:bottom w:w="${DOCX_DEFAULTS.table.cellMarginBottom}" w:type="dxa"/>
        <w:right w:w="${DOCX_DEFAULTS.table.cellMarginRight}" w:type="dxa"/>
      </w:tblCellMar>
    </w:tblPr>
  </w:style>${headings.join('')}
  <w:style w:type="paragraph" w:styleId="ListParagraph">
    <w:name w:val="List Paragraph"/>
    <w:basedOn w:val="Normal"/>
    <w:uiPriority w:val="34"/>
    <w:qFormat/>
    <w:pPr>
      <w:ind w:left="720"/>
    </w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Quote">
    <w:name w:val="Quote"/>
    <w:basedOn w:val="Normal"/>
    <w:next w:val="Normal"/>
    <w:uiPriority w:val="29"/>
    <w:qFormat/>
    <w:pPr>
      <w:pBdr>
        <w:left w:val="single" w:sz="18" w:space="12" w:color="BFBFBF"/>
      </w:pBdr>
      <w:ind w:left="360"/>
      <w:spacing w:before="120" w:after="120"/>
    </w:pPr>
    <w:rPr>
      <w:i/>
      <w:iCs/>
      <w:color w:val="404040"/>
    </w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="CodeBlock">
    <w:name w:val="Code Block"/>
    <w:basedOn w:val="Normal"/>
    <w:uiPriority w:val="99"/>
    <w:pPr>
      <w:pBdr>
        <w:top w:val="single" w:sz="4" w:space="4" w:color="D9D9D9"/>
        <w:left w:val="single" w:sz="4" w:space="4" w:color="D9D9D9"/>
        <w:bottom w:val="single" w:sz="4" w:space="4" w:color="D9D9D9"/>
        <w:right w:val="single" w:sz="4" w:space="4" w:color="D9D9D9"/>
      </w:pBdr>
      <w:shd w:val="clear" w:color="auto" w:fill="F5F5F5"/>
      <w:spacing w:after="0" w:line="240" w:lineRule="auto"/>
    </w:pPr>
    <w:rPr>
      <w:rFonts w:ascii="${DOCX_DEFAULTS.code.fontName}" w:hAnsi="${DOCX_DEFAULTS.code.fontName}" w:cs="${DOCX_DEFAULTS.code.fontName}"/>
      <w:sz w:val="${ptToHalfPt(DOCX_DEFAULTS.code.fontSizePt)}"/>
      <w:szCs w:val="${ptToHalfPt(DOCX_DEFAULTS.code.fontSizePt)}"/>
    </w:rPr>
  </w:style>
  <w:style w:type="table" w:styleId="TableGrid">
    <w:name w:val="Table Grid"/>
    <w:basedOn w:val="TableNormal"/>
    <w:uiPriority w:val="39"/>
    <w:tblPr>
      <w:tblBorders>
        <w:top w:val="single" w:sz="${DOCX_DEFAULTS.table.borderSize}" w:space="0" w:color="${DOCX_DEFAULTS.table.borderColor}"/>
        <w:left w:val="single" w:sz="${DOCX_DEFAULTS.table.borderSize}" w:space="0" w:color="${DOCX_DEFAULTS.table.borderColor}"/>
        <w:bottom w:val="single" w:sz="${DOCX_DEFAULTS.table.borderSize}" w:space="0" w:color="${DOCX_DEFAULTS.table.borderColor}"/>
        <w:right w:val="single" w:sz="${DOCX_DEFAULTS.table.borderSize}" w:space="0" w:color="${DOCX_DEFAULTS.table.borderColor}"/>
        <w:insideH w:val="single" w:sz="${DOCX_DEFAULTS.table.borderSize}" w:space="0" w:color="${DOCX_DEFAULTS.table.borderColor}"/>
        <w:insideV w:val="single" w:sz="${DOCX_DEFAULTS.table.borderSize}" w:space="0" w:color="${DOCX_DEFAULTS.table.borderColor}"/>
      </w:tblBorders>
    </w:tblPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Header">
    <w:name w:val="header"/>
    <w:basedOn w:val="Normal"/>
    <w:uiPriority w:val="99"/>
    <w:unhideWhenUsed/>
    <w:pPr>
      <w:tabs>
        <w:tab w:val="center" w:pos="4513"/>
        <w:tab w:val="right" w:pos="9026"/>
      </w:tabs>
      <w:spacing w:after="0" w:line="240" w:lineRule="auto"/>
    </w:pPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="Footer">
    <w:name w:val="footer"/>
    <w:basedOn w:val="Normal"/>
    <w:uiPriority w:val="99"/>
    <w:unhideWhenUsed/>
    <w:pPr>
      <w:tabs>
        <w:tab w:val="center" w:pos="4513"/>
        <w:tab w:val="right" w:pos="9026"/>
      </w:tabs>
      <w:spacing w:after="0" w:line="240" w:lineRule="auto"/>
    </w:pPr>
  </w:style>
</w:styles>`;
}
