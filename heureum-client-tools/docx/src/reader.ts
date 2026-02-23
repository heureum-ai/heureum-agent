/**
 * Reverse parser: OOXML document.xml → remark AST nodes.
 * Uses regex-based extraction (self-generated XML → predictable structure).
 */

import type { DocxMetadata } from './types.js';
import { DOCX_DEFAULTS } from './configs.js';
import { NUM_ID_ORDERED } from './numbering.js';

// ── XML utility ─────────────────────────────────────────

export function unescapeXml(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

// ── Inline run extraction ───────────────────────────────

interface RawRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  code?: boolean;
  fontName?: string;
  fontSize?: number;
  color?: string;
}

function extractRuns(paragraphXml: string): RawRun[] {
  const runs: RawRun[] = [];

  // Match w:r elements (but not w:r inside w:hyperlink — those will be handled separately)
  const runRe = /<w:r\b[^>]*>([\s\S]*?)<\/w:r>/g;
  let m: RegExpExecArray | null;

  while ((m = runRe.exec(paragraphXml)) !== null) {
    const runXml = m[1];

    // Extract text content from w:t elements
    const textParts: string[] = [];
    const tRe = /<w:t[^>]*>([\s\S]*?)<\/w:t>/g;
    let tm: RegExpExecArray | null;
    while ((tm = tRe.exec(runXml)) !== null) {
      textParts.push(unescapeXml(tm[1]));
    }

    // Check for page break
    if (/<w:br\s+w:type="page"/.test(runXml)) {
      continue; // Skip page break runs
    }

    // Check for line break
    if (/<w:br\s*\/?>/.test(runXml) && !/<w:br\s+w:type=/.test(runXml)) {
      textParts.push('\n');
    }

    const text = textParts.join('');
    if (!text && textParts.length === 0) continue;

    // Parse rPr
    const rPrXml = runXml.match(/<w:rPr>([\s\S]*?)<\/w:rPr>/)?.[1] ?? '';

    const run: RawRun = { text };
    if (/<w:b\s*\/?>/.test(rPrXml) && !/<w:b\s+w:val="0"/.test(rPrXml)) run.bold = true;
    if (/<w:bCs\s*\/?>/.test(rPrXml) && !run.bold && !/<w:bCs\s+w:val="0"/.test(rPrXml)) run.bold = true;
    if (/<w:i\s*\/?>/.test(rPrXml) && !/<w:i\s+w:val="0"/.test(rPrXml)) run.italic = true;
    if (/<w:iCs\s*\/?>/.test(rPrXml) && !run.italic && !/<w:iCs\s+w:val="0"/.test(rPrXml)) run.italic = true;
    if (/<w:u\s/.test(rPrXml)) run.underline = true;

    const fontMatch = rPrXml.match(/<w:rFonts[^>]*w:ascii="([^"]+)"/);
    if (fontMatch) {
      run.fontName = fontMatch[1];
      if (run.fontName === DOCX_DEFAULTS.code.fontName) run.code = true;
    }

    const sizeMatch = rPrXml.match(/<w:sz\s+w:val="(\d+)"/);
    if (sizeMatch) run.fontSize = Number(sizeMatch[1]) / 2;

    const colorMatch = rPrXml.match(/<w:color\s+w:val="([0-9A-Fa-f]{6})"/);
    if (colorMatch) run.color = `#${colorMatch[1]}`;

    runs.push(run);
  }

  return runs;
}

// ── AST node builders ───────────────────────────────────

type MdastNode = Record<string, any>;

function textNode(value: string): MdastNode {
  return { type: 'text', value };
}

function runsToInlineNodes(runs: RawRun[]): MdastNode[] {
  const nodes: MdastNode[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    if (run.code) {
      nodes.push({ type: 'inlineCode', value: run.text });
      continue;
    }
    let node: MdastNode = textNode(run.text);
    if (run.italic) node = { type: 'emphasis', children: [node] };
    if (run.bold) node = { type: 'strong', children: [node] };
    nodes.push(node);
  }
  return nodes;
}

