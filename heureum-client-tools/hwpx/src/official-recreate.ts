import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import { hwpxCreateDocument, hwpxSetPageLayout, hwpxInsertImage } from './tools.js';
import { HWPX_DEFAULTS } from './configs.js';

export interface RecreateOfficialArgs {
  raw_dir: string;
  output_path: string;
  temp_output_path?: string;
  font?: string;
  font_size?: number;
}

export interface RecreateOfficialResult {
  success: boolean;
  output: string;
  outputPath?: string;
  metrics?: {
    source: { p: number; tbl: number; pic: number; run: number };
    recreated: { p: number; tbl: number; pic: number; run: number };
  };
}

export async function recreateOfficialDocument(args: RecreateOfficialArgs): Promise<RecreateOfficialResult> {
  try {
    const rawDir = path.resolve(args.raw_dir);
    const outputPath = path.resolve(args.output_path);
    const tempPath = path.resolve(args.temp_output_path || `${outputPath}.tmp.hwpx`);
    const baseFont = args.font ?? HWPX_DEFAULTS.officialRecreate.fontName;
    const baseFontSize = args.font_size ?? HWPX_DEFAULTS.officialRecreate.fontSizePt;

    const sectionXml = (await fs.promises.readFile(path.join(rawDir, 'Contents', 'section0.xml'), 'utf8'));
    const headerXml = (await fs.promises.readFile(path.join(rawDir, 'Contents', 'header.xml'), 'utf8'));
    const hpfXml = (await fs.promises.readFile(path.join(rawDir, 'Contents', 'content.hpf'), 'utf8'));

    const title = (hpfXml.match(/<opf:title>([\s\S]*?)<\/opf:title>/) || [])[1]
      || HWPX_DEFAULTS.officialRecreate.title;
    const binMap = parseBinMap(headerXml, hpfXml);
    const contentResult = buildContent(sectionXml, headerXml, rawDir, binMap);
    const content = contentResult.blocks;
    const pageLayout = parsePageLayout(sectionXml);
    const header = parseHeaderFooterContent(sectionXml, 'header');
    const footer = parseHeaderFooterContent(sectionXml, 'footer');
    const imageSpecs = parseImageSpecs(sectionXml, binMap, rawDir);
    const postInsertImages = imageSpecs.filter((x) => !contentResult.embeddedImageRefs.has(String(x.ref)));

    const createResult = await hwpxCreateDocument({
      output_path: tempPath,
      title: unescapeXml(title),
      content,
      header,
      footer,
      font: baseFont,
      font_size: baseFontSize,
    });
    if (!createResult.success) {
      return { success: false, output: createResult.output };
    }

    if (pageLayout) {
      const layoutResult = await hwpxSetPageLayout({
        path: tempPath,
        ...pageLayout,
        output_path: outputPath,
      });
      if (!layoutResult.success) {
        return { success: false, output: layoutResult.output };
      }
    } else {
      ;(await fs.promises.copyFile(tempPath, outputPath));
    }

    for (const img of postInsertImages) {
      const ins = await hwpxInsertImage({
        path: outputPath,
        image_path: img.path,
        width_mm: img.width_mm,
        height_mm: img.height_mm,
        text_wrap: img.text_wrap as 'TOP_AND_BOTTOM' | 'SQUARE' | 'BEHIND_TEXT',
        output_path: outputPath,
      });
      if (!ins.success) {
        return { success: false, output: `insert image failed (${img.ref}): ${ins.output}` };
      }
    }

    const outZip = (await fs.promises.readFile(outputPath));
    const out = await JSZip.loadAsync(outZip);
    const outSec = await out.file('Contents/section0.xml')!.async('string');

    return {
      success: true,
      output: `Recreated official document: ${outputPath}`,
      outputPath,
      metrics: {
        source: metric(sectionXml),
        recreated: metric(outSec),
      },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to recreate official document: ${msg}` };
  }
}

function unescapeXml(str: string): string {
  return str
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function extractBalancedTags(xml: string, tagName: string): string[] {
  const closeToken = `</${tagName}>`;
  const out: string[] = [];
  let i = 0;
  let depth = 0;
  let start = -1;

  while (i < xml.length) {
    const nextOpen = findNextOpenTag(xml, tagName, i);
    const nextClose = xml.indexOf(closeToken, i);
    if (nextOpen === -1 && nextClose === -1) break;

    if (nextOpen !== -1 && (nextClose === -1 || nextOpen < nextClose)) {
      const tagEnd = xml.indexOf('>', nextOpen);
      if (tagEnd === -1) break;
      const selfClosing = xml[tagEnd - 1] === '/';
      if (depth === 0) start = nextOpen;
      if (selfClosing) {
        if (depth === 0 && start >= 0) {
          out.push(xml.slice(start, tagEnd + 1));
          start = -1;
        }
      } else {
        depth += 1;
      }
      i = tagEnd + 1;
      continue;
    }

    if (nextClose !== -1) {
      depth -= 1;
      i = nextClose + closeToken.length;
      if (depth === 0 && start >= 0) {
        out.push(xml.slice(start, i));
        start = -1;
      }
    }
  }
  return out;
}

function findNextOpenTag(xml: string, tagName: string, fromIndex: number): number {
  const token = `<${tagName}`;
  let idx = fromIndex;
  while (idx < xml.length) {
    const found = xml.indexOf(token, idx);
    if (found === -1) return -1;
    const nextChar = xml[found + token.length];
    if (nextChar === ' ' || nextChar === '>' || nextChar === '/' || nextChar === '\n' || nextChar === '\t' || nextChar === '\r') {
      return found;
    }
    idx = found + token.length;
  }
  return -1;
}

function parseFontMap(headerXml: string): Map<number, string> {
  const map = new Map<number, string>();
  const hangulFace = headerXml.match(/<hh:fontface\s+lang="HANGUL"[\s\S]*?<\/hh:fontface>/);
  if (!hangulFace) return map;
  for (const m of hangulFace[0].matchAll(/<hh:font\s+id="(\d+)"\s+face="([^"]+)"/g)) {
    map.set(Number(m[1]), m[2]);
  }
  return map;
}

function parseBinMap(...xmlInputs: string[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const xml of xmlInputs) {
    if (!xml) continue;
    for (const m of xml.matchAll(/<hh:binItem\s+id="([^"]+)"\s+src="([^"]+)"/g)) {
      map.set(m[1], m[2]);
    }
    for (const m of xml.matchAll(/<opf:item\s+id="([^"]+)"\s+href="([^"]+)"[^>]*isEmbeded="1"/g)) {
      map.set(m[1], m[2]);
    }
  }
  return map;
}

function parseCharMap(headerXml: string): Map<number, Record<string, any>> {
  const map = new Map<number, Record<string, any>>();
  for (const m of headerXml.matchAll(/<hh:charPr\s+id="(\d+)"([^>]*)>([\s\S]*?)<\/hh:charPr>/g)) {
    const id = Number(m[1]);
    const attrs = m[2] || '';
    const body = m[3] || '';
    const height = attrs.match(/\bheight="(\d+)"/);
    const color = attrs.match(/\btextColor="(#[0-9A-Fa-f]{6})"/);
    const fontRef = body.match(/<hh:fontRef\s+hangul="(\d+)"/);
    map.set(id, {
      bold: /\bbold="1"/.test(attrs),
      italic: /\bitalic="1"/.test(attrs),
      underline: /\bunderline="1"/.test(attrs),
      fontSize: height ? Number(height[1]) / 100 : undefined,
      color: color ? color[1] : undefined,
      fontRef: fontRef ? Number(fontRef[1]) : undefined,
    });
  }
  return map;
}

function parseParaMap(headerXml: string): Map<number, Record<string, any>> {
  const map = new Map<number, Record<string, any>>();
  for (const m of headerXml.matchAll(/<hh:paraPr\s+id="(\d+)"[\s\S]*?<\/hh:paraPr>/g)) {
    const id = Number(m[1]);
    const xml = m[0];
    const align = xml.match(/<hh:align\s+horizontal="(LEFT|CENTER|RIGHT|JUSTIFY)"/);
    const ls = xml.match(/<hh:lineSpacing\s+[^>]*value="(-?\d+)"/);

    let indent = 0;
    let left = 0;
    let right = 0;
    let prev = 0;
    let next = 0;
    const hcIndent = xml.match(/<hc:intent\s+value="(-?\d+)"/);
    const hcLeft = xml.match(/<hc:left\s+value="(-?\d+)"/);
    const hcRight = xml.match(/<hc:right\s+value="(-?\d+)"/);
    const hcPrev = xml.match(/<hc:prev\s+value="(-?\d+)"/);
    const hcNext = xml.match(/<hc:next\s+value="(-?\d+)"/);
    if (hcIndent || hcLeft || hcRight || hcPrev || hcNext) {
      indent = Number(hcIndent?.[1] ?? 0);
      left = Number(hcLeft?.[1] ?? 0);
      right = Number(hcRight?.[1] ?? 0);
      prev = Number(hcPrev?.[1] ?? 0);
      next = Number(hcNext?.[1] ?? 0);
    } else {
      const legacy = xml.match(/<hh:margin\s+indent="(-?\d+)"\s+left="(-?\d+)"\s+right="(-?\d+)"\s+prev="(-?\d+)"\s+next="(-?\d+)"/);
      if (legacy) {
        indent = Number(legacy[1]);
        left = Number(legacy[2]);
        right = Number(legacy[3]);
        prev = Number(legacy[4]);
        next = Number(legacy[5]);
      }
    }

    map.set(id, {
      alignment: align?.[1],
      lineSpacing: ls ? Number(ls[1]) : undefined,
      indent,
      marginLeft: left,
      marginRight: right,
      spaceBefore: prev,
      spaceAfter: next,
    });
  }
  return map;
}

function extractAttrNumber(tagXml: string, attr: string): number | undefined {
  const raw = tagXml.match(new RegExp(`\\b${attr}="(-?\\d+)"`))?.[1];
  return raw !== undefined ? Number(raw) : undefined;
}

function parsePageLayout(sectionXml: string): Record<string, number> | null {
  const pagePrTag = sectionXml.match(/<hp:pagePr\b[^>]*>/)?.[0];
  if (!pagePrTag) return null;
  const pagePrStart = sectionXml.indexOf(pagePrTag);
  const afterPagePr = sectionXml.slice(pagePrStart + pagePrTag.length);
  const marginTag = afterPagePr.match(/<hp:margin\b[^>]*\/>/)?.[0];
  if (!marginTag) return null;

  const pageWidth = extractAttrNumber(pagePrTag, 'width');
  const pageHeight = extractAttrNumber(pagePrTag, 'height');
  const marginHeader = extractAttrNumber(marginTag, 'header');
  const marginFooter = extractAttrNumber(marginTag, 'footer');
  const marginLeft = extractAttrNumber(marginTag, 'left');
  const marginRight = extractAttrNumber(marginTag, 'right');
  const marginTop = extractAttrNumber(marginTag, 'top');
  const marginBottom = extractAttrNumber(marginTag, 'bottom');

  if (
    pageWidth === undefined
    || pageHeight === undefined
    || marginLeft === undefined
    || marginRight === undefined
    || marginTop === undefined
    || marginBottom === undefined
  ) {
    return null;
  }

  return {
    page_width: pageWidth,
    page_height: pageHeight,
    margin_header: marginHeader ?? 0,
    margin_footer: marginFooter ?? 0,
    margin_left: marginLeft,
    margin_right: marginRight,
    margin_top: marginTop,
    margin_bottom: marginBottom,
  };
}

function parseHeaderFooterContent(sectionXml: string, type: 'header' | 'footer'): Record<string, any> | undefined {
  const tags = type === 'header'
    ? ['hs:header', 'hp:header']
    : ['hs:footer', 'hp:footer'];
  let xml: string | undefined;
  for (const tag of tags) {
    const m = sectionXml.match(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`));
    if (m) {
      xml = m[0];
      break;
    }
  }
  if (!xml) return undefined;

  const tblMatch = xml.match(/<hp:tbl\b[\s\S]*?<\/hp:tbl>/);
  if (!tblMatch) {
    let text = '';
    const tokenRe = /<hp:t>([\s\S]*?)<\/hp:t>|<hp:autoNum\b[^>]*numType="(PAGE|TOTAL_PAGE)"[^>]*>/g;
    let x: RegExpExecArray | null;
    while ((x = tokenRe.exec(xml)) !== null) {
      if (x[1] !== undefined) text += unescapeXml(x[1].replace(/<hp:lineBreak\s*\/>/g, '\n'));
      if (x[2]) text += `{{${x[2]}}}`;
    }
    return { text };
  }

  const tableXml = tblMatch[0];
  const rows: string[][] = [];
  const rowXmls = extractBalancedTags(tableXml, 'hp:tr');
  let columnWidths: number[] | undefined;
  for (const rowXml of rowXmls) {
    const cells = extractBalancedTags(rowXml, 'hp:tc');
    const row: string[] = [];
    if (!columnWidths) {
      columnWidths = cells.map((tc) => {
        const w = tc.match(/<hp:cellSz\s+width="(\d+)"/);
        return w ? Number(w[1]) : 0;
      });
    }
    for (const tc of cells) {
      let text = '';
      const tokenRe = /<hp:t>([\s\S]*?)<\/hp:t>|<hp:autoNum\b[^>]*numType="(PAGE|TOTAL_PAGE)"[^>]*>/g;
      let x: RegExpExecArray | null;
      while ((x = tokenRe.exec(tc)) !== null) {
        if (x[1] !== undefined) text += unescapeXml(x[1].replace(/<hp:lineBreak\s*\/>/g, '\n'));
        if (x[2]) text += `{{${x[2]}}}`;
      }
      row.push(text);
    }
    rows.push(row);
  }
  return { table: { rows, columnWidths } };
}

