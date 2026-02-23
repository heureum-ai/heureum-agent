/**
 * Safe XML template builders for charPr, paraPr, borderFill, and table structures.
 * Agents pass simple typed parameters; all XML generation is handled internally.
 */

import { escapeXml } from './template.js';
import { HWPX_DEFAULTS, HWPX_PAGE_SIZES, HWPUNIT_PER_MM } from './configs.js';

// ── Unit conversion ─────────────────────────────────────

/**
 * Well-known HWPUNIT values used in standard page sizes / margins.
 * When a mm→HWPUNIT conversion lands within ±SNAP_TOLERANCE of one
 * of these values, snap to the canonical constant so that viewers
 * (Polaris Office, 한컴오피스 등) recognise the standard page layout.
 */
const SNAP_TOLERANCE = 10;
const SNAP_TARGETS: number[] = [
  // page sizes
  ...Object.values(HWPX_PAGE_SIZES).flatMap(s => [s.width, s.height]),
  // default margins
  HWPX_DEFAULTS.page.marginTop,
  HWPX_DEFAULTS.page.marginBottom,
  HWPX_DEFAULTS.page.marginLeft,
  HWPX_DEFAULTS.page.marginRight,
  HWPX_DEFAULTS.page.marginHeader,
  HWPX_DEFAULTS.page.marginFooter,
];

export function mmToHwpUnit(mm: number): number {
  const raw = Math.round(mm * HWPUNIT_PER_MM);
  for (const target of SNAP_TARGETS) {
    if (Math.abs(raw - target) <= SNAP_TOLERANCE) return target;
  }
  return raw;
}

export function hwpUnitToMm(hu: number): number {
  return Number((hu / HWPUNIT_PER_MM).toFixed(1));
}

// ── CharPr builder ──────────────────────────────────────

export interface CharFormatOptions {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fontSize?: number;    // pt (12 → height=1200)
  textColor?: string;   // "#RRGGBB"
  fontRef?: number;     // 0=함초롬돋움, 1=돋움(monospace)
}

export function buildCharPrXml(id: number, opts: CharFormatOptions): string {
  const height = opts.fontSize
    ? Math.round(opts.fontSize * 100)
    : Math.round(HWPX_DEFAULTS.document.fontSizePt * 100);
  const textColor = opts.textColor ?? '#000000';
  const fontId = opts.fontRef ?? 0;
  const bold = opts.bold ? ' bold="1"' : '';
  const italic = opts.italic ? ' italic="1"' : '';
  const underline = opts.underline ? ' underline="1"' : '';

  return `      <hh:charPr id="${id}" height="${height}" textColor="${textColor}" shadeColor="none" useFontSpace="0" useKerning="0" symMark="NONE" borderFillIDRef="2"${bold}${italic}${underline}>
        <hh:fontRef hangul="${fontId}" latin="${fontId}" hanja="${fontId}" japanese="${fontId}" other="${fontId}" symbol="${fontId}" user="${fontId}"/>
        <hh:ratio hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:spacing hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
        <hh:relSz hangul="100" latin="100" hanja="100" japanese="100" other="100" symbol="100" user="100"/>
        <hh:offset hangul="0" latin="0" hanja="0" japanese="0" other="0" symbol="0" user="0"/>
      </hh:charPr>`;
}

/** Parse an existing charPr element to extract CharFormatOptions */
export function parseCharPrXml(charPrXml: string): CharFormatOptions {
  const opts: CharFormatOptions = {};

  const heightMatch = charPrXml.match(/height="(\d+)"/);
  if (heightMatch) opts.fontSize = Number(heightMatch[1]) / 100;

  const colorMatch = charPrXml.match(/textColor="(#[0-9A-Fa-f]{6})"/);
  if (colorMatch) opts.textColor = colorMatch[1];

  if (/\bbold="1"/.test(charPrXml)) opts.bold = true;
  if (/\bitalic="1"/.test(charPrXml)) opts.italic = true;
  if (/\bunderline="1"/.test(charPrXml)) opts.underline = true;

  const fontRefMatch = charPrXml.match(/<hh:fontRef\s+hangul="(\d+)"/);
  if (fontRefMatch) opts.fontRef = Number(fontRefMatch[1]);

  return opts;
}

/** Resolve charPr inheritance: base charPr attributes + overRides */
export function resolveCharFormat(
  headerXml: string,
  baseCharPrId: number,
  overRides: CharFormatOptions,
): CharFormatOptions {
  // Find the base charPr element
  const charPrRe = new RegExp(
    `<hh:charPr\\s+id="${baseCharPrId}"[\\s\\S]*?</hh:charPr>`,
  );
  const match = headerXml.match(charPrRe);

  let base: CharFormatOptions = {
    fontSize: HWPX_DEFAULTS.document.fontSizePt,
    textColor: '#000000',
    fontRef: 0,
  };

  if (match) {
    base = parseCharPrXml(match[0]);
  }

  return { ...base, ...stripUndefined(overRides) };
}

