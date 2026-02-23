/**
 * Generates header.xml for HWPX documents.
 * Contains fontfaces, charProperties, paraProperties, borderFills, tabProperties, and styles.
 *
 * Default values based on: 행정업무의 효율적 운영에 관한 규정 시행규칙 (행정안전부령 제264호)
 * https://www.law.go.kr/LSW/lsInfoP.do?lsId=007319
 */

import { HWPX_DEFAULTS } from './configs.js';
import { COMMON_NS } from './template.js';
import type { ExtractedStyles } from './types.js';

/**
 * charPr ID mapping:
 *  #0  - Body text (12pt, 함초롬돋움)
 *  #1  - Bold (12pt, bold)
 *  #2  - Italic (12pt, italic)
 *  #3  - Bold+Italic (12pt)
 *  #4  - H1 (22pt, bold)
 *  #5  - H2 (16pt, bold)
 *  #6  - H3 (14pt, bold)
 *  #7  - H4 (13pt, bold)
 *  #8  - H5 (12pt, bold)
 *  #9  - H6 (12pt, bold)
 *  #10 - Code (10pt, monospace)
 *  #11 - Blockquote (12pt, italic)
 */

interface CharPrDef {
  id: number;
  height: number;  // 1/100 pt (1000 = 10pt)
  bold?: boolean;
  italic?: boolean;
  fontRef?: number; // font id reference (0=함초롬돋움, 1=monospace)
}

const CHAR_PR_DEFS: CharPrDef[] = [
  { id: 0,  height: 1200 },                       // body (12pt)
  { id: 1,  height: 1200, bold: true },            // bold
  { id: 2,  height: 1200, italic: true },          // italic
  { id: 3,  height: 1200, bold: true, italic: true }, // bold+italic
  { id: 4,  height: 2200, bold: true },            // H1 (22pt)
  { id: 5,  height: 1600, bold: true },            // H2 (16pt)
  { id: 6,  height: 1400, bold: true },            // H3 (14pt)
  { id: 7,  height: 1300, bold: true },            // H4 (13pt)
  { id: 8,  height: 1200, bold: true },            // H5 (12pt)
  { id: 9,  height: 1200, bold: true },            // H6 (12pt)
  { id: 10, height: 1000, fontRef: 1 },            // code (10pt)
  { id: 11, height: 1200, italic: true },          // blockquote (12pt)
];

function buildFontfaces(): string {
  // Minimal fontface set: one font per language category
  const langs = ['HANGUL', 'LATIN', 'HANJA', 'JAPANESE', 'OTHER', 'SYMBOL', 'USER'];
  let xml = `    <hh:fontfaces itemCnt="${langs.length}">\n`;

  for (const lang of langs) {
    xml += `      <hh:fontface lang="${lang}" fontCnt="2">\n`;
    // id=0: 함초롬돋움 (default)
    xml += `        <hh:font id="0" face="함초롬돋움" type="TTF" isEmbedded="0">\n`;
    xml += `          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>\n`;
    xml += `        </hh:font>\n`;
    // id=1: monospace for code
    xml += `        <hh:font id="1" face="돋움" type="TTF" isEmbedded="0">\n`;
    xml += `          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="0" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>\n`;
    xml += `        </hh:font>\n`;
    xml += `      </hh:fontface>\n`;
  }

  xml += `    </hh:fontfaces>`;
  return xml;
}

function buildCharPr(def: CharPrDef): string {
  const fontId = def.fontRef ?? 0;
  const bold = def.bold ? ' bold="1"' : '';
  const italic = def.italic ? ' italic="1"' : '';

  return `      <hh:charPr id="${def.id}" height="${def.height}" textColor="#000000" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="2"${bold}${italic}>
        <hh:fontRef hangul="${fontId}" latin="${fontId}" hanja="${fontId}" japanese="${fontId}" other="${fontId}" symbol="${fontId}" user="${fontId}"/>
        <hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
      </hh:charPr>`;
}

function buildCharProperties(): string {
  let xml = `    <hh:charProperties itemCnt="${CHAR_PR_DEFS.length}">\n`;
  for (const def of CHAR_PR_DEFS) {
    xml += buildCharPr(def) + '\n';
  }
  xml += `    </hh:charProperties>`;
  return xml;
}

function buildTabProperties(): string {
  return `    <hh:tabProperties itemCnt="1">
      <hh:tabPr id="0" autoTabLeft="0" autoTabRight="0"/>
    </hh:tabProperties>`;
}