// ── Paragraph-level processing ──────────────────────────

interface ParagraphInfo {
  xml: string;
  runs: RawRun[];
  styleId?: string;
  numId?: number;
  numLevel?: number;
  hasPageBreak?: boolean;
}

function parseParagraphInfo(pXml: string): ParagraphInfo {
  const runs = extractRuns(pXml);
  const pPrXml = pXml.match(/<w:pPr>([\s\S]*?)<\/w:pPr>/)?.[1] ?? '';

  const styleMatch = pPrXml.match(/<w:pStyle\s+w:val="([^"]+)"/);
  const styleId = styleMatch?.[1];

  const numIdMatch = pPrXml.match(/<w:numId\s+w:val="(\d+)"/);
  const numLevelMatch = pPrXml.match(/<w:ilvl\s+w:val="(\d+)"/);
  const numId = numIdMatch ? Number(numIdMatch[1]) : undefined;
  const numLevel = numLevelMatch ? Number(numLevelMatch[1]) : undefined;

  const hasPageBreak = /<w:pageBreakBefore\s*\/?>/.test(pPrXml) ||
    /<w:br\s+w:type="page"/.test(pXml);

  return { xml: pXml, runs, styleId, numId, numLevel, hasPageBreak };
}

function isHeadingStyle(styleId?: string): number | null {
  if (!styleId) return null;
  const m = styleId.match(/^Heading(\d)$/);
  return m ? Number(m[1]) : null;
}

// ── Table parsing ───────────────────────────────────────

function parseTable(tableXml: string): MdastNode | null {
  const rows: MdastNode[] = [];
  const trRe = /<w:tr\b[\s\S]*?<\/w:tr>/g;
  let trm: RegExpExecArray | null;

  while ((trm = trRe.exec(tableXml)) !== null) {
    const rowXml = trm[0];
    const cells: MdastNode[] = [];
    const tcRe = /<w:tc\b[\s\S]*?<\/w:tc>/g;
    let tcm: RegExpExecArray | null;

    while ((tcm = tcRe.exec(rowXml)) !== null) {
      const cellXml = tcm[0];
      // Reuse extractRuns (which uses <w:r\b> to avoid matching <w:rPr> etc.)
      // to properly extract text from cell paragraphs without XML leakage.
      const cellRuns = extractRuns(cellXml);
      const inlineNodes = runsToInlineNodes(cellRuns);
      cells.push({
        type: 'tableCell',
        children: inlineNodes.length > 0 ? inlineNodes : [textNode('')],
      });
    }

    if (cells.length > 0) {
      rows.push({ type: 'tableRow', children: cells });
    }
  }

  if (rows.length === 0) return null;
  return { type: 'table', children: rows };
}

// ── document.xml → AST ─────────────────────────────────

