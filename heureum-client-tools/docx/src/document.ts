/**
 * AST → document.xml body content.
 * Converts remark AST nodes to OOXML WordprocessingML paragraphs.
 */

import { escapeXml } from './template.js';
import { DOCX_DEFAULTS, ptToHalfPt, mmToTwips } from './configs.js';
import { NUM_ID_BULLET, NUM_ID_ORDERED } from './numbering.js';
import {
  buildRPr,
  buildRun,
  buildPPr,
  buildParagraph,
  buildTable,
  buildSectPr,
  buildPageBreak,
  type RunFormatOptions,
  type SectionPropsOptions,
} from './formatter.js';
import type { DocxDocumentOptions } from './types.js';

// ── Inline extraction ───────────────────────────────────

interface InlineRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
}

function extractInlineRuns(node: any, inherited?: { bold?: boolean; italic?: boolean }): InlineRun[] {
  if (node.type === 'text') {
    return [{ text: node.value, bold: inherited?.bold, italic: inherited?.italic }];
  }
  if (node.type === 'inlineCode') {
    return [{ text: node.value, code: true, bold: inherited?.bold, italic: inherited?.italic }];
  }
  if (node.type === 'strong') {
    const children = node.children ?? [];
    return children.flatMap((c: any) =>
      extractInlineRuns(c, { bold: true, italic: inherited?.italic }),
    );
  }
  if (node.type === 'emphasis') {
    const children = node.children ?? [];
    return children.flatMap((c: any) =>
      extractInlineRuns(c, { bold: inherited?.bold, italic: true }),
    );
  }
  if (node.type === 'delete') {
    // strikethrough — treat as plain for now
    const children = node.children ?? [];
    return children.flatMap((c: any) => extractInlineRuns(c, inherited));
  }
  if (node.type === 'link') {
    // Flatten link children as underlined text
    const children = node.children ?? [];
    return children.flatMap((c: any) => extractInlineRuns(c, inherited));
  }
  if (node.type === 'image') {
    // Placeholder text for image in inline context
    return [{ text: node.alt || '[image]', ...inherited }];
  }
  if (node.type === 'html') {
    return [{ text: node.value, ...inherited }];
  }
  if (node.children) {
    return node.children.flatMap((c: any) => extractInlineRuns(c, inherited));
  }
  return [];
}

function inlineRunsToXml(runs: InlineRun[]): string[] {
  return runs.map((run) => {
    const opts: RunFormatOptions = {};
    if (run.bold) opts.bold = true;
    if (run.italic) opts.italic = true;
    if (run.code) {
      opts.fontName = DOCX_DEFAULTS.code.fontName;
      opts.fontSizePt = DOCX_DEFAULTS.code.fontSizePt;
    }
    const rPr = buildRPr(opts);
    return buildRun(run.text, rPr);
  });
}

// ── AST node processors ─────────────────────────────────

function processHeading(node: any): string {
  const depth = node.depth ?? 1;
  const runs = extractInlineRuns({ children: node.children });
  const xmlRuns = runs.map((run) => {
    const headingSize = DOCX_DEFAULTS.document.headingSizesPt[depth] ?? DOCX_DEFAULTS.document.fontSizePt;
    const rPr = buildRPr({
      bold: true,
      italic: run.italic,
      fontSizePt: headingSize,
    });
    return buildRun(run.text, rPr);
  });
  const pPr = buildPPr({ styleId: `Heading${depth}` });
  return buildParagraph(xmlRuns, pPr);
}

function processParagraph(node: any): string {
  const runs = extractInlineRuns({ children: node.children });
  if (runs.length === 0) {
    return buildParagraph([]);
  }
  return buildParagraph(inlineRunsToXml(runs));
}

function processListItems(node: any): string {
  const ordered = node.ordered ?? false;
  const numId = ordered ? NUM_ID_ORDERED : NUM_ID_BULLET;
  const items: string[] = [];

  for (const item of node.children ?? []) {
    if (item.type !== 'listItem') continue;
    const depth = 0;
    items.push(...processListItem(item, numId, depth));
  }

  return items.join('');
}

