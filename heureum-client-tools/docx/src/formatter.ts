/**
 * XML builder utilities for OOXML DOCX elements.
 * Builds w:rPr, w:pPr, table, and image XML fragments.
 */

import { escapeXml } from './template.js';
import { DOCX_DEFAULTS, DOCX_PAGE_SIZES, mmToTwips, mmToEmu, ptToHalfPt } from './configs.js';
import { NUM_ID_BULLET, NUM_ID_ORDERED } from './numbering.js';

// ── Run Properties (w:rPr) ──────────────────────────────

export interface RunFormatOptions {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  fontSizePt?: number;
  color?: string;       // "RRGGBB" (no #)
  fontName?: string;
  highlight?: string;
  vertAlign?: 'superscript' | 'subscript';
}

export function buildRPr(opts: RunFormatOptions): string {
  if (!opts || Object.keys(opts).length === 0) return '';
  const parts: string[] = [];
  if (opts.fontName) {
    parts.push(`<w:rFonts w:ascii="${escapeXml(opts.fontName)}" w:eastAsia="${escapeXml(opts.fontName)}" w:hAnsi="${escapeXml(opts.fontName)}"/>`);
  }
  if (opts.bold) parts.push('<w:b/><w:bCs/>');
  if (opts.italic) parts.push('<w:i/><w:iCs/>');
  if (opts.underline) parts.push('<w:u w:val="single"/>');
  if (opts.strike) parts.push('<w:strike/>');
  if (opts.color) parts.push(`<w:color w:val="${opts.color.replace(/^#/, '')}"/>`);
  if (opts.highlight) parts.push(`<w:highlight w:val="${opts.highlight}"/>`);
  if (opts.fontSizePt != null) {
    const hp = ptToHalfPt(opts.fontSizePt);
    parts.push(`<w:sz w:val="${hp}"/><w:szCs w:val="${hp}"/>`);
  }
  if (opts.vertAlign) parts.push(`<w:vertAlign w:val="${opts.vertAlign}"/>`);
  if (parts.length === 0) return '';
  return `<w:rPr>${parts.join('')}</w:rPr>`;
}

// ── Run element (w:r) ───────────────────────────────────

export function buildRun(text: string, rPr?: string): string {
  const rPrPart = rPr || '';
  // Split by newlines → multiple w:t with w:br between
  const lines = text.split('\n');
  const tParts = lines.map((line, i) => {
    const t = `<w:t xml:space="preserve">${escapeXml(line)}</w:t>`;
    return i < lines.length - 1 ? `${t}<w:br/>` : t;
  });
  return `<w:r>${rPrPart}${tParts.join('')}</w:r>`;
}

// ── Paragraph Properties (w:pPr) ────────────────────────

export interface ParaFormatOptions {
  styleId?: string;
  alignment?: 'left' | 'center' | 'right' | 'both' | 'distribute';
  spacingBeforePt?: number;
  spacingAfterPt?: number;
  lineSpacingPercent?: number;
  lineSpacingExactPt?: number;
  indentLeftTwips?: number;
  indentRightTwips?: number;
  indentFirstLineTwips?: number;
  indentHangingTwips?: number;
  keepNext?: boolean;
  keepLines?: boolean;
  pageBreakBefore?: boolean;
  numId?: number;
  numLevel?: number;
  outlineLvl?: number;
  shading?: string; // "RRGGBB"
  rPr?: string;     // paragraph-level run properties (for styles)
}

