/**
 * JSON Envelope -> HWPX (no step folders)
 *
 * Storage policy:
 * - No steps/01..04 folders.
 * - By default, only one file is stored under run directory:
 *   - result.hwpx
 * - Optional artifacts (saved only with --keep-artifacts):
 *   - document_envelope.json
 *   - run_report.json
 *
 * Usage:
 *   node scripts/json-envelope-pipeline.mjs <envelope_json_path> [runs_root] [--keep-artifacts]
 */

import fs from 'node:fs';
import path from 'node:path';
import JSZip from 'jszip';
import {
  createDocument,
  parseTemplateStyle,
  handleHwpxTool,
} from '../dist/index.js';

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function huToMm(value) {
  return Number((Number(value || 0) / 283.464566929).toFixed(2));
}

function pickStyleValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

async function callTool(toolName, args) {
  const res = await handleHwpxTool(toolName, args);
  if (!res?.success) {
    throw new Error(`${toolName} failed: ${res?.output || 'unknown error'}`);
  }
  return res;
}

function normalizeEnvelope(rawEnvelope) {
  const meta = rawEnvelope.meta || {};
  const style = rawEnvelope.style || {};
  const structure = rawEnvelope.structure || {};
  const content = rawEnvelope.content || rawEnvelope.agent_output?.content || {};
  return { meta, style, structure, content, raw: rawEnvelope };
}

function deriveStyleSnapshot(extracted, referencePath) {
  const page = extracted.pageLayout || {};
  const margins = page.margins || {};
  const paraUsage = Object.entries(extracted.usage?.paraPrUsage || {}).sort((a, b) => Number(b[1]) - Number(a[1]));
  const charUsage = Object.entries(extracted.usage?.charPrUsage || {}).sort((a, b) => Number(b[1]) - Number(a[1]));
  const paraMap = new Map((extracted.paraProperties || []).map((x) => [String(x.id), x]));
  const charMap = new Map((extracted.charProperties || []).map((x) => [String(x.id), x]));

  const hangulFonts = new Map();
  for (const font of extracted.fonts || []) {
    if (font.lang === 'HANGUL' && !hangulFonts.has(String(font.id))) {
      hangulFonts.set(String(font.id), font.face);
    }
  }

  const topPara = paraMap.get(paraUsage[0]?.[0] || '') || {};
  const topChar = charMap.get(charUsage[0]?.[0] || '') || {};

  return {
    reference_path: referencePath || null,
    page: {
      width_mm: huToMm(page.width || 59528),
      height_mm: huToMm(page.height || 84186),
      margin_top_mm: huToMm(margins.top || 5669),
      margin_bottom_mm: huToMm(margins.bottom || 4252),
      margin_left_mm: huToMm(margins.left || 4252),
      margin_right_mm: huToMm(margins.right || 4252),
      margin_header_mm: huToMm(margins.header || 3600),
      margin_footer_mm: huToMm(margins.footer || 3600),
    },
    typography: {
      body_font_name: hangulFonts.get(String(topChar.fontRef)) || '한양신명조',
      body_font_size_pt: Number(topChar.fontSize || 10),
      line_spacing_percent: Number(topPara.lineSpacing || 130),
      indent_mm: huToMm(topPara.indent || -2450),
    },
    header_footer: {
      header: extracted.headerFooter?.header || null,
      footer: extracted.headerFooter?.footer || null,
    },
  };
}

async function resolveStyle(env) {
  if (env.style && Object.keys(env.style).length > 0) return env.style;

  const referencePath = env.meta?.reference_path || env.meta?.style_reference_path;
  if (!referencePath) {
    return {
      page: {
        width_mm: 210,
        height_mm: 297,
        margin_top_mm: 20,
        margin_bottom_mm: 15,
        margin_left_mm: 15,
        margin_right_mm: 15,
        margin_header_mm: 12.7,
        margin_footer_mm: 12.7,
      },
      typography: {
        body_font_name: '한양신명조',
        body_font_size_pt: 10,
        line_spacing_percent: 130,
        indent_mm: -8.6,
      },
      header_footer: { header: null, footer: null },
    };
  }

  const extract = await parseTemplateStyle({
    path: path.resolve(referencePath),
    include_all_sections: true,
  });
  if (!extract?.success) {
    throw new Error(`hwpx_extract_styles failed: ${extract?.output || 'unknown error'}`);
  }
  const parsed = JSON.parse(extract.output);
  return deriveStyleSnapshot(parsed, path.resolve(referencePath));
}

