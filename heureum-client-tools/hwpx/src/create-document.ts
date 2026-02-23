/**
 * Structured document creation for HWPX.
 * Takes a typed content array and produces a complete .hwpx archive in one call.
 */

import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';
import {
  MIMETYPE,
  VERSION_XML,
  CONTAINER_XML,
  MANIFEST_XML,
  SETTINGS_XML,
  COMMON_NS,
  buildContainerRdf,
  buildContentHpf,
  escapeXml,
} from './template.js';
import { buildHeaderXml } from './header.js';
import { HWPX_DEFAULTS, HWPX_PAGE_SIZES, type HwpxPageSizeKey } from './configs.js';
import {
  mmToHwpUnit,
  addCharPrToHeader,
  addParaPrToHeader,
  addBorderFillToHeader,
  addFontToHeader,
  addBinItemToHeader,
  buildTableXml,
  buildImagePicXml,
  buildHeaderFooterXml,
  type CharFormatOptions,
  type ParaFormatOptions,
  type BorderFillOptions,
  type ParsedTable,
  type ParsedCell,
  type HwpxHeaderFooterContent,
} from './formatter.js';

// ── Public interfaces ────────────────────────────────────

export interface HwpxTextRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;            // "#RRGGBB"
  fontSize?: number;         // pt
  fontName?: string;         // font face name
  lineBreak?: boolean;       // append <hp:lineBreak/> after this run
}

export interface HwpxParagraph {
  text?: string;
  runs?: HwpxTextRun[];
  heading?: 1 | 2 | 3 | 4 | 5 | 6;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  color?: string;            // "#RRGGBB"
  fontSize?: number;         // pt (e.g. 10, 16, 26)
  fontName?: string;         // overrides document default font
  alignment?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFY';
  bullet?: boolean;
  numbered?: boolean;
  lineSpacing?: number;      // percentage (e.g. 160)
  indent?: number;           // mm, negative for hanging indent
  marginLeft?: number;       // mm
  marginRight?: number;      // mm
  spacing?: { before?: number; after?: number };  // mm
  pageBreak?: boolean;       // page break before this paragraph
  lineBreak?: boolean;       // append lineBreak at end of paragraph text/runs
}