export function buildPPr(opts: ParaFormatOptions): string {
  if (!opts || Object.keys(opts).length === 0) return '';
  const parts: string[] = [];

  if (opts.styleId) parts.push(`<w:pStyle w:val="${escapeXml(opts.styleId)}"/>`);
  if (opts.keepNext) parts.push('<w:keepNext/>');
  if (opts.keepLines) parts.push('<w:keepLines/>');
  if (opts.pageBreakBefore) parts.push('<w:pageBreakBefore/>');

  if (opts.numId != null) {
    const ilvl = opts.numLevel ?? 0;
    parts.push(`<w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${opts.numId}"/></w:numPr>`);
  }

  if (opts.shading) {
    parts.push(`<w:shd w:val="clear" w:color="auto" w:fill="${opts.shading.replace(/^#/, '')}"/>`);
  }

  // Indentation
  if (
    opts.indentLeftTwips != null ||
    opts.indentRightTwips != null ||
    opts.indentFirstLineTwips != null ||
    opts.indentHangingTwips != null
  ) {
    const attrs: string[] = [];
    if (opts.indentLeftTwips != null) attrs.push(`w:left="${opts.indentLeftTwips}"`);
    if (opts.indentRightTwips != null) attrs.push(`w:right="${opts.indentRightTwips}"`);
    if (opts.indentFirstLineTwips != null) attrs.push(`w:firstLine="${opts.indentFirstLineTwips}"`);
    if (opts.indentHangingTwips != null) attrs.push(`w:hanging="${opts.indentHangingTwips}"`);
    parts.push(`<w:ind ${attrs.join(' ')}/>`);
  }

  // Spacing
  if (
    opts.spacingBeforePt != null ||
    opts.spacingAfterPt != null ||
    opts.lineSpacingPercent != null ||
    opts.lineSpacingExactPt != null
  ) {
    const attrs: string[] = [];
    if (opts.spacingBeforePt != null) attrs.push(`w:before="${Math.round(opts.spacingBeforePt * 20)}"`);
    if (opts.spacingAfterPt != null) attrs.push(`w:after="${Math.round(opts.spacingAfterPt * 20)}"`);
    if (opts.lineSpacingPercent != null) {
      attrs.push(`w:line="${Math.round(opts.lineSpacingPercent * 240 / 100)}" w:lineRule="auto"`);
    } else if (opts.lineSpacingExactPt != null) {
      attrs.push(`w:line="${Math.round(opts.lineSpacingExactPt * 20)}" w:lineRule="exact"`);
    }
    parts.push(`<w:spacing ${attrs.join(' ')}/>`);
  }

  if (opts.alignment) parts.push(`<w:jc w:val="${opts.alignment}"/>`);
  if (opts.outlineLvl != null) parts.push(`<w:outlineLvl w:val="${opts.outlineLvl}"/>`);
  if (opts.rPr) parts.push(`<w:rPr>${opts.rPr}</w:rPr>`);

  if (parts.length === 0) return '';
  return `<w:pPr>${parts.join('')}</w:pPr>`;
}

// ── Paragraph element (w:p) ─────────────────────────────

export function buildParagraph(runs: string[], pPr?: string): string {
  return `<w:p>${pPr || ''}${runs.join('')}</w:p>`;
}

// ── Table builder ───────────────────────────────────────

export interface TableOptions {
  rows: string[][];
  columnWidthsTwips?: number[];
  headerRow?: boolean;
  headerBackground?: string; // "RRGGBB"
  borderSize?: number;
  borderColor?: string;
}

export function buildTable(opts: TableOptions): string {
  const { rows, headerRow, headerBackground, borderSize, borderColor } = opts;
  if (rows.length === 0) return '';

  const colCount = rows[0].length;
  const totalWidth = DOCX_PAGE_SIZES[DOCX_DEFAULTS.document.pageSize].width
    - DOCX_DEFAULTS.page.marginLeft - DOCX_DEFAULTS.page.marginRight;

  let colWidths = opts.columnWidthsTwips;
  if (!colWidths || colWidths.length !== colCount) {
    const w = Math.floor(totalWidth / colCount);
    colWidths = Array(colCount).fill(w);
    colWidths[colCount - 1] += totalWidth - w * colCount;
  }

  const bs = borderSize ?? DOCX_DEFAULTS.table.borderSize;
  const bc = borderColor ?? DOCX_DEFAULTS.table.borderColor;

  let xml = '<w:tbl>';
  xml += '<w:tblPr>';
  xml += '<w:tblStyle w:val="TableGrid"/>';
  xml += `<w:tblW w:w="${colWidths.reduce((a, b) => a + b, 0)}" w:type="dxa"/>`;
  xml += `<w:tblBorders>`;
  xml += `<w:top w:val="single" w:sz="${bs}" w:space="0" w:color="${bc}"/>`;
  xml += `<w:left w:val="single" w:sz="${bs}" w:space="0" w:color="${bc}"/>`;
  xml += `<w:bottom w:val="single" w:sz="${bs}" w:space="0" w:color="${bc}"/>`;
  xml += `<w:right w:val="single" w:sz="${bs}" w:space="0" w:color="${bc}"/>`;
  xml += `<w:insideH w:val="single" w:sz="${bs}" w:space="0" w:color="${bc}"/>`;
  xml += `<w:insideV w:val="single" w:sz="${bs}" w:space="0" w:color="${bc}"/>`;
  xml += '</w:tblBorders>';
  xml += '<w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>';
  xml += '</w:tblPr>';

  // Column grid
  xml += '<w:tblGrid>';
  for (const w of colWidths) {
    xml += `<w:gridCol w:w="${w}"/>`;
  }
  xml += '</w:tblGrid>';

  // Rows
  for (let r = 0; r < rows.length; r++) {
    const isHeader = headerRow && r === 0;
    xml += '<w:tr>';
    if (isHeader) {
      xml += '<w:trPr><w:tblHeader/></w:trPr>';
    }
    for (let c = 0; c < colCount; c++) {
      xml += '<w:tc>';
      xml += '<w:tcPr>';
      xml += `<w:tcW w:w="${colWidths[c]}" w:type="dxa"/>`;
      if (isHeader && headerBackground) {
        xml += `<w:shd w:val="clear" w:color="auto" w:fill="${headerBackground.replace(/^#/, '')}"/>`;
      }
      xml += '</w:tcPr>';
      // Cell content paragraph
      const cellText = rows[r]?.[c] ?? '';
      const cellRPr = isHeader ? buildRPr({ bold: true }) : '';
      const cellRun = buildRun(cellText, cellRPr);
      xml += buildParagraph([cellRun]);
      xml += '</w:tc>';
    }
    xml += '</w:tr>';
  }

  xml += '</w:tbl>';
  return xml;
}

