/**
 * DOCX tool implementations — 22 tools matching hwpx 1:1 + docx_accept_changes.
 */

import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';

import { createDocx } from './writer.js';
import { createDocument, type DocxCreateDocumentParams } from './create-document.js';
import { DocxPipeline, resolveWorkDir } from './pipeline.js';
import { acceptTrackedChanges } from './tracked-changes.js';
import { validateDocx } from './validate.js';
import { escapeXml, buildCoreXml, buildDocumentRels, buildContentTypes } from './template.js';
import {
  DOCX_DEFAULTS,
  DOCX_PAGE_SIZES,
  mmToTwips,
  mmToEmu,
  ptToHalfPt,
  twipsToMm,
} from './configs.js';
import {
  buildRPr,
  buildRun,
  buildPPr,
  buildParagraph,
  buildTable,
  buildSectPr,
  buildInlineImage,
  type RunFormatOptions,
} from './formatter.js';

export type DocxToolResult = {
  success: boolean;
  output: string;
  outputPath?: string;
};

// ── Utility ─────────────────────────────────────────────

async function readDocxZip(filePath: string): Promise<JSZip> {
  const data = await fs.promises.readFile(path.resolve(filePath));
  return JSZip.loadAsync(data);
}

async function writeDocxZip(zip: JSZip, outputPath: string): Promise<void> {
  const buffer = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
  await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.promises.writeFile(outputPath, buffer);
}

async function getDocumentXml(zip: JSZip): Promise<string> {
  const file = zip.file('word/document.xml');
  if (!file) throw new Error('word/document.xml not found in DOCX');
  return file.async('string');
}

function pipelineFromTaskDir(taskDir: string): DocxPipeline {
  return new DocxPipeline({
    sessionId: '_',
    taskType: 'docx',
    taskId: '_',
    workDir: taskDir.replace(/\/steps\/.*$/, '').replace(/\/_\/docx\/_$/, ''),
  });
}

// ── 1. docx_create_markdown ─────────────────────────────

