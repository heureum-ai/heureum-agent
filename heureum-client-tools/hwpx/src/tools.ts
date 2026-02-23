/**
 * HWPX tool implementations.
 */

import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';
import remarkParse from 'remark-parse';
import remarkGfm from 'remark-gfm';
import remarkFrontmatter from 'remark-frontmatter';
import { unified } from 'unified';
import { createHwpx } from './writer.js';
import { createDocument, type HwpxCreateDocumentParams } from './create-document.js';
import { HwpxPipeline } from './pipeline.js';
import { escapeXml, MIMETYPE, VERSION_XML, CONTAINER_XML, MANIFEST_XML, SETTINGS_XML, buildContainerRdf, buildContentHpf, COMMON_NS } from './template.js';
import { buildHeaderXml } from './header.js';
import { buildSecPr, buildSectionXml } from './section.js';
import { unescapeXml } from './reader.js';
import {
  mmToHwpUnit,
  resolveCharFormat,
  addCharPrToHeader,
  addParaPrToHeader,
  addBorderFillToHeader,
  parseBorderFillXml,
  parseTableXml,
  buildTableXml,
  buildImagePicXml,
  addBinItemToHeader,
  buildHeaderFooterXml,
  addFontToHeader,
  buildNewTable,
  type CharFormatOptions,
  type ParaFormatOptions,
  type BorderFillOptions,
  type HwpxHeaderFooterContent,
  type HwpxHeaderFooterTable,
} from './formatter.js';
import type { HwpxToolResult, HwpxXmlMap } from './types.js';

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.promises.access(targetPath);
    return true;
  } catch {
    return false;
  }
}


export type { HwpxToolResult } from './types.js';

interface PipelineTaskState {
  markdown?: string;
  ast?: any;
  xmlMap?: HwpxXmlMap;
}

const TASK_STATE_CACHE = new Map<string, PipelineTaskState>();

function normalizeTaskDirKey(taskDir: string): string {
  return path.resolve(taskDir);
}

function getTaskState(taskDir: string): PipelineTaskState {
  const key = normalizeTaskDirKey(taskDir);
  let state = TASK_STATE_CACHE.get(key);
  if (!state) {
    state = {};
    TASK_STATE_CACHE.set(key, state);
  }
  return state;
}

function clearTaskState(taskDir: string): void {
  TASK_STATE_CACHE.delete(normalizeTaskDirKey(taskDir));
}

function buildXmlMapFromAst(ast: any, options?: {
  pageWidth?: number;
  pageHeight?: number;
  marginTop?: number;
  marginBottom?: number;
  marginLeft?: number;
  marginRight?: number;
}): HwpxXmlMap {
  const children = Array.isArray(ast?.children) ? ast.children : [];
  let title: string | undefined;
  for (const node of children) {
    if (node?.type === 'heading' && node?.depth === 1) {
      title = node.children?.map((c: any) => c?.value || '').join('') || undefined;
      break;
    }
  }

  const sectionCount = 1;
  const headerXml = buildHeaderXml(sectionCount);
  const sectionXml = buildSectionXml(children as any[], options);
  const contentHpf = buildContentHpf(sectionCount, title);
  const containerRdf = buildContainerRdf(sectionCount);

  return {
    header: headerXml,
    sections: [sectionXml],
    contentHpf,
    meta: {
      'META-INF/container.xml': CONTAINER_XML,
      'META-INF/manifest.xml': MANIFEST_XML,
      'META-INF/container.rdf': containerRdf,
      'version.xml': VERSION_XML,
      'settings.xml': SETTINGS_XML,
    },
  };
}

async function packXmlMapToHwpx(xmlMap: HwpxXmlMap): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('mimetype', MIMETYPE, { compression: 'STORE' });
  zip.file('version.xml', VERSION_XML);
  zip.file('settings.xml', SETTINGS_XML);
  zip.file('META-INF/container.xml', xmlMap.meta['META-INF/container.xml'] || CONTAINER_XML);
  zip.file('META-INF/manifest.xml', xmlMap.meta['META-INF/manifest.xml'] || MANIFEST_XML);
  zip.file('META-INF/container.rdf', xmlMap.meta['META-INF/container.rdf'] || buildContainerRdf(xmlMap.sections.length || 1));
  zip.file('Contents/content.hpf', xmlMap.contentHpf);
  zip.file('Contents/header.xml', xmlMap.header);
  xmlMap.sections.forEach((section, index) => {
    zip.file(`Contents/section${index}.xml`, section);
  });
  zip.file('Preview/PrvText.txt', '');

  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

// ── Original tool (backward compatible) ─────────────────

export async function hwpxCreateMarkdown(args: {
  markdown: string;
  output_path: string;
}): Promise<HwpxToolResult> {
  try {
    const { markdown, output_path } = args;

    if (!markdown && markdown !== '') {
      return { success: false, output: 'Missing required parameter: markdown' };
    }
    if (!output_path) {
      return { success: false, output: 'Missing required parameter: output_path' };
    }

    const resolvedPath = path.resolve(output_path);
    const dir = path.dirname(resolvedPath);
    if (!(await pathExists(dir))) {
      ;(await fs.promises.mkdir(dir, { recursive: true }));
    }

    const buffer = await createHwpx(markdown);
    ;(await fs.promises.writeFile(resolvedPath, buffer));

    return {
      success: true,
      output: `HWPX document created successfully at: ${resolvedPath}`,
      outputPath: resolvedPath,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to create HWPX: ${msg}` };
  }
}

// ── Structured document creation ─────────────────────────

export async function hwpxCreateDocument(
  args: HwpxCreateDocumentParams,
): Promise<HwpxToolResult> {
  try {
    const { output_path } = args;
    if (!output_path) {
      return { success: false, output: 'Missing required parameter: output_path' };
    }
    if (!args.content) {
      return { success: false, output: 'Missing required parameter: content' };
    }

    const resolvedPath = path.resolve(output_path);
    const dir = path.dirname(resolvedPath);
    if (!(await pathExists(dir))) {
      ;(await fs.promises.mkdir(dir, { recursive: true }));
    }

    const buffer = await createDocument(args);
    ;(await fs.promises.writeFile(resolvedPath, buffer));

    return {
      success: true,
      output: `HWPX document created successfully at: ${resolvedPath}`,
      outputPath: resolvedPath,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to create HWPX document: ${msg}` };
  }
}

// ── Pipeline tools ──────────────────────────────────────

export async function hwpxInitTask(args: {
  session_id: string;
  task_id: string;
  work_dir?: string;
}): Promise<HwpxToolResult> {
  try {
    const { session_id, task_id, work_dir } = args;
    if (!session_id) return { success: false, output: 'Missing required parameter: session_id' };
    if (!task_id) return { success: false, output: 'Missing required parameter: task_id' };

    const pipeline = new HwpxPipeline({
      sessionId: session_id,
      taskType: 'hwpx',
      taskId: task_id,
      workDir: work_dir,
    });

    // Create minimal folder structure (result output target only)
    ;(await fs.promises.mkdir(path.join(pipeline.taskDir, 'output'), { recursive: true }));

    // Initialize in-memory state only; avoid writing extra files by default.
    clearTaskState(pipeline.taskDir);
    getTaskState(pipeline.taskDir);

    return {
      success: true,
      output: `Task initialized at: ${pipeline.taskDir}`,
      outputPath: pipeline.taskDir,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to init task: ${msg}` };
  }
}

export async function hwpxWriteMarkdown(args: {
  task_dir: string;
  markdown: string;
  persist_intermediate?: boolean;
}): Promise<HwpxToolResult> {
  try {
    const { task_dir, markdown, persist_intermediate = false } = args;
    if (!task_dir) return { success: false, output: 'Missing required parameter: task_dir' };
    if (!markdown && markdown !== '') return { success: false, output: 'Missing required parameter: markdown' };

    const processor = unified()
      .use(remarkParse)
      .use(remarkGfm)
      .use(remarkFrontmatter, ['yaml']);
    const ast = processor.parse(markdown) as any;

    const state = getTaskState(task_dir);
    state.markdown = markdown;
    state.ast = ast;

    if (persist_intermediate) {
      const pipeline = pipelineFromTaskDir(task_dir);
      await pipeline.writeMarkdown(markdown);
    }

    return {
      success: true,
      output: persist_intermediate
        ? `Markdown saved and parsed. AST has ${(ast.children as any[]).length} top-level nodes.`
        : `Markdown parsed in memory only. AST has ${(ast.children as any[]).length} top-level nodes.`,
      outputPath: persist_intermediate ? path.join(task_dir, 'output/ast.json') : task_dir,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to write markdown: ${msg}` };
  }
}

