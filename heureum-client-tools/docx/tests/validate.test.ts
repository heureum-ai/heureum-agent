import { describe, it, expect } from 'vitest';
import JSZip from 'jszip';
import { validateDocx, type DocxValidationResult } from '../src/validate.js';
import { createDocx } from '../src/writer.js';
import {
  buildContentTypes,
  ROOT_RELS,
  buildDocumentRels,
  SETTINGS_XML,
  buildFontTable,
  buildCoreXml,
  APP_XML,
} from '../src/template.js';
import { buildStylesXml } from '../src/styles.js';
import { buildNumberingXml } from '../src/numbering.js';

// ── Helpers ──────────────────────────────────────────────

const MINIMAL_DOCUMENT_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
            mc:Ignorable="w14"
            xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
  <w:body>
    <w:p><w:r><w:t>Hello</w:t></w:r></w:p>
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1134" w:bottom="850" w:left="850" w:right="850" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;

/** Build a minimal valid DOCX ZIP as Uint8Array */
async function buildValidDocx(): Promise<Uint8Array> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', buildContentTypes());
  zip.file('_rels/.rels', ROOT_RELS);
  zip.file('word/document.xml', MINIMAL_DOCUMENT_XML);
  zip.file('word/styles.xml', buildStylesXml());
  zip.file('word/settings.xml', SETTINGS_XML);
  zip.file('word/numbering.xml', buildNumberingXml());
  zip.file('word/fontTable.xml', buildFontTable());
  zip.file('word/_rels/document.xml.rels', buildDocumentRels());
  zip.file('docProps/core.xml', buildCoreXml());
  zip.file('docProps/app.xml', APP_XML);
  return zip.generateAsync({ type: 'uint8array' });
}

// ── Tests ────────────────────────────────────────────────

