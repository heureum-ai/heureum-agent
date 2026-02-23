/**
 * Structured document creation API for DOCX.
 * Takes a content array (paragraphs, tables, images, page breaks) and
 * produces a complete .docx file.
 */

import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';
import {
  DOCX_DEFAULTS,
  DOCX_PAGE_SIZES,
  mmToTwips,
  mmToEmu,
  ptToHalfPt,
  type DocxPageSizeKey,
} from './configs.js';
import {
  buildContentTypes,
  ROOT_RELS,
  buildDocumentRels,
  SETTINGS_XML,
  buildFontTable,
  buildCoreXml,
  APP_XML,
  escapeXml,
  type DocRelItem,
  type ContentTypesOverride,
} from './template.js';
import { buildStylesXml } from './styles.js';
import { buildNumberingXml, NUM_ID_BULLET, NUM_ID_ORDERED } from './numbering.js';
import {
  buildRPr,
  buildRun,
  buildPPr,
  buildParagraph,
  buildTable,
  buildSectPr,
  buildPageBreak,
  buildInlineImage,
  type RunFormatOptions,
  type ParaFormatOptions,
  type SectionPropsOptions,
} from './formatter.js';

// ── Public interfaces ───────────────────────────────────

export interface DocxTextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  fontSize?: number;
  fontName?: string;
  lineBreak?: boolean;
}

export interface DocxParagraph {
  text?: string;
  runs?: DocxTextRun[];
  heading?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;
  fontSize?: number;
  fontName?: string;
  alignment?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFY';
  bullet?: boolean;
  numbered?: boolean;
  lineSpacing?: number;
  indent?: number;
  marginLeft?: number;
  marginRight?: number;
  spacing?: { before?: number; after?: number };
  pageBreak?: boolean;
  lineBreak?: boolean;
}

export interface DocxTable {
  rows: string[][];
  headerRow?: boolean;
  headerBackground?: string;
  columnWidths?: number[];
  cellBorder?: {
    topBorderType?: 'NONE' | 'SOLID' | 'DOTTED' | 'DASHED';
    bottomBorderType?: 'NONE' | 'SOLID' | 'DOTTED' | 'DASHED';
    leftBorderType?: 'NONE' | 'SOLID' | 'DOTTED' | 'DASHED';
    rightBorderType?: 'NONE' | 'SOLID' | 'DOTTED' | 'DASHED';
  };
  cellCharFormat?: {
    fontSize?: number;
    fontName?: string;
    color?: string;
    alignment?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFY';
  };
}

export interface DocxImage {
  path: string;
  width_mm?: number;
  height_mm?: number;
}

export interface DocxContentBlock {
  paragraph?: DocxParagraph;
  table?: DocxTable;
  image?: DocxImage;
  pageBreak?: boolean;
}

export interface DocxCreateDocumentParams {
  output_path: string;
  content: DocxContentBlock[];
  page_size?: DocxPageSizeKey;
  font?: string;
  font_size?: number;
  margin?: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
  };
  header?: string | { text?: string };
  footer?: string | { text?: string };
  title?: string;
}

// ── Main function ───────────────────────────────────────