function validateEnvelope(env) {
  const errors = [];
  const sections = Array.isArray(env.structure?.sections) ? env.structure.sections : [];

  if (sections.length === 0) {
    errors.push('structure.sections is required and must be non-empty');
    return errors;
  }

  const paragraphs = env.content?.paragraphs || {};
  const bullets = env.content?.bullets || {};
  const tables = env.content?.tables || {};

  for (const section of sections) {
    for (const slot of section.paragraph_slots || []) {
      if (!paragraphs[slot]) errors.push(`missing paragraph slot: ${slot}`);
    }
    if (section.bullet_slot) {
      const bulletItems = bullets[section.bullet_slot];
      if (!Array.isArray(bulletItems) || bulletItems.length === 0) {
        errors.push(`missing bullet slot: ${section.bullet_slot}`);
      }
    }
    if (section.table) {
      const rows = tables[section.table.id];
      const columns = section.table.columns || [];
      if (!Array.isArray(rows)) {
        errors.push(`missing table: ${section.table.id}`);
      } else {
        for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
          if (!Array.isArray(rows[rowIndex]) || rows[rowIndex].length !== columns.length) {
            errors.push(`table ${section.table.id} row ${rowIndex} column count mismatch`);
          }
        }
      }
    }
  }

  const blob = JSON.stringify(env.content);
  if (/\bTODO\b|\bTBD\b|"\.\.\."/i.test(blob)) {
    errors.push('unresolved placeholders are not allowed');
  }

  return errors;
}

function buildContentBlocks(env) {
  const structure = env.structure.sections || [];
  const paragraphs = env.content.paragraphs || {};
  const bullets = env.content.bullets || {};
  const tables = env.content.tables || {};
  const typography = env.style.typography || {};

  const blocks = [];
  let sectionIndex = 0;
  for (const section of structure) {
    sectionIndex += 1;

    blocks.push({
      paragraph: {
        text: section.heading,
        heading: 2,
        bold: true,
      },
    });

    for (const slot of section.paragraph_slots || []) {
      blocks.push({
        paragraph: {
          text: paragraphs[slot],
          lineSpacing: typography.line_spacing_percent,
          indent: typography.indent_mm,
          fontName: typography.body_font_name,
          fontSize: typography.body_font_size_pt,
        },
      });
    }

    if (section.bullet_slot) {
      for (const item of bullets[section.bullet_slot] || []) {
        blocks.push({
          paragraph: {
            text: item,
            bullet: true,
            lineSpacing: typography.line_spacing_percent,
            fontName: typography.body_font_name,
            fontSize: typography.body_font_size_pt,
          },
        });
      }
    }

    if (section.table) {
      const columns = section.table.columns || [];
      const rows = tables[section.table.id] || [];
      blocks.push({
        table: {
          rows: [columns, ...rows],
          headerRow: true,
        },
      });
    }

    if (sectionIndex < structure.length) {
      blocks.push({ paragraph: { text: '' } });
    }
  }

  return blocks;
}

function buildPageLayoutArgs(outputPath, style) {
  const page = style.page || {};
  return {
    path: outputPath,
    page_width: pickStyleValue(page.width_mm, page.page_width_mm),
    page_height: pickStyleValue(page.height_mm, page.page_height_mm),
    margin_top: pickStyleValue(page.margin_top_mm, page.top_mm),
    margin_bottom: pickStyleValue(page.margin_bottom_mm, page.bottom_mm),
    margin_left: pickStyleValue(page.margin_left_mm, page.left_mm),
    margin_right: pickStyleValue(page.margin_right_mm, page.right_mm),
    margin_header: pickStyleValue(page.margin_header_mm, page.header_mm),
    margin_footer: pickStyleValue(page.margin_footer_mm, page.footer_mm),
    output_path: outputPath,
    section_index: -1,
  };
}

async function inspectOutput(outputPath, env) {
  const zip = await JSZip.loadAsync(fs.readFileSync(outputPath));
  const sectionXml = await zip.file('Contents/section0.xml').async('string');
  const headingChecks = (env.structure.sections || []).map((section) => ({
    heading: section.heading,
    ok: sectionXml.includes(section.heading),
  }));

  const checks = {
    has_header: /<hp:header\b/.test(sectionXml),
    has_footer: /<hp:footer\b/.test(sectionXml),
    auto_num_count: (sectionXml.match(/<hp:autoNum\b/g) || []).length,
    paragraph_count: (sectionXml.match(/<hp:p\b/g) || []).length,
    table_count: (sectionXml.match(/<hp:tbl\b/g) || []).length,
    heading_order_present: headingChecks.every((x) => x.ok),
  };
  return { checks, headingChecks };
}

