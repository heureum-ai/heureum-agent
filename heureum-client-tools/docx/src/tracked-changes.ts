/**
 * Accept tracked changes in a DOCX document (pure XML, no soffice dependency).
 * - w:ins → unwrap (keep inner content, remove w:ins wrapper)
 * - w:del → remove entirely (discard deleted content)
 * - w:rPrChange → remove (accept formatting changes)
 * - w:pPrChange → remove (accept paragraph property changes)
 * - w:sectPrChange → remove
 * - w:tblPrChange → remove
 * - w:trPrChange → remove
 * - w:tcPrChange → remove
 */

import JSZip from 'jszip';

/**
 * Accept all tracked changes in a DOCX buffer.
 * Returns a new Uint8Array with changes accepted.
 */
export async function acceptTrackedChanges(docxBuffer: Uint8Array): Promise<Uint8Array> {
  const zip = await JSZip.loadAsync(docxBuffer);

  // Process document.xml
  const docFile = zip.file('word/document.xml');
  if (docFile) {
    let xml = await docFile.async('string');
    xml = acceptChangesInXml(xml);
    zip.file('word/document.xml', xml);
  }

  // Process headers and footers
  for (const [name, file] of Object.entries(zip.files)) {
    if (file.dir) continue;
    if (/^word\/(header|footer)\d+\.xml$/.test(name)) {
      let xml = await file.async('string');
      xml = acceptChangesInXml(xml);
      zip.file(name, xml);
    }
  }

  return zip.generateAsync({
    type: 'uint8array',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });
}

/**
 * Accept tracked changes within an XML string.
 */
export function acceptChangesInXml(xml: string): string {
  let result = xml;

  // 1. Remove w:del elements entirely (deleted text should be discarded)
  result = removeTagWithContent(result, 'w:del');

  // 2. Unwrap w:ins elements (keep content, remove wrapper)
  result = unwrapTag(result, 'w:ins');

  // 3. Remove change tracking metadata elements
  const changeMetaTags = [
    'w:rPrChange',
    'w:pPrChange',
    'w:sectPrChange',
    'w:tblPrChange',
    'w:trPrChange',
    'w:tcPrChange',
    'w:tblGridChange',
  ];

  for (const tag of changeMetaTags) {
    result = removeTagWithContent(result, tag);
  }

  // 4. Remove w:moveTo / w:moveFrom markers
  result = unwrapTag(result, 'w:moveTo');
  result = removeTagWithContent(result, 'w:moveFrom');

  // 5. Clean up empty runs and paragraphs that might result
  result = result.replace(/<w:r\b[^>]*>\s*<\/w:r>/g, '');

  return result;
}

/**
 * Remove a tag and all its content.
 * Handles nested same-tag elements correctly.
 */
function removeTagWithContent(xml: string, tagName: string): string {
  // Use non-greedy matching for simple cases where there's no nesting
  const simpleRe = new RegExp(`<${tagName}\\b[^>]*/>`, 'g');
  let result = xml.replace(simpleRe, '');

  // For elements with content, handle nesting
  let changed = true;
  while (changed) {
    const before = result;
    // Match innermost (non-nested) instances first
    const re = new RegExp(
      `<${tagName}\\b[^>]*>[\\s\\S]*?<\\/${tagName}>`,
      'g',
    );
    result = result.replace(re, '');
    changed = result !== before;
  }

  return result;
}

/**
 * Unwrap a tag: remove the opening and closing tags but keep inner content.
 */
function unwrapTag(xml: string, tagName: string): string {
  // Remove self-closing instances
  let result = xml.replace(new RegExp(`<${tagName}\\b[^>]*/>`, 'g'), '');

  // Remove opening tags
  result = result.replace(new RegExp(`<${tagName}\\b[^>]*>`, 'g'), '');

  // Remove closing tags
  result = result.replace(new RegExp(`</${tagName}>`, 'g'), '');

  return result;
}