export async function docxCreateMarkdown(args: {
  markdown: string;
  output_path: string;
}): Promise<DocxToolResult> {
  try {
    const buffer = await createDocx(args.markdown);
    const outputPath = path.resolve(args.output_path);
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, buffer);
    return { success: true, output: `DOCX created at ${outputPath}`, outputPath };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ── 2. docx_create_document ─────────────────────────────

export async function docxCreateDocument(
  args: DocxCreateDocumentParams,
): Promise<DocxToolResult> {
  try {
    const buffer = await createDocument(args);
    const outputPath = path.resolve(args.output_path);
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, buffer);
    return { success: true, output: `Structured DOCX created at ${outputPath}`, outputPath };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ── 3. docx_init_task ───────────────────────────────────

export async function docxInitTask(args: {
  session_id: string;
  task_id: string;
  work_dir?: string;
}): Promise<DocxToolResult> {
  try {
    const pipeline = new DocxPipeline({
      sessionId: args.session_id,
      taskType: 'docx',
      taskId: args.task_id,
      workDir: args.work_dir,
    });
    await pipeline.setMeta({ createdAt: new Date().toISOString() });
    return { success: true, output: pipeline.taskDir };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ── 4. docx_write_markdown ──────────────────────────────

export async function docxWriteMarkdown(args: {
  task_dir: string;
  markdown: string;
}): Promise<DocxToolResult> {
  try {
    const pipeline = new DocxPipeline({
      sessionId: '_',
      taskType: 'docx',
      taskId: '_',
      workDir: path.dirname(path.dirname(path.dirname(args.task_dir))),
    });
    // Override taskDir by creating pipeline with correct context
    const ctx = extractTaskContext(args.task_dir);
    const pl = new DocxPipeline(ctx);
    const ast = await pl.writeMarkdown(args.markdown);
    return {
      success: true,
      output: `Markdown saved and parsed. AST has ${ast.children.length} top-level nodes.`,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ── 5. docx_write_xml ───────────────────────────────────

export async function docxWriteXml(args: {
  task_dir: string;
  page_width?: number;
  page_height?: number;
  margin_top?: number;
  margin_bottom?: number;
  margin_left?: number;
  margin_right?: number;
}): Promise<DocxToolResult> {
  try {
    const ctx = extractTaskContext(args.task_dir);
    const pl = new DocxPipeline(ctx);

    // Read AST from parsed step
    const astPath = path.join(args.task_dir, 'steps/02_parsed/ast.json');
    const astJson = await fs.promises.readFile(astPath, 'utf-8');
    const ast = JSON.parse(astJson);

    const docOpts: any = {};
    if (args.page_width) docOpts.pageWidth = mmToTwips(args.page_width);
    if (args.page_height) docOpts.pageHeight = mmToTwips(args.page_height);
    if (args.margin_top) docOpts.marginTop = mmToTwips(args.margin_top);
    if (args.margin_bottom) docOpts.marginBottom = mmToTwips(args.margin_bottom);
    if (args.margin_left) docOpts.marginLeft = mmToTwips(args.margin_left);
    if (args.margin_right) docOpts.marginRight = mmToTwips(args.margin_right);

    await pl.writeXml(ast, { documentOptions: docOpts });
    return { success: true, output: 'DOCX XML files generated in 03_intermediate/docx/' };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ── 6. docx_pack_document ───────────────────────────────

export async function docxPack(args: {
  task_dir: string;
}): Promise<DocxToolResult> {
  try {
    const ctx = extractTaskContext(args.task_dir);
    const pl = new DocxPipeline(ctx);
    const outputPath = await pl.pack();
    return { success: true, output: `Packed to ${outputPath}`, outputPath };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ── 7. docx_unpack_document ─────────────────────────────

export async function docxUnpack(args: {
  task_dir: string;
  input_path: string;
}): Promise<DocxToolResult> {
  try {
    const ctx = extractTaskContext(args.task_dir);
    const pl = new DocxPipeline(ctx);
    await pl.unpack(args.input_path);
    return { success: true, output: 'DOCX unpacked to 03_intermediate/docx/' };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ── 8. docx_read_xml ────────────────────────────────────

export async function docxReadXml(args: {
  task_dir: string;
}): Promise<DocxToolResult> {
  try {
    const ctx = extractTaskContext(args.task_dir);
    const pl = new DocxPipeline(ctx);
    const ast = await pl.readXml();
    return {
      success: true,
      output: `XML parsed to AST with ${ast.children.length} top-level nodes.`,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ── 9. docx_read_markdown ───────────────────────────────

export async function docxReadMarkdown(args: {
  task_dir: string;
}): Promise<DocxToolResult> {
  try {
    const ctx = extractTaskContext(args.task_dir);
    const pl = new DocxPipeline(ctx);

    const astPath = path.join(args.task_dir, 'steps/02_parsed/ast.json');
    const astJson = await fs.promises.readFile(astPath, 'utf-8');
    const ast = JSON.parse(astJson);

    const markdown = await pl.readMarkdown(ast);
    return { success: true, output: markdown };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ── 10. docx_extract_styles ─────────────────────────────

export async function docxExtractStyles(args: {
  path: string;
}): Promise<DocxToolResult> {
  try {
    const zip = await readDocxZip(args.path);

    const result: Record<string, any> = {};

    // Extract styles.xml
    const stylesFile = zip.file('word/styles.xml');
    if (stylesFile) {
      const stylesXml = await stylesFile.async('string');
      result.stylesXml = stylesXml;

      // Extract style definitions
      const styles: any[] = [];
      const styleRe = /<w:style\s[^>]*w:styleId="([^"]+)"[^>]*>([\s\S]*?)<\/w:style>/g;
      let m: RegExpExecArray | null;
      while ((m = styleRe.exec(stylesXml)) !== null) {
        const nameMatch = m[2].match(/<w:name\s+w:val="([^"]+)"/);
        styles.push({
          styleId: m[1],
          name: nameMatch?.[1] ?? m[1],
        });
      }
      result.styles = styles;
    }

    // Extract numbering
    const numberingFile = zip.file('word/numbering.xml');
    if (numberingFile) {
      result.hasNumbering = true;
    }

    // Extract metadata
    const coreFile = zip.file('docProps/core.xml');
    if (coreFile) {
      const coreXml = await coreFile.async('string');
      const titleMatch = coreXml.match(/<dc:title>([\s\S]*?)<\/dc:title>/);
      const creatorMatch = coreXml.match(/<dc:creator>([\s\S]*?)<\/dc:creator>/);
      result.metadata = {
        title: titleMatch?.[1],
        creator: creatorMatch?.[1],
      };
    }

    return { success: true, output: JSON.stringify(result, null, 2) };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ── 11. docx_set_metadata ───────────────────────────────

export async function docxSetMetadata(args: {
  path: string;
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  output_path?: string;
}): Promise<DocxToolResult> {
  try {
    const zip = await readDocxZip(args.path);
    const coreXml = buildCoreXml({
      title: args.title,
      creator: args.author,
      lastModifiedBy: args.author,
      subject: args.subject,
      keywords: args.keywords,
    });
    zip.file('docProps/core.xml', coreXml);

    const outputPath = path.resolve(args.output_path ?? args.path);
    await writeDocxZip(zip, outputPath);
    return { success: true, output: `Metadata updated at ${outputPath}`, outputPath };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ── 12. docx_find_replace ───────────────────────────────

export async function docxFindReplace(args: {
  path: string;
  find: string;
  replace: string;
  output_path?: string;
  case_sensitive?: boolean;
}): Promise<DocxToolResult> {
  try {
    const zip = await readDocxZip(args.path);
    let docXml = await getDocumentXml(zip);

    const findEsc = escapeXml(args.find);
    const replaceEsc = escapeXml(args.replace);
    const caseSensitive = args.case_sensitive !== false;

    // Simple text replacement within w:t elements
    const flags = caseSensitive ? 'g' : 'gi';
    const findRe = new RegExp(escapeRegExp(findEsc), flags);

    let count = 0;
    docXml = docXml.replace(
      /(<w:t[^>]*>)([\s\S]*?)(<\/w:t>)/g,
      (match, open, content, close) => {
        const newContent = content.replace(findRe, () => {
          count++;
          return replaceEsc;
        });
        return `${open}${newContent}${close}`;
      },
    );

    zip.file('word/document.xml', docXml);
    const outputPath = path.resolve(args.output_path ?? args.path);
    await writeDocxZip(zip, outputPath);
    return {
      success: true,
      output: `Replaced ${count} occurrence(s) of "${args.find}" with "${args.replace}"`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ── 13. docx_insert_text ────────────────────────────────

export async function docxInsertText(args: {
  path: string;
  text: string;
  output_path?: string;
}): Promise<DocxToolResult> {
  try {
    const zip = await readDocxZip(args.path);
    let docXml = await getDocumentXml(zip);

    // Build new paragraphs
    const lines = args.text.split('\n');
    const newParagraphs = lines
      .map((line) => buildParagraph([buildRun(line)]))
      .join('');

    // Insert before closing </w:body>
    docXml = docXml.replace(
      /(<w:sectPr[\s\S]*?<\/w:sectPr>\s*<\/w:body>)/,
      `${newParagraphs}$1`,
    );

    zip.file('word/document.xml', docXml);
    const outputPath = path.resolve(args.output_path ?? args.path);
    await writeDocxZip(zip, outputPath);
    return {
      success: true,
      output: `Inserted ${lines.length} paragraph(s)`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ── 14. docx_merge_documents ────────────────────────────

export async function docxMergeDocuments(args: {
  input_paths: string[];
  output_path: string;
}): Promise<DocxToolResult> {
  try {
    if (args.input_paths.length === 0) {
      return { success: false, output: 'No input paths provided' };
    }

    // Use first document as base
    const baseZip = await readDocxZip(args.input_paths[0]);
    let baseDocXml = await getDocumentXml(baseZip);

    // Extract body content (excluding sectPr) from subsequent documents
    for (let i = 1; i < args.input_paths.length; i++) {
      const zip = await readDocxZip(args.input_paths[i]);
      const docXml = await getDocumentXml(zip);

      const bodyMatch = docXml.match(/<w:body>([\s\S]*)<\/w:body>/);
      if (!bodyMatch) continue;

      let bodyContent = bodyMatch[1];
      // Remove sectPr from extracted content
      bodyContent = bodyContent.replace(/<w:sectPr[\s\S]*?<\/w:sectPr>/g, '');

      // Add page break between documents
      const pageBreak = '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';

      // Insert before the sectPr of the base document
      baseDocXml = baseDocXml.replace(
        /(<w:sectPr)/,
        `${pageBreak}${bodyContent}$1`,
      );
    }

    baseZip.file('word/document.xml', baseDocXml);
    const outputPath = path.resolve(args.output_path);
    await writeDocxZip(baseZip, outputPath);
    return {
      success: true,
      output: `Merged ${args.input_paths.length} documents to ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ── 15. docx_set_char_format ────────────────────────────

export async function docxSetCharFormat(args: {
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
}): Promise<DocxToolResult> {
  try {
    const zip = await readDocxZip(args.path);
    let docXml = await getDocumentXml(zip);

    // Build the rPr to apply
    const rPrOpts: RunFormatOptions = {};
    if (args.bold != null) rPrOpts.bold = args.bold;
    if (args.italic != null) rPrOpts.italic = args.italic;
    if (args.underline != null) rPrOpts.underline = args.underline;
    if (args.font_size != null) rPrOpts.fontSizePt = args.font_size;
    if (args.text_color) rPrOpts.color = args.text_color;
    if (args.font_name) rPrOpts.fontName = args.font_name;

    const newRPr = buildRPr(rPrOpts);
    if (!newRPr) {
      return { success: false, output: 'No formatting options specified' };
    }

    // Get paragraphs from body
    const bodyMatch = docXml.match(/<w:body>([\s\S]*)<\/w:body>/);
    if (!bodyMatch) return { success: false, output: 'No body found' };

    // Find target paragraphs
    const paragraphs = [...docXml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)];
    let modified = 0;

    for (let i = 0; i < paragraphs.length; i++) {
      const pXml = paragraphs[i][0];
      if (pXml.includes('<w:sectPr')) continue;

      // Check if this paragraph should be targeted
      if (args.paragraph_index != null && i !== args.paragraph_index) continue;
      if (args.target_text) {
        const textContent = [...pXml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
          .map((m) => m[1])
          .join('');
        if (!textContent.includes(escapeXml(args.target_text))) continue;
      }

      // Replace rPr in all runs of this paragraph
      let newPXml = pXml.replace(
        /(<w:r\b[^>]*>)(<w:rPr>[\s\S]*?<\/w:rPr>)?/g,
        (match, rOpen) => `${rOpen}${newRPr}`,
      );

      docXml = docXml.replace(pXml, newPXml);
      modified++;
    }

    zip.file('word/document.xml', docXml);
    const outputPath = path.resolve(args.output_path ?? args.path);
    await writeDocxZip(zip, outputPath);
    return {
      success: true,
      output: `Applied character formatting to ${modified} paragraph(s)`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ── 16. docx_set_para_format ────────────────────────────

export async function docxSetParaFormat(args: {
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
}): Promise<DocxToolResult> {
  try {
    const zip = await readDocxZip(args.path);
    let docXml = await getDocumentXml(zip);

    // Build new pPr parts
    const pPrParts: string[] = [];
    if (args.alignment) {
      const alignMap: Record<string, string> = { LEFT: 'left', CENTER: 'center', RIGHT: 'right', JUSTIFY: 'both' };
      pPrParts.push(`<w:jc w:val="${alignMap[args.alignment] ?? 'left'}"/>`);
    }
    if (args.line_spacing != null) {
      const lineVal = Math.round(args.line_spacing * 240 / 100);
      pPrParts.push(`<w:spacing w:line="${lineVal}" w:lineRule="auto"/>`);
    }
    if (args.indent != null || args.margin_left != null || args.margin_right != null) {
      const attrs: string[] = [];
      if (args.margin_left != null) attrs.push(`w:left="${mmToTwips(args.margin_left)}"`);
      if (args.margin_right != null) attrs.push(`w:right="${mmToTwips(args.margin_right)}"`);
      if (args.indent != null) {
        if (args.indent >= 0) attrs.push(`w:firstLine="${mmToTwips(args.indent)}"`);
        else attrs.push(`w:hanging="${mmToTwips(Math.abs(args.indent))}"`);
      }
      pPrParts.push(`<w:ind ${attrs.join(' ')}/>`);
    }
    if (args.space_before != null || args.space_after != null) {
      const attrs: string[] = [];
      if (args.space_before != null) attrs.push(`w:before="${Math.round(args.space_before * 20)}"`);
      if (args.space_after != null) attrs.push(`w:after="${Math.round(args.space_after * 20)}"`);
      pPrParts.push(`<w:spacing ${attrs.join(' ')}/>`);
    }

    if (pPrParts.length === 0) {
      return { success: false, output: 'No formatting options specified' };
    }

    const newPPrContent = pPrParts.join('');
    const paragraphs = [...docXml.matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g)];
    let modified = 0;

    for (let i = 0; i < paragraphs.length; i++) {
      const pXml = paragraphs[i][0];
      if (pXml.includes('<w:sectPr')) continue;

      if (args.paragraph_index != null && i !== args.paragraph_index) continue;
      if (args.target_text) {
        const textContent = [...pXml.matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)]
          .map((m) => m[1])
          .join('');
        if (!textContent.includes(escapeXml(args.target_text))) continue;
      }

      let newPXml: string;
      if (/<w:pPr>/.test(pXml)) {
        // Append to existing pPr
        newPXml = pXml.replace(/<\/w:pPr>/, `${newPPrContent}</w:pPr>`);
      } else {
        // Insert new pPr after opening <w:p...>
        newPXml = pXml.replace(/(<w:p\b[^>]*>)/, `$1<w:pPr>${newPPrContent}</w:pPr>`);
      }

      docXml = docXml.replace(pXml, newPXml);
      modified++;
    }

    zip.file('word/document.xml', docXml);
    const outputPath = path.resolve(args.output_path ?? args.path);
    await writeDocxZip(zip, outputPath);
    return {
      success: true,
      output: `Applied paragraph formatting to ${modified} paragraph(s)`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ── 17. docx_set_page_layout ────────────────────────────

export async function docxSetPageLayout(args: {
  path: string;
  page_width?: number;
  page_height?: number;
  margin_top?: number;
  margin_bottom?: number;
  margin_left?: number;
  margin_right?: number;
  margin_header?: number;
  margin_footer?: number;
  output_path?: string;
}): Promise<DocxToolResult> {
  try {
    const zip = await readDocxZip(args.path);
    let docXml = await getDocumentXml(zip);

    // Replace pgSz
    if (args.page_width != null || args.page_height != null) {
      const w = args.page_width != null ? mmToTwips(args.page_width) : undefined;
      const h = args.page_height != null ? mmToTwips(args.page_height) : undefined;
      docXml = docXml.replace(
        /<w:pgSz\s+[^/]*\/>/g,
        (match) => {
          let result = match;
          if (w != null) result = result.replace(/w:w="[^"]*"/, `w:w="${w}"`);
          if (h != null) result = result.replace(/w:h="[^"]*"/, `w:h="${h}"`);
          return result;
        },
      );
    }

    // Replace pgMar
    if (args.margin_top != null || args.margin_bottom != null ||
        args.margin_left != null || args.margin_right != null ||
        args.margin_header != null || args.margin_footer != null) {
      docXml = docXml.replace(
        /<w:pgMar\s+[^/]*\/>/g,
        (match) => {
          let result = match;
          if (args.margin_top != null) result = result.replace(/w:top="[^"]*"/, `w:top="${mmToTwips(args.margin_top!)}"`);
          if (args.margin_bottom != null) result = result.replace(/w:bottom="[^"]*"/, `w:bottom="${mmToTwips(args.margin_bottom!)}"`);
          if (args.margin_left != null) result = result.replace(/w:left="[^"]*"/, `w:left="${mmToTwips(args.margin_left!)}"`);
          if (args.margin_right != null) result = result.replace(/w:right="[^"]*"/, `w:right="${mmToTwips(args.margin_right!)}"`);
          if (args.margin_header != null) result = result.replace(/w:header="[^"]*"/, `w:header="${mmToTwips(args.margin_header!)}"`);
          if (args.margin_footer != null) result = result.replace(/w:footer="[^"]*"/, `w:footer="${mmToTwips(args.margin_footer!)}"`);
          return result;
        },
      );
    }

    zip.file('word/document.xml', docXml);
    const outputPath = path.resolve(args.output_path ?? args.path);
    await writeDocxZip(zip, outputPath);
    return { success: true, output: `Page layout updated at ${outputPath}`, outputPath };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ── 18. docx_edit_table_cell ────────────────────────────

export async function docxEditTableCell(args: {
  path: string;
  table_index?: number;
  row: number;
  col: number;
  text?: string;
  background_color?: string;
  bold?: boolean;
  output_path?: string;
}): Promise<DocxToolResult> {
  try {
    const zip = await readDocxZip(args.path);
    let docXml = await getDocumentXml(zip);

    const tableIdx = args.table_index ?? 0;
    const tables = [...docXml.matchAll(/<w:tbl\b[\s\S]*?<\/w:tbl>/g)];
    if (tableIdx >= tables.length) {
      return { success: false, output: `Table index ${tableIdx} out of range (${tables.length} tables)` };
    }

    let tableXml = tables[tableIdx][0];
    const trs = [...tableXml.matchAll(/<w:tr\b[\s\S]*?<\/w:tr>/g)];
    if (args.row >= trs.length) {
      return { success: false, output: `Row ${args.row} out of range (${trs.length} rows)` };
    }

    let rowXml = trs[args.row][0];
    const tcs = [...rowXml.matchAll(/<w:tc\b[\s\S]*?<\/w:tc>/g)];
    if (args.col >= tcs.length) {
      return { success: false, output: `Col ${args.col} out of range (${tcs.length} cols)` };
    }

    let cellXml = tcs[args.col][0];

    // Replace text
    if (args.text != null) {
      const rPr = args.bold ? buildRPr({ bold: true }) : '';
      const newRun = buildRun(args.text, rPr);
      const newPara = buildParagraph([newRun]);
      // Replace all paragraphs in the cell
      cellXml = cellXml.replace(
        /(<w:tcPr>[\s\S]*?<\/w:tcPr>)[\s\S]*?(?=<\/w:tc>)/,
        `$1${newPara}`,
      );
    }

    // Background color
    if (args.background_color) {
      const shdXml = `<w:shd w:val="clear" w:color="auto" w:fill="${args.background_color.replace(/^#/, '')}"/>`;
      if (/<w:tcPr>/.test(cellXml)) {
        cellXml = cellXml.replace(/<\/w:tcPr>/, `${shdXml}</w:tcPr>`);
      } else {
        cellXml = cellXml.replace(/<w:tc\b[^>]*>/, `$&<w:tcPr>${shdXml}</w:tcPr>`);
      }
    }

    rowXml = rowXml.replace(tcs[args.col][0], cellXml);
    tableXml = tableXml.replace(trs[args.row][0], rowXml);
    docXml = docXml.replace(tables[tableIdx][0], tableXml);

    zip.file('word/document.xml', docXml);
    const outputPath = path.resolve(args.output_path ?? args.path);
    await writeDocxZip(zip, outputPath);
    return {
      success: true,
      output: `Cell [${args.row},${args.col}] updated`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ── 19. docx_insert_image ───────────────────────────────

export async function docxInsertImage(args: {
  path: string;
  image_path: string;
  width_mm?: number;
  height_mm?: number;
  output_path?: string;
}): Promise<DocxToolResult> {
  try {
    const zip = await readDocxZip(args.path);
    let docXml = await getDocumentXml(zip);

    // Read image file
    const imgPath = path.resolve(args.image_path);
    const imgData = await fs.promises.readFile(imgPath);
    const ext = path.extname(imgPath).toLowerCase().replace('.', '');
    const fileName = `image_${Date.now()}.${ext}`;

    // Add image to media folder
    zip.file(`word/media/${fileName}`, imgData);

    // Add relationship
    let relsXml = '';
    const relsFile = zip.file('word/_rels/document.xml.rels');
    if (relsFile) {
      relsXml = await relsFile.async('string');
    }

    // Find next rId
    const rIdMatches = [...relsXml.matchAll(/Id="rId(\d+)"/g)];
    let maxId = 0;
    for (const m of rIdMatches) {
      const id = Number(m[1]);
      if (id > maxId) maxId = id;
    }
    const rId = `rId${maxId + 1}`;

    // Add relationship
    relsXml = relsXml.replace(
      '</Relationships>',
      `<Relationship Id="${rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${fileName}"/>\n</Relationships>`,
    );
    zip.file('word/_rels/document.xml.rels', relsXml);

    // Build image paragraph
    const widthEmu = mmToEmu(args.width_mm ?? DOCX_DEFAULTS.image.widthMm);
    const heightEmu = mmToEmu(args.height_mm ?? DOCX_DEFAULTS.image.heightMm);
    const imgXml = buildInlineImage(rId, widthEmu, heightEmu, fileName);
    const paraXml = buildParagraph([imgXml]);

    // Insert before sectPr
    docXml = docXml.replace(
      /(<w:sectPr)/,
      `${paraXml}$1`,
    );

    zip.file('word/document.xml', docXml);
    const outputPath = path.resolve(args.output_path ?? args.path);
    await writeDocxZip(zip, outputPath);
    return {
      success: true,
      output: `Image inserted from ${args.image_path}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ── 20. docx_set_header_footer ──────────────────────────

export async function docxSetHeaderFooter(args: {
  path: string;
  type: 'header' | 'footer';
  text: string;
  alignment?: string;
  output_path?: string;
}): Promise<DocxToolResult> {
  try {
    const zip = await readDocxZip(args.path);
    let docXml = await getDocumentXml(zip);

    const isHeader = args.type === 'header';
    const rootTag = isHeader ? 'w:hdr' : 'w:ftr';
    const styleId = isHeader ? 'Header' : 'Footer';
    const fileName = isHeader ? 'header1.xml' : 'footer1.xml';
    const refTag = isHeader ? 'w:headerReference' : 'w:footerReference';
    const relType = isHeader
      ? 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/header'
      : 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer';
    const contentType = isHeader
      ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml'
      : 'application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml';

    const alignMap: Record<string, string> = { LEFT: 'left', CENTER: 'center', RIGHT: 'right' };
    const alignment = alignMap[args.alignment ?? 'CENTER'] ?? 'center';

    const pPr = buildPPr({ styleId, alignment: alignment as any });
    const run = buildRun(args.text);
    const p = buildParagraph([run], pPr);

    const partXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<${rootTag} xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  ${p}
</${rootTag}>`;

    zip.file(`word/${fileName}`, partXml);

    // Ensure relationship exists
    let relsXml = '';
    const relsFile = zip.file('word/_rels/document.xml.rels');
    if (relsFile) relsXml = await relsFile.async('string');

    let rId: string;
    const existingRel = relsXml.match(new RegExp(`Id="(rId\\d+)"[^>]*Target="${fileName}"`));
    if (existingRel) {
      rId = existingRel[1];
    } else {
      const rIdMatches = [...relsXml.matchAll(/Id="rId(\d+)"/g)];
      let maxId = 0;
      for (const m of rIdMatches) { const id = Number(m[1]); if (id > maxId) maxId = id; }
      rId = `rId${maxId + 1}`;
      relsXml = relsXml.replace(
        '</Relationships>',
        `<Relationship Id="${rId}" Type="${relType}" Target="${fileName}"/>\n</Relationships>`,
      );
      zip.file('word/_rels/document.xml.rels', relsXml);
    }

    // Ensure reference in sectPr
    if (!docXml.includes(`<${refTag}`)) {
      docXml = docXml.replace(
        /<w:sectPr>/,
        `<w:sectPr><${refTag} w:type="default" r:id="${rId}"/>`,
      );
    }

    // Ensure Content_Types
    let ctXml = '';
    const ctFile = zip.file('[Content_Types].xml');
    if (ctFile) ctXml = await ctFile.async('string');
    if (!ctXml.includes(`/word/${fileName}`)) {
      ctXml = ctXml.replace(
        '</Types>',
        `<Override PartName="/word/${fileName}" ContentType="${contentType}"/>\n</Types>`,
      );
      zip.file('[Content_Types].xml', ctXml);
    }

    zip.file('word/document.xml', docXml);
    const outputPath = path.resolve(args.output_path ?? args.path);
    await writeDocxZip(zip, outputPath);
    return {
      success: true,
      output: `${args.type} set at ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ── 21. docx_insert_table ───────────────────────────────

export async function docxInsertTable(args: {
  path: string;
  rows: number;
  cols: number;
  headers?: string[];
  data?: string[][];
  output_path?: string;
}): Promise<DocxToolResult> {
  try {
    const zip = await readDocxZip(args.path);
    let docXml = await getDocumentXml(zip);

    const allRows: string[][] = [];
    if (args.headers) allRows.push(args.headers);
    if (args.data) allRows.push(...args.data);

    // Fill remaining rows/cols with empty strings
    while (allRows.length < args.rows) {
      allRows.push(Array(args.cols).fill(''));
    }
    for (const row of allRows) {
      while (row.length < args.cols) row.push('');
    }

    const tableXml = buildTable({
      rows: allRows,
      headerRow: !!args.headers,
    });

    // Insert before sectPr
    docXml = docXml.replace(
      /(<w:sectPr)/,
      `${tableXml}$1`,
    );

    zip.file('word/document.xml', docXml);
    const outputPath = path.resolve(args.output_path ?? args.path);
    await writeDocxZip(zip, outputPath);
    return {
      success: true,
      output: `Table ${args.rows}x${args.cols} inserted`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ── 22. docx_accept_changes ─────────────────────────────

export async function docxAcceptChanges(args: {
  path: string;
  output_path?: string;
}): Promise<DocxToolResult> {
  try {
    const data = await fs.promises.readFile(path.resolve(args.path));
    const result = await acceptTrackedChanges(new Uint8Array(data));
    const outputPath = path.resolve(args.output_path ?? args.path);
    await fs.promises.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.promises.writeFile(outputPath, result);
    return {
      success: true,
      output: `Tracked changes accepted at ${outputPath}`,
      outputPath,
    };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ── 23. docx_validate ───────────────────────────────────

export async function docxValidate(args: {
  path: string;
}): Promise<DocxToolResult> {
  try {
    const data = await fs.promises.readFile(path.resolve(args.path));
    const result = await validateDocx(new Uint8Array(data));

    const lines: string[] = [];
    lines.push(`Valid: ${result.valid}`);
    if (result.errors.length > 0) {
      lines.push(`Errors (${result.errors.length}):`);
      for (const e of result.errors) lines.push(`  - ${e}`);
    }
    if (result.warnings.length > 0) {
      lines.push(`Warnings (${result.warnings.length}):`);
      for (const w of result.warnings) lines.push(`  - ${w}`);
    }
    if (result.errors.length === 0 && result.warnings.length === 0) {
      lines.push('No issues found.');
    }

    return { success: true, output: lines.join('\n') };
  } catch (e: any) {
    return { success: false, output: `Error: ${e.message}` };
  }
}

// ── Helpers ─────────────────────────────────────────────

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractTaskContext(taskDir: string): {
  sessionId: string;
  taskType: string;
  taskId: string;
  workDir: string;
} {
  // taskDir pattern: {workDir}/{sessionId}/{taskType}/{taskId}
  const parts = taskDir.split(path.sep);
  const taskId = parts[parts.length - 1];
  const taskType = parts[parts.length - 2];
  const sessionId = parts[parts.length - 3];
  const workDir = parts.slice(0, parts.length - 3).join(path.sep);
  return { sessionId, taskType, taskId, workDir };
}