async function main() {
  const envelopeArg = process.argv[2];
  if (!envelopeArg) {
    throw new Error('Usage: node scripts/json-envelope-pipeline.mjs <envelope_json_path> [runs_root] [--keep-artifacts]');
  }
  const keepArtifacts = process.argv.includes('--keep-artifacts') || process.env.HWPX_KEEP_ARTIFACTS === '1';

  const envelopePath = path.resolve(envelopeArg);
  const runsRoot = path.resolve(process.argv[3] || path.join(process.cwd(), 'runs'));
  const rawEnvelope = readJson(envelopePath);
  const env = normalizeEnvelope(rawEnvelope);
  env.style = await resolveStyle(env);

  const validationErrors = validateEnvelope(env);
  if (validationErrors.length > 0) {
    throw new Error(`Envelope validation failed: ${validationErrors.join('; ')}`);
  }

  const sessionId = env.meta.session_id || 'json_envelope';
  const taskId = env.meta.task_id || `run_${Date.now()}`;
  const runDir = path.join(runsRoot, sessionId, taskId);
  ensureDir(runDir);

  const envelopeOutPath = path.join(runDir, 'document_envelope.json');
  if (keepArtifacts) {
    writeJson(envelopeOutPath, {
      meta: env.meta,
      style: env.style,
      structure: env.structure,
      content: env.content,
    });
  }

  const content = buildContentBlocks(env);
  const page = env.style.page || {};
  const typography = env.style.typography || {};
  const header = env.style.header_footer?.header;
  const footer = env.style.header_footer?.footer;

  const hwpxBuffer = await createDocument({
    output_path: path.join(runDir, 'result.hwpx'),
    title: env.meta.title || env.structure?.document?.title || '문서',
    content,
    font: typography.body_font_name || '한양신명조',
    font_size: typography.body_font_size_pt || 10,
    margin: {
      top: pickStyleValue(page.margin_top_mm, 20),
      bottom: pickStyleValue(page.margin_bottom_mm, 15),
      left: pickStyleValue(page.margin_left_mm, 15),
      right: pickStyleValue(page.margin_right_mm, 15),
    },
    header,
    footer,
  });

  const outputPath = path.join(runDir, 'result.hwpx');
  fs.writeFileSync(outputPath, hwpxBuffer);

  // Enforce exact page/header/footer lock values from style snapshot.
  if (header) {
    await callTool('hwpx_set_header_footer', {
      path: outputPath,
      type: 'header',
      content: header,
      alignment: 'CENTER',
      output_path: outputPath,
      section_index: -1,
    });
  }
  if (footer) {
    await callTool('hwpx_set_header_footer', {
      path: outputPath,
      type: 'footer',
      content: footer,
      alignment: 'CENTER',
      output_path: outputPath,
      section_index: -1,
    });
  }
  await callTool('hwpx_set_page_layout', buildPageLayoutArgs(outputPath, env.style));

  const inspection = await inspectOutput(outputPath, env);
  const checks = {
    envelope_valid: true,
    ...inspection.checks,
  };
  const gate = (
    checks.heading_order_present
    && checks.has_header
    && checks.has_footer
    && checks.auto_num_count >= 2
  ) ? 'PASS' : 'FAIL';

  const runReportPath = path.join(runDir, 'run_report.json');
  if (keepArtifacts) {
    writeJson(runReportPath, {
      mode: 'json_envelope_direct',
      run_dir: runDir,
      files: {
        document_envelope: envelopeOutPath,
        output_hwpx: outputPath,
        run_report: runReportPath,
      },
      checks,
      heading_checks: inspection.headingChecks,
      gate,
      tool_sequence: [
        'createDocument',
        'hwpx_set_header_footer(header)',
        'hwpx_set_header_footer(footer)',
        'hwpx_set_page_layout',
      ],
    });
  }

  process.stdout.write(`${JSON.stringify({
    run_dir: runDir,
    output_hwpx: outputPath,
    run_report: keepArtifacts ? runReportPath : null,
    document_envelope: keepArtifacts ? envelopeOutPath : null,
    gate,
    checks,
    keep_artifacts: keepArtifacts,
  }, null, 2)}\n`);
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exit(1);
});