function buildParaMarginBlock(indent: number, left: number, right: number, prev: number, next: number, lsType: string, lsValue: number): string {
  return `<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"><hh:margin><hc:intent value="${indent}" unit="HWPUNIT"/><hc:left value="${left}" unit="HWPUNIT"/><hc:right value="${right}" unit="HWPUNIT"/><hc:prev value="${prev}" unit="HWPUNIT"/><hc:next value="${next}" unit="HWPUNIT"/></hh:margin><hh:lineSpacing type="${lsType}" value="${lsValue}" unit="HWPUNIT"/></hp:case><hp:default><hh:margin><hc:intent value="${indent}" unit="HWPUNIT"/><hc:left value="${left}" unit="HWPUNIT"/><hc:right value="${right}" unit="HWPUNIT"/><hc:prev value="${prev}" unit="HWPUNIT"/><hc:next value="${next}" unit="HWPUNIT"/></hh:margin><hh:lineSpacing type="${lsType}" value="${lsValue}" unit="HWPUNIT"/></hp:default></hp:switch>`;
}

/**
 * paraPr ID mapping:
 *  #0 - Body text (JUSTIFY, lineSpacing 130%, no extra spacing)
 *  #1 - H1 (spaceBefore=800, spaceAfter=400)
 *  #2 - H2 (spaceBefore=600, spaceAfter=300)
 *  #3 - H3 (spaceBefore=400, spaceAfter=200)
 *  #4 - H4 (spaceBefore=300, spaceAfter=150)
 *  #5 - H5 (spaceBefore=200, spaceAfter=100)
 *  #6 - H6 (spaceBefore=200, spaceAfter=100)
 */

interface ParaPrDef {
  id: number;
  spaceBefore: number;
  spaceAfter: number;
}

const HEADING_PARA_PR_DEFS: ParaPrDef[] = [
  { id: 1, spaceBefore: 800, spaceAfter: 400 },  // H1
  { id: 2, spaceBefore: 600, spaceAfter: 300 },  // H2
  { id: 3, spaceBefore: 400, spaceAfter: 200 },  // H3
  { id: 4, spaceBefore: 300, spaceAfter: 150 },  // H4
  { id: 5, spaceBefore: 200, spaceAfter: 100 },  // H5
  { id: 6, spaceBefore: 200, spaceAfter: 100 },  // H6
];

function buildParaPr(id: number, prev: number, next: number): string {
  const marginBlock = buildParaMarginBlock(0, 0, 0, prev, next, 'PERCENT', 130);
  return `      <hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">
        <hh:align horizontal="JUSTIFY" vertical="BASELINE"/>
        <hh:heading type="NONE" idRef="0" level="0"/>
        <hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>
        <hh:autoSpacing eAsianEng="0" eAsianNum="0"/>
        ${marginBlock}
        <hh:border borderFillIDRef="2" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/>
      </hh:paraPr>`;
}

function buildParaProperties(): string {
  const totalCount = 1 + HEADING_PARA_PR_DEFS.length; // body + H1-H6
  const bodyMarginBlock = buildParaMarginBlock(0, 0, 0, 0, 0, 'PERCENT', 130);
  let xml = `    <hh:paraProperties itemCnt="${totalCount}">\n`;
  // id=0: body
  xml += `      <hh:paraPr id="0" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">
        <hh:align horizontal="JUSTIFY" vertical="BASELINE"/>
        <hh:heading type="NONE" idRef="0" level="0"/>
        <hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="0" lineWrap="BREAK"/>
        <hh:autoSpacing eAsianEng="0" eAsianNum="0"/>
        ${bodyMarginBlock}
        <hh:border borderFillIDRef="2" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/>
      </hh:paraPr>\n`;
  // id=1~6: headings
  for (const def of HEADING_PARA_PR_DEFS) {
    xml += buildParaPr(def.id, def.spaceBefore, def.spaceAfter) + '\n';
  }
  xml += `    </hh:paraProperties>`;
  return xml;
}