export async function hwpxWriteXml(args: {
  task_dir: string;
  page_width?: number;
  page_height?: number;
  margin_top?: number;
  margin_bottom?: number;
  margin_left?: number;
  margin_right?: number;
  persist_intermediate?: boolean;
}): Promise<HwpxToolResult> {
  try {
    const {
      task_dir,
      page_width,
      page_height,
      margin_top,
      margin_bottom,
      margin_left,
      margin_right,
      persist_intermediate = false,
    } = args;
    if (!task_dir) return { success: false, output: 'Missing required parameter: task_dir' };

    const state = getTaskState(task_dir);
    let ast = state.ast;
    if (!ast) {
      const astPath = path.join(task_dir, 'output/ast.json');
      if (!(await pathExists(astPath))) {
        return { success: false, output: 'AST state not found. Run hwpx_write_markdown first.' };
      }
      ast = JSON.parse((await fs.promises.readFile(astPath, 'utf-8')));
      state.ast = ast;
    }

    const documentOptions = {
      pageWidth: page_width !== undefined ? mmToHwpUnit(page_width) : undefined,
      pageHeight: page_height !== undefined ? mmToHwpUnit(page_height) : undefined,
      marginTop: margin_top !== undefined ? mmToHwpUnit(margin_top) : undefined,
      marginBottom: margin_bottom !== undefined ? mmToHwpUnit(margin_bottom) : undefined,
      marginLeft: margin_left !== undefined ? mmToHwpUnit(margin_left) : undefined,
      marginRight: margin_right !== undefined ? mmToHwpUnit(margin_right) : undefined,
    };

    let xmlMap: HwpxXmlMap;
    if (persist_intermediate) {
      const pipeline = pipelineFromTaskDir(task_dir);
      xmlMap = await pipeline.writeXml(ast, { documentOptions });
    } else {
      xmlMap = buildXmlMapFromAst(ast, documentOptions);
    }
    state.xmlMap = xmlMap;

    return {
      success: true,
      output: persist_intermediate
        ? `XML generated: ${xmlMap.sections.length} section(s). Files saved to output/hwpx/`
        : `XML generated in memory: ${xmlMap.sections.length} section(s).`,
      outputPath: persist_intermediate ? path.join(task_dir, 'output/hwpx') : task_dir,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to write XML: ${msg}` };
  }
}

export async function hwpxPack(args: {
  task_dir: string;
  persist_intermediate?: boolean;
}): Promise<HwpxToolResult> {
  try {
    const { task_dir, persist_intermediate = false } = args;
    if (!task_dir) return { success: false, output: 'Missing required parameter: task_dir' };

    const outputDir = path.join(task_dir, 'output');
    if (!(await pathExists(outputDir))) {
      ;(await fs.promises.mkdir(outputDir, { recursive: true }));
    }
    const outputPath = path.join(outputDir, 'result.hwpx');

    if (persist_intermediate) {
      const pipeline = pipelineFromTaskDir(task_dir);
      const packedPath = await pipeline.pack();
      return {
        success: true,
        output: `HWPX file packed successfully: ${packedPath}`,
        outputPath: packedPath,
      };
    }

    const state = getTaskState(task_dir);
    if (state.xmlMap) {
      const buffer = await packXmlMapToHwpx(state.xmlMap);
      ;(await fs.promises.writeFile(outputPath, buffer));
      // Drop transient state after successful pack.
      clearTaskState(task_dir);
    } else {
      // Backward-compat: allow packing from persisted output/hwpx if present.
      const pipeline = pipelineFromTaskDir(task_dir);
      await pipeline.pack();
    }

    return {
      success: true,
      output: `HWPX file packed successfully: ${outputPath}`,
      outputPath,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to pack: ${msg}` };
  }
}

export async function hwpxUnpack(args: {
  task_dir: string;
  input_path: string;
}): Promise<HwpxToolResult> {
  try {
    const { task_dir, input_path } = args;
    if (!task_dir) return { success: false, output: 'Missing required parameter: task_dir' };
    if (!input_path) return { success: false, output: 'Missing required parameter: input_path' };

    const pipeline = pipelineFromTaskDir(task_dir);
    await pipeline.unpack(input_path);

    return {
      success: true,
      output: `HWPX unpacked to: ${path.join(task_dir, 'output/hwpx')}`,
      outputPath: path.join(task_dir, 'output/hwpx'),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to unpack: ${msg}` };
  }
}

export async function hwpxReadXml(args: {
  task_dir: string;
}): Promise<HwpxToolResult> {
  try {
    const { task_dir } = args;
    if (!task_dir) return { success: false, output: 'Missing required parameter: task_dir' };

    const pipeline = pipelineFromTaskDir(task_dir);
    const ast = await pipeline.readXml();

    return {
      success: true,
      output: `AST extracted with ${(ast.children as any[]).length} top-level nodes. Saved to output/ast.json`,
      outputPath: path.join(task_dir, 'output/ast.json'),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to read XML: ${msg}` };
  }
}

export async function hwpxReadMarkdown(args: {
  task_dir: string;
}): Promise<HwpxToolResult> {
  try {
    const { task_dir } = args;
    if (!task_dir) return { success: false, output: 'Missing required parameter: task_dir' };

    // Read AST from previous step
    const astPath = path.join(task_dir, 'output/ast.json');
    if (!(await pathExists(astPath))) {
      return { success: false, output: 'ast.json not found. Run hwpx_read_xml first.' };
    }

    const ast = JSON.parse((await fs.promises.readFile(astPath, 'utf-8')));
    const pipeline = pipelineFromTaskDir(task_dir);
    const markdown = await pipeline.readMarkdown(ast);

    return {
      success: true,
      output: markdown,
      outputPath: path.join(task_dir, 'output/input.md'),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to read markdown: ${msg}` };
  }
}

// ── Read tool: extract_styles ────────────────────────────

function getTagAttr(tagXml: string, attr: string): string | undefined {
  return tagXml.match(new RegExp(`\\b${attr}="([^"]*)"`))?.[1];
}

function getTagAttrNumber(tagXml: string, attr: string): number | undefined {
  const raw = getTagAttr(tagXml, attr);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isNaN(n) ? undefined : n;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readMetaValue(hpfXml: string, name: string): string | undefined {
  const escapedName = escapeRegex(name);

  // Read content attribute first to correctly handle self-closing tags.
  const attrMatch = hpfXml.match(
    new RegExp(`<opf:meta\\s+[^>]*\\bname="${escapedName}"[^>]*\\bcontent="([^"]*)"[^>]*\\/?>`, 'i'),
  );
  if (attrMatch) {
    const value = unescapeXml(attrMatch[1].trim());
    // Common templates use content="text" placeholder.
    if (value.length > 0 && value !== 'text') return value;
    return undefined;
  }

  const bodyMatch = hpfXml.match(
    new RegExp(`<opf:meta\\s+[^>]*\\bname="${escapedName}"[^>]*>([^<]*)<\\/opf:meta>`, 'i'),
  );
  if (bodyMatch) {
    const value = unescapeXml(bodyMatch[1].trim());
    if (value.length > 0 && value !== 'text') return value;
  }
  return undefined;
}

function parseStylesMetadata(hpfXml: string): {
  title?: string;
  creator?: string;
  language?: string;
  createdDate?: string;
  modifiedDate?: string;
  subject?: string;
  keywords?: string;
} {
  const title = hpfXml.match(/<opf:title>([\s\S]*?)<\/opf:title>/)?.[1];
  const language = hpfXml.match(/<opf:language>([\s\S]*?)<\/opf:language>/)?.[1];
  return {
    title: title ? unescapeXml(title.trim()) : undefined,
    creator: readMetaValue(hpfXml, 'creator'),
    language: language ? unescapeXml(language.trim()) : undefined,
    createdDate: readMetaValue(hpfXml, 'CreatedDate') ?? readMetaValue(hpfXml, 'createdDate'),
    modifiedDate: readMetaValue(hpfXml, 'ModifiedDate') ?? readMetaValue(hpfXml, 'modifiedDate'),
    subject: readMetaValue(hpfXml, 'subject'),
    keywords: readMetaValue(hpfXml, 'keyword') ?? readMetaValue(hpfXml, 'keywords'),
  };
}

function parseStylesFonts(headerXml: string): Array<{ id: number; face: string; type?: string; lang?: string }> {
  const out: Array<{ id: number; face: string; type?: string; lang?: string }> = [];
  const dedupe = new Set<string>();
  for (const faceBlock of headerXml.matchAll(/<hh:fontface\b([^>]*)>[\s\S]*?<\/hh:fontface>/g)) {
    const faceAttrs = faceBlock[1] ?? '';
    const lang = faceAttrs.match(/\blang="([^"]+)"/)?.[1];
    for (const fontMatch of faceBlock[0].matchAll(/<hh:font\b([^>]*)>/g)) {
      const attrs = fontMatch[1];
      const id = Number(attrs.match(/\bid="(\d+)"/)?.[1] ?? NaN);
      const face = attrs.match(/\bface="([^"]+)"/)?.[1];
      const type = attrs.match(/\btype="([^"]+)"/)?.[1];
      if (Number.isNaN(id) || !face) continue;
      const key = `${id}|${face}|${type ?? ''}|${lang ?? ''}`;
      if (dedupe.has(key)) continue;
      dedupe.add(key);
      out.push({ id, face, type, lang });
    }
  }
  return out.sort((a, b) =>
    a.id - b.id
    || (a.lang ?? '').localeCompare(b.lang ?? '')
    || a.face.localeCompare(b.face),
  );
}

function parseStylesCharProperties(headerXml: string): Array<{
  id: number;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  textColor?: string;
  fontRef?: number;
  fontRefs?: {
    hangul?: number;
    latin?: number;
    hanja?: number;
    japanese?: number;
    other?: number;
    symbol?: number;
    user?: number;
  };
}> {
  const out: Array<{
    id: number;
    fontSize?: number;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    textColor?: string;
    fontRef?: number;
    fontRefs?: {
      hangul?: number;
      latin?: number;
      hanja?: number;
      japanese?: number;
      other?: number;
      symbol?: number;
      user?: number;
    };
  }> = [];
  for (const m of headerXml.matchAll(/<hh:charPr\s+id="(\d+)"([^>]*)>([\s\S]*?)<\/hh:charPr>/g)) {
    const id = Number(m[1]);
    const attrs = m[2] ?? '';
    const body = m[3] ?? '';
    const fontSizeRaw = attrs.match(/\bheight="(\d+)"/)?.[1];
    const fontRefAttrs = body.match(/<hh:fontRef\b([^>]*)\/?>/)?.[1] ?? '';
    const readFontRef = (name: string): number | undefined => {
      const raw = fontRefAttrs.match(new RegExp(`\\b${name}="(\\d+)"`))?.[1];
      if (raw === undefined) return undefined;
      const n = Number(raw);
      return Number.isNaN(n) ? undefined : n;
    };
    const fontRefs = {
      hangul: readFontRef('hangul'),
      latin: readFontRef('latin'),
      hanja: readFontRef('hanja'),
      japanese: readFontRef('japanese'),
      other: readFontRef('other'),
      symbol: readFontRef('symbol'),
      user: readFontRef('user'),
    };
    const hasFontRefs = Object.values(fontRefs).some((v) => v !== undefined);
    out.push({
      id,
      fontSize: fontSizeRaw ? Number(fontSizeRaw) / 100 : undefined,
      bold: /\bbold="1"/.test(attrs) || undefined,
      italic: /\bitalic="1"/.test(attrs) || undefined,
      underline: /\bunderline="1"/.test(attrs) || undefined,
      textColor: attrs.match(/\btextColor="(#[0-9A-Fa-f]{6})"/)?.[1],
      fontRef: fontRefs.hangul,
      fontRefs: hasFontRefs ? fontRefs : undefined,
    });
  }
  return out.sort((a, b) => a.id - b.id);
}

