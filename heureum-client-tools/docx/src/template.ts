/**
 * Fixed XML templates for OOXML DOCX structure.
 * Dynamic builders for [Content_Types].xml, .rels, document.xml.rels, core.xml, app.xml.
 */

import { DOCX_DEFAULTS } from './configs.js';

// ── XML escape ──────────────────────────────────────────

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// ── [Content_Types].xml ─────────────────────────────────

export interface ContentTypesOverride {
  partName: string;
  contentType: string;
}

export function buildContentTypes(overrides?: ContentTypesOverride[]): string {
  const defaultTypes = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    '<Default Extension="png" ContentType="image/png"/>',
    '<Default Extension="jpeg" ContentType="image/jpeg"/>',
    '<Default Extension="jpg" ContentType="image/jpeg"/>',
    '<Default Extension="gif" ContentType="image/gif"/>',
  ];

  const overrideParts = [
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>',
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>',
    '<Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>',
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>',
    '<Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
  ];

  if (overrides) {
    for (const o of overrides) {
      overrideParts.push(
        `<Override PartName="${escapeXml(o.partName)}" ContentType="${escapeXml(o.contentType)}"/>`,
      );
    }
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  ${defaultTypes.join('\n  ')}
  ${overrideParts.join('\n  ')}
</Types>`;
}

// ── _rels/.rels ─────────────────────────────────────────

export const ROOT_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

// ── word/_rels/document.xml.rels ────────────────────────

export interface DocRelItem {
  id: string;
  type: string;
  target: string;
}

export function buildDocumentRels(extraRels?: DocRelItem[]): string {
  const rels = [
    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>',
    '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>',
    '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/>',
    '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/>',
  ];

  if (extraRels) {
    for (const r of extraRels) {
      rels.push(
        `<Relationship Id="${escapeXml(r.id)}" Type="${escapeXml(r.type)}" Target="${escapeXml(r.target)}"/>`,
      );
    }
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  ${rels.join('\n  ')}
</Relationships>`;
}

// ── word/settings.xml ───────────────────────────────────

export const SETTINGS_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:zoom w:percent="100"/>
  <w:defaultTabStop w:val="720"/>
  <w:characterSpacingControl w:val="doNotCompress"/>
  <w:compat>
    <w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>
    <w:compatSetting w:name="overrideTableStyleFontSizeAndJustification" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/>
    <w:compatSetting w:name="enableOpenTypeFeatures" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/>
    <w:compatSetting w:name="doNotFlipMirrorIndents" w:uri="http://schemas.microsoft.com/office/word" w:val="1"/>
  </w:compat>
</w:settings>`;

// ── word/fontTable.xml ──────────────────────────────────

export function buildFontTable(extraFonts?: string[]): string {
  const fonts = [
    `<w:font w:name="Malgun Gothic">
    <w:panose1 w:val="020B0503020000020004"/>
    <w:charset w:val="81"/>
    <w:family w:val="swiss"/>
    <w:pitch w:val="variable"/>
  </w:font>`,
    `<w:font w:name="Times New Roman">
    <w:panose1 w:val="02020603050405020304"/>
    <w:charset w:val="00"/>
    <w:family w:val="roman"/>
    <w:pitch w:val="variable"/>
  </w:font>`,
    `<w:font w:name="Courier New">
    <w:panose1 w:val="02070309020205020404"/>
    <w:charset w:val="00"/>
    <w:family w:val="modern"/>
    <w:pitch w:val="fixed"/>
  </w:font>`,
  ];

  if (extraFonts) {
    for (const name of extraFonts) {
      fonts.push(
        `<w:font w:name="${escapeXml(name)}">
    <w:charset w:val="00"/>
    <w:family w:val="auto"/>
    <w:pitch w:val="variable"/>
  </w:font>`,
      );
    }
  }

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
         xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  ${fonts.join('\n  ')}
</w:fonts>`;
}

// ── docProps/core.xml ───────────────────────────────────

export function buildCoreXml(opts?: {
  title?: string;
  creator?: string;
  lastModifiedBy?: string;
  description?: string;
  subject?: string;
  keywords?: string;
}): string {
  const now = new Date().toISOString();
  const title = opts?.title ?? DOCX_DEFAULTS.metadata.title;
  const creator = opts?.creator ?? DOCX_DEFAULTS.metadata.creator;
  const lastModifiedBy = opts?.lastModifiedBy ?? DOCX_DEFAULTS.metadata.lastModifiedBy;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
                   xmlns:dc="http://purl.org/dc/elements/1.1/"
                   xmlns:dcterms="http://purl.org/dc/terms/"
                   xmlns:dcmitype="http://purl.org/dc/dcmitype/"
                   xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${escapeXml(title)}</dc:title>
  <dc:creator>${escapeXml(creator)}</dc:creator>
  <cp:lastModifiedBy>${escapeXml(lastModifiedBy)}</cp:lastModifiedBy>${opts?.description ? `\n  <dc:description>${escapeXml(opts.description)}</dc:description>` : ''}${opts?.subject ? `\n  <dc:subject>${escapeXml(opts.subject)}</dc:subject>` : ''}${opts?.keywords ? `\n  <cp:keywords>${escapeXml(opts.keywords)}</cp:keywords>` : ''}
  <dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;
}

// ── docProps/app.xml ────────────────────────────────────

export const APP_XML = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
            xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>heureum</Application>
  <AppVersion>1.0</AppVersion>
</Properties>`;

// ── OOXML namespace constants ───────────────────────────

export const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
  mc: 'http://schemas.openxmlformats.org/markup-compatibility/2006',
  wps: 'http://schemas.microsoft.com/office/word/2010/wordprocessingShape',
  w14: 'http://schemas.microsoft.com/office/word/2010/wordml',
} as const;