function buildBorderFills(): string {
  return `    <hh:borderFills itemCnt="2">
      <hh:borderFill id="1" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">
        <hh:slash type="NONE" crooked="0" isCounter="0"/>
        <hh:backSlash type="NONE" crooked="0" isCounter="0"/>
        <hh:leftBorder type="NONE" width="${HWPX_DEFAULTS.border.width}" color="${HWPX_DEFAULTS.border.color}"/>
        <hh:rightBorder type="NONE" width="${HWPX_DEFAULTS.border.width}" color="${HWPX_DEFAULTS.border.color}"/>
        <hh:topBorder type="NONE" width="${HWPX_DEFAULTS.border.width}" color="${HWPX_DEFAULTS.border.color}"/>
        <hh:bottomBorder type="NONE" width="${HWPX_DEFAULTS.border.width}" color="${HWPX_DEFAULTS.border.color}"/>
        <hh:diagonal type="NONE" width="${HWPX_DEFAULTS.border.width}" color="${HWPX_DEFAULTS.border.color}"/>
      </hh:borderFill>
      <hh:borderFill id="2" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">
        <hh:slash type="NONE" crooked="0" isCounter="0"/>
        <hh:backSlash type="NONE" crooked="0" isCounter="0"/>
        <hh:leftBorder type="NONE" width="${HWPX_DEFAULTS.border.width}" color="${HWPX_DEFAULTS.border.color}"/>
        <hh:rightBorder type="NONE" width="${HWPX_DEFAULTS.border.width}" color="${HWPX_DEFAULTS.border.color}"/>
        <hh:topBorder type="NONE" width="${HWPX_DEFAULTS.border.width}" color="${HWPX_DEFAULTS.border.color}"/>
        <hh:bottomBorder type="NONE" width="${HWPX_DEFAULTS.border.width}" color="${HWPX_DEFAULTS.border.color}"/>
        <hh:diagonal type="NONE" width="${HWPX_DEFAULTS.border.width}" color="${HWPX_DEFAULTS.border.color}"/>
      </hh:borderFill>
    </hh:borderFills>`;
}

function buildStyles(): string {
  return `    <hh:styles itemCnt="14">
      <hh:style id="0" type="PARA" name="바탕글" engName="Normal" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="0" langID="1042" lockForm="0"/>
      <hh:style id="1" type="PARA" name="본문" engName="Body" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="1" langID="1042" lockForm="0"/>
      <hh:style id="2" type="PARA" name="개요 1" engName="Outline 1" paraPrIDRef="1" charPrIDRef="0" nextStyleIDRef="2" langID="1042" lockForm="0"/>
      <hh:style id="3" type="PARA" name="개요 2" engName="Outline 2" paraPrIDRef="2" charPrIDRef="0" nextStyleIDRef="3" langID="1042" lockForm="0"/>
      <hh:style id="4" type="PARA" name="개요 3" engName="Outline 3" paraPrIDRef="3" charPrIDRef="0" nextStyleIDRef="4" langID="1042" lockForm="0"/>
      <hh:style id="5" type="PARA" name="개요 4" engName="Outline 4" paraPrIDRef="4" charPrIDRef="0" nextStyleIDRef="5" langID="1042" lockForm="0"/>
      <hh:style id="6" type="PARA" name="개요 5" engName="Outline 5" paraPrIDRef="5" charPrIDRef="0" nextStyleIDRef="6" langID="1042" lockForm="0"/>
      <hh:style id="7" type="PARA" name="개요 6" engName="Outline 6" paraPrIDRef="6" charPrIDRef="0" nextStyleIDRef="7" langID="1042" lockForm="0"/>
      <hh:style id="8" type="PARA" name="개요 7" engName="Outline 7" paraPrIDRef="6" charPrIDRef="0" nextStyleIDRef="8" langID="1042" lockForm="0"/>
      <hh:style id="9" type="PARA" name="쪽 번호" engName="Page Number" paraPrIDRef="0" charPrIDRef="1" nextStyleIDRef="9" langID="1042" lockForm="0"/>
      <hh:style id="10" type="PARA" name="머리말" engName="Header" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="10" langID="1042" lockForm="0"/>
      <hh:style id="11" type="PARA" name="각주" engName="Footnote" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="11" langID="1042" lockForm="0"/>
      <hh:style id="12" type="PARA" name="미주" engName="Endnote" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="12" langID="1042" lockForm="0"/>
      <hh:style id="13" type="PARA" name="메모" engName="Memo" paraPrIDRef="0" charPrIDRef="0" nextStyleIDRef="13" langID="1042" lockForm="0"/>
    </hh:styles>`;
}

export function buildHeaderXml(sectionCount: number = 1, styles?: ExtractedStyles): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>
<hh:head ${COMMON_NS}
         version="1.4" secCnt="${sectionCount}">
  <hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/>
  <hh:refList>
${buildFontfaces()}
${buildBorderFills()}
${buildCharProperties()}
${buildTabProperties()}
${buildParaProperties()}
${buildStyles()}
  </hh:refList>
  <hh:compatibleDocument targetProgram="HWP201X"/>
  <hh:docOption>
    <hh:linkinfo path="" pageInherit="0" footNoteShapeInherit="0"/>
  </hh:docOption>
  <hh:trackchageConfig flags="0"/>
</hh:head>`;
}