function parseStylesParaProperties(headerXml: string): Array<{
  id: number;
  alignment?: string;
  lineSpacing?: number;
  indent?: number;
  marginLeft?: number;
  marginRight?: number;
  spaceBefore?: number;
  spaceAfter?: number;
  heading?: { type?: string; level?: number };
}> {
  const out: Array<{
    id: number;
    alignment?: string;
    lineSpacing?: number;
    indent?: number;
    marginLeft?: number;
    marginRight?: number;
    spaceBefore?: number;
    spaceAfter?: number;
    heading?: { type?: string; level?: number };
  }> = [];
  for (const m of headerXml.matchAll(/<hh:paraPr\s+id="(\d+)"[\s\S]*?<\/hh:paraPr>/g)) {
    const id = Number(m[1]);
    const xml = m[0];
    const alignment = xml.match(/<hh:align\s+[^>]*horizontal="(LEFT|CENTER|RIGHT|JUSTIFY)"/)?.[1];
    const lineSpacing = xml.match(/<hh:lineSpacing\s+[^>]*value="(-?\d+)"/)?.[1];
    const headingType = xml.match(/<hh:heading\s+[^>]*type="([^"]+)"/)?.[1];
    const headingLevel = xml.match(/<hh:heading\s+[^>]*level="(-?\d+)"/)?.[1];

    const indent = xml.match(/<hc:intent\s+value="(-?\d+)"/)?.[1];
    const left = xml.match(/<hc:left\s+value="(-?\d+)"/)?.[1];
    const right = xml.match(/<hc:right\s+value="(-?\d+)"/)?.[1];
    const prev = xml.match(/<hc:prev\s+value="(-?\d+)"/)?.[1];
    const next = xml.match(/<hc:next\s+value="(-?\d+)"/)?.[1];

    const legacy = xml.match(/<hh:margin\s+indent="(-?\d+)"\s+left="(-?\d+)"\s+right="(-?\d+)"\s+prev="(-?\d+)"\s+next="(-?\d+)"/);

    out.push({
      id,
      alignment,
      lineSpacing: lineSpacing !== undefined ? Number(lineSpacing) : undefined,
      indent: indent !== undefined ? Number(indent) : legacy ? Number(legacy[1]) : undefined,
      marginLeft: left !== undefined ? Number(left) : legacy ? Number(legacy[2]) : undefined,
      marginRight: right !== undefined ? Number(right) : legacy ? Number(legacy[3]) : undefined,
      spaceBefore: prev !== undefined ? Number(prev) : legacy ? Number(legacy[4]) : undefined,
      spaceAfter: next !== undefined ? Number(next) : legacy ? Number(legacy[5]) : undefined,
      heading: (headingType || headingLevel)
        ? {
          type: headingType,
          level: headingLevel !== undefined ? Number(headingLevel) : undefined,
        }
        : undefined,
    });
  }
  return out.sort((a, b) => a.id - b.id);
}

function parseStylesBorderFills(headerXml: string): Array<{
  id: number;
  backgroundColor?: string;
  fillColor?: string;
  top: { type?: string; width?: string; color?: string };
  bottom: { type?: string; width?: string; color?: string };
  left: { type?: string; width?: string; color?: string };
  right: { type?: string; width?: string; color?: string };
}> {
  const out: Array<{
    id: number;
    backgroundColor?: string;
    fillColor?: string;
    top: { type?: string; width?: string; color?: string };
    bottom: { type?: string; width?: string; color?: string };
    left: { type?: string; width?: string; color?: string };
    right: { type?: string; width?: string; color?: string };
  }> = [];
  for (const m of headerXml.matchAll(/<hh:borderFill\s+id="(\d+)"[\s\S]*?<\/hh:borderFill>/g)) {
    const parsed = parseBorderFillXml(m[0]);
    out.push({
      id: parsed.id,
      backgroundColor: parsed.backgroundColor,
      fillColor: parsed.fillColor,
      top: parsed.top,
      bottom: parsed.bottom,
      left: parsed.left,
      right: parsed.right,
    });
  }
  return out.sort((a, b) => a.id - b.id);
}

function parseStylesStyleDefs(headerXml: string): Array<{
  id: number;
  name?: string;
  type?: string;
  paraPrIDRef?: number;
  charPrIDRef?: number;
}> {
  const out: Array<{
    id: number;
    name?: string;
    type?: string;
    paraPrIDRef?: number;
    charPrIDRef?: number;
  }> = [];
  for (const m of headerXml.matchAll(/<hh:style\b([^>]*)\/?>/g)) {
    const attrs = m[1];
    const idRaw = attrs.match(/\bid="(\d+)"/)?.[1];
    if (!idRaw) continue;
    const paraPrRaw = attrs.match(/\bparaPrIDRef="(\d+)"/)?.[1];
    const charPrRaw = attrs.match(/\bcharPrIDRef="(\d+)"/)?.[1];
    out.push({
      id: Number(idRaw),
      name: attrs.match(/\bname="([^"]+)"/)?.[1],
      type: attrs.match(/\btype="([^"]+)"/)?.[1],
      paraPrIDRef: paraPrRaw !== undefined ? Number(paraPrRaw) : undefined,
      charPrIDRef: charPrRaw !== undefined ? Number(charPrRaw) : undefined,
    });
  }
  return out.sort((a, b) => a.id - b.id);
}

function parseSectionStyleUsage(sectionXml: string): {
  paragraphCount: number;
  runCount: number;
  tableCount: number;
  styleUsage: Record<string, number>;
  paraPrUsage: Record<string, number>;
  charPrUsage: Record<string, number>;
} {
  const styleUsage: Record<string, number> = {};
  const paraPrUsage: Record<string, number> = {};
  const charPrUsage: Record<string, number> = {};
  let paragraphCount = 0;
  let runCount = 0;

  for (const m of sectionXml.matchAll(/<hp:p\b([^>]*)>/g)) {
    paragraphCount += 1;
    const attrs = m[1] ?? '';
    const styleId = attrs.match(/\bstyleIDRef="(\d+)"/)?.[1];
    const paraPrId = attrs.match(/\bparaPrIDRef="(\d+)"/)?.[1];
    if (styleId !== undefined) styleUsage[styleId] = (styleUsage[styleId] ?? 0) + 1;
    if (paraPrId !== undefined) paraPrUsage[paraPrId] = (paraPrUsage[paraPrId] ?? 0) + 1;
  }

  for (const m of sectionXml.matchAll(/<hp:run\b([^>]*)>/g)) {
    runCount += 1;
    const attrs = m[1] ?? '';
    const charPrId = attrs.match(/\bcharPrIDRef="(\d+)"/)?.[1];
    if (charPrId !== undefined) charPrUsage[charPrId] = (charPrUsage[charPrId] ?? 0) + 1;
  }

  const tableCount = [...sectionXml.matchAll(/<hp:tbl\b/g)].length;
  return {
    paragraphCount,
    runCount,
    tableCount,
    styleUsage,
    paraPrUsage,
    charPrUsage,
  };
}

function mergeUsageCounts(into: Record<string, number>, from: Record<string, number>): void {
  for (const [key, value] of Object.entries(from)) {
    into[key] = (into[key] ?? 0) + value;
  }
}

function buildEffectiveStyleSummaries(
  styles: Array<{
    id: number;
    name?: string;
    type?: string;
    paraPrIDRef?: number;
    charPrIDRef?: number;
  }>,
  paraProperties: Array<{
    id: number;
    alignment?: string;
    lineSpacing?: number;
    indent?: number;
    marginLeft?: number;
    marginRight?: number;
    spaceBefore?: number;
    spaceAfter?: number;
    heading?: { type?: string; level?: number };
  }>,
  charProperties: Array<{
    id: number;
    fontSize?: number;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    textColor?: string;
    fontRef?: number;
    fontRefs?: {
      hangul?: number;
      latin?: number;
      hanja?: number;
      japanese?: number;
      other?: number;
      symbol?: number;
      user?: number;
    };
  }>,
): Array<{
  id: number;
  name?: string;
  type?: string;
  paraPrIDRef?: number;
  charPrIDRef?: number;
  paraPr?: unknown;
  charPr?: unknown;
}> {
  const paraById = new Map(paraProperties.map((item) => [item.id, item]));
  const charById = new Map(charProperties.map((item) => [item.id, item]));
  return styles.map((style) => ({
    ...style,
    paraPr: style.paraPrIDRef !== undefined ? paraById.get(style.paraPrIDRef) : undefined,
    charPr: style.charPrIDRef !== undefined ? charById.get(style.charPrIDRef) : undefined,
  }));
}

function parseStylesPageLayout(sectionXml: string): {
  width?: number;
  height?: number;
  margins?: {
    top?: number;
    bottom?: number;
    left?: number;
    right?: number;
    header?: number;
    footer?: number;
    gutter?: number;
  };
} {
  const pagePrTag = sectionXml.match(/<hp:pagePr\b[^>]*>/)?.[0];
  if (!pagePrTag) return {};
  const pagePrStart = sectionXml.indexOf(pagePrTag);
  const afterPagePr = sectionXml.slice(pagePrStart + pagePrTag.length);
  const marginTag = afterPagePr.match(/<hp:margin\b[^>]*\/>/)?.[0];

  return {
    width: getTagAttrNumber(pagePrTag, 'width'),
    height: getTagAttrNumber(pagePrTag, 'height'),
    margins: marginTag
      ? {
        top: getTagAttrNumber(marginTag, 'top'),
        bottom: getTagAttrNumber(marginTag, 'bottom'),
        left: getTagAttrNumber(marginTag, 'left'),
        right: getTagAttrNumber(marginTag, 'right'),
        header: getTagAttrNumber(marginTag, 'header'),
        footer: getTagAttrNumber(marginTag, 'footer'),
        gutter: getTagAttrNumber(marginTag, 'gutter'),
      }
      : undefined,
  };
}