export interface HwpxTable {
  rows: string[][];
  headerRow?: boolean;
  headerBackground?: string; // "#RRGGBB"
  columnWidths?: number[];   // mm (omit for equal distribution)
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

export interface HwpxImage {
  path: string;
  width_mm?: number;         // default 100
  height_mm?: number;        // default 75
  text_wrap?: 'TOP_AND_BOTTOM' | 'SQUARE' | 'BEHIND_TEXT';
}

export interface HwpxContentBlock {
  paragraph?: HwpxParagraph;
  table?: HwpxTable;
  image?: HwpxImage;
  pageBreak?: boolean;       // standalone page break
}

export interface HwpxCreateDocumentParams {
  output_path: string;
  content: HwpxContentBlock[];
  page_size?: HwpxPageSizeKey;
  font?: string;
  font_size?: number;
  margin?: { top?: number; bottom?: number; left?: number; right?: number }; // mm
  header?: string | HwpxHeaderFooterContent;
  footer?: string | HwpxHeaderFooterContent;
  title?: string;
}

// ── ID generator ─────────────────────────────────────────

function makeIdGenerator(start = 2147483648): () => string {
  let counter = start;
  return () => String(counter++);
}

// ── Main function ────────────────────────────────────────

export async function createDocument(
  params: HwpxCreateDocumentParams,
): Promise<Uint8Array> {
  const {
    content,
    page_size = HWPX_DEFAULTS.document.pageSize,
    font = HWPX_DEFAULTS.document.fontName,
    font_size = HWPX_DEFAULTS.document.fontSizePt,
    margin,
    header: headerText,
    footer: footerText,
    title,
  } = params;

  const nextId = makeIdGenerator();

  // ── Stage A: Document settings ─────────────────────────

  const ps = HWPX_PAGE_SIZES[page_size] ?? HWPX_PAGE_SIZES[HWPX_DEFAULTS.document.pageSize];
  const pageWidth = ps.width;
  const pageHeight = ps.height;

  const marginTop = margin?.top !== undefined
    ? mmToHwpUnit(margin.top)
    : HWPX_DEFAULTS.page.marginTop;
  const marginBottom = margin?.bottom !== undefined
    ? mmToHwpUnit(margin.bottom)
    : HWPX_DEFAULTS.page.marginBottom;
  const marginLeft = margin?.left !== undefined
    ? mmToHwpUnit(margin.left)
    : HWPX_DEFAULTS.page.marginLeft;
  const marginRight = margin?.right !== undefined
    ? mmToHwpUnit(margin.right)
    : HWPX_DEFAULTS.page.marginRight;

  // Content area width for table column calculation
  const contentWidth = pageWidth - marginLeft - marginRight;

  // ── Stage B: header.xml initialization ─────────────────

  let headerXml = buildHeaderXml(1);

  // Register custom font
  let fontId = 0;
  if (font !== HWPX_DEFAULTS.document.builtInFontName) {
    const fontResult = addFontToHeader(headerXml, font);
    headerXml = fontResult.xml;
    fontId = fontResult.fontId;
  }

  // Build base charPr for the document default font+size
  const baseCharOpts: CharFormatOptions = {
    fontSize: font_size,
    textColor: '#000000',
    fontRef: fontId,
  };

  // Register default charPr
  const defaultCharResult = addCharPrToHeader(headerXml, baseCharOpts);
  headerXml = defaultCharResult.xml;
  const defaultCharPrId = defaultCharResult.id;

  const fontIdCache = new Map<string, number>();
  if (font) fontIdCache.set(font, fontId);

  // Image binary data to add to ZIP later
  const imageEntries: { zipPath: string; data: Uint8Array; manifestId: string; mediaType: string }[] = [];

  // Numbered list counter
  let numberedCounter = 0;

  // ── Stage C: Process content blocks ────────────────────

  const contentXmlParts: string[] = [];

  for (const block of content) {
    if (block.paragraph) {
      const p = block.paragraph;
      const xml = processParagraphBlock(p);
      contentXmlParts.push(xml);
    } else if (block.table) {
      const xml = processTableBlock(block.table);
      contentXmlParts.push(xml);
    } else if (block.image) {
      const xml = await processImageBlock(block.image);
      if (xml) contentXmlParts.push(xml);
    } else if (block.pageBreak) {
      const xml = processPageBreak();
      contentXmlParts.push(xml);
    }
  }

  // ── Stage D: section0.xml assembly ─────────────────────

  const secPrXml = buildCustomSecPr(
    pageWidth, pageHeight,
    marginTop, marginBottom, marginLeft, marginRight,
    headerText, footerText, nextId,
  );

  const firstParaId = nextId();
  let sectionXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n`;
  sectionXml += `<hs:sec ${COMMON_NS}>\n`;
  sectionXml += `  <hp:p id="${firstParaId}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">\n`;
  sectionXml += `    <hp:run charPrIDRef="0">\n`;
  sectionXml += secPrXml + '\n';
  sectionXml += `      <hp:ctrl>\n`;
  sectionXml += `        <hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/>\n`;
  sectionXml += `      </hp:ctrl>\n`;
  sectionXml += `    </hp:run>\n`;
  sectionXml += `  </hp:p>\n`;

  for (const part of contentXmlParts) {
    sectionXml += part + '\n';
  }

  // Trailing empty paragraph
  const emptyParaId = nextId();
  sectionXml += `  <hp:p id="${emptyParaId}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">\n`;
  sectionXml += `    <hp:run charPrIDRef="0"><hp:t></hp:t></hp:run>\n`;
  sectionXml += `  </hp:p>\n`;
  sectionXml += `</hs:sec>`;

  // ── Stage E: ZIP packaging ─────────────────────────────

  const zip = new JSZip();
  zip.file('mimetype', MIMETYPE, { compression: 'STORE' });
  zip.file('version.xml', VERSION_XML);
  zip.file('META-INF/container.xml', CONTAINER_XML);
  zip.file('META-INF/manifest.xml', MANIFEST_XML);
  zip.file('META-INF/container.rdf', buildContainerRdf(1));
  zip.file('settings.xml', SETTINGS_XML);
  zip.file(
    'Contents/content.hpf',
    buildContentHpf(
      1,
      title,
      imageEntries.map((entry) => ({
        id: entry.manifestId,
        href: entry.zipPath,
        mediaType: entry.mediaType,
      })),
    ),
  );
  zip.file('Contents/header.xml', headerXml);
  zip.file('Contents/section0.xml', sectionXml);
  zip.file('Preview/PrvText.txt', title || '');

  // Add image binaries
  for (const entry of imageEntries) {
    zip.file(entry.zipPath, entry.data);
  }

  const buffer = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  return buffer;

  // ── Internal helpers (closures over headerXml, nextId, etc.) ──

  function processParagraphBlock(p: HwpxParagraph): string {
    const text = p.text ?? '';

    // Determine paragraph format
    const paraOpts: ParaFormatOptions = {};

    if (p.alignment) paraOpts.alignment = p.alignment;
    if (p.lineSpacing) {
      paraOpts.lineSpacingType = 'PERCENT';
      paraOpts.lineSpacingValue = p.lineSpacing;
    }
    if (p.indent !== undefined) paraOpts.indent = mmToHwpUnit(p.indent);
    if (p.marginLeft !== undefined) paraOpts.marginLeft = mmToHwpUnit(p.marginLeft);
    if (p.marginRight !== undefined) paraOpts.marginRight = mmToHwpUnit(p.marginRight);
    if (p.spacing?.before) paraOpts.spaceBefore = mmToHwpUnit(p.spacing.before);
    if (p.spacing?.after) paraOpts.spaceAfter = mmToHwpUnit(p.spacing.after);
    if ((p.bullet || p.numbered) && p.marginLeft === undefined) paraOpts.marginLeft = mmToHwpUnit(HWPX_DEFAULTS.paragraph.bulletMarginLeftMm);
    if (p.pageBreak) paraOpts.pageBreakBefore = true;

    const paraResult = addParaPrToHeader(headerXml, paraOpts);
    headerXml = paraResult.xml;
    const paraPrId = paraResult.id;

    // Build text with prefix
    let displayText = text;
    if (p.bullet) {
      displayText = '• ' + text;
    } else if (p.numbered) {
      numberedCounter++;
      displayText = `${numberedCounter}. ` + text;
    } else {
      // Reset numbered counter when not in numbered mode
      numberedCounter = 0;
    }

    const paraId = nextId();
    const styleId = 0;
    let xml = `  <hp:p id="${paraId}" paraPrIDRef="${paraPrId}" styleIDRef="${styleId}" pageBreak="0" columnBreak="0" merged="0">\n`;

    const runs = p.runs ?? [];
    if (runs.length > 0) {
      let prefixApplied = false;
      const prefix = p.bullet ? '• ' : (p.numbered ? `${numberedCounter}. ` : '');

      for (const run of runs) {
        const runFontRef = resolveFontRef(run.fontName ?? p.fontName);
        const runCharOpts: CharFormatOptions = {
          fontSize: run.fontSize ?? p.fontSize ?? (p.heading ? HWPX_DEFAULTS.document.headingSizesPt[p.heading] : font_size),
          textColor: run.color ?? p.color ?? '#000000',
          fontRef: runFontRef,
          bold: run.bold ?? p.bold ?? (p.heading ? true : undefined),
          italic: run.italic ?? p.italic,
          underline: run.underline ?? p.underline,
        };
        const runChar = addCharPrToHeader(headerXml, runCharOpts);
        headerXml = runChar.xml;

        let runText = run.text;
        if (!prefixApplied && prefix) {
          runText = prefix + runText;
          prefixApplied = true;
        }
        xml += buildTextRunsXml(runChar.id, runText, run.lineBreak === true);
      }

      // If there were no usable runs, still preserve list prefix semantics
      if (!prefixApplied && prefix) {
        const fallbackChar = addCharPrToHeader(headerXml, {
          fontSize: p.fontSize ?? (p.heading ? HWPX_DEFAULTS.document.headingSizesPt[p.heading] : font_size),
          textColor: p.color ?? '#000000',
          fontRef: resolveFontRef(p.fontName),
          bold: p.bold ?? (p.heading ? true : undefined),
          italic: p.italic,
          underline: p.underline,
        });
        headerXml = fallbackChar.xml;
        xml += buildTextRunsXml(fallbackChar.id, prefix, false);
      }

      if (p.lineBreak) {
        const fallbackChar = addCharPrToHeader(headerXml, {
          fontSize: p.fontSize ?? (p.heading ? HWPX_DEFAULTS.document.headingSizesPt[p.heading] : font_size),
          textColor: p.color ?? '#000000',
          fontRef: resolveFontRef(p.fontName),
          bold: p.bold ?? (p.heading ? true : undefined),
          italic: p.italic,
          underline: p.underline,
        });
        headerXml = fallbackChar.xml;
        xml += buildLineBreakRunXml(fallbackChar.id);
      }
    } else {
      const charOpts: CharFormatOptions = {
        fontSize: p.fontSize ?? (p.heading ? HWPX_DEFAULTS.document.headingSizesPt[p.heading] : font_size),
        textColor: p.color ?? '#000000',
        fontRef: resolveFontRef(p.fontName),
        bold: p.bold ?? (p.heading ? true : undefined),
        italic: p.italic,
        underline: p.underline,
      };
      const charResult = addCharPrToHeader(headerXml, charOpts);
      headerXml = charResult.xml;
      xml += buildTextRunsXml(charResult.id, displayText, p.lineBreak === true);
    }

    xml += `  </hp:p>`;
    return xml;
  }

  function processTableBlock(t: HwpxTable): string {
    const rowCount = t.rows.length;
    if (rowCount === 0) return '';
    const colCount = t.rows[0].length;

    // Column widths
    const colWidths = t.columnWidths && t.columnWidths.length === colCount
      ? t.columnWidths.map(w => mmToHwpUnit(w))
      : Array(colCount).fill(Math.floor(contentWidth / colCount));
    const totalWidth = colWidths.reduce((a, b) => a + b, 0);

    // Border fill for cells (SOLID border)
    const cellBorderResult = addBorderFillToHeader(headerXml, {
      borderType: 'SOLID',
      borderWidth: HWPX_DEFAULTS.border.width,
      borderColor: HWPX_DEFAULTS.border.color,
      topBorderType: t.cellBorder?.topBorderType,
      bottomBorderType: t.cellBorder?.bottomBorderType,
      leftBorderType: t.cellBorder?.leftBorderType,
      rightBorderType: t.cellBorder?.rightBorderType,
    });
    headerXml = cellBorderResult.xml;
    const cellBorderFillId = cellBorderResult.id;

    const tableCellFontRef = resolveFontRef(t.cellCharFormat?.fontName);
    const dataCellCharResult = addCharPrToHeader(headerXml, {
      fontSize: t.cellCharFormat?.fontSize ?? font_size,
      textColor: t.cellCharFormat?.color ?? '#000000',
      fontRef: tableCellFontRef,
    });
    headerXml = dataCellCharResult.xml;
    const dataCellCharPrId = dataCellCharResult.id;

    // Header background border fill
    let headerBorderFillId = cellBorderFillId;
    if (t.headerRow && t.headerBackground) {
      const headerBfResult = addBorderFillToHeader(headerXml, {
        backgroundColor: t.headerBackground,
        borderType: 'SOLID',
        borderWidth: HWPX_DEFAULTS.border.width,
        borderColor: HWPX_DEFAULTS.border.color,
        topBorderType: t.cellBorder?.topBorderType,
        bottomBorderType: t.cellBorder?.bottomBorderType,
        leftBorderType: t.cellBorder?.leftBorderType,
        rightBorderType: t.cellBorder?.rightBorderType,
      });
      headerXml = headerBfResult.xml;
      headerBorderFillId = headerBfResult.id;
    }

    // CharPr for header cells (bold, white text if dark background)
    let headerCharPrId = defaultCharPrId;
    if (t.headerRow) {
      const headerCharOpts: CharFormatOptions = {
        fontSize: t.cellCharFormat?.fontSize ?? font_size,
        textColor: t.headerBackground ? '#FFFFFF' : '#000000',
        fontRef: tableCellFontRef,
        bold: true,
      };
      const hcResult = addCharPrToHeader(headerXml, headerCharOpts);
      headerXml = hcResult.xml;
      headerCharPrId = hcResult.id;
    }

    // Build ParsedTable
    const tableData: ParsedTable = {
      id: '',
      rowCnt: rowCount,
      colCnt: colCount,
      totalWidth,
      borderFillIDRef: cellBorderFillId,
      rows: [],
    };

    for (let r = 0; r < rowCount; r++) {
      const isHeader = !!(t.headerRow && r === 0);
      const row: ParsedCell[] = [];
      for (let c = 0; c < colCount; c++) {
        row.push({
          text: t.rows[r]?.[c] ?? '',
          charPrIDRef: isHeader ? headerCharPrId : dataCellCharPrId,
          colAddr: c,
          rowAddr: r,
          colSpan: 1,
          rowSpan: 1,
          width: colWidths[c],
          height: 1609,
          header: isHeader,
          borderFillIDRef: isHeader ? headerBorderFillId : cellBorderFillId,
        });
      }
      tableData.rows.push(row);
    }

    return buildTableXml(tableData, nextId);
  }

  async function processImageBlock(img: HwpxImage): Promise<string | null> {
    const resolvedImgPath = path.resolve(img.path);
    let imgBuf: Buffer;
    try {
      imgBuf = await fs.promises.readFile(resolvedImgPath);
    } catch {
      return null;
    }
    const ext = path.extname(resolvedImgPath).slice(1).toLowerCase();
    const format = ext === 'jpg' ? 'jpeg' : ext;

    // Determine binItem ID
    const binIdMatches = [...headerXml.matchAll(/<hh:binItem\s+id="(\d+)"/g)];
    let maxBinId = 0;
    for (const m of binIdMatches) {
      const id = Number(m[1]);
      if (id > maxBinId) maxBinId = id;
    }
    const binItemId = maxBinId + 1;

    const imgFileName = `image${binItemId}.${ext}`;
    const zipPath = `BinData/${imgFileName}`;
    const mediaType = extToMediaType(ext);
    const manifestId = `img${binItemId}`;

    headerXml = addBinItemToHeader(headerXml, binItemId, zipPath, format);
    imageEntries.push({ zipPath, data: new Uint8Array(imgBuf), manifestId, mediaType });

    const widthHU = img.width_mm ? mmToHwpUnit(img.width_mm) : mmToHwpUnit(HWPX_DEFAULTS.image.widthMm);
    const heightHU = img.height_mm ? mmToHwpUnit(img.height_mm) : mmToHwpUnit(HWPX_DEFAULTS.image.heightMm);

    const paraId = nextId();
    const picId = nextId();
    return buildImagePicXml(paraId, picId, binItemId, widthHU, heightHU, img.text_wrap);
  }

  function processPageBreak(): string {
    // Create a paraPr with pageBreakBefore
    const pbResult = addParaPrToHeader(headerXml, { pageBreakBefore: true });
    headerXml = pbResult.xml;
    const paraPrId = pbResult.id;

    const paraId = nextId();
    return `  <hp:p id="${paraId}" paraPrIDRef="${paraPrId}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
    <hp:run charPrIDRef="0"><hp:t></hp:t></hp:run>
  </hp:p>`;
  }

  function resolveFontRef(fontName?: string): number {
    if (!fontName) return fontId;
    const cached = fontIdCache.get(fontName);
    if (cached !== undefined) return cached;
    const fontResult = addFontToHeader(headerXml, fontName);
    headerXml = fontResult.xml;
    fontIdCache.set(fontName, fontResult.fontId);
    return fontResult.fontId;
  }

  function buildLineBreakRunXml(charPrId: number): string {
    return `    <hp:run charPrIDRef="${charPrId}"><hp:t><hp:lineBreak/></hp:t></hp:run>\n`;
  }

  function buildTextRunsXml(charPrId: number, textValue: string, appendLineBreak: boolean): string {
    const parts = textValue.split('\n');
    let xml = '';
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (part.length > 0 || parts.length === 1) {
        xml += `    <hp:run charPrIDRef="${charPrId}"><hp:t>${escapeXml(part)}</hp:t></hp:run>\n`;
      }
      if (i < parts.length - 1) {
        xml += buildLineBreakRunXml(charPrId);
      }
    }
    if (appendLineBreak) {
      xml += buildLineBreakRunXml(charPrId);
    }
    return xml;
  }

  function extToMediaType(ext: string): string {
    const e = ext.toLowerCase();
    switch (e) {
      case 'jpg':
      case 'jpeg':
        return 'image/jpeg';
      case 'png':
        return 'image/png';
      case 'gif':
        return 'image/gif';
      case 'bmp':
        return 'image/bmp';
      case 'webp':
        return 'image/webp';
      case 'svg':
        return 'image/svg+xml';
      default:
        return `image/${e}`;
    }
  }
}

// ── secPr builder with header/footer ─────────────────────

function buildCustomSecPr(
  width: number,
  height: number,
  marginTop: number,
  marginBottom: number,
  marginLeft: number,
  marginRight: number,
  headerContent: string | HwpxHeaderFooterContent | undefined,
  footerContent: string | HwpxHeaderFooterContent | undefined,
  nextId: () => string,
): string {
  let hfXml = '';
  if (headerContent !== undefined) {
    const paraId = nextId();
    hfXml += '\n' + buildHeaderFooterXml('header', headerContent, paraId, 'CENTER', 0, nextId);
  }
  if (footerContent !== undefined) {
    const paraId = nextId();
    hfXml += '\n' + buildHeaderFooterXml('footer', footerContent, paraId, 'CENTER', 0, nextId);
  }

  return `    <hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">
      <hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/>
      <hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>
      <hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>
      <hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>
      <hp:pagePr landscape="WIDELY" width="${width}" height="${height}" gutterType="LEFT_ONLY">
        <hp:margin header="${HWPX_DEFAULTS.page.marginHeader}" footer="${HWPX_DEFAULTS.page.marginFooter}" gutter="${HWPX_DEFAULTS.page.gutter}" left="${marginLeft}" right="${marginRight}" top="${marginTop}" bottom="${marginBottom}"/>
      </hp:pagePr>
      <hp:footNotePr>
        <hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/>
        <hp:noteLine length="${HWPX_DEFAULTS.page.footNoteLineLength}" type="SOLID" width="${HWPX_DEFAULTS.border.width}" color="${HWPX_DEFAULTS.border.color}"/>
        <hp:noteSpacing betweenNotes="283" belowLine="567" aboveLine="850"/>
        <hp:numbering type="CONTINUOUS" newNum="1"/>
        <hp:placement place="EACH_COLUMN" beneathText="0"/>
      </hp:footNotePr>
      <hp:endNotePr>
        <hp:autoNumFormat type="DIGIT" userChar="" prefixChar="" suffixChar=")" supscript="0"/>
        <hp:noteLine length="${HWPX_DEFAULTS.page.endNoteLineLength}" type="SOLID" width="${HWPX_DEFAULTS.border.width}" color="${HWPX_DEFAULTS.border.color}"/>
        <hp:noteSpacing betweenNotes="0" belowLine="567" aboveLine="850"/>
        <hp:numbering type="CONTINUOUS" newNum="1"/>
        <hp:placement place="END_OF_DOCUMENT" beneathText="0"/>
      </hp:endNotePr>
      <hp:pageBorderFill type="BOTH" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER">
        <hp:offset left="${HWPX_DEFAULTS.page.pageBorderOffset}" right="${HWPX_DEFAULTS.page.pageBorderOffset}" top="${HWPX_DEFAULTS.page.pageBorderOffset}" bottom="${HWPX_DEFAULTS.page.pageBorderOffset}"/>
      </hp:pageBorderFill>
      <hp:pageBorderFill type="EVEN" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER">
        <hp:offset left="${HWPX_DEFAULTS.page.pageBorderOffset}" right="${HWPX_DEFAULTS.page.pageBorderOffset}" top="${HWPX_DEFAULTS.page.pageBorderOffset}" bottom="${HWPX_DEFAULTS.page.pageBorderOffset}"/>
      </hp:pageBorderFill>
      <hp:pageBorderFill type="ODD" borderFillIDRef="1" textBorder="PAPER" headerInside="0" footerInside="0" fillArea="PAPER">
        <hp:offset left="${HWPX_DEFAULTS.page.pageBorderOffset}" right="${HWPX_DEFAULTS.page.pageBorderOffset}" top="${HWPX_DEFAULTS.page.pageBorderOffset}" bottom="${HWPX_DEFAULTS.page.pageBorderOffset}"/>
      </hp:pageBorderFill>${hfXml}
    </hp:secPr>`;
}