/** Add a charPr to header.xml, returning the new id. Reuses existing if identical. */
export function addCharPrToHeader(
  headerXml: string,
  opts: CharFormatOptions,
): { xml: string; id: number } {
  // Find all existing charPr entries
  const charPrEntries = [...headerXml.matchAll(/<hh:charPr\s+id="(\d+)"[\s\S]*?<\/hh:charPr>/g)];

  // Check if an identical charPr already exists
  for (const entry of charPrEntries) {
    const existing = parseCharPrXml(entry[0]);
    if (charFormatEquals(existing, opts)) {
      return { xml: headerXml, id: Number(entry[1]) };
    }
  }

  // Find max id
  let maxId = 0;
  for (const entry of charPrEntries) {
    const id = Number(entry[1]);
    if (id > maxId) maxId = id;
  }
  const newId = maxId + 1;

  // Build new charPr XML
  const newCharPr = buildCharPrXml(newId, opts);

  // Insert before </hh:charProperties> and update itemCnt
  let xml = headerXml.replace(
    /(\s*)<\/hh:charProperties>/,
    `\n${newCharPr}\n$1</hh:charProperties>`,
  );

  // Update itemCnt
  xml = xml.replace(
    /<hh:charProperties\s+itemCnt="(\d+)">/,
    (_m, cnt) => `<hh:charProperties itemCnt="${Number(cnt) + 1}">`,
  );

  return { xml, id: newId };
}

function charFormatEquals(a: CharFormatOptions, b: CharFormatOptions): boolean {
  return (
    (a.bold ?? false) === (b.bold ?? false) &&
    (a.italic ?? false) === (b.italic ?? false) &&
    (a.underline ?? false) === (b.underline ?? false) &&
    (a.fontSize ?? HWPX_DEFAULTS.document.fontSizePt) === (b.fontSize ?? HWPX_DEFAULTS.document.fontSizePt) &&
    (a.textColor ?? '#000000') === (b.textColor ?? '#000000') &&
    (a.fontRef ?? 0) === (b.fontRef ?? 0)
  );
}

// ── ParaPr builder ──────────────────────────────────────

export interface ParaFormatOptions {
  alignment?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFY';
  lineSpacingType?: 'PERCENT' | 'FIXED';
  lineSpacingValue?: number;
  indent?: number;
  marginLeft?: number;
  marginRight?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  pageBreakBefore?: boolean;
  headingType?: 'NONE' | 'OUTLINE';
  headingLevel?: number;
}

function buildParaMarginBlock(indent: number, left: number, right: number, prev: number, next: number, lsType: string, lsValue: number): string {
  return `<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar"><hh:margin><hc:intent value="${indent}" unit="HWPUNIT"/><hc:left value="${left}" unit="HWPUNIT"/><hc:right value="${right}" unit="HWPUNIT"/><hc:prev value="${prev}" unit="HWPUNIT"/><hc:next value="${next}" unit="HWPUNIT"/></hh:margin><hh:lineSpacing type="${lsType}" value="${lsValue}" unit="HWPUNIT"/></hp:case><hp:default><hh:margin><hc:intent value="${indent}" unit="HWPUNIT"/><hc:left value="${left}" unit="HWPUNIT"/><hc:right value="${right}" unit="HWPUNIT"/><hc:prev value="${prev}" unit="HWPUNIT"/><hc:next value="${next}" unit="HWPUNIT"/></hh:margin><hh:lineSpacing type="${lsType}" value="${lsValue}" unit="HWPUNIT"/></hp:default></hp:switch>`;
}

export function buildParaPrXml(id: number, opts: ParaFormatOptions): string {
  const align = opts.alignment ?? HWPX_DEFAULTS.paragraph.alignment;
  const lsType = opts.lineSpacingType ?? HWPX_DEFAULTS.paragraph.lineSpacingType;
  const lsValue = opts.lineSpacingValue ?? HWPX_DEFAULTS.paragraph.lineSpacingValue;
  const indent = opts.indent ?? 0;
  const mLeft = opts.marginLeft ?? 0;
  const mRight = opts.marginRight ?? 0;
  const prev = opts.spaceBefore ?? 0;
  const next = opts.spaceAfter ?? 0;
  const pbBefore = opts.pageBreakBefore ? '1' : '0';
  const headingType = opts.headingType ?? 'NONE';
  const headingLevel = opts.headingLevel ?? 0;

  const marginBlock = buildParaMarginBlock(indent, mLeft, mRight, prev, next, lsType, lsValue);

  return `      <hh:paraPr id="${id}" tabPrIDRef="0" condense="0" fontLineHeight="0" snapToGrid="1" suppressLineNumbers="0" checked="0">
        <hh:align horizontal="${align}" vertical="BASELINE"/>
        <hh:heading type="${headingType}" idRef="0" level="${headingLevel}"/>
        <hh:breakSetting breakLatinWord="KEEP_WORD" breakNonLatinWord="KEEP_WORD" widowOrphan="0" keepWithNext="0" keepLines="0" pageBreakBefore="${pbBefore}" lineWrap="BREAK"/>
        <hh:autoSpacing eAsianEng="0" eAsianNum="0"/>
        ${marginBlock}
        <hh:border borderFillIDRef="2" offsetLeft="0" offsetRight="0" offsetTop="0" offsetBottom="0" connect="0" ignoreMargin="0"/>
      </hh:paraPr>`;
}