function parseStylesHeaderFooter(sectionXml: string): {
  header?: { text?: string; table?: { rows: string[][]; columnWidths?: number[] }; autoPageNum?: boolean; autoTotalPages?: boolean };
  footer?: { text?: string; table?: { rows: string[][]; columnWidths?: number[] }; autoPageNum?: boolean; autoTotalPages?: boolean };
} {
  const parseOne = (
    kind: 'header' | 'footer',
  ): { text?: string; table?: { rows: string[][]; columnWidths?: number[] }; autoPageNum?: boolean; autoTotalPages?: boolean } | undefined => {
    const tags = kind === 'header'
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

    const hasPage = /<hp:autoNum\b[^>]*numType="PAGE"/.test(xml);
    const hasTotal = /<hp:autoNum\b[^>]*numType="TOTAL_PAGE"/.test(xml);
    const toTokenText = (src: string): string => {
      const tokenRe = /<hp:t>([\s\S]*?)<\/hp:t>|<hp:autoNum\b[^>]*numType="(PAGE|TOTAL_PAGE)"[^>]*>/g;
      let text = '';
      let x: RegExpExecArray | null;
      while ((x = tokenRe.exec(src)) !== null) {
        if (x[1] !== undefined) text += unescapeXml(x[1].replace(/<hp:lineBreak\s*\/>/g, '\n'));
        if (x[2]) text += `{{${x[2]}}}`;
      }
      return text;
    };

    const tblMatch = xml.match(/<hp:tbl\b[\s\S]*?<\/hp:tbl>/);
    if (!tblMatch) {
      return {
        text: toTokenText(xml),
        autoPageNum: hasPage || undefined,
        autoTotalPages: hasTotal || undefined,
      };
    }

    const tableXml = tblMatch[0];
    const rows: string[][] = [];
    const rowMatches = [...tableXml.matchAll(/<hp:tr>([\s\S]*?)<\/hp:tr>/g)];
    let columnWidths: number[] | undefined;
    for (const rowMatch of rowMatches) {
      const cellMatches = [...rowMatch[1].matchAll(/<hp:tc[\s\S]*?<\/hp:tc>/g)];
      if (!columnWidths) {
        columnWidths = cellMatches.map((cell) => Number(cell[0].match(/<hp:cellSz\s+width="(\d+)"/)?.[1] ?? 0));
      }
      const row: string[] = [];
      for (const cell of cellMatches) row.push(toTokenText(cell[0]));
      rows.push(row);
    }
    return {
      table: { rows, columnWidths },
      autoPageNum: hasPage || undefined,
      autoTotalPages: hasTotal || undefined,
    };
  };

  return {
    header: parseOne('header'),
    footer: parseOne('footer'),
  };
}

export async function hwpxExtractStyles(args: {
  path: string;
  section_index?: number;
  include_all_sections?: boolean;
}): Promise<HwpxToolResult> {
  try {
    const { path: inputPath, section_index, include_all_sections } = args;
    if (!inputPath) return { success: false, output: 'Missing required parameter: path' };

    const zip = await loadHwpxZip(inputPath);
    const headerFile = zip.file('Contents/header.xml');
    const hpfFile = zip.file('Contents/content.hpf');
    if (!headerFile) return { success: false, output: 'Invalid HWPX: header.xml not found' };
    if (!hpfFile) return { success: false, output: 'Invalid HWPX: content.hpf not found' };

    const headerXml = await headerFile.async('string');
    const hpfXml = await hpfFile.async('string');

    const effectiveSectionIndex = section_index === undefined && include_all_sections ? -1 : section_index;
    const sectionPaths = resolveSectionPaths(zip, effectiveSectionIndex);
    const existingSectionPaths = sectionPaths.filter((p) => Boolean(zip.file(p)));
    if (existingSectionPaths.length === 0) {
      return {
        success: false,
        output: effectiveSectionIndex === undefined
          ? 'Invalid HWPX: section0.xml not found'
          : `Section not found for section_index=${effectiveSectionIndex}`,
      };
    }

    const sectionDetails: Array<{
      sectionPath: string;
      pageLayout: ReturnType<typeof parseStylesPageLayout>;
      headerFooter: ReturnType<typeof parseStylesHeaderFooter>;
      usage: ReturnType<typeof parseSectionStyleUsage>;
    }> = [];
    for (const sectionPath of existingSectionPaths) {
      const sectionXml = await zip.file(sectionPath)!.async('string');
      sectionDetails.push({
        sectionPath,
        pageLayout: parseStylesPageLayout(sectionXml),
        headerFooter: parseStylesHeaderFooter(sectionXml),
        usage: parseSectionStyleUsage(sectionXml),
      });
    }

    const fonts = parseStylesFonts(headerXml);
    const charProperties = parseStylesCharProperties(headerXml);
    const paraProperties = parseStylesParaProperties(headerXml);
    const borderFills = parseStylesBorderFills(headerXml);
    const styles = parseStylesStyleDefs(headerXml);
    const effectiveStyles = buildEffectiveStyleSummaries(styles, paraProperties, charProperties);

    const aggregateUsage = {
      paragraphCount: 0,
      runCount: 0,
      tableCount: 0,
      styleUsage: {} as Record<string, number>,
      paraPrUsage: {} as Record<string, number>,
      charPrUsage: {} as Record<string, number>,
    };
    for (const section of sectionDetails) {
      aggregateUsage.paragraphCount += section.usage.paragraphCount;
      aggregateUsage.runCount += section.usage.runCount;
      aggregateUsage.tableCount += section.usage.tableCount;
      mergeUsageCounts(aggregateUsage.styleUsage, section.usage.styleUsage);
      mergeUsageCounts(aggregateUsage.paraPrUsage, section.usage.paraPrUsage);
      mergeUsageCounts(aggregateUsage.charPrUsage, section.usage.charPrUsage);
    }

    const primary = sectionDetails[0];
    const result: Record<string, unknown> = {
      metadata: parseStylesMetadata(hpfXml),
      fonts,
      charProperties,
      paraProperties,
      borderFills,
      styles,
      effectiveStyles,
      usage: aggregateUsage,
      pageLayout: primary?.pageLayout ?? {},
      headerFooter: primary?.headerFooter ?? {},
    };
    if (effectiveSectionIndex === -1) {
      result.sections = sectionDetails;
      result.sectionCount = sectionDetails.length;
    }

    return {
      success: true,
      output: JSON.stringify(result, null, 2),
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to extract styles: ${msg}` };
  }
}

/**
 * Unified template style parser entrypoint for HWPX toolkit.
 * Keeps backward compatibility by delegating to hwpxExtractStyles.
 */
export async function parseTemplateStyle(
  args: Parameters<typeof hwpxExtractStyles>[0] & {
    preflightRead?: boolean;
    preflight_read?: boolean;
  },
): Promise<HwpxToolResult> {
  const runPreflight = args.preflightRead ?? args.preflight_read ?? true;
  if (runPreflight) {
    try {
      if (!args.path) return { success: false, output: 'Missing required parameter: path' };
      const resolvedPath = path.resolve(args.path);
      if (!(await pathExists(resolvedPath))) {
        return { success: false, output: `Preflight read failed: File not found: ${resolvedPath}` };
      }
      const zip = await loadHwpxZip(resolvedPath);
      if (!zip.file('Contents/header.xml')) {
        return { success: false, output: 'Preflight read failed: Invalid HWPX: header.xml not found' };
      }
      if (!zip.file('Contents/content.hpf')) {
        return { success: false, output: 'Preflight read failed: Invalid HWPX: content.hpf not found' };
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      return { success: false, output: `Preflight read failed: ${msg}` };
    }
  }
  return hwpxExtractStyles(args);
}

// ── ZIP edit helpers (private) ───────────────────────────

async function loadHwpxZip(filePath: string): Promise<JSZip> {
  const resolved = path.resolve(filePath);
  const buf = (await fs.promises.readFile(resolved));
  return JSZip.loadAsync(buf);
}

async function saveHwpxZip(zip: JSZip, outputPath: string): Promise<string> {
  const resolved = path.resolve(outputPath);
  const dir = path.dirname(resolved);
  if (!(await pathExists(dir))) (await fs.promises.mkdir(dir, { recursive: true }));

  // Rebuild ZIP to guarantee mimetype is first entry with STORE compression
  const newZip = new JSZip();
  const mimetypeFile = zip.file('mimetype');
  const mimetypeContent = mimetypeFile ? await mimetypeFile.async('string') : MIMETYPE;
  newZip.file('mimetype', mimetypeContent, { compression: 'STORE' });

  for (const [relativePath, file] of Object.entries(zip.files)) {
    if (relativePath === 'mimetype' || file.dir) continue;
    const content = await file.async('uint8array');
    newZip.file(relativePath, content);
  }

  const buffer = await newZip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  ;(await fs.promises.writeFile(resolved, buffer));
  return resolved;
}

function replaceMetaTag(xml: string, name: string, value: string): string {
  const escaped = escapeXml(value);
  // Match self-closing: <opf:meta name="X" content="text"/>
  const selfClosingRe = new RegExp(
    `(<opf:meta\\s+name="${name}"\\s+content="text")\\s*/>`,
    'g',
  );
  // Match with content: <opf:meta name="X" content="text">...</opf:meta>
  const contentRe = new RegExp(
    `(<opf:meta\\s+name="${name}"\\s+content="text">)[\\s\\S]*?</opf:meta>`,
    'g',
  );

  let result = xml;
  if (contentRe.test(result)) {
    result = result.replace(contentRe, `$1${escaped}</opf:meta>`);
  } else if (selfClosingRe.test(result)) {
    result = result.replace(selfClosingRe, `$1>${escaped}</opf:meta>`);
  }
  return result;
}

// ── Edit tool: set_metadata ─────────────────────────────

export async function hwpxSetMetadata(args: {
  path: string;
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  output_path?: string;
}): Promise<HwpxToolResult> {
  try {
    const { path: inputPath, title, author, subject, keywords, output_path } = args;
    if (!inputPath) return { success: false, output: 'Missing required parameter: path' };

    const zip = await loadHwpxZip(inputPath);
    const hpfFile = zip.file('Contents/content.hpf');
    if (!hpfFile) return { success: false, output: 'Invalid HWPX: Contents/content.hpf not found' };

    let hpfXml = await hpfFile.async('string');

    if (title !== undefined) {
      hpfXml = hpfXml.replace(
        /<opf:title>[\s\S]*?<\/opf:title>/,
        `<opf:title>${escapeXml(title)}</opf:title>`,
      );
    }

    if (author !== undefined) {
      hpfXml = replaceMetaTag(hpfXml, 'creator', author);
      hpfXml = replaceMetaTag(hpfXml, 'lastsaveby', author);
    }

    if (subject !== undefined) {
      hpfXml = replaceMetaTag(hpfXml, 'subject', subject);
    }

    if (keywords !== undefined) {
      hpfXml = replaceMetaTag(hpfXml, 'keyword', keywords);
    }

    // Update ModifiedDate
    const now = new Date().toISOString().replace('T', ' ').slice(0, 19);
    hpfXml = replaceMetaTag(hpfXml, 'ModifiedDate', now);

    zip.file('Contents/content.hpf', hpfXml);

    const outPath = output_path || inputPath;
    const saved = await saveHwpxZip(zip, outPath);

    const changed: string[] = [];
    if (title !== undefined) changed.push('title');
    if (author !== undefined) changed.push('author');
    if (subject !== undefined) changed.push('subject');
    if (keywords !== undefined) changed.push('keywords');

    return {
      success: true,
      output: `Metadata updated (${changed.join(', ')}): ${saved}`,
      outputPath: saved,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to set metadata: ${msg}` };
  }
}

