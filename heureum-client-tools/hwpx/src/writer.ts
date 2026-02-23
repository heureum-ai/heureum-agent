/**
 * ZIP packaging for HWPX documents.
 * Parses markdown → remark AST → HWPX XML → ZIP archive.
 */

import JSZip from 'jszip';
import remarkFrontmatter from 'remark-frontmatter';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

import { buildHeaderXml } from './header.js';
import { buildSectionXml } from './section.js';
import {
    CONTAINER_XML,
    MANIFEST_XML,
    MIMETYPE,
    SETTINGS_XML,
    VERSION_XML,
    buildContainerRdf,
    buildContentHpf,
} from './template.js';
import type { HwpxDocumentOptions } from './types.js';

/**
 * Create an HWPX document from markdown content.
 *
 * @param markdown - Markdown string to convert
 * @param options  - Page layout options
 * @returns Uint8Array containing the .hwpx ZIP archive
 */
export async function createHwpx(
  markdown: string,
  options?: HwpxDocumentOptions,
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
  const sectionCount = 1;
  const headerXml = buildHeaderXml(sectionCount);
  const sectionXml = buildSectionXml(tree.children as any[], options);
  const containerRdf = buildContainerRdf(sectionCount);
  const contentHpf = buildContentHpf(sectionCount, title);

  // 3. Package into ZIP
  const zip = new JSZip();

  // mimetype MUST be first entry, stored without compression
  zip.file('mimetype', MIMETYPE, { compression: 'STORE' });

  // Fixed structure files
  zip.file('version.xml', VERSION_XML);
  zip.file('META-INF/container.xml', CONTAINER_XML);
  zip.file('META-INF/manifest.xml', MANIFEST_XML);
  zip.file('META-INF/container.rdf', containerRdf);
  zip.file('settings.xml', SETTINGS_XML);

  // Content files
  zip.file('Contents/content.hpf', contentHpf);
  zip.file('Contents/header.xml', headerXml);
  zip.file('Contents/section0.xml', sectionXml);

  // Preview (empty but present)
  zip.file('Preview/PrvText.txt', title || '');

  // 4. Generate ZIP binary
  const buffer = await zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
    // JSZip will respect per-file compression options (STORE for mimetype)
  });

  return buffer;
}