export function parseDocumentXml(
  documentXml: string,
  _stylesXml?: string,
  _numberingXml?: string,
): MdastNode[] {
  const nodes: MdastNode[] = [];

  // Extract w:body content
  const bodyMatch = documentXml.match(/<w:body>([\s\S]*)<\/w:body>/);
  if (!bodyMatch) return nodes;
  const bodyXml = bodyMatch[1];

  // Build sequential element list (paragraphs and tables)
  interface Element {
    type: 'paragraph' | 'table';
    xml: string;
    position: number;
  }

  const elements: Element[] = [];

  // Find tables
  const tblRe = /<w:tbl\b[\s\S]*?<\/w:tbl>/g;
  let tblm: RegExpExecArray | null;
  const tableRanges: Array<{ start: number; end: number }> = [];

  while ((tblm = tblRe.exec(bodyXml)) !== null) {
    elements.push({ type: 'table', xml: tblm[0], position: tblm.index });
    tableRanges.push({ start: tblm.index, end: tblm.index + tblm[0].length });
  }

  // Find paragraphs (outside tables and not containing w:sectPr)
  const pRe = /<w:p\b[^>]*>[\s\S]*?<\/w:p>/g;
  let pm: RegExpExecArray | null;

  while ((pm = pRe.exec(bodyXml)) !== null) {
    const pos = pm.index;
    // Skip paragraphs inside tables
    const insideTable = tableRanges.some((r) => pos >= r.start && pos < r.end);
    if (insideTable) continue;
    // Skip sectPr paragraphs
    if (pm[0].includes('<w:sectPr')) continue;
    elements.push({ type: 'paragraph', xml: pm[0], position: pos });
  }

  elements.sort((a, b) => a.position - b.position);

  // Process elements, merging consecutive list items and code blocks
  let currentList: { ordered: boolean; items: MdastNode[] } | null = null;
  let codeLines: string[] = [];

  function flushCode() {
    if (codeLines.length > 0) {
      nodes.push({ type: 'code', value: codeLines.join('\n') });
      codeLines = [];
    }
  }

  function flushList() {
    if (currentList) {
      nodes.push({
        type: 'list',
        ordered: currentList.ordered,
        ...(currentList.ordered ? { start: 1 } : {}),
        children: currentList.items,
      });
      currentList = null;
    }
  }

  for (const el of elements) {
    if (el.type === 'table') {
      flushCode();
      flushList();
      const tblNode = parseTable(el.xml);
      if (tblNode) nodes.push(tblNode);
      continue;
    }

    const info = parseParagraphInfo(el.xml);

    // Heading
    const headingLevel = isHeadingStyle(info.styleId);
    if (headingLevel !== null) {
      flushCode();
      flushList();
      nodes.push({
        type: 'heading',
        depth: headingLevel,
        children: runsToInlineNodes(info.runs),
      });
      continue;
    }

    // Code block
    if (info.styleId === 'CodeBlock') {
      flushList();
      codeLines.push(info.runs.map((r) => r.text).join(''));
      continue;
    }

    // Blockquote
    if (info.styleId === 'Quote') {
      flushCode();
      flushList();
      nodes.push({
        type: 'blockquote',
        children: [
          {
            type: 'paragraph',
            children: runsToInlineNodes(info.runs),
          },
        ],
      });
      continue;
    }

    // List item
    if (info.numId != null) {
      flushCode();
      const ordered = info.numId === NUM_ID_ORDERED;
      if (currentList && currentList.ordered !== ordered) {
        flushList();
      }
      if (!currentList) {
        currentList = { ordered, items: [] };
      }
      currentList.items.push({
        type: 'listItem',
        children: [
          {
            type: 'paragraph',
            children: runsToInlineNodes(info.runs),
          },
        ],
      });
      continue;
    }

    // Thematic break (paragraph with bottom border)
    if (/<w:bottom\s+w:val="single"/.test(info.xml) && info.runs.length === 0) {
      flushCode();
      flushList();
      nodes.push({ type: 'thematicBreak' });
      continue;
    }

    // Regular paragraph
    flushCode();
    flushList();

    // Skip empty paragraphs
    const text = info.runs.map((r) => r.text).join('').trim();
    if (!text) continue;

    nodes.push({
      type: 'paragraph',
      children: runsToInlineNodes(info.runs),
    });
  }

  flushCode();
  flushList();

  return nodes;
}

// ── core.xml → metadata ─────────────────────────────────

export function parseCoreXml(coreXml: string): DocxMetadata {
  const titleMatch = coreXml.match(/<dc:title>([\s\S]*?)<\/dc:title>/);
  const title = titleMatch ? unescapeXml(titleMatch[1]) : undefined;

  const creatorMatch = coreXml.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/);
  const creator = creatorMatch ? unescapeXml(creatorMatch[1]) : undefined;

  const lastModifiedByMatch = coreXml.match(/<cp:lastModifiedBy>([\s\S]*?)<\/cp:lastModifiedBy>/);
  const lastModifiedBy = lastModifiedByMatch ? unescapeXml(lastModifiedByMatch[1]) : undefined;

  const descriptionMatch = coreXml.match(/<dc:description>([\s\S]*?)<\/dc:description>/);
  const description = descriptionMatch ? unescapeXml(descriptionMatch[1]) : undefined;

  return { title, creator, lastModifiedBy, description };
}