function processListItem(item: any, numId: number, depth: number): string[] {
  const paragraphs: string[] = [];

  for (const child of item.children ?? []) {
    if (child.type === 'paragraph') {
      const runs = extractInlineRuns({ children: child.children });
      const pPr = buildPPr({
        styleId: 'ListParagraph',
        numId,
        numLevel: depth,
      });
      paragraphs.push(buildParagraph(inlineRunsToXml(runs), pPr));
    } else if (child.type === 'list') {
      // Nested list
      for (const nestedItem of child.children ?? []) {
        if (nestedItem.type === 'listItem') {
          const nestedNumId = child.ordered ? NUM_ID_ORDERED : NUM_ID_BULLET;
          paragraphs.push(...processListItem(nestedItem, nestedNumId, depth + 1));
        }
      }
    }
  }

  return paragraphs;
}

function processCodeBlock(node: any): string {
  const value = node.value ?? '';
  const lines = value.split('\n');
  return lines
    .map((line: string) => {
      const rPr = buildRPr({ fontName: DOCX_DEFAULTS.code.fontName, fontSizePt: DOCX_DEFAULTS.code.fontSizePt });
      const run = buildRun(line, rPr);
      const pPr = buildPPr({ styleId: 'CodeBlock' });
      return buildParagraph([run], pPr);
    })
    .join('');
}

function processBlockquote(node: any): string {
  const paragraphs: string[] = [];

  for (const child of node.children ?? []) {
    if (child.type === 'paragraph') {
      const runs = extractInlineRuns({ children: child.children });
      const pPr = buildPPr({ styleId: 'Quote' });
      paragraphs.push(buildParagraph(inlineRunsToXml(runs), pPr));
    } else {
      // Recursively process nested content
      paragraphs.push(processNode(child));
    }
  }

  return paragraphs.join('');
}

function processTable(node: any): string {
  const rows: string[][] = [];
  for (const row of node.children ?? []) {
    if (row.type !== 'tableRow') continue;
    const cells: string[] = [];
    for (const cell of row.children ?? []) {
      if (cell.type !== 'tableCell') continue;
      const runs = extractInlineRuns({ children: cell.children });
      cells.push(runs.map((r) => r.text).join(''));
    }
    rows.push(cells);
  }

  if (rows.length === 0) return '';

  return buildTable({
    rows,
    headerRow: true,
  });
}

function processThematicBreak(): string {
  // Horizontal rule as a paragraph with bottom border
  return `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="auto"/></w:pBdr><w:spacing w:after="0"/></w:pPr></w:p>`;
}

function processNode(node: any): string {
  switch (node.type) {
    case 'heading':
      return processHeading(node);
    case 'paragraph':
      return processParagraph(node);
    case 'list':
      return processListItems(node);
    case 'code':
      return processCodeBlock(node);
    case 'blockquote':
      return processBlockquote(node);
    case 'table':
      return processTable(node);
    case 'thematicBreak':
      return processThematicBreak();
    case 'html':
      // Pass through as a plain text paragraph
      return buildParagraph([buildRun(node.value ?? '')]);
    case 'yaml':
      // Skip frontmatter
      return '';
    default:
      return '';
  }
}

// ── Public: build document.xml ──────────────────────────

export function buildDocumentXml(
  astChildren: any[],
  opts?: DocxDocumentOptions,
): string {
  const bodyContent = astChildren.map(processNode).join('');

  const sectPrOpts: SectionPropsOptions = {};
  if (opts?.pageWidth) sectPrOpts.pageWidth = opts.pageWidth;
  if (opts?.pageHeight) sectPrOpts.pageHeight = opts.pageHeight;
  if (opts?.marginTop) sectPrOpts.marginTop = opts.marginTop;
  if (opts?.marginBottom) sectPrOpts.marginBottom = opts.marginBottom;
  if (opts?.marginLeft) sectPrOpts.marginLeft = opts.marginLeft;
  if (opts?.marginRight) sectPrOpts.marginRight = opts.marginRight;

  const sectPr = buildSectPr(sectPrOpts);

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
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
${bodyContent}
    ${sectPr}
  </w:body>
</w:document>`;
}