function parseParaPrXml(paraPrXml: string): ParaFormatOptions {
  const opts: ParaFormatOptions = {};

  const alignMatch = paraPrXml.match(/horizontal="(LEFT|CENTER|RIGHT|JUSTIFY)"/);
  if (alignMatch) opts.alignment = alignMatch[1] as ParaFormatOptions['alignment'];

  const lsTypeMatch = paraPrXml.match(/<hh:lineSpacing\s+[^>]*type="(PERCENT|FIXED)"/);
  if (lsTypeMatch) opts.lineSpacingType = lsTypeMatch[1] as 'PERCENT' | 'FIXED';

  const lsValueMatch = paraPrXml.match(/<hh:lineSpacing\s+[^>]*value="(\d+)"/);
  if (lsValueMatch) opts.lineSpacingValue = Number(lsValueMatch[1]);

  const pbMatch = paraPrXml.match(/pageBreakBefore="([01])"/);
  if (pbMatch && pbMatch[1] === '1') opts.pageBreakBefore = true;
  const headingTypeMatch = paraPrXml.match(/<hh:heading\s+[^>]*type="(NONE|OUTLINE)"/);
  if (headingTypeMatch) opts.headingType = headingTypeMatch[1] as 'NONE' | 'OUTLINE';
  const headingLevelMatch = paraPrXml.match(/<hh:heading\s+[^>]*level="(-?\d+)"/);
  if (headingLevelMatch) opts.headingLevel = Number(headingLevelMatch[1]);

  // New format: <hc:intent value="0">, <hc:left value="0">, etc.
  const intentMatch = paraPrXml.match(/<hc:intent\s+value="(-?\d+)"/);
  const leftMatch = paraPrXml.match(/<hc:left\s+value="(-?\d+)"/);
  const rightMatch = paraPrXml.match(/<hc:right\s+value="(-?\d+)"/);
  const prevMatch = paraPrXml.match(/<hc:prev\s+value="(-?\d+)"/);
  const nextMatch = paraPrXml.match(/<hc:next\s+value="(-?\d+)"/);

  if (intentMatch || leftMatch || rightMatch || prevMatch || nextMatch) {
    opts.indent = Number(intentMatch?.[1] ?? 0);
    opts.marginLeft = Number(leftMatch?.[1] ?? 0);
    opts.marginRight = Number(rightMatch?.[1] ?? 0);
    opts.spaceBefore = Number(prevMatch?.[1] ?? 0);
    opts.spaceAfter = Number(nextMatch?.[1] ?? 0);
  } else {
    // Legacy format: <hh:margin indent="0" left="0" right="0" prev="0" next="0">
    const marginMatch = paraPrXml.match(
      /<hh:margin\s+indent="(-?\d+)"\s+left="(-?\d+)"\s+right="(-?\d+)"\s+prev="(-?\d+)"\s+next="(-?\d+)"/,
    );
    if (marginMatch) {
      opts.indent = Number(marginMatch[1]);
      opts.marginLeft = Number(marginMatch[2]);
      opts.marginRight = Number(marginMatch[3]);
      opts.spaceBefore = Number(marginMatch[4]);
      opts.spaceAfter = Number(marginMatch[5]);
    }
  }

  return opts;
}

function paraFormatEquals(a: ParaFormatOptions, b: ParaFormatOptions): boolean {
  return (
    (a.alignment ?? HWPX_DEFAULTS.paragraph.alignment) === (b.alignment ?? HWPX_DEFAULTS.paragraph.alignment) &&
    (a.lineSpacingType ?? HWPX_DEFAULTS.paragraph.lineSpacingType) === (b.lineSpacingType ?? HWPX_DEFAULTS.paragraph.lineSpacingType) &&
    (a.lineSpacingValue ?? HWPX_DEFAULTS.paragraph.lineSpacingValue) === (b.lineSpacingValue ?? HWPX_DEFAULTS.paragraph.lineSpacingValue) &&
    (a.indent ?? 0) === (b.indent ?? 0) &&
    (a.marginLeft ?? 0) === (b.marginLeft ?? 0) &&
    (a.marginRight ?? 0) === (b.marginRight ?? 0) &&
    (a.spaceBefore ?? 0) === (b.spaceBefore ?? 0) &&
    (a.spaceAfter ?? 0) === (b.spaceAfter ?? 0) &&
    (a.pageBreakBefore ?? false) === (b.pageBreakBefore ?? false) &&
    (a.headingType ?? 'NONE') === (b.headingType ?? 'NONE') &&
    (a.headingLevel ?? 0) === (b.headingLevel ?? 0)
  );
}