// ── Edit tool: find_replace (with cross-run + multi-section) ──

export async function hwpxFindReplace(args: {
  path: string;
  find: string;
  replace: string;
  output_path?: string;
  case_sensitive?: boolean;
  section_index?: number;
}): Promise<HwpxToolResult> {
  try {
    const { path: inputPath, find, replace, output_path, case_sensitive, section_index } = args;
    if (!inputPath) return { success: false, output: 'Missing required parameter: path' };
    if (!find) return { success: false, output: 'Missing required parameter: find' };
    if (replace === undefined) return { success: false, output: 'Missing required parameter: replace' };

    const zip = await loadHwpxZip(inputPath);
    const caseSensitive = case_sensitive !== false;
    const flags = caseSensitive ? 'g' : 'gi';
    const escapedFind = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    let totalCount = 0;
    const sectionPaths = resolveSectionPaths(zip, section_index);

    for (const sectionPath of sectionPaths) {
      const sectionFile = zip.file(sectionPath);
      if (!sectionFile) continue;
      let sectionXml = await sectionFile.async('string');

      // Pass 1: single-run replacement
      let pass1Count = 0;
      sectionXml = sectionXml.replace(
        /(<hp:t>)([\s\S]*?)(<\/hp:t>)/g,
        (_match, open: string, content: string, close: string) => {
          let text = unescapeXml(content);
          const re = new RegExp(escapedFind, flags);
          const matches = text.match(re);
          if (matches) {
            pass1Count += matches.length;
            text = text.replace(re, replace);
          }
          return open + escapeXml(text) + close;
        },
      );
      totalCount += pass1Count;

      // Pass 2: cross-run (only if pass 1 found nothing)
      if (pass1Count === 0) {
        const crossResult = crossRunReplace(sectionXml, find, replace, caseSensitive);
        sectionXml = crossResult.xml;
        totalCount += crossResult.count;
      }

      zip.file(sectionPath, sectionXml);
    }

    const outPath = output_path || inputPath;
    const saved = await saveHwpxZip(zip, outPath);

    return {
      success: true,
      output: `Replaced ${totalCount} occurrence(s) of "${find}" → "${replace}": ${saved}`,
      outputPath: saved,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to find/replace: ${msg}` };
  }
}

/** Cross-run find/replace: concatenates run texts per paragraph, replaces, and rebuilds */
function crossRunReplace(
  sectionXml: string,
  find: string,
  replace: string,
  caseSensitive: boolean,
): { xml: string; count: number } {
  let totalCount = 0;
  const flags = caseSensitive ? 'g' : 'gi';
  const escapedFind = find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  const result = sectionXml.replace(
    /(<hp:p\s[^>]*>)([\s\S]*?)(<\/hp:p>)/g,
    (fullMatch, openTag: string, content: string, closeTag: string) => {
      // Extract runs
      const runRe = /<hp:run\s+charPrIDRef="(\d+)"><hp:t>([\s\S]*?)<\/hp:t><\/hp:run>/g;
      const runs: { charPrId: string; text: string }[] = [];
      let rm: RegExpExecArray | null;
      while ((rm = runRe.exec(content)) !== null) {
        runs.push({ charPrId: rm[1], text: unescapeXml(rm[2]) });
      }

      if (runs.length < 2) return fullMatch;

      const fullText = runs.map(r => r.text).join('');
      const re = new RegExp(escapedFind, flags);
      const matches = fullText.match(re);

      if (!matches) return fullMatch;

      totalCount += matches.length;
      const newText = fullText.replace(re, replace);

      // Rebuild: preserve first run's format, single run output
      const newContent = `\n    <hp:run charPrIDRef="${runs[0].charPrId}"><hp:t>${escapeXml(newText)}</hp:t></hp:run>\n  `;
      return openTag + newContent + closeTag;
    },
  );

  return { xml: result, count: totalCount };
}

// ── Edit tool: insert_text (with multi-section) ─────────

export async function hwpxInsertText(args: {
  path: string;
  text: string;
  output_path?: string;
  section_index?: number;
}): Promise<HwpxToolResult> {
  try {
    const { path: inputPath, text, output_path, section_index } = args;
    if (!inputPath) return { success: false, output: 'Missing required parameter: path' };
    if (!text && text !== '') return { success: false, output: 'Missing required parameter: text' };

    const zip = await loadHwpxZip(inputPath);
    const sectionPaths = resolveSectionPaths(zip, section_index);

    for (const sectionPath of sectionPaths) {
      const sectionFile = zip.file(sectionPath);
      if (!sectionFile) continue;
      let sectionXml = await sectionFile.async('string');

      let maxId = 0;
      const allIdRe = /\bid="(\d+)"/g;
      let m: RegExpExecArray | null;
      while ((m = allIdRe.exec(sectionXml)) !== null) {
        const id = Number(m[1]);
        if (id > maxId) maxId = id;
      }

      const lines = text.split('\n');
      const newParas: string[] = [];
      for (const line of lines) {
        maxId++;
        newParas.push(
          `  <hp:p id="${maxId}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">\n` +
          `    <hp:run charPrIDRef="0"><hp:t>${escapeXml(line)}</hp:t></hp:run>\n` +
          `  </hp:p>`,
        );
      }

      const insertBlock = '\n' + newParas.join('\n');
      const trailingRe = /(\n\s*<hp:p\s+id="\d+"[^>]*>\s*\n\s*<hp:run\s+charPrIDRef="0"><hp:t><\/hp:t><\/hp:run>\s*\n\s*<\/hp:p>\s*\n)<\/hs:sec>/;
      if (trailingRe.test(sectionXml)) {
        sectionXml = sectionXml.replace(trailingRe, insertBlock + '$1</hs:sec>');
      } else {
        sectionXml = sectionXml.replace('</hs:sec>', insertBlock + '\n</hs:sec>');
      }

      zip.file(sectionPath, sectionXml);
    }

    const lines = text.split('\n');
    const outPath = output_path || inputPath;
    const saved = await saveHwpxZip(zip, outPath);

    return {
      success: true,
      output: `Inserted ${lines.length} paragraph(s): ${saved}`,
      outputPath: saved,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to insert text: ${msg}` };
  }
}

// ── Edit tool: merge_documents ──────────────────────────

