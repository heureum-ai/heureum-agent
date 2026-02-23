/**
 * Reverse parser: HWPX XML → remark AST nodes.
 * Phase 1: regex-based extraction (self-generated XML → predictable structure).
 */

import type { HwpxMetadata } from './types.js';

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
  charPrId: number;
  text: string;
  style?: CharPrStyle;
}

interface CharPrStyle {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  fontSize?: number; // pt
  color?: string;
  fontRef?: number;
  fontName?: string;
}

interface ParaPrStyle {
  alignment?: 'LEFT' | 'CENTER' | 'RIGHT' | 'JUSTIFY';
}

function parseFontLookup(headerXml: string): Map<number, string> {
  const lookup = new Map<number, string>();
  const fontfaceXml = headerXml.match(/<hh:fontface\s+lang="HANGUL"[\s\S]*?<\/hh:fontface>/)?.[0];
  if (!fontfaceXml) return lookup;
  for (const m of fontfaceXml.matchAll(/<hh:font\s+id="(\d+)"\s+face="([^"]+)"/g)) {
    lookup.set(Number(m[1]), m[2]);
  }
  return lookup;
}

function parseCharPrLookup(headerXml: string, fontLookup?: Map<number, string>): Map<number, CharPrStyle> {
  const lookup = new Map<number, CharPrStyle>();
  const charPrRe = /<hh:charPr\s+id="(\d+)"([^>]*)>([\s\S]*?)<\/hh:charPr>/g;
  let m: RegExpExecArray | null;
  while ((m = charPrRe.exec(headerXml)) !== null) {
    const id = Number(m[1]);
    const openAttrs = m[2] ?? '';
    const body = m[3] ?? '';
    const style: CharPrStyle = {};

    if (/\bbold="1"/.test(openAttrs)) style.bold = true;
    if (/\bitalic="1"/.test(openAttrs)) style.italic = true;
    if (/\bunderline="1"/.test(openAttrs)) style.underline = true;

    const heightMatch = openAttrs.match(/\bheight="(\d+)"/);
    if (heightMatch) style.fontSize = Number(heightMatch[1]) / 100;

    const colorMatch = openAttrs.match(/\btextColor="(#[0-9A-Fa-f]{6})"/);
    if (colorMatch) style.color = colorMatch[1];

    const fontRefMatch = body.match(/<hh:fontRef\s+hangul="(\d+)"/);
    if (fontRefMatch) {
      style.fontRef = Number(fontRefMatch[1]);
      if (fontLookup?.has(style.fontRef)) style.fontName = fontLookup.get(style.fontRef);
    }

    lookup.set(id, style);
  }
  return lookup;
}

function parseParaPrLookup(headerXml: string): Map<number, ParaPrStyle> {
  const lookup = new Map<number, ParaPrStyle>();
  const paraPrRe = /<hh:paraPr\s+id="(\d+)"[\s\S]*?<\/hh:paraPr>/g;
  let m: RegExpExecArray | null;
  while ((m = paraPrRe.exec(headerXml)) !== null) {
    const id = Number(m[1]);
    const xml = m[0];
    const align = xml.match(/<hh:align\s+horizontal="(LEFT|CENTER|RIGHT|JUSTIFY)"/)?.[1];
    lookup.set(id, { alignment: align as ParaPrStyle['alignment'] | undefined });
  }
  return lookup;
}

function extractRuns(paragraphXml: string, charPrLookup?: Map<number, CharPrStyle>): RawRun[] {
  const runs: RawRun[] = [];
  const runRe = /<hp:run\s+charPrIDRef="(\d+)"[^>]*>\s*<hp:t>([\s\S]*?)<\/hp:t>\s*<\/hp:run>/g;
  let m: RegExpExecArray | null;
  while ((m = runRe.exec(paragraphXml)) !== null) {
    const charPrId = Number(m[1]);
    const text = unescapeXml(m[2].replace(/<hp:lineBreak\s*\/>/g, '\n'));
    runs.push({ charPrId, text, style: charPrLookup?.get(charPrId) });
  }
  return runs;
}

// ── AST node builders ───────────────────────────────────

type MdastNode = Record<string, any>;

function textNode(value: string): MdastNode {
  return { type: 'text', value };
}

