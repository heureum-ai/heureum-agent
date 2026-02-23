/**
 * Generates section0.xml from remark AST nodes.
 * Maps markdown elements to HWPX paragraph/run/table XML.
 */

import { COMMON_NS, escapeXml } from './template.js';
import { HWPX_DEFAULTS, HWPX_PAGE_SIZES } from './configs.js';
import type { HwpxDocumentOptions } from './types.js';

// charPr ID constants matching header.ts definitions
const CHAR_BODY = 0;
const CHAR_BOLD = 1;
const CHAR_ITALIC = 2;
const CHAR_BOLD_ITALIC = 3;
const CHAR_H1 = 4;
// H2=5, H3=6, H4=7, H5=8, H6=9
const CHAR_CODE = 10;
const CHAR_QUOTE = 11;

function headingCharPrId(depth: number): number {
  // H1=4, H2=5, ... H6=9
  return CHAR_H1 + Math.min(depth - 1, 5);
}

// paraPr ID constants matching header.ts definitions
// H1=1, H2=2, ... H6=6
function headingParaPrId(depth: number): number {
  return Math.min(Math.max(depth, 1), 6);
}

interface InlineRun {
  text: string;
  charPrId: number;
}

/** Extract inline runs from a remark paragraph/heading child nodes, handling bold/italic nesting. */
function extractInlineRuns(children: any[], baseCharPr: number = CHAR_BODY): InlineRun[] {
  const runs: InlineRun[] = [];

  for (const child of children) {
    switch (child.type) {
      case 'text':
        if (child.value) {
          runs.push({ text: child.value, charPrId: baseCharPr });
        }
        break;

      case 'strong': {
        const strongBase = baseCharPr === CHAR_ITALIC ? CHAR_BOLD_ITALIC
          : baseCharPr === CHAR_BOLD_ITALIC ? CHAR_BOLD_ITALIC
          : CHAR_BOLD;
        runs.push(...extractInlineRuns(child.children || [], strongBase));
        break;
      }

      case 'emphasis': {
        const emBase = baseCharPr === CHAR_BOLD ? CHAR_BOLD_ITALIC
          : baseCharPr === CHAR_BOLD_ITALIC ? CHAR_BOLD_ITALIC
          : CHAR_ITALIC;
        runs.push(...extractInlineRuns(child.children || [], emBase));
        break;
      }

      case 'inlineCode':
        runs.push({ text: child.value || '', charPrId: CHAR_CODE });
        break;

      case 'link':
        // Render link text, ignore URL
        runs.push(...extractInlineRuns(child.children || [], baseCharPr));
        break;

      case 'delete':
        // Strikethrough - render as plain text
        runs.push(...extractInlineRuns(child.children || [], baseCharPr));
        break;

      case 'break':
        runs.push({ text: '\n', charPrId: baseCharPr });
        break;

      default:
        // Fallback: try to extract text value
        if (child.value) {
          runs.push({ text: child.value, charPrId: baseCharPr });
        } else if (child.children) {
          runs.push(...extractInlineRuns(child.children, baseCharPr));
        }
        break;
    }
  }

  return runs;
}

/** Get plain text from AST node recursively */
function getPlainText(node: any): string {
  if (node.value) return node.value;
  if (node.children) {
    return node.children.map(getPlainText).join('');
  }
  return '';
}

let _paraIdCounter = 0;
function nextParaId(): string {
  return String(2147483648 + (_paraIdCounter++));
}

/** Reset paragraph ID counter (for testing) */
export function resetParaIdCounter(): void {
  _paraIdCounter = 0;
}

function buildRunXml(charPrId: number, text: string): string {
  return `    <hp:run charPrIDRef="${charPrId}"><hp:t>${escapeXml(text)}</hp:t></hp:run>`;
}

function buildParagraphXml(runs: InlineRun[], paraPrId: number = 0, styleId: number = 0): string {
  const id = nextParaId();
  let xml = `  <hp:p id="${id}" paraPrIDRef="${paraPrId}" styleIDRef="${styleId}" pageBreak="0" columnBreak="0" merged="0">\n`;
  for (const run of runs) {
    xml += buildRunXml(run.charPrId, run.text) + '\n';
  }
  xml += `  </hp:p>`;
  return xml;
}

/** Build an empty paragraph (useful as spacer) */
function buildEmptyParagraph(): string {
  const id = nextParaId();
  return `  <hp:p id="${id}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">
    <hp:run charPrIDRef="0"><hp:t></hp:t></hp:run>
  </hp:p>`;
}