export async function hwpxMergeDocuments(args: {
  input_paths: string[];
  output_path: string;
}): Promise<HwpxToolResult> {
  try {
    const { input_paths, output_path } = args;
    if (!input_paths || input_paths.length === 0) {
      return { success: false, output: 'Missing required parameter: input_paths' };
    }
    if (!output_path) return { success: false, output: 'Missing required parameter: output_path' };

    // Extract content paragraphs from each document's section0.xml
    const allContent: string[] = [];
    let globalMaxId = 2147483648; // starting ID base

    for (const inputPath of input_paths) {
      const zip = await loadHwpxZip(inputPath);
      const sectionFile = zip.file('Contents/section0.xml');
      if (!sectionFile) {
        return { success: false, output: `Invalid HWPX (no section0.xml): ${inputPath}` };
      }
      const sectionXml = await sectionFile.async('string');

      // Extract content area: after the secPr paragraph, before trailing empty paragraph
      // The secPr paragraph is the first <hp:p> that contains <hp:secPr
      // Content paragraphs are everything between that and the trailing empty paragraph

      // Remove XML declaration and <hs:sec ...> wrapper
      const bodyMatch = sectionXml.match(/<hs:sec[^>]*>([\s\S]*)<\/hs:sec>/);
      if (!bodyMatch) continue;
      const body = bodyMatch[1];

      // Split into top-level elements (paragraphs and tables)
      const elementRe = /\s*(<hp:p\s[\s\S]*?<\/hp:p>|<hp:tbl\s[\s\S]*?<\/hp:tbl>)/g;
      const elements: string[] = [];
      let em: RegExpExecArray | null;
      while ((em = elementRe.exec(body)) !== null) {
        elements.push(em[1].trim());
      }

      // Skip first element (secPr paragraph) and last element (trailing empty paragraph)
      const contentElements: string[] = [];
      for (let i = 0; i < elements.length; i++) {
        const el = elements[i];
        // Skip secPr paragraph
        if (el.includes('<hp:secPr')) continue;
        // Skip trailing empty paragraph (last element that has empty <hp:t></hp:t>)
        if (i === elements.length - 1) {
          const isEmptyP = /<hp:p[^>]*>\s*<hp:run\s+charPrIDRef="0"><hp:t><\/hp:t><\/hp:run>\s*<\/hp:p>/.test(el);
          if (isEmptyP) continue;
        }
        contentElements.push(el);
      }

      allContent.push(...contentElements);
    }

    // Re-number all IDs to be unique
    let idCounter = globalMaxId;
    const renumbered = allContent.map(el => {
      return el.replace(/\bid="(\d+)"/g, () => {
        idCounter++;
        return `id="${idCounter}"`;
      });
    });

    // Build the merged section XML
    const secPr = buildSecPr();
    const firstParaId = ++idCounter;
    let sectionXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?>\n`;
    sectionXml += `<hs:sec ${COMMON_NS}>\n`;
    sectionXml += `  <hp:p id="${firstParaId}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">\n`;
    sectionXml += `    <hp:run charPrIDRef="0">\n`;
    sectionXml += secPr + '\n';
    sectionXml += `      <hp:ctrl>\n`;
    sectionXml += `        <hp:colPr id="" type="NEWSPAPER" layout="LEFT" colCount="1" sameSz="1" sameGap="0"/>\n`;
    sectionXml += `      </hp:ctrl>\n`;
    sectionXml += `    </hp:run>\n`;
    sectionXml += `  </hp:p>\n`;

    for (const para of renumbered) {
      sectionXml += para + '\n';
    }

    // Trailing empty paragraph
    const emptyParaId = ++idCounter;
    sectionXml += `  <hp:p id="${emptyParaId}" paraPrIDRef="0" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0">\n`;
    sectionXml += `    <hp:run charPrIDRef="0"><hp:t></hp:t></hp:run>\n`;
    sectionXml += `  </hp:p>\n`;
    sectionXml += `</hs:sec>`;

    // Build complete HWPX ZIP
    const zip = new JSZip();
    zip.file('mimetype', MIMETYPE, { compression: 'STORE' });
    zip.file('version.xml', VERSION_XML);
    zip.file('META-INF/container.xml', CONTAINER_XML);
    zip.file('META-INF/manifest.xml', MANIFEST_XML);
    zip.file('META-INF/container.rdf', buildContainerRdf(1));
    zip.file('settings.xml', SETTINGS_XML);
    zip.file('Contents/content.hpf', buildContentHpf(1, 'Merged Document'));
    zip.file('Contents/header.xml', buildHeaderXml(1));
    zip.file('Contents/section0.xml', sectionXml);
    zip.file('Preview/PrvText.txt', 'Merged Document');

    const saved = await saveHwpxZip(zip, output_path);

    return {
      success: true,
      output: `Merged ${input_paths.length} document(s) with ${renumbered.length} content element(s): ${saved}`,
      outputPath: saved,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to merge documents: ${msg}` };
  }
}

// ── Format tool: set_char_format ────────────────────────

export async function hwpxSetCharFormat(args: {
  path: string;
  target_text?: string;
  paragraph_index?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  font_size?: number;
  text_color?: string;
  font_name?: string;
  output_path?: string;
  section_index?: number;
}): Promise<HwpxToolResult> {
  try {
    const { path: inputPath, target_text, paragraph_index, bold, italic, underline, font_size, text_color, font_name, output_path, section_index } = args;
    if (!inputPath) return { success: false, output: 'Missing required parameter: path' };

    const zip = await loadHwpxZip(inputPath);
    const headerFile = zip.file('Contents/header.xml');
    if (!headerFile) return { success: false, output: 'Invalid HWPX: header.xml not found' };

    let headerXml = await headerFile.async('string');

    // Build overRides from params
    const overRides: CharFormatOptions = {};
    if (bold !== undefined) overRides.bold = bold;
    if (italic !== undefined) overRides.italic = italic;
    if (underline !== undefined) overRides.underline = underline;
    if (font_size !== undefined) overRides.fontSize = font_size;
    if (text_color !== undefined) overRides.textColor = text_color;

    // Font registration
    if (font_name !== undefined) {
      const fontResult = addFontToHeader(headerXml, font_name);
      headerXml = fontResult.xml;
      overRides.fontRef = fontResult.fontId;
    }

    let totalModified = 0;
    const sectionPaths = resolveSectionPaths(zip, section_index);

    for (const sectionPath of sectionPaths) {
      const sectionFile = zip.file(sectionPath);
      if (!sectionFile) continue;
      let sectionXml = await sectionFile.async('string');

      // Extract content paragraphs (skip secPr paragraph)
      const contentParas = extractContentParagraphs(sectionXml);

      // Determine target paragraphs
      let targetParas: { xml: string; index: number }[] = [];
      if (paragraph_index !== undefined) {
        if (paragraph_index >= 0 && paragraph_index < contentParas.length) {
          targetParas = [{ xml: contentParas[paragraph_index], index: paragraph_index }];
        }
      } else {
        targetParas = contentParas.map((xml, index) => ({ xml, index }));
      }

      // Find target runs and group by original charPrIDRef
      const runReplacements: Map<string, { newCharPrId: number }> = new Map();

      for (const para of targetParas) {
        const runs = [...para.xml.matchAll(/<hp:run\s+charPrIDRef="(\d+)">([\s\S]*?)<\/hp:run>/g)];

        for (const runMatch of runs) {
          const originalCharPrId = Number(runMatch[1]);
          const runContent = runMatch[2];

          // Check target_text filter
          if (target_text !== undefined) {
            const textMatch = runContent.match(/<hp:t>([\s\S]*?)<\/hp:t>/);
            const runText = textMatch ? unescapeXml(textMatch[1]) : '';
            if (!runText.includes(target_text)) continue;
          }

          // Use a cache key to avoid re-computing for same base charPrId
          const cacheKey = String(originalCharPrId);
          if (!runReplacements.has(cacheKey)) {
            const resolvedOpts = resolveCharFormat(headerXml, originalCharPrId, overRides);
            const result = addCharPrToHeader(headerXml, resolvedOpts);
            headerXml = result.xml;
            runReplacements.set(cacheKey, { newCharPrId: result.id });
          }

          const { newCharPrId } = runReplacements.get(cacheKey)!;

          // Replace charPrIDRef in this specific run within the section XML
          const oldRun = runMatch[0];
          const newRun = oldRun.replace(
            `charPrIDRef="${originalCharPrId}"`,
            `charPrIDRef="${newCharPrId}"`,
          );
          sectionXml = sectionXml.replace(oldRun, newRun);
          totalModified++;
        }
      }

      zip.file(sectionPath, sectionXml);
    }

    zip.file('Contents/header.xml', headerXml);

    const outPath = output_path || inputPath;
    const saved = await saveHwpxZip(zip, outPath);

    return {
      success: true,
      output: `Character format applied to ${totalModified} run(s): ${saved}`,
      outputPath: saved,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to set char format: ${msg}` };
  }
}

// ── Format tool: set_para_format ────────────────────────

export async function hwpxSetParaFormat(args: {
  path: string;
  target_text?: string;
  paragraph_index?: number;
  alignment?: string;
  line_spacing?: number;
  indent?: number;
  margin_left?: number;
  margin_right?: number;
  space_before?: number;
  space_after?: number;
  output_path?: string;
  section_index?: number;
}): Promise<HwpxToolResult> {
  try {
    const { path: inputPath, target_text, paragraph_index, alignment, line_spacing, indent, margin_left, margin_right, space_before, space_after, output_path, section_index } = args;
    if (!inputPath) return { success: false, output: 'Missing required parameter: path' };

    const zip = await loadHwpxZip(inputPath);
    const headerFile = zip.file('Contents/header.xml');
    if (!headerFile) return { success: false, output: 'Invalid HWPX: header.xml not found' };

    let headerXml = await headerFile.async('string');

    // Build paraPr options
    const opts: ParaFormatOptions = {};
    if (alignment !== undefined) opts.alignment = alignment as ParaFormatOptions['alignment'];
    if (line_spacing !== undefined) {
      opts.lineSpacingType = 'PERCENT';
      opts.lineSpacingValue = line_spacing;
    }
    if (indent !== undefined) opts.indent = mmToHwpUnit(indent);
    if (margin_left !== undefined) opts.marginLeft = mmToHwpUnit(margin_left);
    if (margin_right !== undefined) opts.marginRight = mmToHwpUnit(margin_right);
    if (space_before !== undefined) opts.spaceBefore = mmToHwpUnit(space_before);
    if (space_after !== undefined) opts.spaceAfter = mmToHwpUnit(space_after);

    // Add paraPr to header
    const paraPrResult = addParaPrToHeader(headerXml, opts);
    headerXml = paraPrResult.xml;
    const newParaPrId = paraPrResult.id;

    let totalModified = 0;
    const sectionPaths = resolveSectionPaths(zip, section_index);

    for (const sectionPath of sectionPaths) {
      const sectionFile = zip.file(sectionPath);
      if (!sectionFile) continue;
      let sectionXml = await sectionFile.async('string');

      // Extract content paragraphs
      const contentParas = extractContentParagraphs(sectionXml);

      // Determine target paragraphs
      const targetIndices: number[] = [];
      if (paragraph_index !== undefined) {
        if (paragraph_index >= 0 && paragraph_index < contentParas.length) {
          targetIndices.push(paragraph_index);
        }
      } else if (target_text !== undefined) {
        for (let i = 0; i < contentParas.length; i++) {
          const paraText = extractParaText(contentParas[i]);
          if (paraText.includes(target_text)) {
            targetIndices.push(i);
          }
        }
      } else {
        for (let i = 0; i < contentParas.length; i++) {
          targetIndices.push(i);
        }
      }

      // Replace paraPrIDRef in target paragraphs
      for (const idx of targetIndices) {
        const oldPara = contentParas[idx];
        const newPara = oldPara.replace(
          /(<hp:p\s+id="[^"]*"\s+)paraPrIDRef="\d+"/,
          `$1paraPrIDRef="${newParaPrId}"`,
        );
        if (newPara !== oldPara) {
          sectionXml = sectionXml.replace(oldPara, newPara);
          totalModified++;
        }
      }

      zip.file(sectionPath, sectionXml);
    }

    zip.file('Contents/header.xml', headerXml);

    const outPath = output_path || inputPath;
    const saved = await saveHwpxZip(zip, outPath);

    return {
      success: true,
      output: `Paragraph format applied to ${totalModified} paragraph(s): ${saved}`,
      outputPath: saved,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to set para format: ${msg}` };
  }
}

// ── Format tool: set_page_layout ────────────────────────

export async function hwpxSetPageLayout(args: {
  path: string;
  page_width?: number;   // mm
  page_height?: number;  // mm
  margin_top?: number;   // mm
  margin_bottom?: number; // mm
  margin_left?: number;  // mm
  margin_right?: number; // mm
  margin_header?: number; // mm
  margin_footer?: number; // mm
  output_path?: string;
  section_index?: number;
}): Promise<HwpxToolResult> {
  try {
    const { path: inputPath, output_path, section_index } = args;
    if (!inputPath) return { success: false, output: 'Missing required parameter: path' };

    const zip = await loadHwpxZip(inputPath);

    // Convert mm → HWPUNIT at the boundary
    const pageWidth = args.page_width !== undefined ? mmToHwpUnit(args.page_width) : undefined;
    const pageHeight = args.page_height !== undefined ? mmToHwpUnit(args.page_height) : undefined;
    const marginTop = args.margin_top !== undefined ? mmToHwpUnit(args.margin_top) : undefined;
    const marginBottom = args.margin_bottom !== undefined ? mmToHwpUnit(args.margin_bottom) : undefined;
    const marginLeft = args.margin_left !== undefined ? mmToHwpUnit(args.margin_left) : undefined;
    const marginRight = args.margin_right !== undefined ? mmToHwpUnit(args.margin_right) : undefined;
    const marginHeader = args.margin_header !== undefined ? mmToHwpUnit(args.margin_header) : undefined;
    const marginFooter = args.margin_footer !== undefined ? mmToHwpUnit(args.margin_footer) : undefined;

    const sectionPaths = resolveSectionPaths(zip, section_index);

    for (const sectionPath of sectionPaths) {
      const sectionFile = zip.file(sectionPath);
      if (!sectionFile) continue;
      let sectionXml = await sectionFile.async('string');

      // Replace pagePr attributes
      if (pageWidth !== undefined) {
        sectionXml = sectionXml.replace(
          /(<hp:pagePr\s[^>]*\bwidth=")(\d+)(")/,
          `$1${pageWidth}$3`,
        );
      }
      if (pageHeight !== undefined) {
        sectionXml = sectionXml.replace(
          /(<hp:pagePr\s[^>]*\bheight=")(\d+)(")/,
          `$1${pageHeight}$3`,
        );
      }

      // Replace margin attributes
      const marginReplace = (xml: string, attr: string, value: number | undefined): string => {
        if (value === undefined) return xml;
        return xml.replace(
          new RegExp(`(<hp:margin\\s[^>]*\\b${attr}=")(\\d+)(")`),
          `$1${value}$3`,
        );
      };

      sectionXml = marginReplace(sectionXml, 'top', marginTop);
      sectionXml = marginReplace(sectionXml, 'bottom', marginBottom);
      sectionXml = marginReplace(sectionXml, 'left', marginLeft);
      sectionXml = marginReplace(sectionXml, 'right', marginRight);
      sectionXml = marginReplace(sectionXml, 'header', marginHeader);
      sectionXml = marginReplace(sectionXml, 'footer', marginFooter);

      zip.file(sectionPath, sectionXml);
    }

    const outPath = output_path || inputPath;
    const saved = await saveHwpxZip(zip, outPath);

    const changed: string[] = [];
    if (pageWidth !== undefined) changed.push('width');
    if (pageHeight !== undefined) changed.push('height');
    if (marginTop !== undefined) changed.push('margin-top');
    if (marginBottom !== undefined) changed.push('margin-bottom');
    if (marginLeft !== undefined) changed.push('margin-left');
    if (marginRight !== undefined) changed.push('margin-right');
    if (marginHeader !== undefined) changed.push('margin-header');
    if (marginFooter !== undefined) changed.push('margin-footer');

    return {
      success: true,
      output: `Page layout updated (${changed.join(', ')}): ${saved}`,
      outputPath: saved,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to set page layout: ${msg}` };
  }
}