function parseImageSpecs(sectionXml: string, binMap: Map<string, string>, rawDir: string): Array<Record<string, any>> {
  const out: Array<Record<string, any>> = [];
  const seen = new Set<string>();
  for (const m of sectionXml.matchAll(/<hp:pic\b[\s\S]*?<\/hp:pic>/g)) {
    const picXml = m[0];
    const binRef = (picXml.match(/<hc:img\s+binaryItemIDRef="([^"]+)"/) || [])[1];
    if (!binRef || seen.has(binRef)) continue;
    const src = binMap.get(binRef);
    if (!src) continue;
    const abs = path.join(rawDir, src);
    if (!fs.existsSync(abs)) continue;
    const sz = picXml.match(/<hp:sz\s+width="(\d+)"[^>]*height="(\d+)"/);
    const textWrap = (picXml.match(/\btextWrap="([^"]+)"/) || [])[1]
      || HWPX_DEFAULTS.officialRecreate.imageFallbackTextWrap;
    const widthHU = sz ? Number(sz[1]) : HWPX_DEFAULTS.officialRecreate.imageFallbackWidthHu;
    const heightHU = sz ? Number(sz[2]) : HWPX_DEFAULTS.officialRecreate.imageFallbackHeightHu;
    out.push({
      ref: binRef,
      path: abs,
      width_mm: Number((widthHU / 283.46).toFixed(3)),
      height_mm: Number((heightHU / 283.46).toFixed(3)),
      text_wrap: textWrap,
    });
    seen.add(binRef);
  }
  return out;
}