function processHeading(node: any): string {
  const depth = node.depth || 1;
  const charPr = headingCharPrId(depth);
  const paraPr = headingParaPrId(depth);
  const runs = extractInlineRuns(node.children || [], charPr);
  if (runs.length === 0) {
    runs.push({ text: '', charPrId: charPr });
  }
  return buildParagraphXml(runs, paraPr);
}

function processParagraph(node: any): string {
  const runs = extractInlineRuns(node.children || [], CHAR_BODY);
  if (runs.length === 0) {
    runs.push({ text: '', charPrId: CHAR_BODY });
  }
  return buildParagraphXml(runs);
}

function processListItems(node: any, ordered: boolean, startNum: number = 1): string[] {
  const paragraphs: string[] = [];
  const items = node.children || [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (item.type !== 'listItem') continue;

    const prefix = ordered ? `${startNum + i}. ` : '• ';
    const content = item.children || [];

    for (const child of content) {
      if (child.type === 'paragraph') {
        const runs = extractInlineRuns(child.children || [], CHAR_BODY);
        // Prepend bullet/number prefix to first run
        if (runs.length > 0) {
          runs[0] = { text: prefix + runs[0].text, charPrId: runs[0].charPrId };
        } else {
          runs.push({ text: prefix, charPrId: CHAR_BODY });
        }
        paragraphs.push(buildParagraphXml(runs));
      } else if (child.type === 'list') {
        // Nested list
        paragraphs.push(...processListItems(child, child.ordered || false, child.start || 1));
      }
    }
  }

  return paragraphs;
}

function processCodeBlock(node: any): string[] {
  const code = node.value || '';
  const lines = code.split('\n');
  return lines.map((line: string) =>
    buildParagraphXml([{ text: line, charPrId: CHAR_CODE }])
  );
}

function processBlockquote(node: any): string[] {
  const paragraphs: string[] = [];
  const children = node.children || [];

  for (const child of children) {
    if (child.type === 'paragraph') {
      const text = getPlainText(child);
      paragraphs.push(
        buildParagraphXml([{ text: `▎ ${text}`, charPrId: CHAR_QUOTE }])
      );
    } else if (child.type === 'blockquote') {
      // Nested blockquote
      paragraphs.push(...processBlockquote(child));
    }
  }

  return paragraphs;
}

function processTable(node: any): string {
  const rows = node.children || [];
  const rowCount = rows.length;
  const colCount = rows[0]?.children?.length || 1;

  // Calculate column widths (equal distribution, total ~50000 HWPUNIT)
  const totalWidth = HWPX_DEFAULTS.table.totalWidth;
  const colWidth = Math.floor(totalWidth / colCount);

  const tblId = nextParaId();
  let xml = `  <hp:tbl id="${tblId}" numberingType="TABLE" textWrap="${HWPX_DEFAULTS.table.textWrap}" textFlow="${HWPX_DEFAULTS.table.textFlow}" lock="0" pageBreak="CELL" repeatHeader="1" rowCnt="${rowCount}" colCnt="${colCount}" cellSpacing="0" borderFillIDRef="1" noAdjust="0">\n`;
  xml += `    <hp:sz width="${totalWidth}" widthRelTo="ABSOLUTE" height="0" heightRelTo="ABSOLUTE" protect="0"/>\n`;
  xml += `    <hp:pos treatAsChar="1" affectLSpacing="0" flowWithText="1" allowOverlap="0" holdAnchorAndSO="0" vertRelTo="PARA" horzRelTo="PARA" vertAlign="TOP" horzAlign="LEFT" vertOffset="0" horzOffset="0"/>\n`;
  xml += `    <hp:outMargin left="0" right="0" top="0" bottom="0"/>\n`;
  xml += `    <hp:inMargin left="510" right="510" top="141" bottom="141"/>\n`;

  for (let r = 0; r < rowCount; r++) {
    const row = rows[r];
    const cells = row?.children || [];
    xml += `    <hp:tr>\n`;

    for (let c = 0; c < colCount; c++) {
      const cell = cells[c];
      const cellText = cell ? getPlainText(cell) : '';
      const cellParaId = nextParaId();

      xml += `      <hp:tc name="" header="${r === 0 ? '1' : '0'}" hasMargin="1" protect="0" editable="0" dirty="0" borderFillIDRef="1">\n`;
      xml += `        <hp:subList id="" textDirection="HORIZONTAL" lineWrap="SQUEEZE" vertAlign="CENTER" linkListIDRef="0" linkListNextIDRef="0" textWidth="0" textHeight="0" hasTextRef="0" hasNumRef="0">\n`;
      xml += `          <hp:p id="${cellParaId}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">\n`;
      xml += `            <hp:run charPrIDRef="0"><hp:t>${escapeXml(cellText)}</hp:t></hp:run>\n`;
      xml += `          </hp:p>\n`;
      xml += `        </hp:subList>\n`;
      xml += `        <hp:cellAddr colAddr="${c}" rowAddr="${r}"/>\n`;
      xml += `        <hp:cellSpan colSpan="1" rowSpan="1"/>\n`;
      xml += `        <hp:cellSz width="${colWidth}" height="1609"/>\n`;
      xml += `        <hp:cellMargin left="0" right="0" top="0" bottom="0"/>\n`;
      xml += `      </hp:tc>\n`;
    }

    xml += `    </hp:tr>\n`;
  }

  xml += `  </hp:tbl>`;
  return xml;
}