// ── Format tool: edit_table_cell ────────────────────────

export async function hwpxEditTableCell(args: {
  path: string;
  table_index?: number;
  row: number;
  col: number;
  text?: string;
  background_color?: string;
  border_type?: string;
  border_width?: string;
  merge_right?: number;
  merge_down?: number;
  output_path?: string;
  section_index?: number;
}): Promise<HwpxToolResult> {
  try {
    const { path: inputPath, table_index, row, col, text, background_color, border_type, border_width, merge_right, merge_down, output_path, section_index } = args;
    if (!inputPath) return { success: false, output: 'Missing required parameter: path' };

    const zip = await loadHwpxZip(inputPath);
    const headerFile = zip.file('Contents/header.xml');
    if (!headerFile) return { success: false, output: 'Invalid HWPX: header.xml not found' };

    let headerXml = await headerFile.async('string');

    // Use first matching section (table_index is relative to the section)
    const sectionPaths = resolveSectionPaths(zip, section_index);
    const sectionPath = sectionPaths[0];
    const sectionFile = zip.file(sectionPath);
    if (!sectionFile) return { success: false, output: `Invalid HWPX: ${sectionPath} not found` };

    let sectionXml = await sectionFile.async('string');

    // Find the N-th table
    const tableIdx = table_index ?? 0;
    const tableMatches = [...sectionXml.matchAll(/<hp:tbl\s[\s\S]*?<\/hp:tbl>/g)];
    if (tableIdx >= tableMatches.length) {
      return { success: false, output: `Table index ${tableIdx} out of range (${tableMatches.length} tables found)` };
    }

    const originalTableXml = tableMatches[tableIdx][0];
    const parsed = parseTableXml(originalTableXml);

    // Validate row/col
    if (row < 0 || row >= parsed.rows.length) {
      return { success: false, output: `Row ${row} out of range (${parsed.rows.length} rows)` };
    }
    if (col < 0 || col >= parsed.rows[row].length) {
      return { success: false, output: `Col ${col} out of range (${parsed.rows[row].length} cols in row ${row})` };
    }

    const targetCell = parsed.rows[row][col];
    const changes: string[] = [];

    // Text replacement
    if (text !== undefined) {
      targetCell.text = text;
      changes.push('text');
    }

    // Background color / border styling
    if (background_color !== undefined || border_type !== undefined || border_width !== undefined) {
      const bfOpts: BorderFillOptions = {};
      if (background_color !== undefined) bfOpts.backgroundColor = background_color;
      if (border_type !== undefined) bfOpts.borderType = border_type as BorderFillOptions['borderType'];
      if (border_width !== undefined) bfOpts.borderWidth = border_width;
      const bfResult = addBorderFillToHeader(headerXml, bfOpts);
      headerXml = bfResult.xml;
      targetCell.borderFillIDRef = bfResult.id;
      if (background_color !== undefined) changes.push('background');
      if (border_type !== undefined) changes.push('border');
    }

    // Merge right
    if (merge_right !== undefined && merge_right > 0) {
      const mr = merge_right;
      for (let c = 1; c <= mr; c++) {
        const absCol = col + c;
        if (absCol < parsed.rows[row].length) {
          targetCell.width += parsed.rows[row][absCol].width;
        }
      }
      parsed.rows[row].splice(col + 1, mr);
      targetCell.colSpan += mr;
      changes.push(`merge_right=${mr}`);
    }

    // Merge down
    if (merge_down !== undefined && merge_down > 0) {
      const md = merge_down;
      for (let r = 1; r <= md; r++) {
        const absRow = row + r;
        if (absRow < parsed.rows.length) {
          const belowRow = parsed.rows[absRow];
          const belowCellIdx = belowRow.findIndex(c => c.colAddr === targetCell.colAddr);
          if (belowCellIdx >= 0) {
            const removeCount = merge_right !== undefined && merge_right > 0 ? targetCell.colSpan : 1;
            let removed = 0;
            while (removed < removeCount && belowCellIdx < belowRow.length) {
              belowRow.splice(belowCellIdx, 1);
              removed++;
            }
          }
        }
      }
      targetCell.rowSpan += md;
      changes.push(`merge_down=${md}`);
    }

    parsed.rowCnt = parsed.rows.length;

    // Rebuild table XML
    let idCounter = 0;
    const allIdMatches = [...sectionXml.matchAll(/\bid="(\d+)"/g)];
    let maxExistingId = 0;
    for (const m of allIdMatches) {
      const id = Number(m[1]);
      if (id > maxExistingId) maxExistingId = id;
    }
    idCounter = maxExistingId;

    const newTableXml = buildTableXml(parsed, () => String(++idCounter));
    sectionXml = sectionXml.replace(originalTableXml, newTableXml);

    zip.file('Contents/header.xml', headerXml);
    zip.file(sectionPath, sectionXml);

    const outPath = output_path || inputPath;
    const saved = await saveHwpxZip(zip, outPath);

    return {
      success: true,
      output: `Table cell [${row},${col}] updated (${changes.join(', ')}): ${saved}`,
      outputPath: saved,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to edit table cell: ${msg}` };
  }
}

// ── New tool: insert_image ───────────────────────────────

export async function hwpxInsertImage(args: {
  path: string;
  image_path: string;
  width_mm?: number;
  height_mm?: number;
  text_wrap?: 'TOP_AND_BOTTOM' | 'SQUARE' | 'BEHIND_TEXT';
  output_path?: string;
  section_index?: number;
}): Promise<HwpxToolResult> {
  try {
    const { path: inputPath, image_path, width_mm, height_mm, text_wrap, output_path, section_index } = args;
    if (!inputPath) return { success: false, output: 'Missing required parameter: path' };
    if (!image_path) return { success: false, output: 'Missing required parameter: image_path' };

    const resolvedImgPath = path.resolve(image_path);
    if (!(await pathExists(resolvedImgPath))) {
      return { success: false, output: `Image file not found: ${resolvedImgPath}` };
    }

    const imgBuf = (await fs.promises.readFile(resolvedImgPath));
    const ext = path.extname(resolvedImgPath).slice(1).toLowerCase();
    const format = ext === 'jpg' ? 'jpeg' : ext;

    const zip = await loadHwpxZip(inputPath);
    const headerFile = zip.file('Contents/header.xml');
    if (!headerFile) return { success: false, output: 'Invalid HWPX: header.xml not found' };

    let headerXml = await headerFile.async('string');

    // Determine binItem ID
    const binIdMatches = [...headerXml.matchAll(/<hh:binItem\s+id="(\d+)"/g)];
    let maxBinId = 0;
    for (const m of binIdMatches) {
      const id = Number(m[1]);
      if (id > maxBinId) maxBinId = id;
    }
    const binItemId = maxBinId + 1;

    // Add image to ZIP
    const imgFileName = `image${binItemId}.${ext}`;
    zip.file(`BinData/${imgFileName}`, imgBuf);

    // Add binItem to header
    headerXml = addBinItemToHeader(headerXml, binItemId, `BinData/${imgFileName}`, format);

    // Calculate dimensions
    const widthHU = width_mm ? mmToHwpUnit(width_mm) : mmToHwpUnit(100); // default 100mm
    const heightHU = height_mm ? mmToHwpUnit(height_mm) : mmToHwpUnit(75); // default 75mm

    const sectionPaths = resolveSectionPaths(zip, section_index);

    for (const sectionPath of sectionPaths) {
      const sectionFile = zip.file(sectionPath);
      if (!sectionFile) continue;
      let sectionXml = await sectionFile.async('string');

      // Find max ID in section
      let maxId = 0;
      const allIdRe = /\bid="(\d+)"/g;
      let m: RegExpExecArray | null;
      while ((m = allIdRe.exec(sectionXml)) !== null) {
        const id = Number(m[1]);
        if (id > maxId) maxId = id;
      }

      const paraId = String(maxId + 1);
      const picId = String(maxId + 2);

      const picXml = buildImagePicXml(paraId, picId, binItemId, widthHU, heightHU, text_wrap);

      // Insert before trailing empty paragraph
      const trailingRe = /(\n\s*<hp:p\s+id="\d+"[^>]*>\s*\n?\s*<hp:run\s+charPrIDRef="0"><hp:t><\/hp:t><\/hp:run>\s*\n?\s*<\/hp:p>\s*\n)<\/hs:sec>/;
      if (trailingRe.test(sectionXml)) {
        sectionXml = sectionXml.replace(trailingRe, '\n' + picXml + '$1</hs:sec>');
      } else {
        sectionXml = sectionXml.replace('</hs:sec>', '\n' + picXml + '\n</hs:sec>');
      }

      zip.file(sectionPath, sectionXml);
    }

    zip.file('Contents/header.xml', headerXml);

    // Update manifest to include BinData
    const manifestFile = zip.file('META-INF/manifest.xml');
    if (manifestFile) {
      let manifestXml = await manifestFile.async('string');
      if (!manifestXml.includes('BinData/')) {
        manifestXml = manifestXml.replace(
          '</manifest:manifest>',
          `  <manifest:file-entry manifest:full-path="BinData/" manifest:media-type=""/>\n</manifest:manifest>`,
        );
      }
      zip.file('META-INF/manifest.xml', manifestXml);
    }

    const outPath = output_path || inputPath;
    const saved = await saveHwpxZip(zip, outPath);

    return {
      success: true,
      output: `Image inserted (${widthHU}x${heightHU} HU, binItem=${binItemId}): ${saved}`,
      outputPath: saved,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to insert image: ${msg}` };
  }
}