// ── Image builder ───────────────────────────────────────

export function buildInlineImage(
  rId: string,
  widthEmu: number,
  heightEmu: number,
  name?: string,
): string {
  const imgName = name ?? 'image';
  return `<w:r>
  <w:rPr><w:noProof/></w:rPr>
  <w:drawing>
    <wp:inline distT="0" distB="0" distL="0" distR="0">
      <wp:extent cx="${widthEmu}" cy="${heightEmu}"/>
      <wp:effectExtent l="0" t="0" r="0" b="0"/>
      <wp:docPr id="1" name="${escapeXml(imgName)}"/>
      <wp:cNvGraphicFramePr>
        <a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/>
      </wp:cNvGraphicFramePr>
      <a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">
          <pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">
            <pic:nvPicPr>
              <pic:cNvPr id="0" name="${escapeXml(imgName)}"/>
              <pic:cNvPicPr/>
            </pic:nvPicPr>
            <pic:blipFill>
              <a:blip r:embed="${rId}" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"/>
              <a:stretch><a:fillRect/></a:stretch>
            </pic:blipFill>
            <pic:spPr>
              <a:xfrm>
                <a:off x="0" y="0"/>
                <a:ext cx="${widthEmu}" cy="${heightEmu}"/>
              </a:xfrm>
              <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
            </pic:spPr>
          </pic:pic>
        </a:graphicData>
      </a:graphic>
    </wp:inline>
  </w:drawing>
</w:r>`;
}

// ── Section Properties (w:sectPr) ───────────────────────

export interface SectionPropsOptions {
  pageWidth?: number;   // twips
  pageHeight?: number;
  marginTop?: number;
  marginBottom?: number;
  marginLeft?: number;
  marginRight?: number;
  marginHeader?: number;
  marginFooter?: number;
  headerRef?: string;   // rId
  footerRef?: string;   // rId
}

export function buildSectPr(opts?: SectionPropsOptions): string {
  const pg = DOCX_PAGE_SIZES[DOCX_DEFAULTS.document.pageSize];
  const w = opts?.pageWidth ?? pg.width;
  const h = opts?.pageHeight ?? pg.height;
  const mt = opts?.marginTop ?? DOCX_DEFAULTS.page.marginTop;
  const mb = opts?.marginBottom ?? DOCX_DEFAULTS.page.marginBottom;
  const ml = opts?.marginLeft ?? DOCX_DEFAULTS.page.marginLeft;
  const mr = opts?.marginRight ?? DOCX_DEFAULTS.page.marginRight;
  const mh = opts?.marginHeader ?? DOCX_DEFAULTS.page.marginHeader;
  const mf = opts?.marginFooter ?? DOCX_DEFAULTS.page.marginFooter;
  const gutter = DOCX_DEFAULTS.page.gutter;

  let xml = '<w:sectPr>';
  if (opts?.headerRef) {
    xml += `<w:headerReference w:type="default" r:id="${opts.headerRef}"/>`;
  }
  if (opts?.footerRef) {
    xml += `<w:footerReference w:type="default" r:id="${opts.footerRef}"/>`;
  }
  xml += `<w:pgSz w:w="${w}" w:h="${h}"/>`;
  xml += `<w:pgMar w:top="${mt}" w:right="${mr}" w:bottom="${mb}" w:left="${ml}" w:header="${mh}" w:footer="${mf}" w:gutter="${gutter}"/>`;
  xml += '<w:cols w:space="720"/>';
  xml += '<w:docGrid w:linePitch="360"/>';
  xml += '</w:sectPr>';
  return xml;
}

// ── Hyperlink ───────────────────────────────────────────

export function buildHyperlink(rId: string, text: string, rPr?: string): string {
  const runRPr = rPr || buildRPr({ color: '0563C1', underline: true });
  return `<w:hyperlink r:id="${rId}"><w:r>${runRPr}<w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:hyperlink>`;
}

// ── Page break ──────────────────────────────────────────

export function buildPageBreak(): string {
  return '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
}