function parseRunText(runXml: string): string {
  const parts: string[] = [];
  for (const t of runXml.matchAll(/<hp:t>([\s\S]*?)<\/hp:t>/g)) {
    const normalized = t[1].replace(/<hp:lineBreak\s*\/>/g, '\n');
    parts.push(unescapeXml(normalized));
  }
  return parts.join('');
}

function buildContent(
  sectionXml: string,
  headerXml: string,
  rawDir: string,
  binMap: Map<string, string>,
): { blocks: Array<Record<string, any>>; embeddedImageRefs: Set<string> } {
  const fontMap = parseFontMap(headerXml);
  const charMap = parseCharMap(headerXml);
  const paraMap = parseParaMap(headerXml);

  const blocks: Array<Record<string, any>> = [];
  const embeddedImageRefs = new Set<string>();
  const paras = extractBalancedTags(sectionXml, 'hp:p');
  let isFirst = true;
  for (const pXml of paras) {
    if (isFirst) {
      isFirst = false;
      continue;
    }
    const paraPrRef = Number((pXml.match(/paraPrIDRef="(\d+)"/) || [])[1] ?? 0);
    const paraPr = paraMap.get(paraPrRef) || {};

    const hasHeaderFooterCtrl = /<(?:hp|hs):(?:header|footer)\b/.test(pXml);
    if (!hasHeaderFooterCtrl) {
      const topRunsForImage = extractBalancedTags(pXml, 'hp:run');
      for (const runXml of topRunsForImage) {
        const pic = runXml.match(/<hp:pic\b[\s\S]*?<\/hp:pic>/);
        if (!pic) continue;
        const picXml = pic[0];
        const binRef = (picXml.match(/<hc:img\s+binaryItemIDRef="([^"]+)"/) || [])[1];
        const src = binMap.get(binRef);
        if (!src) continue;
        const sz = picXml.match(/<hp:sz\s+width="(\d+)"[^>]*height="(\d+)"/);
        const textWrap = (picXml.match(/textWrap="([^"]+)"/) || [])[1]
          || HWPX_DEFAULTS.officialRecreate.imageFallbackTextWrap;
        const widthHU = sz ? Number(sz[1]) : HWPX_DEFAULTS.officialRecreate.imageFallbackWidthHu;
        const heightHU = sz ? Number(sz[2]) : HWPX_DEFAULTS.officialRecreate.imageFallbackHeightHu;
        const imgPath = path.join(rawDir, src);
        if (fs.existsSync(imgPath)) {
          embeddedImageRefs.add(String(binRef));
          blocks.push({
            image: {
              path: imgPath,
              width_mm: Number((widthHU / 283.46).toFixed(3)),
              height_mm: Number((heightHU / 283.46).toFixed(3)),
              text_wrap: textWrap,
            },
          });
        }
      }
    }

    const runs: Array<Record<string, any>> = [];
    for (const runXml of extractBalancedTags(pXml, 'hp:run')) {
      const charPrId = Number((runXml.match(/charPrIDRef="(\d+)"/) || [])[1] ?? 0);
      const text = parseRunText(runXml);
      if (!text && text !== '') continue;
      if (text.length === 0 && !runXml.includes('<hp:t>')) continue;
      const cp = charMap.get(charPrId) || {};
      const run: Record<string, any> = { text };
      if (cp.bold) run.bold = true;
      if (cp.italic) run.italic = true;
      if (cp.underline) run.underline = true;
      if (cp.color) run.color = cp.color;
      if (cp.fontSize) run.fontSize = cp.fontSize;
      if (cp.fontRef !== undefined && fontMap.has(cp.fontRef)) run.fontName = fontMap.get(cp.fontRef);
      runs.push(run);
    }

    if (runs.length === 0) {
      if (!/paraPrIDRef=/.test(pXml)) continue;
      runs.push({ text: '' });
    }

    const paragraph: Record<string, any> = { runs };
    if (paraPr.alignment) paragraph.alignment = paraPr.alignment;
    if (paraPr.lineSpacing !== undefined) paragraph.lineSpacing = paraPr.lineSpacing;
    if (paraPr.indent !== undefined) paragraph.indent = paraPr.indent;
    if (paraPr.marginLeft !== undefined) paragraph.marginLeft = paraPr.marginLeft;
    if (paraPr.marginRight !== undefined) paragraph.marginRight = paraPr.marginRight;
    if (paraPr.spaceBefore !== undefined || paraPr.spaceAfter !== undefined) {
      paragraph.spacing = {};
      if (paraPr.spaceBefore !== undefined) paragraph.spacing.before = paraPr.spaceBefore;
      if (paraPr.spaceAfter !== undefined) paragraph.spacing.after = paraPr.spaceAfter;
    }
    blocks.push({ paragraph });
  }
  return { blocks, embeddedImageRefs };
}

function metric(xml: string): { p: number; tbl: number; pic: number; run: number } {
  return {
    p: (xml.match(/<hp:p\b/g) || []).length,
    tbl: (xml.match(/<hp:tbl\b/g) || []).length,
    pic: (xml.match(/<hp:pic\b/g) || []).length,
    run: (xml.match(/<hp:run\b/g) || []).length,
  };
}