export function addParaPrToHeader(
  headerXml: string,
  opts: ParaFormatOptions,
): { xml: string; id: number } {
  const paraPrEntries = [...headerXml.matchAll(/<hh:paraPr\s+id="(\d+)"[\s\S]*?<\/hh:paraPr>/g)];

  // Check for existing identical
  for (const entry of paraPrEntries) {
    const existing = parseParaPrXml(entry[0]);
    if (paraFormatEquals(existing, opts)) {
      return { xml: headerXml, id: Number(entry[1]) };
    }
  }

  let maxId = 0;
  for (const entry of paraPrEntries) {
    const id = Number(entry[1]);
    if (id > maxId) maxId = id;
  }
  const newId = maxId + 1;

  const newParaPr = buildParaPrXml(newId, opts);

  let xml = headerXml.replace(
    /(\s*)<\/hh:paraProperties>/,
    `\n${newParaPr}\n$1</hh:paraProperties>`,
  );

  xml = xml.replace(
    /<hh:paraProperties\s+itemCnt="(\d+)">/,
    (_m, cnt) => `<hh:paraProperties itemCnt="${Number(cnt) + 1}">`,
  );

  return { xml, id: newId };
}

// ── BorderFill builder ──────────────────────────────────

export interface BorderFillOptions {
  backgroundColor?: string;
  borderType?: 'NONE' | 'SOLID' | 'DOTTED' | 'DASHED';
  borderWidth?: string;   // "0.12 mm", "0.4 mm"
  borderColor?: string;
  topBorderType?: 'NONE' | 'SOLID' | 'DOTTED' | 'DASHED';
  bottomBorderType?: 'NONE' | 'SOLID' | 'DOTTED' | 'DASHED';
  leftBorderType?: 'NONE' | 'SOLID' | 'DOTTED' | 'DASHED';
  rightBorderType?: 'NONE' | 'SOLID' | 'DOTTED' | 'DASHED';
}

export interface ParsedBorderFill {
  id: number;
  backgroundColor?: string;
  fillColor?: string;
  top: { type?: string; width?: string; color?: string };
  bottom: { type?: string; width?: string; color?: string };
  left: { type?: string; width?: string; color?: string };
  right: { type?: string; width?: string; color?: string };
}

export function buildBorderFillXml(id: number, opts: BorderFillOptions): string {
  const bType = opts.borderType ?? HWPX_DEFAULTS.border.type;
  const bWidth = opts.borderWidth ?? HWPX_DEFAULTS.border.width;
  const bColor = opts.borderColor ?? HWPX_DEFAULTS.border.color;
  const leftType = opts.leftBorderType ?? bType;
  const rightType = opts.rightBorderType ?? bType;
  const topType = opts.topBorderType ?? bType;
  const bottomType = opts.bottomBorderType ?? bType;

  let xml = `      <hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="NONE" breakCellSeparateLine="0">
        <hh:slash type="NONE" crooked="0" isCounter="0"/>
        <hh:backSlash type="NONE" crooked="0" isCounter="0"/>
        <hh:leftBorder type="${leftType}" width="${bWidth}" color="${bColor}"/>
        <hh:rightBorder type="${rightType}" width="${bWidth}" color="${bColor}"/>
        <hh:topBorder type="${topType}" width="${bWidth}" color="${bColor}"/>
        <hh:bottomBorder type="${bottomType}" width="${bWidth}" color="${bColor}"/>
        <hh:diagonal type="NONE" width="${HWPX_DEFAULTS.border.width}" color="${HWPX_DEFAULTS.border.color}"/>`;

  if (opts.backgroundColor) {
    xml += `\n        <hh:fillBrush>
          <hh:windowBrush faceColor="${opts.backgroundColor}" hatchColor="none" alpha="0"/>
        </hh:fillBrush>`;
  }

  xml += `\n      </hh:borderFill>`;
  return xml;
}

export function parseBorderFillXml(borderFillXml: string): ParsedBorderFill {
  const attrs = borderFillXml.match(/<hh:borderFill\b([^>]*)>/)?.[1] ?? '';
  const id = Number(attrs.match(/\bid="(\d+)"/)?.[1] ?? 0);

  const parseSide = (sideTag: string): { type?: string; width?: string; color?: string } => {
    const sideAttrs = borderFillXml.match(new RegExp(`<hh:${sideTag}\\b([^>]*)\\/?>`))?.[1] ?? '';
    const type = sideAttrs.match(/\btype="([^"]+)"/)?.[1];
    const width = sideAttrs.match(/\bwidth="([^"]+)"/)?.[1];
    const color = sideAttrs.match(/\bcolor="([^"]+)"/)?.[1];
    return { type, width, color };
  };

  const backgroundColor = borderFillXml.match(/<hh:windowBrush\b[^>]*\bfaceColor="([^"]+)"/)?.[1];
  const fillColor = borderFillXml.match(/<hh:gradation\b[^>]*\bcolor="([^"]+)"/)?.[1];

  return {
    id,
    backgroundColor,
    fillColor,
    top: parseSide('topBorder'),
    bottom: parseSide('bottomBorder'),
    left: parseSide('leftBorder'),
    right: parseSide('rightBorder'),
  };
}