export async function createDocument(params: DocxCreateDocumentParams): Promise<Uint8Array> {
  const {
    content,
    page_size,
    font,
    font_size,
    margin,
    header,
    footer,
    title,
  } = params;

  // Page settings
  const pageSizeKey = page_size ?? DOCX_DEFAULTS.document.pageSize;
  const pg = DOCX_PAGE_SIZES[pageSizeKey];
  const pageWidth = pg.width;
  const pageHeight = pg.height;
  const marginTop = margin?.top != null ? mmToTwips(margin.top) : DOCX_DEFAULTS.page.marginTop;
  const marginBottom = margin?.bottom != null ? mmToTwips(margin.bottom) : DOCX_DEFAULTS.page.marginBottom;
  const marginLeft = margin?.left != null ? mmToTwips(margin.left) : DOCX_DEFAULTS.page.marginLeft;
  const marginRight = margin?.right != null ? mmToTwips(margin.right) : DOCX_DEFAULTS.page.marginRight;

  const defaultFont = font ?? DOCX_DEFAULTS.document.fontName;
  const defaultFontSize = font_size ?? DOCX_DEFAULTS.document.fontSizePt;

  // Track images and relationships
  const extraRels: DocRelItem[] = [];
  const imageEntries: Array<{ zipPath: string; data: Uint8Array }> = [];
  const extraContentTypes: ContentTypesOverride[] = [];
  let relIdCounter = 10; // Start from rId10 to avoid conflicts
  let numberedCounter = 0;

  // Process content blocks
  let bodyXml = '';

  for (const block of content) {
    if (block.pageBreak) {
      bodyXml += buildPageBreak();
      continue;
    }

    if (block.paragraph) {
      bodyXml += processParagraphBlock(block.paragraph, defaultFont, defaultFontSize, numberedCounter);
      if (block.paragraph.numbered) numberedCounter++;
      else if (!block.paragraph.bullet) numberedCounter = 0;
      continue;
    }

    if (block.table) {
      bodyXml += processTableBlock(block.table);
      continue;
    }

    if (block.image) {
      const rId = `rId${relIdCounter++}`;
      const imgResult = await processImageBlock(block.image, rId);
      if (imgResult) {
        bodyXml += imgResult.xml;
        imageEntries.push(imgResult.entry);
        extraRels.push(imgResult.rel);
      }
      continue;
    }
  }

  // Header/Footer
  let headerRelId: string | undefined;
  let footerRelId: string | undefined;
  let headerXml: string | undefined;
  let footerXml: string | undefined;

  if (header) {
    headerRelId = `rId${relIdCounter++}`;
    const text = typeof header === 'string' ? header : header.text ?? '';
    headerXml = buildHeaderFooterPartXml('header', text);
    extraRels.push({
      id: headerRelId,
      type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header',
      target: 'header1.xml',
    });
    extraContentTypes.push({
      partName: '/word/header1.xml',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml',
    });
  }

  if (footer) {
    footerRelId = `rId${relIdCounter++}`;
    const text = typeof footer === 'string' ? footer : footer.text ?? '';
    footerXml = buildHeaderFooterPartXml('footer', text);
    extraRels.push({
      id: footerRelId,
      type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer',
      target: 'footer1.xml',
    });
    extraContentTypes.push({
      partName: '/word/footer1.xml',
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml',
    });
  }

  // Build sectPr
  const sectPrOpts: SectionPropsOptions = {
    pageWidth, pageHeight,
    marginTop, marginBottom, marginLeft, marginRight,
    headerRef: headerRelId,
    footerRef: footerRelId,
  };
  const sectPr = buildSectPr(sectPrOpts);

  // Build document.xml
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"
            xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
            xmlns:o="urn:schemas-microsoft-com:office:office"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
            xmlns:v="urn:schemas-microsoft-com:vml"
            xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
            xmlns:w10="urn:schemas-microsoft-com:office:word"
            xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"
            xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"
            xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"
            xmlns:wne="http://schemas.microsoft.com/office/word/2006/wordml"
            xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"
            xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"
            mc:Ignorable="w14 wp14">
  <w:body>
${bodyXml}
    ${sectPr}
  </w:body>
</w:document>`;

  // Package ZIP
  const zip = new JSZip();
  zip.file('[Content_Types].xml', buildContentTypes(extraContentTypes));
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/document.xml', documentXml);
  zip.file('word/styles.xml', buildStylesXml({ defaultFont, defaultFontSizePt: defaultFontSize }));
  zip.file('word/settings.xml', SETTINGS_XML);
  zip.file('word/numbering.xml', buildNumberingXml());
  zip.file('word/fontTable.xml', buildFontTable());
  zip.file('word/_rels/document.xml.rels', buildDocumentRels(extraRels));
  zip.file('docProps/core.xml', buildCoreXml({ title }));
  zip.file('docProps/app.xml', APP_XML);

  if (headerXml) zip.file('word/header1.xml', headerXml);
  if (footerXml) zip.file('word/footer1.xml', footerXml);

  for (const img of imageEntries) {
    zip.file(img.zipPath, img.data);
  }

  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

// ── Block processors ────────────────────────────────────

function processParagraphBlock(
  para: DocxParagraph,
  defaultFont: string,
  defaultFontSize: number,
  numberedCounter: number,
): string {
  const pPrOpts: ParaFormatOptions = {};

  // Heading
  if (para.heading) {
    pPrOpts.styleId = `Heading${para.heading}`;
  }

  // Alignment
  if (para.alignment) {
    const alignMap: Record<string, ParaFormatOptions['alignment']> = {
      LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFY: 'both',
    };
    pPrOpts.alignment = alignMap[para.alignment] ?? 'left';
  }

  // List
  if (para.bullet) {
    pPrOpts.styleId = 'ListParagraph';
    pPrOpts.numId = NUM_ID_BULLET;
    pPrOpts.numLevel = 0;
  }
  if (para.numbered) {
    pPrOpts.styleId = 'ListParagraph';
    pPrOpts.numId = NUM_ID_ORDERED;
    pPrOpts.numLevel = 0;
  }

  // Spacing
  if (para.lineSpacing) pPrOpts.lineSpacingPercent = para.lineSpacing;
  if (para.spacing?.before) pPrOpts.spacingBeforePt = para.spacing.before;
  if (para.spacing?.after) pPrOpts.spacingAfterPt = para.spacing.after;

  // Indentation
  if (para.indent != null) {
    if (para.indent >= 0) {
      pPrOpts.indentFirstLineTwips = mmToTwips(para.indent);
    } else {
      pPrOpts.indentHangingTwips = mmToTwips(Math.abs(para.indent));
    }
  }
  if (para.marginLeft != null) pPrOpts.indentLeftTwips = mmToTwips(para.marginLeft);
  if (para.marginRight != null) pPrOpts.indentRightTwips = mmToTwips(para.marginRight);

  // Page break before
  if (para.pageBreak) pPrOpts.pageBreakBefore = true;

  const pPr = buildPPr(pPrOpts);

  // Build runs
  let runs: string[];

  if (para.runs && para.runs.length > 0) {
    runs = para.runs.map((run) => {
      const rOpts: RunFormatOptions = {};
      if (run.bold) rOpts.bold = true;
      if (run.italic) rOpts.italic = true;
      if (run.underline) rOpts.underline = true;
      if (run.color) rOpts.color = run.color;
      if (run.fontSize) rOpts.fontSizePt = run.fontSize;
      if (run.fontName) rOpts.fontName = run.fontName;

      const rPr = buildRPr(rOpts);
      let text = run.text;
      if (run.lineBreak) text += '\n';
      return buildRun(text, rPr);
    });
  } else {
    const text = para.text ?? '';
    const rOpts: RunFormatOptions = {};
    if (para.bold) rOpts.bold = true;
    if (para.italic) rOpts.italic = true;
    if (para.underline) rOpts.underline = true;
    if (para.color) rOpts.color = para.color;
    if (para.fontSize) rOpts.fontSizePt = para.fontSize;
    if (para.fontName) rOpts.fontName = para.fontName;

    const rPr = buildRPr(rOpts);
    runs = [buildRun(text, rPr)];
  }

  return buildParagraph(runs, pPr);
}

function processTableBlock(table: DocxTable): string {
  const colWidths = table.columnWidths?.map((w) => mmToTwips(w));
  return buildTable({
    rows: table.rows,
    columnWidthsTwips: colWidths,
    headerRow: table.headerRow,
    headerBackground: table.headerBackground,
  });
}

async function processImageBlock(
  image: DocxImage,
  rId: string,
): Promise<{ xml: string; entry: { zipPath: string; data: Uint8Array }; rel: DocRelItem } | null> {
  try {
    const imgPath = path.resolve(image.path);
    const data = await fs.promises.readFile(imgPath);
    const ext = path.extname(imgPath).toLowerCase().replace('.', '');
    const mediaType = ext === 'jpg' ? 'jpeg' : ext;
    const fileName = `image_${rId}.${ext}`;
    const zipPath = `word/media/${fileName}`;

    const widthEmu = mmToEmu(image.width_mm ?? DOCX_DEFAULTS.image.widthMm);
    const heightEmu = mmToEmu(image.height_mm ?? DOCX_DEFAULTS.image.heightMm);

    const imgXml = buildInlineImage(rId, widthEmu, heightEmu, fileName);
    const paraXml = buildParagraph([imgXml]);

    return {
      xml: paraXml,
      entry: { zipPath, data: new Uint8Array(data) },
      rel: {
        id: rId,
        type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/image',
        target: `media/${fileName}`,
      },
    };
  } catch {
    return null;
  }
}

function buildHeaderFooterPartXml(type: 'header' | 'footer', text: string): string {
  const rootTag = type === 'header' ? 'w:hdr' : 'w:ftr';
  const styleId = type === 'header' ? 'Header' : 'Footer';
  const pPr = buildPPr({ styleId, alignment: 'center' });
  const run = buildRun(text);
  const p = buildParagraph([run], pPr);

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<${rootTag} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  ${p}
</${rootTag}>`;
}