function htmlNode(value: string): MdastNode {
  return { type: 'html', value };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function wrapRunMarkup(baseHtml: string, bold?: boolean, italic?: boolean): string {
  let html = baseHtml;
  if (bold) html = `<strong>${html}</strong>`;
  if (italic) html = `<em>${html}</em>`;
  return html;
}

function hasNonDefaultColor(color?: string): boolean {
  return !!color && color.toUpperCase() !== '#000000';
}

function hasRichRunStyle(style?: CharPrStyle): boolean {
  if (!style) return false;
  return !!(
    style.underline
    || hasNonDefaultColor(style.color)
    || style.fontName
    || (style.fontSize !== undefined && style.fontSize !== 10)
  );
}

function runToHtml(run: RawRun): string {
  const txt = escapeHtml(run.text).replace(/\n/g, '<br/>');
  const style = run.style;

  // Fallback for legacy fixed IDs when header.xml is unavailable.
  if (!style) {
    if (run.charPrId === 1) return '<strong>' + txt + '</strong>';
    if (run.charPrId === 2) return '<em>' + txt + '</em>';
    if (run.charPrId === 3) return '<em><strong>' + txt + '</strong></em>';
    return txt;
  }

  const css: string[] = [];
  if (style.underline) css.push('text-decoration: underline');
  if (hasNonDefaultColor(style.color)) css.push(`color: ${style.color}`);
  if (style.fontSize !== undefined && style.fontSize !== 10) css.push(`font-size: ${style.fontSize}pt`);
  if (style.fontName) css.push(`font-family: '${escapeHtml(style.fontName)}'`);

  const formatted = wrapRunMarkup(txt, style.bold, style.italic);
  if (css.length === 0) return formatted;
  return `<span style="${css.join('; ')}">${formatted}</span>`;
}

function runsToInlineHtml(runs: RawRun[]): string {
  return runs.map(runToHtml).join('');
}

function runsToInlineNodes(runs: RawRun[]): MdastNode[] {
  const nodes: MdastNode[] = [];
  for (const run of runs) {
    const txt = run.text;
    if (!txt && txt !== '') continue;
    if (hasRichRunStyle(run.style)) {
      nodes.push(htmlNode(runToHtml(run)));
      continue;
    }
    if (run.style) {
      if (run.style.bold && run.style.italic) {
        nodes.push({ type: 'strong', children: [{ type: 'emphasis', children: [textNode(txt)] }] });
      } else if (run.style.bold) {
        nodes.push({ type: 'strong', children: [textNode(txt)] });
      } else if (run.style.italic) {
        nodes.push({ type: 'emphasis', children: [textNode(txt)] });
      } else {
        nodes.push(textNode(txt));
      }
      continue;
    }

    // Fallback for legacy fixed IDs when header.xml is unavailable.
    if (run.charPrId === 1) {
      nodes.push({ type: 'strong', children: [textNode(txt)] });
    } else if (run.charPrId === 2) {
      nodes.push({ type: 'emphasis', children: [textNode(txt)] });
    } else if (run.charPrId === 3) {
      nodes.push({ type: 'strong', children: [{ type: 'emphasis', children: [textNode(txt)] }] });
    } else {
      nodes.push(textNode(txt));
    }
  }
  return nodes;
}

// ── Paragraph-level processing ──────────────────────────

function isHeadingParagraph(runs: RawRun[]): number | null {
  if (runs.length === 0) return null;
  const id = runs[0].charPrId;
  if (id >= 4 && id <= 9) return id - 3; // depth 1-6
  return null;
}

function isCodeParagraph(runs: RawRun[]): boolean {
  return runs.length > 0 && runs.every(r => r.charPrId === 10);
}

function isBlockquoteParagraph(runs: RawRun[]): boolean {
  return runs.length > 0 && runs.every(r => r.charPrId === 11);
}

function isThematicBreak(runs: RawRun[]): boolean {
  if (runs.length !== 1) return false;
  return runs[0].text.startsWith('────');
}

function isBulletList(runs: RawRun[]): boolean {
  if (runs.length === 0) return false;
  return runs[0].text.startsWith('• ');
}

function isOrderedList(runs: RawRun[]): boolean {
  if (runs.length === 0) return false;
  return /^\d+\.\s/.test(runs[0].text);
}

function stripListPrefix(runs: RawRun[]): RawRun[] {
  if (runs.length === 0) return runs;
  const first = { ...runs[0] };
  if (first.text.startsWith('• ')) {
    first.text = first.text.slice(2);
  } else {
    const m = first.text.match(/^\d+\.\s/);
    if (m) first.text = first.text.slice(m[0].length);
  }
  return [first, ...runs.slice(1)];
}

function stripBlockquotePrefix(runs: RawRun[]): RawRun[] {
  if (runs.length === 0) return runs;
  const first = { ...runs[0] };
  if (first.text.startsWith('▎ ')) {
    first.text = first.text.slice(2);
  }
  return [first, ...runs.slice(1)];
}

// ── Table parsing ───────────────────────────────────────

function parseTable(tableXml: string): MdastNode | null {
  const rowRe = /<hp:tr>([\s\S]*?)<\/hp:tr>/g;
  const rows: MdastNode[] = [];
  let rm: RegExpExecArray | null;

  while ((rm = rowRe.exec(tableXml)) !== null) {
    const rowContent = rm[1];
    const cellRe = /<hp:tc[\s\S]*?<\/hp:tc>/g;
    const cells: MdastNode[] = [];
    let cm: RegExpExecArray | null;

    while ((cm = cellRe.exec(rowContent)) !== null) {
      const cellXml = cm[0];
      const textParts = [...cellXml.matchAll(/<hp:t>([\s\S]*?)<\/hp:t>/g)].map((m) =>
        unescapeXml(m[1].replace(/<hp:lineBreak\s*\/>/g, '\n')),
      );
      const cellText = textParts.join('');
      cells.push({
        type: 'tableCell',
        children: [textNode(cellText)],
      });
    }

    if (cells.length > 0) {
      rows.push({ type: 'tableRow', children: cells });
    }
  }

  if (rows.length === 0) return null;
  return { type: 'table', children: rows };
}

// ── Section XML → AST ───────────────────────────────────

interface ParagraphBlock {
  type: 'paragraph';
  xml: string;
  runs: RawRun[];
  paraPrId?: number;
  paraStyle?: ParaPrStyle;
}

function extractParagraphs(
  sectionXml: string,
  charPrLookup?: Map<number, CharPrStyle>,
  paraPrLookup?: Map<number, ParaPrStyle>,
): ParagraphBlock[] {
  const blocks: ParagraphBlock[] = [];
  // Match top-level <hp:p> elements (not inside <hp:tbl>)
  const pRe = /<hp:p\s+id="[^"]*"[^>]*>[\s\S]*?<\/hp:p>/g;
  let m: RegExpExecArray | null;

  while ((m = pRe.exec(sectionXml)) !== null) {
    const xml = m[0];
    // Skip paragraphs inside tables (they'll be handled by table parser)
    // Skip secPr paragraphs (contain <hp:secPr>)
    if (xml.includes('<hp:secPr')) continue;

    const runs = extractRuns(xml, charPrLookup);
    const paraPrRaw = xml.match(/\bparaPrIDRef="(\d+)"/)?.[1];
    const paraPrId = paraPrRaw !== undefined ? Number(paraPrRaw) : undefined;
    blocks.push({
      type: 'paragraph',
      xml,
      runs,
      paraPrId,
      paraStyle: paraPrId !== undefined ? paraPrLookup?.get(paraPrId) : undefined,
    });
  }

  return blocks;
}