export function addBorderFillToHeader(
  headerXml: string,
  opts: BorderFillOptions,
): { xml: string; id: number } {
  const bfEntries = [...headerXml.matchAll(/<hh:borderFill\s+id="(\d+)"[\s\S]*?<\/hh:borderFill>/g)];

  let maxId = 0;
  for (const entry of bfEntries) {
    const id = Number(entry[1]);
    if (id > maxId) maxId = id;
  }
  const newId = maxId + 1;

  const newBf = buildBorderFillXml(newId, opts);

  let xml = headerXml.replace(
    /(\s*)<\/hh:borderFills>/,
    `\n${newBf}\n$1</hh:borderFills>`,
  );

  xml = xml.replace(
    /<hh:borderFills\s+itemCnt="(\d+)">/,
    (_m, cnt) => `<hh:borderFills itemCnt="${Number(cnt) + 1}">`,
  );

  return { xml, id: newId };
}

// ── Table parser / builder ──────────────────────────────

export interface ParsedCell {
  text: string;
  charPrIDRef: number;
  colAddr: number;
  rowAddr: number;
  colSpan: number;
  rowSpan: number;
  width: number;
  height: number;
  header: boolean;
  borderFillIDRef: number;
}

export interface ParsedTable {
  id: string;
  rowCnt: number;
  colCnt: number;
  totalWidth: number;
  borderFillIDRef: number;
  rows: ParsedCell[][];
}

export function parseTableXml(tableXml: string): ParsedTable {
  // Extract table-level attributes
  const tblMatch = tableXml.match(/<hp:tbl\s+id="([^"]*)"[^>]*rowCnt="(\d+)"[^>]*colCnt="(\d+)"[^>]*borderFillIDRef="(\d+)"/);
  const id = tblMatch?.[1] ?? '';
  const rowCnt = Number(tblMatch?.[2] ?? 0);
  const colCnt = Number(tblMatch?.[3] ?? 0);
  const borderFillIDRef = Number(tblMatch?.[4] ?? 1);

  const szMatch = tableXml.match(/<hp:sz\s+width="(\d+)"/);
  const totalWidth = Number(szMatch?.[1] ?? HWPX_DEFAULTS.table.totalWidth);

  // Extract rows
  const rows: ParsedCell[][] = [];
  const trBlocks = [...tableXml.matchAll(/<hp:tr>([\s\S]*?)<\/hp:tr>/g)];

  for (const trBlock of trBlocks) {
    const row: ParsedCell[] = [];
    const tcBlocks = [...trBlock[1].matchAll(/<hp:tc\s[\s\S]*?<\/hp:tc>/g)];

    for (const tcBlock of tcBlocks) {
      const tcXml = tcBlock[0];

      // Extract and join all <hp:t> text nodes inside the cell.
      const text = [...tcXml.matchAll(/<hp:t>([\s\S]*?)<\/hp:t>/g)]
        .map((m) => unescapeXmlSimple(m[1]))
        .join('');

      // Extract charPrIDRef
      const charPrMatch = tcXml.match(/charPrIDRef="(\d+)"/);
      const charPrIDRef = Number(charPrMatch?.[1] ?? 0);

      // Extract header
      const headerMatch = tcXml.match(/header="([01])"/);
      const header = headerMatch?.[1] === '1';

      // Extract borderFillIDRef from tc
      const bfMatch = tcXml.match(/<hp:tc[^>]*borderFillIDRef="(\d+)"/);
      const cellBorderFillIDRef = Number(bfMatch?.[1] ?? 1);

      // Extract cellAddr
      const addrMatch = tcXml.match(/<hp:cellAddr\s+colAddr="(\d+)"\s+rowAddr="(\d+)"/);
      const colAddr = Number(addrMatch?.[1] ?? 0);
      const rowAddr = Number(addrMatch?.[2] ?? 0);

      // Extract cellSpan
      const spanMatch = tcXml.match(/<hp:cellSpan\s+colSpan="(\d+)"\s+rowSpan="(\d+)"/);
      const colSpan = Number(spanMatch?.[1] ?? 1);
      const rowSpan = Number(spanMatch?.[2] ?? 1);

      // Extract cellSz
      const cellSzMatch = tcXml.match(/<hp:cellSz\s+width="(\d+)"\s+height="(\d+)"/);
      const width = Number(cellSzMatch?.[1] ?? 0);
      const height = Number(cellSzMatch?.[2] ?? HWPX_DEFAULTS.table.cellHeight);

      row.push({
        text,
        charPrIDRef,
        colAddr,
        rowAddr,
        colSpan,
        rowSpan,
        width,
        height,
        header,
        borderFillIDRef: cellBorderFillIDRef,
      });
    }

    rows.push(row);
  }

  return { id, rowCnt, colCnt, totalWidth, borderFillIDRef, rows };
}

