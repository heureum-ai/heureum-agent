/**
 * ZIP packaging for DOCX documents.
 * Parses markdown → remark AST → OOXML → ZIP archive.
 */

import JSZip from 'jszip';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { buildDocumentXml } from './document.js';
import { buildStylesXml } from './styles.js';
import { buildNumberingXml } from './numbering.js';
import {
  buildContentTypes,
  ROOT_RELS,
  buildDocumentRels,
  SETTINGS_XML,
  buildFontTable,
  buildCoreXml,
  APP_XML,
} from './template.js';
import type { DocxDocumentOptions } from './types.js';

/**
 * Create a DOCX document from markdown content.
 *
 * @param markdown - Markdown string to convert
 * @param options  - Page layout options
 * @returns Uint8Array containing the .docx ZIP archive
 */
export async function createDocx(
  markdown: string,
  options?: DocxDocumentOptions,
): Promise<Uint8Array> {
  // 1. Parse markdown → AST
  const processor = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkFrontmatter, ['yaml']);

  const tree = processor.parse(markdown);

  // Extract title from first heading if present
  let title: string | undefined;
  for (const node of (tree.children as any[])) {
    if (node.type === 'heading' && node.depth === 1) {
      title = node.children?.map((c: any) => c.value || '').join('') || undefined;
      break;
    }
  }

  // 2. Generate XML files
  const documentXml = buildDocumentXml(tree.children as any[], options);
  const stylesXml = buildStylesXml({
    defaultFont: options?.fontName,
    defaultFontSizePt: options?.fontSizePt,
  });
  const numberingXml = buildNumberingXml();
  const contentTypes = buildContentTypes();
  const documentRels = buildDocumentRels();
  const fontTable = buildFontTable();
  const coreXml = buildCoreXml({ title: options?.title ?? title });

  // 3. Package into ZIP
  const zip = new JSZip();

  zip.file('[Content_Types].xml', contentTypes);
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/document.xml', documentXml);
  zip.file('word/styles.xml', stylesXml);
  zip.file('word/settings.xml', SETTINGS_XML);
  zip.file('word/numbering.xml', numberingXml);
  zip.file('word/fontTable.xml', fontTable);
  zip.file('word/_rels/document.xml.rels', documentRels);
  zip.file('docProps/core.xml', coreXml);
  zip.file('docProps/app.xml', APP_XML);

  // 4. Generate ZIP binary
  const buffer = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  return buffer;
}