export function parseSectionXml(sectionXml: string, headerXml?: string): MdastNode[] {
  const nodes: MdastNode[] = [];
  const fontLookup = headerXml ? parseFontLookup(headerXml) : undefined;
  const charPrLookup = headerXml ? parseCharPrLookup(headerXml, fontLookup) : undefined;
  const paraPrLookup = headerXml ? parseParaPrLookup(headerXml) : undefined;

  // 1. Extract tables first and replace with placeholders
  const tablePositions: { start: number; end: number; node: MdastNode }[] = [];
  const tblRe = /<hp:tbl[\s\S]*?<\/hp:tbl>/g;
  let tm: RegExpExecArray | null;

  while ((tm = tblRe.exec(sectionXml)) !== null) {
    const tblNode = parseTable(tm[0]);
    if (tblNode) {
      tablePositions.push({ start: tm.index, end: tm.index + tm[0].length, node: tblNode });
    }
  }

  // 2. Remove table content from section for paragraph extraction
  let cleanedXml = sectionXml;
  for (let i = tablePositions.length - 1; i >= 0; i--) {
    const tp = tablePositions[i];
    cleanedXml = cleanedXml.slice(0, tp.start) + `<!--TABLE_${i}-->` + cleanedXml.slice(tp.end);
  }

  // 3. Extract paragraphs from cleaned XML
  const paragraphs = extractParagraphs(cleanedXml, charPrLookup, paraPrLookup);

  // Build a sequential list of elements with their positions in original XML
  interface Element {
    type: 'paragraph' | 'table';
    data: ParagraphBlock | MdastNode;
    position: number;
  }

  const elements: Element[] = [];
  // Add table positions
  for (let i = 0; i < tablePositions.length; i++) {
    elements.push({ type: 'table', data: tablePositions[i].node, position: tablePositions[i].start });
  }

  // For paragraphs, find their position in the original XML
  const pRe = /<hp:p\s+id="[^"]*"[^>]*>[\s\S]*?<\/hp:p>/g;
  let pm: RegExpExecArray | null;
  let pIdx = 0;

  while ((pm = pRe.exec(cleanedXml)) !== null) {
    const xml = pm[0];
    if (xml.includes('<hp:secPr') || xml.includes('<!--TABLE_')) continue;
    if (pIdx < paragraphs.length) {
      elements.push({ type: 'paragraph', data: paragraphs[pIdx], position: pm.index });
      pIdx++;
    }
  }

  // Sort by position
  elements.sort((a, b) => a.position - b.position);

  // 4. Convert elements to AST nodes, merging consecutive same-type blocks
  let codeLines: string[] = [];
  let bulletItems: MdastNode[] = [];
  let orderedItems: MdastNode[] = [];
  let blockquoteChildren: MdastNode[] = [];

  function flushCode() {
    if (codeLines.length > 0) {
      nodes.push({ type: 'code', value: codeLines.join('\n') });
      codeLines = [];
    }
  }

  function flushBulletList() {
    if (bulletItems.length > 0) {
      nodes.push({ type: 'list', ordered: false, children: bulletItems });
      bulletItems = [];
    }
  }

  function flushOrderedList() {
    if (orderedItems.length > 0) {
      nodes.push({ type: 'list', ordered: true, start: 1, children: orderedItems });
      orderedItems = [];
    }
  }

  function flushBlockquote() {
    if (blockquoteChildren.length > 0) {
      nodes.push({ type: 'blockquote', children: blockquoteChildren });
      blockquoteChildren = [];
    }
  }

  function flushAll() {
    flushCode();
    flushBulletList();
    flushOrderedList();
    flushBlockquote();
  }

  for (const el of elements) {
    if (el.type === 'table') {
      flushAll();
      nodes.push(el.data as MdastNode);
      continue;
    }

    const block = el.data as ParagraphBlock;
    const { runs } = block;
    const paraAlign = block.paraStyle?.alignment;
    const needsAlignedParagraph = paraAlign === 'CENTER' || paraAlign === 'RIGHT';

    // Skip empty paragraphs (spacers)
    if (runs.length === 0 || (runs.length === 1 && runs[0].text === '')) {
      continue;
    }

    // Thematic break
    if (isThematicBreak(runs)) {
      flushAll();
      nodes.push({ type: 'thematicBreak' });
      continue;
    }

    // Heading
    const headingDepth = isHeadingParagraph(runs);
    if (headingDepth !== null) {
      flushAll();
      nodes.push({
        type: 'heading',
        depth: headingDepth,
        children: runsToInlineNodes(runs),
      });
      continue;
    }

    // Code block (merge consecutive)
    if (isCodeParagraph(runs)) {
      flushBulletList();
      flushOrderedList();
      flushBlockquote();
      codeLines.push(runs.map(r => r.text).join(''));
      continue;
    }

    // Blockquote
    if (isBlockquoteParagraph(runs)) {
      flushCode();
      flushBulletList();
      flushOrderedList();
      const stripped = stripBlockquotePrefix(runs);
      blockquoteChildren.push({
        type: 'paragraph',
        children: [textNode(stripped.map(r => r.text).join(''))],
      });
      continue;
    }

    // Bullet list
    if (isBulletList(runs)) {
      flushCode();
      flushOrderedList();
      flushBlockquote();
      const stripped = stripListPrefix(runs);
      bulletItems.push({
        type: 'listItem',
        children: [{ type: 'paragraph', children: runsToInlineNodes(stripped) }],
      });
      continue;
    }

    // Ordered list
    if (isOrderedList(runs)) {
      flushCode();
      flushBulletList();
      flushBlockquote();
      const stripped = stripListPrefix(runs);
      orderedItems.push({
        type: 'listItem',
        children: [{ type: 'paragraph', children: runsToInlineNodes(stripped) }],
      });
      continue;
    }

    // Regular paragraph
    flushAll();
    if (needsAlignedParagraph) {
      const cssAlign = paraAlign.toLowerCase();
      nodes.push({
        type: 'html',
        value: `<p style="text-align: ${cssAlign}">${runsToInlineHtml(runs)}</p>`,
      });
      continue;
    }
    nodes.push({
      type: 'paragraph',
      children: runsToInlineNodes(runs),
    });
  }

  flushAll();
  return nodes;
}

// ── content.hpf → metadata ─────────────────────────────

export function parseContentHpf(hpfXml: string): HwpxMetadata {
  const titleMatch = hpfXml.match(/<opf:title>([\s\S]*?)<\/opf:title>/);
  const title = titleMatch ? unescapeXml(titleMatch[1]) : undefined;

  const langMatch = hpfXml.match(/<opf:language>([\s\S]*?)<\/opf:language>/);
  const language = langMatch ? langMatch[1] : undefined;

  const creatorMatch = hpfXml.match(/<opf:meta\s+name="creator"[^>]*>([\s\S]*?)<\/opf:meta>/);
  const creator = creatorMatch ? creatorMatch[1] : undefined;

  // Count section references
  const sectionMatches = hpfXml.match(/id="section\d+"/g);
  const sectionCount = sectionMatches ? sectionMatches.length : 1;

  return { title, language, creator, sectionCount };
}