export function buildTableXml(data: ParsedTable, nextId: () => string): string {
  const tblId = nextId();
  let xml = `  <hp:tbl id="${tblId}" numberingType="TABLE" textWrap="${HWPX_DEFAULTS.table.textWrap}" textFlow="${HWPX_DEFAULTS.table.textFlow}" lock="0" pageBreak="CELL" repeatHeader="1" rowCnt="${data.rowCnt}" colCnt="${data.colCnt}" cellSpacing="0" borderFillIDRef="${data.borderFillIDRef}" noAdjust="0">\n`;
  xml += `    <hp:sz width="${data.totalWidth}" widthRelTo="ABSOLUTE" height="0" heightRelTo="ABSOLUTE" protect="0"/>\n`;
  xml += `    <hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>\n`;
  xml += `    <hp:outMargin left="0" right="0" top="0" bottom="0"/>\n`;
  xml += `    <hp:inMargin left="${HWPX_DEFAULTS.table.inMargin.left}" right="${HWPX_DEFAULTS.table.inMargin.right}" top="${HWPX_DEFAULTS.table.inMargin.top}" bottom="${HWPX_DEFAULTS.table.inMargin.bottom}"/>\n`;

  for (const row of data.rows) {
    xml += `    <hp:tr>\n`;
    for (const cell of row) {
      const cellParaId = nextId();
      xml += `      <hp:tc name="" header="${cell.header ? '1' : '0'}" hasMargin="1" protect="0" editable="0" dirty="0" borderFillIDRef="${cell.borderFillIDRef}">\n`;
      xml += `        <hp:subList id="" textDirection="HORIZONTAL" lineWrap="SQUEEZE" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">\n`;
      xml += `          <hp:p id="${cellParaId}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">\n`;
      xml += `            <hp:run charPrIDRef="${cell.charPrIDRef}"><hp:t>${escapeXml(cell.text)}</hp:t></hp:run>\n`;
      xml += `          </hp:p>\n`;
      xml += `        </hp:subList>\n`;
      xml += `        <hp:cellAddr colAddr="${cell.colAddr}" rowAddr="${cell.rowAddr}"/>\n`;
      xml += `        <hp:cellSpan colSpan="${cell.colSpan}" rowSpan="${cell.rowSpan}"/>\n`;
      xml += `        <hp:cellSz width="${cell.width}" height="${cell.height}"/>\n`;
      xml += `        <hp:cellMargin left="0" right="0" top="0" bottom="0"/>\n`;
      xml += `      </hp:tc>\n`;
    }
    xml += `    </hp:tr>\n`;
  }

  xml += `  </hp:tbl>`;
  return xml;
}

// ── Image builder ───────────────────────────────────────

export function buildImagePicXml(
  paraId: string,
  picId: string,
  binItemId: number,
  widthHU: number,
  heightHU: number,
  textWrap: 'TOP_AND_BOTTOM' | 'SQUARE' | 'BEHIND_TEXT' = HWPX_DEFAULTS.image.textWrap,
): string {
  const treatAsChar = textWrap === 'BEHIND_TEXT' ? '0' : '1';
  return `  <hp:p id="${paraId}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
    <hp:run charPrIDRef="0">
      <hp:pic id="${picId}" numberingType="PICTURE" textWrap="${textWrap}" textFlow="BOTH_SIDES" lock="0">
        <hp:sz width="${widthHU}" height="${heightHU}" widthRelTo="ABSOLUTE" heightRelTo="ABSOLUTE" protect="0"/>
        <hp:pos treatAsChar="${treatAsChar}" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>
        <hp:outMargin left="0" right="0" top="0" bottom="0"/>
        <hp:img binaryItemIDRef="${binItemId}" bright="0" contrast="0" effect="REAL_PIC" binaryItemIDRef2="0"/>
      </hp:pic>
    </hp:run>
  </hp:p>`;
}

export function addBinItemToHeader(
  headerXml: string,
  id: number,
  src: string,
  format: string,
): string {
  if (headerXml.includes('<hh:binItems')) {
    let xml = headerXml.replace(
      /(\s*)<\/hh:binItems>/,
      `\n      <hh:binItem id="${id}" src="${src}" format="${format.toUpperCase()}" isEmbedded="1"/>\n$1</hh:binItems>`,
    );
    xml = xml.replace(
      /<hh:binItems\s+itemCnt="(\d+)">/,
      (_m, cnt) => `<hh:binItems itemCnt="${Number(cnt) + 1}">`,
    );
    return xml;
  }
  const binItemsXml = `    <hh:binItems itemCnt="1">\n      <hh:binItem id="${id}" src="${src}" format="${format.toUpperCase()}" isEmbedded="1"/>\n    </hh:binItems>`;
  return headerXml.replace(
    /(\s*)<\/hh:refList>/,
    `\n${binItemsXml}\n$1</hh:refList>`,
  );
}

// ── Header/Footer builder ───────────────────────────────

export function buildHeaderFooterXml(
  type: 'header' | 'footer',
  content: string | HwpxHeaderFooterContent,
  paraId: string,
  alignment: 'LEFT' | 'CENTER' | 'RIGHT' = 'CENTER',
  charPrId: number = 0,
  nextId?: () => string,
): string {
  const tagName = type === 'header' ? 'hp:header' : 'hp:footer';
  const normalized = normalizeHeaderFooterContent(content);
  const idGen = nextId ?? makeLocalIdGenerator(paraId);
  const paraRunsXml = buildHeaderFooterRunsXml(normalized, charPrId);
  const tableXml = normalized.table ? buildHeaderFooterTableXml(normalized.table, charPrId, idGen) : '';
  const paragraphXml = `          <hp:p id="${paraId}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
${paraRunsXml}          </hp:p>`;
  return `      <${tagName} type="BOTH" width="0" height="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">
        <hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="TOP" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">
${paragraphXml}
${tableXml}
        </hp:subList>
      </${tagName}>`;
}