function processThematicBreak(): string {
  return buildParagraphXml([{ text: '────────────────────────────────', charPrId: CHAR_BODY }]);
}

function processNode(node: any): string[] {
  switch (node.type) {
    case 'heading':
      return [processHeading(node)];

    case 'paragraph':
      return [processParagraph(node)];

    case 'list':
      return processListItems(node, node.ordered || false, node.start || 1);

    case 'code':
      return processCodeBlock(node);

    case 'blockquote':
      return processBlockquote(node);

    case 'table':
      return [processTable(node)];

    case 'thematicBreak':
      return [processThematicBreak()];

    case 'yaml':
    case 'toml':
    case 'html':
      // Skip frontmatter and raw HTML
      return [];

    default:
      return [];
  }
}

export function buildSecPr(options?: HwpxDocumentOptions): string {
  const width = options?.pageWidth ?? HWPX_PAGE_SIZES[HWPX_DEFAULTS.document.pageSize].width;
  const height = options?.pageHeight ?? HWPX_PAGE_SIZES[HWPX_DEFAULTS.document.pageSize].height;
  const top = options?.marginTop ?? HWPX_DEFAULTS.page.marginTop;
  const bottom = options?.marginBottom ?? HWPX_DEFAULTS.page.marginBottom;
  const left = options?.marginLeft ?? HWPX_DEFAULTS.page.marginLeft;
  const right = options?.marginRight ?? HWPX_DEFAULTS.page.marginRight;

  return `    <hp:secPr id="" textDirection="HORIZONTAL" spaceColumns="1134" tabStop="8000" tabStopVal="4000" tabStopUnit="HWPUNIT" outlineShapeIDRef="1" memoShapeIDRef="0" textVerticalWidthHead="0" masterPageCnt="0">
      <hp:grid lineGrid="0" charGrid="0" wonggojiFormat="0"/>
      <hp:startNum pageStartsOn="BOTH" page="0" pic="0" tbl="0" equation="0"/>
      <hp:visibility hideFirstHeader="0" hideFirstFooter="0" hideFirstMasterPage="0" border="SHOW_ALL" fill="SHOW_ALL" hideFirstPageNum="0" hideFirstEmptyLine="0" showLineNumber="0"/>
      <hp:lineNumberShape restartType="0" countBy="0" distance="0" startNumber="0"/>
      <hp:pagePr landscape="WIDELY" width="${width}" height="${height}" gutterType="LEFT_ONLY">
        <hp:margin header="${HWPX_DEFAULTS.page.marginHeader}" footer="${HWPX_DEFAULTS.page.marginFooter}" gutter="${HWPX_DEFAULTS.page.gutter}" left="${left}" right="${right}" top="${top}" bottom="${bottom}"/>
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
      </hp:pageBorderFill>
    </hp:secPr>`;
}

export function buildSectionXml(astNodes: any[], options?: HwpxDocumentOptions): string {
  // Reset paragraph counter for each section generation
  resetParaIdCounter();

  const secPr = buildSecPr(options);

  // First paragraph contains secPr (required by HWPX format)
  const firstParaId = nextParaId();
  let xml = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n`;
  xml += `<hs:sec ${COMMON_NS}>\n`;
  xml += `  <hp:p id="${firstParaId}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">\n`;
  xml += `    <hp:run charPrIDRef="0">\n`;
  xml += secPr + '\n';
  xml += `      <hp:ctrl>\n`;
  xml += `        <hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/>\n`;
  xml += `      </hp:ctrl>\n`;
  xml += `    </hp:run>\n`;
  xml += `  </hp:p>\n`;

  // Process all AST nodes
  for (const node of astNodes) {
    const paragraphs = processNode(node);
    for (const p of paragraphs) {
      xml += p + '\n';
    }
  }

  // End with an empty paragraph if there's content (mimics Hangul behavior)
  if (astNodes.length > 0) {
    xml += buildEmptyParagraph() + '\n';
  }

  xml += `</hs:sec>`;
  return xml;
}