// ── New tool: set_header_footer ─────────────────────────

export async function hwpxSetHeaderFooter(args: {
  path: string;
  type: 'header' | 'footer';
  text?: string;
  content?: HwpxHeaderFooterContent;
  table?: HwpxHeaderFooterTable;
  auto_page_num?: boolean;
  auto_total_pages?: boolean;
  autoPageNum?: boolean;
  autoTotalPages?: boolean;
  alignment?: 'LEFT' | 'CENTER' | 'RIGHT';
  output_path?: string;
  section_index?: number;
}): Promise<HwpxToolResult> {
  try {
    const {
      path: inputPath,
      type,
      text,
      content,
      table,
      auto_page_num,
      auto_total_pages,
      autoPageNum,
      autoTotalPages,
      alignment,
      output_path,
      section_index,
    } = args;
    if (!inputPath) return { success: false, output: 'Missing required parameter: path' };
    if (!type) return { success: false, output: 'Missing required parameter: type' };
    const hasTopLevelContent = !!table || !!auto_page_num || !!auto_total_pages || !!autoPageNum || !!autoTotalPages;
    if ((text === undefined || text === null) && !content && !hasTopLevelContent) {
      return { success: false, output: 'Missing required parameter: text/content/table/auto_page_num' };
    }
    const hfContent: HwpxHeaderFooterContent = content ?? {
      text: text ?? '',
      table,
      autoPageNum: autoPageNum ?? auto_page_num,
      autoTotalPages: autoTotalPages ?? auto_total_pages,
    };

    const zip = await loadHwpxZip(inputPath);
    const sectionPaths = resolveSectionPaths(zip, section_index);

    for (const sectionPath of sectionPaths) {
      const sectionFile = zip.file(sectionPath);
      if (!sectionFile) continue;
      let sectionXml = await sectionFile.async('string');

      // Find max ID
      let maxId = 0;
      const allIdRe = /\bid="(\d+)"/g;
      let m: RegExpExecArray | null;
      while ((m = allIdRe.exec(sectionXml)) !== null) {
        const id = Number(m[1]);
        if (id > maxId) maxId = id;
      }

      let idCounter = maxId;
      const nextId = (): string => String(++idCounter);
      const paraId = nextId();
      const hfXml = buildHeaderFooterXml(type, hfContent, paraId, alignment, 0, nextId);

      // Insert inside secPr (before </hp:secPr>)
      const tagName = type === 'header' ? 'hp:header' : 'hp:footer';
      // Remove existing header/footer of same type if present
      const existingRe = new RegExp(`\\s*<${tagName}[\\s\\S]*?</${tagName}>`, 'g');
      sectionXml = sectionXml.replace(existingRe, '');

      // Insert before </hp:secPr>
      sectionXml = sectionXml.replace(
        /(\s*)<\/hp:secPr>/,
        `\n${hfXml}\n$1</hp:secPr>`,
      );

      zip.file(sectionPath, sectionXml);
    }

    const outPath = output_path || inputPath;
    const saved = await saveHwpxZip(zip, outPath);

    return {
      success: true,
      output: `${type === 'header' ? 'Header' : 'Footer'} set: ${saved}`,
      outputPath: saved,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to set header/footer: ${msg}` };
  }
}

// ── New tool: insert_table ──────────────────────────────

export async function hwpxInsertTable(args: {
  path: string;
  rows: number;
  cols: number;
  headers?: string[];
  data?: string[][];
  output_path?: string;
  section_index?: number;
}): Promise<HwpxToolResult> {
  try {
    const { path: inputPath, rows, cols, headers, data, output_path, section_index } = args;
    if (!inputPath) return { success: false, output: 'Missing required parameter: path' };
    if (rows === undefined) return { success: false, output: 'Missing required parameter: rows' };
    if (cols === undefined) return { success: false, output: 'Missing required parameter: cols' };

    const zip = await loadHwpxZip(inputPath);
    const sectionPaths = resolveSectionPaths(zip, section_index);

    for (const sectionPath of sectionPaths) {
      const sectionFile = zip.file(sectionPath);
      if (!sectionFile) continue;
      let sectionXml = await sectionFile.async('string');

      // Find max ID
      let maxId = 0;
      const allIdRe = /\bid="(\d+)"/g;
      let m: RegExpExecArray | null;
      while ((m = allIdRe.exec(sectionXml)) !== null) {
        const id = Number(m[1]);
        if (id > maxId) maxId = id;
      }

      let idCounter = maxId;
      const tableXml = buildNewTable(
        rows,
        cols,
        headers || [],
        data || [],
        () => String(++idCounter),
      );

      // Insert before trailing empty paragraph
      const trailingRe = /(\n\s*<hp:p\s+id="\d+"[^>]*>\s*\n?\s*<hp:run\s+charPrIDRef="0"><hp:t><\/hp:t><\/hp:run>\s*\n?\s*<\/hp:p>\s*\n)<\/hs:sec>/;
      if (trailingRe.test(sectionXml)) {
        sectionXml = sectionXml.replace(trailingRe, '\n' + tableXml + '$1</hs:sec>');
      } else {
        sectionXml = sectionXml.replace('</hs:sec>', '\n' + tableXml + '\n</hs:sec>');
      }

      zip.file(sectionPath, sectionXml);
    }

    const outPath = output_path || inputPath;
    const saved = await saveHwpxZip(zip, outPath);

    return {
      success: true,
      output: `Table inserted (${rows}x${cols}): ${saved}`,
      outputPath: saved,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return { success: false, output: `Failed to insert table: ${msg}` };
  }
}

// ── Section path resolver ───────────────────────────────

/** Resolve section XML paths from ZIP based on section_index.
 *  undefined → section0 only; -1 → all sections; N → sectionN */
function resolveSectionPaths(zip: JSZip, sectionIndex?: number): string[] {
  if (sectionIndex === undefined) return ['Contents/section0.xml'];
  if (sectionIndex === -1) {
    const paths: string[] = [];
    zip.forEach((p) => {
      if (/^Contents\/section\d+\.xml$/.test(p)) paths.push(p);
    });
    return paths.sort();
  }
  return [`Contents/section${sectionIndex}.xml`];
}

// ── Format tool helpers ─────────────────────────────────

/** Extract content paragraphs from section XML (skip secPr paragraph and trailing empty) */
function extractContentParagraphs(sectionXml: string): string[] {
  const bodyMatch = sectionXml.match(/<hs:sec[^>]*>([\s\S]*)<\/hs:sec>/);
  if (!bodyMatch) return [];
  const body = bodyMatch[1];

  // Match top-level <hp:p> elements (not inside tables)
  const elements: string[] = [];
  const elementRe = /\s*(<hp:p\s[\s\S]*?<\/hp:p>)/g;
  let m: RegExpExecArray | null;
  while ((m = elementRe.exec(body)) !== null) {
    elements.push(m[1].trim());
  }

  // Filter out secPr paragraph and trailing empty paragraph
  const result: string[] = [];
  for (let i = 0; i < elements.length; i++) {
    const el = elements[i];
    if (el.includes('<hp:secPr')) continue;
    // Skip trailing empty paragraph (last element with empty <hp:t></hp:t>)
    if (i === elements.length - 1) {
      const isEmptyP = /<hp:p[^>]*>\s*\n?\s*<hp:run\s+charPrIDRef="\d+"><hp:t><\/hp:t><\/hp:run>\s*\n?\s*<\/hp:p>/.test(el);
      if (isEmptyP) continue;
    }
    result.push(el);
  }

  return result;
}

/** Extract plain text from a paragraph XML */
function extractParaText(paraXml: string): string {
  const texts: string[] = [];
  const textRe = /<hp:t>([\s\S]*?)<\/hp:t>/g;
  let m: RegExpExecArray | null;
  while ((m = textRe.exec(paraXml)) !== null) {
    texts.push(unescapeXml(m[1]));
  }
  return texts.join('');
}

// ── Helper ──────────────────────────────────────────────

/**
 * Reconstruct a HwpxPipeline from an existing task_dir path.
 * Extracts sessionId/taskType/taskId from the directory structure.
 */
function pipelineFromTaskDir(taskDir: string): HwpxPipeline {
  // taskDir = workDir/sessionId/taskType/taskId
  const parts = taskDir.split(path.sep);
  const taskId = parts[parts.length - 1];
  const taskType = parts[parts.length - 2];
  const sessionId = parts[parts.length - 3];
  const workDir = parts.slice(0, parts.length - 3).join(path.sep);

  return new HwpxPipeline({
    sessionId,
    taskType,
    taskId,
    workDir: workDir || '/',
  });
}