export interface HwpxHeaderFooterTable {
  rows: string[][];
  columnWidths?: number[];
}

export interface HwpxHeaderFooterContent {
  text?: string;
  table?: HwpxHeaderFooterTable;
  autoPageNum?: boolean;
  autoTotalPages?: boolean;
  auto_page_num?: boolean;
  auto_total_pages?: boolean;
}

function normalizeHeaderFooterContent(content: string | HwpxHeaderFooterContent): HwpxHeaderFooterContent {
  if (typeof content === 'string') return { text: content };
  if (!content) return {};
  return {
    ...content,
    autoPageNum: content.autoPageNum ?? content.auto_page_num,
    autoTotalPages: content.autoTotalPages ?? content.auto_total_pages,
  };
}

function makeLocalIdGenerator(startId: string): () => string {
  let current = Number(startId);
  if (!Number.isFinite(current)) current = 0;
  return () => String(++current);
}

function buildHeaderFooterRunsXml(content: HwpxHeaderFooterContent, charPrId: number): string {
  let xml = '';
  if (content.text && content.text.length > 0) {
    xml += buildInlineTextWithAutoNum(content.text, charPrId);
  }
  if (content.autoPageNum) xml += buildAutoNumRunXml(charPrId, 'PAGE');
  if (content.autoTotalPages) xml += buildAutoNumRunXml(charPrId, 'TOTAL_PAGE');
  if (!xml) {
    xml = `            <hp:run charPrIDRef="${charPrId}"><hp:t></hp:t></hp:run>\n`;
  }
  return xml;
}

function buildInlineTextWithAutoNum(text: string, charPrId: number): string {
  const tokenRe = /\{\{(PAGE|TOTAL_PAGE)\}\}/g;
  let xml = '';
  let idx = 0;
  for (const m of text.matchAll(tokenRe)) {
    const start = m.index ?? 0;
    if (start > idx) {
      xml += `            <hp:run charPrIDRef="${charPrId}"><hp:t>${escapeXml(text.slice(idx, start))}</hp:t></hp:run>\n`;
    }
    xml += buildAutoNumRunXml(charPrId, m[1] as 'PAGE' | 'TOTAL_PAGE');
    idx = start + m[0].length;
  }
  if (idx < text.length) {
    xml += `            <hp:run charPrIDRef="${charPrId}"><hp:t>${escapeXml(text.slice(idx))}</hp:t></hp:run>\n`;
  }
  if (!xml && text.length === 0) {
    xml = `            <hp:run charPrIDRef="${charPrId}"><hp:t></hp:t></hp:run>\n`;
  }
  return xml;
}

function buildAutoNumRunXml(charPrId: number, numType: 'PAGE' | 'TOTAL_PAGE'): string {
  return `            <hp:run charPrIDRef="${charPrId}"><hp:ctrl><hp:autoNum num="1" numType="${numType}"><hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar="" supscript="0"/></hp:autoNum></hp:ctrl></hp:run>\n`;
}

function buildHeaderFooterTableXml(
  table: HwpxHeaderFooterTable,
  charPrId: number,
  nextId: () => string,
): string {
  if (!table.rows || table.rows.length === 0) return '';
  const rowCnt = table.rows.length;
  const colCnt = table.rows[0]?.length ?? 0;
  if (colCnt <= 0) return '';

  const totalWidth = HWPX_DEFAULTS.table.totalWidth;
  let colWidths = table.columnWidths ?? [];
  if (colWidths.length !== colCnt || colWidths.some((w) => !Number.isFinite(w) || w <= 0)) {
    const eq = Math.floor(totalWidth / colCnt);
    colWidths = Array(colCnt).fill(eq);
    colWidths[colCnt - 1] += totalWidth - eq * colCnt;
  }

  let xml = `          <hp:tbl id="${nextId()}" numberingType="TABLE" textWrap="${HWPX_DEFAULTS.table.textWrap}" textFlow="${HWPX_DEFAULTS.table.textFlow}" lock="0" pageBreak="CELL" repeatHeader="1" rowCnt="${rowCnt}" colCnt="${colCnt}" cellSpacing="0" borderFillIDRef="1" noAdjust="0">\n`;
  xml += `            <hp:sz width="${totalWidth}" widthRelTo="ABSOLUTE" height="0" heightRelTo="ABSOLUTE" protect="0"/>\n`;
  xml += `            <hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>\n`;
  xml += `            <hp:outMargin left="0" right="0" top="0" bottom="0"/>\n`;
  xml += `            <hp:inMargin left="${HWPX_DEFAULTS.table.headerFooterInMargin.left}" right="${HWPX_DEFAULTS.table.headerFooterInMargin.right}" top="${HWPX_DEFAULTS.table.headerFooterInMargin.top}" bottom="${HWPX_DEFAULTS.table.headerFooterInMargin.bottom}"/>\n`;

  for (let r = 0; r < rowCnt; r++) {
    xml += `            <hp:tr>\n`;
    const rowHeight = HWPX_DEFAULTS.table.headerFooterCellHeight;
    for (let c = 0; c < colCnt; c++) {
      const cellText = table.rows[r]?.[c] ?? '';
      xml += `              <hp:tc name="" header="0" hasMargin="1" protect="0" editable="0" dirty="0" borderFillIDRef="1">\n`;
      xml += `                <hp:subList id="" textDirection="HORIZONTAL" lineWrap="BREAK" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">\n`;
      xml += `                  <hp:p id="${nextId()}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">\n`;
      xml += buildInlineTextWithAutoNum(cellText, charPrId);
      xml += `                  </hp:p>\n`;
      xml += `                </hp:subList>\n`;
      xml += `                <hp:cellAddr colAddr="${c}" rowAddr="${r}"/>\n`;
      xml += `                <hp:cellSpan colSpan="1" rowSpan="1"/>\n`;
      xml += `                <hp:cellSz width="${colWidths[c]}" height="${rowHeight}"/>\n`;
      xml += `                <hp:cellMargin left="0" right="0" top="0" bottom="0"/>\n`;
      xml += `              </hp:tc>\n`;
    }
    xml += `            </hp:tr>\n`;
  }
  xml += `          </hp:tbl>`;
  return xml;
}

