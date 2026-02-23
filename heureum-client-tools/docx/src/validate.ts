/**
 * DOCX validation — checks OOXML spec compliance.
 * Pure function: takes Uint8Array, returns validation result.
 */

import JSZip from 'jszip';
import { XMLParser, XMLValidator } from 'fast-xml-parser';

// ── Public types ─────────────────────────────────────────

export interface DocxValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

// ── Required files ───────────────────────────────────────

const REQUIRED_FILES = [
  '[Content_Types].xml',
  '_rels/.rels',
  'word/document.xml',
  'word/styles.xml',
  'word/settings.xml',
  'word/numbering.xml',
  'word/fontTable.xml',
  'word/_rels/document.xml.rels',
  'docProps/core.xml',
] as const;

// ── Required namespaces on <w:document> ──────────────────

const REQUIRED_NS_PREFIXES = ['w', 'r'] as const;

// ── Main ─────────────────────────────────────────────────

export async function validateDocx(data: Uint8Array): Promise<DocxValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Load ZIP
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(data);
  } catch {
    return { valid: false, errors: ['Invalid ZIP archive'], warnings };
  }

  const zipFiles = Object.keys(zip.files).filter((f) => !zip.files[f].dir);

  // ── 1. Required files ─────────────────────────────────
  for (const required of REQUIRED_FILES) {
    if (!zip.file(required)) {
      errors.push(`Missing required file: ${required}`);
    }
  }

  // ── 2. Content-Types overrides vs actual ZIP files ────
  const ctFile = zip.file('[Content_Types].xml');
  if (ctFile) {
    const ctXml = await ctFile.async('string');
    const overrideRe = /PartName="\/([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = overrideRe.exec(ctXml)) !== null) {
      const partName = m[1];
      if (!zip.file(partName)) {
        errors.push(`[Content_Types].xml references missing file: ${partName}`);
      }
    }
  }

  // ── 3. Root rels targets ──────────────────────────────
  const rootRelsFile = zip.file('_rels/.rels');
  if (rootRelsFile) {
    const relsXml = await rootRelsFile.async('string');
    const targetRe = /Target="([^"]+)"/g;
    let m: RegExpExecArray | null;
    while ((m = targetRe.exec(relsXml)) !== null) {
      const target = m[1];
      if (!zip.file(target)) {
        errors.push(`_rels/.rels target not found in ZIP: ${target}`);
      }
    }
  }

  // ── 4. Document rels targets ──────────────────────────
  const docRelsFile = zip.file('word/_rels/document.xml.rels');
  let docRelsMap: Map<string, string> | undefined;
  if (docRelsFile) {
    const relsXml = await docRelsFile.async('string');
    docRelsMap = new Map();
    const relRe = /Id="([^"]+)"[^>]*Target="([^"]+)"[^>]*Type="([^"]+)"/g;
    // Also handle Target before Type
    const relRe2 = /Id="([^"]+)"[^>]*Type="([^"]+)"[^>]*Target="([^"]+)"/g;

    const parseRels = (xml: string) => {
      const map = new Map<string, string>();
      const tagRe = /<Relationship\s+([^>]+)\/>/g;
      let tag: RegExpExecArray | null;
      while ((tag = tagRe.exec(xml)) !== null) {
        const attrs = tag[1];
        const idMatch = attrs.match(/Id="([^"]+)"/);
        const targetMatch = attrs.match(/Target="([^"]+)"/);
        const typeMatch = attrs.match(/Type="([^"]+)"/);
        if (idMatch && targetMatch) {
          map.set(idMatch[1], targetMatch[1]);
          // Validate target exists for internal relationships (not external)
          const target = targetMatch[1];
          const type = typeMatch?.[1] ?? '';
          const isExternal = /TargetMode="External"/.test(attrs);
          if (!isExternal) {
            // Resolve relative to word/
            const resolvedTarget = target.startsWith('/') ? target.slice(1) : `word/${target}`;
            if (!zip.file(resolvedTarget)) {
              errors.push(`word/_rels/document.xml.rels target not found: ${target} (resolved: ${resolvedTarget})`);
            }
          }
        }
      }
      return map;
    };

    docRelsMap = parseRels(relsXml);
  }

  // ── 5. XML well-formedness ────────────────────────────
  const xmlFiles = [
    '[Content_Types].xml',
    '_rels/.rels',
    'word/document.xml',
    'word/styles.xml',
    'word/settings.xml',
    'word/numbering.xml',
    'word/fontTable.xml',
    'word/_rels/document.xml.rels',
    'docProps/core.xml',
  ];
  const parser = new XMLParser({
    ignoreAttributes: false,
  });
  const validator = XMLValidator;
  for (const xmlPath of xmlFiles) {
    const file = zip.file(xmlPath);
    if (!file) continue;
    try {
      const content = await file.async('string');
      const validationResult = validator.validate(content);
      if (validationResult !== true) {
        const err = validationResult.err;
        errors.push(`XML parse error in ${xmlPath}: ${err.msg} (line ${err.line})`);
      }
    } catch (e: any) {
      errors.push(`XML parse error in ${xmlPath}: ${e.message}`);
    }
  }

  // ── 6. Namespace check on document.xml ────────────────
  const docFile = zip.file('word/document.xml');
  if (docFile) {
    const docXml = await docFile.async('string');
    const rootMatch = docXml.match(/<w:document\b([^>]*)>/);
    if (rootMatch) {
      const rootAttrs = rootMatch[1];

      for (const prefix of REQUIRED_NS_PREFIXES) {
        const nsPattern = new RegExp(`xmlns:${prefix}=`);
        if (!nsPattern.test(rootAttrs)) {
          errors.push(`Missing required namespace declaration: xmlns:${prefix}`);
        }
      }

      // Check mc:Ignorable prefixes have matching xmlns declarations
      const mcIgnorable = rootAttrs.match(/mc:Ignorable="([^"]+)"/);
      if (mcIgnorable) {
        // mc namespace itself must be declared
        if (!/xmlns:mc=/.test(rootAttrs)) {
          errors.push('mc:Ignorable used but xmlns:mc not declared');
        }
        const prefixes = mcIgnorable[1].split(/\s+/);
        for (const prefix of prefixes) {
          const nsPattern = new RegExp(`xmlns:${prefix}=`);
          if (!nsPattern.test(rootAttrs)) {
            warnings.push(`mc:Ignorable references undeclared prefix: ${prefix}`);
          }
        }
      }
    } else {
      errors.push('document.xml missing <w:document> root element');
    }

    // ── 7. Body structure ─────────────────────────────
    if (!/<w:body\b/.test(docXml)) {
      errors.push('document.xml missing <w:body>');
    }
    if (!/<w:sectPr\b/.test(docXml)) {
      errors.push('document.xml missing <w:sectPr>');
    }

    // ── 8. Media references (r:embed rIds) ────────────
    if (docRelsMap) {
      const embedRe = /r:embed="([^"]+)"/g;
      let m: RegExpExecArray | null;
      while ((m = embedRe.exec(docXml)) !== null) {
        const rId = m[1];
        if (!docRelsMap.has(rId)) {
          warnings.push(`r:embed references unknown rId: ${rId}`);
        }
      }
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
  };
}