describe('validateDocx', () => {
  it('should validate a correct DOCX as valid', async () => {
    const data = await buildValidDocx();
    const result = await validateDocx(data);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should validate a DOCX created by createDocx as valid', async () => {
    const buffer = await createDocx('# Hello\n\nWorld');
    const result = await validateDocx(buffer);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('should report error for missing required files', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', buildContentTypes());
    zip.file('_rels/.rels', ROOT_RELS);
    zip.file('word/document.xml', MINIMAL_DOCUMENT_XML);
    // Missing: styles.xml, settings.xml, numbering.xml, fontTable.xml, document.xml.rels, core.xml
    const data = await zip.generateAsync({ type: 'uint8array' });

    const result = await validateDocx(data);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('word/styles.xml'))).toBe(true);
    expect(result.errors.some((e) => e.includes('word/settings.xml'))).toBe(true);
    expect(result.errors.some((e) => e.includes('word/numbering.xml'))).toBe(true);
    expect(result.errors.some((e) => e.includes('word/fontTable.xml'))).toBe(true);
    expect(result.errors.some((e) => e.includes('word/_rels/document.xml.rels'))).toBe(true);
    expect(result.errors.some((e) => e.includes('docProps/core.xml'))).toBe(true);
  });

  it('should report error for Content-Types referencing missing file', async () => {
    const zip = new JSZip();
    // Content-Types with override for a file that doesn't exist
    const ctXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/ghost.xml" ContentType="application/xml"/>
</Types>`;
    zip.file('[Content_Types].xml', ctXml);
    zip.file('_rels/.rels', ROOT_RELS);
    zip.file('word/document.xml', MINIMAL_DOCUMENT_XML);
    zip.file('word/styles.xml', buildStylesXml());
    zip.file('word/settings.xml', SETTINGS_XML);
    zip.file('word/numbering.xml', buildNumberingXml());
    zip.file('word/fontTable.xml', buildFontTable());
    zip.file('word/_rels/document.xml.rels', buildDocumentRels());
    zip.file('docProps/core.xml', buildCoreXml());
    zip.file('docProps/app.xml', APP_XML);
    const data = await zip.generateAsync({ type: 'uint8array' });

    const result = await validateDocx(data);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('word/ghost.xml'))).toBe(true);
  });

  it('should report error for root rels referencing missing target', async () => {
    const zip = new JSZip();
    const badRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId99" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/missing.xml"/>
</Relationships>`;
    zip.file('[Content_Types].xml', buildContentTypes());
    zip.file('_rels/.rels', badRels);
    zip.file('word/document.xml', MINIMAL_DOCUMENT_XML);
    zip.file('word/styles.xml', buildStylesXml());
    zip.file('word/settings.xml', SETTINGS_XML);
    zip.file('word/numbering.xml', buildNumberingXml());
    zip.file('word/fontTable.xml', buildFontTable());
    zip.file('word/_rels/document.xml.rels', buildDocumentRels());
    zip.file('docProps/core.xml', buildCoreXml());
    zip.file('docProps/app.xml', APP_XML);
    const data = await zip.generateAsync({ type: 'uint8array' });

    const result = await validateDocx(data);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('word/missing.xml'))).toBe(true);
  });

  it('should report error for malformed XML', async () => {
    const zip = new JSZip();
    zip.file('[Content_Types].xml', buildContentTypes());
    zip.file('_rels/.rels', ROOT_RELS);
    // Malformed XML — unclosed tag
    zip.file('word/document.xml', '<w:document><w:body><unclosed>');
    zip.file('word/styles.xml', buildStylesXml());
    zip.file('word/settings.xml', SETTINGS_XML);
    zip.file('word/numbering.xml', buildNumberingXml());
    zip.file('word/fontTable.xml', buildFontTable());
    zip.file('word/_rels/document.xml.rels', buildDocumentRels());
    zip.file('docProps/core.xml', buildCoreXml());
    zip.file('docProps/app.xml', APP_XML);
    const data = await zip.generateAsync({ type: 'uint8array' });

    const result = await validateDocx(data);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('word/document.xml'))).toBe(true);
  });

  it('should report error for missing <w:body> or <w:sectPr>', async () => {
    const noBodyXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
</w:document>`;
    const zip = new JSZip();
    zip.file('[Content_Types].xml', buildContentTypes());
    zip.file('_rels/.rels', ROOT_RELS);
    zip.file('word/document.xml', noBodyXml);
    zip.file('word/styles.xml', buildStylesXml());
    zip.file('word/settings.xml', SETTINGS_XML);
    zip.file('word/numbering.xml', buildNumberingXml());
    zip.file('word/fontTable.xml', buildFontTable());
    zip.file('word/_rels/document.xml.rels', buildDocumentRels());
    zip.file('docProps/core.xml', buildCoreXml());
    zip.file('docProps/app.xml', APP_XML);
    const data = await zip.generateAsync({ type: 'uint8array' });

    const result = await validateDocx(data);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('<w:body>'))).toBe(true);
    expect(result.errors.some((e) => e.includes('<w:sectPr>'))).toBe(true);
  });

  it('should report error for missing namespace declarations', async () => {
    const noNsXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>Hello</w:t></w:r></w:p>
    <w:sectPr/>
  </w:body>
</w:document>`;
    const zip = new JSZip();
    zip.file('[Content_Types].xml', buildContentTypes());
    zip.file('_rels/.rels', ROOT_RELS);
    zip.file('word/document.xml', noNsXml);
    zip.file('word/styles.xml', buildStylesXml());
    zip.file('word/settings.xml', SETTINGS_XML);
    zip.file('word/numbering.xml', buildNumberingXml());
    zip.file('word/fontTable.xml', buildFontTable());
    zip.file('word/_rels/document.xml.rels', buildDocumentRels());
    zip.file('docProps/core.xml', buildCoreXml());
    zip.file('docProps/app.xml', APP_XML);
    const data = await zip.generateAsync({ type: 'uint8array' });

    const result = await validateDocx(data);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('xmlns:r'))).toBe(true);
  });

  it('should warn for r:embed referencing unknown rId', async () => {
    const docWithBadEmbed = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p><w:r><w:drawing><a:blipFill xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:blip r:embed="rId999"/></a:blipFill></w:drawing></w:r></w:p>
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1134" w:bottom="850" w:left="850" w:right="850" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;
    const zip = new JSZip();
    zip.file('[Content_Types].xml', buildContentTypes());
    zip.file('_rels/.rels', ROOT_RELS);
    zip.file('word/document.xml', docWithBadEmbed);
    zip.file('word/styles.xml', buildStylesXml());
    zip.file('word/settings.xml', SETTINGS_XML);
    zip.file('word/numbering.xml', buildNumberingXml());
    zip.file('word/fontTable.xml', buildFontTable());
    zip.file('word/_rels/document.xml.rels', buildDocumentRels());
    zip.file('docProps/core.xml', buildCoreXml());
    zip.file('docProps/app.xml', APP_XML);
    const data = await zip.generateAsync({ type: 'uint8array' });

    const result = await validateDocx(data);
    // This is a warning, not an error — document is still structurally valid
    expect(result.warnings.some((w) => w.includes('rId999'))).toBe(true);
  });

  it('should report error for invalid ZIP data', async () => {
    const result = await validateDocx(new Uint8Array([0, 1, 2, 3]));
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Invalid ZIP archive');
  });

  it('should report error for document rels referencing missing target', async () => {
    const badDocRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>
  <Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/>
  <Relationship Id="rId5" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/ghost.png"/>
</Relationships>`;
    const zip = new JSZip();
    zip.file('[Content_Types].xml', buildContentTypes());
    zip.file('_rels/.rels', ROOT_RELS);
    zip.file('word/document.xml', MINIMAL_DOCUMENT_XML);
    zip.file('word/styles.xml', buildStylesXml());
    zip.file('word/settings.xml', SETTINGS_XML);
    zip.file('word/numbering.xml', buildNumberingXml());
    zip.file('word/fontTable.xml', buildFontTable());
    zip.file('word/_rels/document.xml.rels', badDocRels);
    zip.file('docProps/core.xml', buildCoreXml());
    zip.file('docProps/app.xml', APP_XML);
    const data = await zip.generateAsync({ type: 'uint8array' });

    const result = await validateDocx(data);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes('media/ghost.png'))).toBe(true);
  });

  it('should warn for mc:Ignorable with undeclared prefix', async () => {
    const docWithBadMc = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
            xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"
            mc:Ignorable="w14 w15">
  <w:body>
    <w:p><w:r><w:t>Hello</w:t></w:r></w:p>
    <w:sectPr>
      <w:pgSz w:w="11906" w:h="16838"/>
      <w:pgMar w:top="1134" w:bottom="850" w:left="850" w:right="850" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`;
    const zip = new JSZip();
    zip.file('[Content_Types].xml', buildContentTypes());
    zip.file('_rels/.rels', ROOT_RELS);
    zip.file('word/document.xml', docWithBadMc);
    zip.file('word/styles.xml', buildStylesXml());
    zip.file('word/settings.xml', SETTINGS_XML);
    zip.file('word/numbering.xml', buildNumberingXml());
    zip.file('word/fontTable.xml', buildFontTable());
    zip.file('word/_rels/document.xml.rels', buildDocumentRels());
    zip.file('docProps/core.xml', buildCoreXml());
    zip.file('docProps/app.xml', APP_XML);
    const data = await zip.generateAsync({ type: 'uint8array' });

    const result = await validateDocx(data);
    // w14 and w15 are not declared as xmlns:w14 / xmlns:w15
    expect(result.warnings.some((w) => w.includes('w14'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('w15'))).toBe(true);
  });
});