// ── Font registration ───────────────────────────────────

export function addFontToHeader(
  headerXml: string,
  fontName: string,
): { xml: string; fontId: number } {
  const escapedName = fontName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const existingMatch = headerXml.match(
    new RegExp(`<hh:font\\s+id="(\\d+)"\\s+face="${escapedName}"`),
  );
  if (existingMatch) {
    return { xml: headerXml, fontId: Number(existingMatch[1]) };
  }

  // Find max font ID across all fontface sections
  const fontIdMatches = [...headerXml.matchAll(/<hh:font\s+id="(\d+)"/g)];
  let maxFontId = 0;
  for (const m of fontIdMatches) {
    const id = Number(m[1]);
    if (id > maxFontId) maxFontId = id;
  }
  const newFontId = maxFontId + 1;

  // Add to each fontface lang section
  let xml = headerXml.replace(
    /(<hh:fontface\s+lang="[^"]*"\s+fontCnt=")(\d+)("[\s\S]*?)(      <\/hh:fontface>)/g,
    (_m, prefix, cnt, middle, close) => {
      const newFont = `        <hh:font id="${newFontId}" face="${fontName}" type="TTF" isEmbedded="0">\n          <hh:typeInfo familyType="FCAT_GOTHIC" weight="6" proportion="4" contrast="0" strokeVariation="1" armStyle="1" letterform="1" midline="1" xHeight="1"/>\n        </hh:font>\n`;
      return `${prefix}${Number(cnt) + 1}${middle}${newFont}${close}`;
    },
  );

  return { xml, fontId: newFontId };
}

// ── New table builder ───────────────────────────────────

export function buildNewTable(
  rows: number,
  cols: number,
  headers: string[],
  data: string[][],
  nextId: () => string,
): string {
  const totalWidth = HWPX_DEFAULTS.table.totalWidth;
  const colWidth = Math.floor(totalWidth / cols);
  const cellHeight = HWPX_DEFAULTS.table.cellHeight;

  const tableData: ParsedTable = {
    id: '',
    rowCnt: rows,
    colCnt: cols,
    totalWidth,
    borderFillIDRef: 1,
    rows: [],
  };

  // Header row
  if (headers.length > 0) {
    const headerRow: ParsedCell[] = [];
    for (let c = 0; c < cols; c++) {
      headerRow.push({
        text: headers[c] || '',
        charPrIDRef: 0,
        colAddr: c,
        rowAddr: 0,
        colSpan: 1,
        rowSpan: 1,
        width: colWidth,
        height: cellHeight,
        header: true,
        borderFillIDRef: 1,
      });
    }
    tableData.rows.push(headerRow);
  }

  // Data rows
  const headerOffset = headers.length > 0 ? 1 : 0;
  for (let r = 0; r < data.length; r++) {
    const row: ParsedCell[] = [];
    for (let c = 0; c < cols; c++) {
      row.push({
        text: data[r]?.[c] || '',
        charPrIDRef: 0,
        colAddr: c,
        rowAddr: r + headerOffset,
        colSpan: 1,
        rowSpan: 1,
        width: colWidth,
        height: cellHeight,
        header: false,
        borderFillIDRef: 1,
      });
    }
    tableData.rows.push(row);
  }

  return buildTableXml(tableData, nextId);
}

// ── Utilities ───────────────────────────────────────────

function stripUndefined<T extends object>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key of Object.keys(obj) as (keyof T)[]) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
}

function unescapeXmlSimple(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}
