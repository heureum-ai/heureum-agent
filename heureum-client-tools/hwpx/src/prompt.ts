/**
 * Reusable prompts/workflows for agents generating Korean public-sector HWPX documents.
 * Keep these prompts implementation-agnostic and tool-focused.
 */
import type { ExtractedStyles } from './types.js';
import { HWPX_DEFAULTS } from './configs.js';

export interface HwpxPromptOptions {
  documentTitle?: string;
  authorityName?: string;
  includeAppendix?: boolean;
}

const DEFAULT_TITLE = '공식 행정문서';
const DEFAULT_AUTHORITY = '행정기관';

function section(tag: string, lines: string | string[]): string[] {
  const content = Array.isArray(lines) ? lines : [lines];
  return [`<section name="${tag}">`, ...content, '</section>'];
}

/**
 * General prompt for reproducing official Korean administrative documents with this toolchain.
 */
export function buildOfficialHwpxWorkflowPrompt(options: HwpxPromptOptions = {}): string {
  const title = options.documentTitle ?? DEFAULT_TITLE;
  const authority = options.authorityName ?? DEFAULT_AUTHORITY;
  const appendixHint = options.includeAppendix === false ? '부칙/별표가 없을 수 있음' : '부칙/별표 포함 가능';

  return [
    '<prompt>',
    ...section('mission', `목표: "${title}" 문서를 ${authority}의 공문서 규격에 맞게 HWPX로 생성한다. (${appendixHint})`),
    '',
    ...section('core_principles', [
      '1. 하드코딩 금지: 특정 문서 전용 분기(if title === ...)를 만들지 않는다.',
      '2. 구조 우선: 단락/런/표/머리말·꼬리말/이미지를 툴 파라미터로 표현한다.',
      '3. 반복 보정: 1회 생성 후 레이아웃/서식 차이를 수정 툴로 점진적으로 줄인다.',
    ]),
    '',
    ...section('recommended_tool_order', [
      '1. hwpx_create_document',
      '2. hwpx_set_page_layout',
      '3. hwpx_set_header_footer (content.table + auto_page_num/auto_total_pages)',
      '4. hwpx_insert_image (text_wrap 포함)',
      '5. hwpx_set_para_format / hwpx_set_char_format',
      '6. 필요 시 hwpx_edit_table_cell, hwpx_insert_text, hwpx_find_replace',
    ]),
    '',
    ...section('authoring_rules', [
      '- 본문은 paragraph.runs[] 사용 (조 제목/본문/개정주석 혼합 서식).',
      '- 내어쓰기는 indent 음수값으로 표현 (예: 조/항/호/목 계층).',
      '- 표는 columnWidths와 cellBorder(방향별)를 명시.',
      '- 머리말/꼬리말 페이지 표기는 {{PAGE}}, {{TOTAL_PAGE}} 또는 auto_page_num 플래그 사용.',
      '- 이미지 배치는 text_wrap 기준으로 선택: TOP_AND_BOTTOM / SQUARE / BEHIND_TEXT.',
    ]),
    '',
    ...section('quality_gate', [
      '- 문단 수, 표 수, 이미지 수를 기준 문서와 비교.',
      '- 주요 조문 제목/부칙 제목/연락처 라인의 텍스트 존재 여부 확인.',
      '- 머리말/꼬리말에 표와 페이지 번호 필드(autoNum)가 생성되었는지 확인.',
      '- 실패 시 원인 레벨(텍스트/서식/배치)을 분리해서 재시도.',
    ]),
    '',
    ...section('output', [
      '- 최종 산출물 경로',
      '- 적용한 툴 호출 순서 요약',
      '- 남은 차이(있다면)와 다음 보정 액션',
    ]),
    '</prompt>',
  ].join('\n');
}

/**
 * A static, generic workflow prompt for broad reuse.
 */
export const OFFICIAL_HWPX_WORKFLOW_PROMPT: string = buildOfficialHwpxWorkflowPrompt();

/**
 * Skill-friendly prompt: includes role, constraints, workflow, and output contract.
 * This is intended to be embedded directly in a skill definition.
 */
export function buildOfficialHwpxSkillPrompt(options: HwpxPromptOptions = {}): string {
  const title = options.documentTitle ?? DEFAULT_TITLE;
  const authority = options.authorityName ?? DEFAULT_AUTHORITY;
  const appendixHint = options.includeAppendix === false ? '부칙/별표는 선택사항' : '부칙/별표 포함 가능';

  return [
    '<prompt>',
    ...section('role', `당신은 ${authority} 공식문서 재현을 담당하는 HWPX 생성 에이전트다.`),
    '',
    ...section('mission', [
      `기준 문서 "${title}"를 HWPX 툴 체인만으로 재현한다. (${appendixHint})`,
      '하드코딩 분기 없이 재사용 가능한 파라미터 기반 구현만 사용한다.',
    ]),
    '',
    ...section('must', [
      '- 구현 로직은 src/ 아래 툴/모듈에서 처리한다. 스크립트는 오케스트레이션만 담당한다.',
      '- paragraph.runs[]로 혼합 서식을 표현한다.',
      '- 음수 indent로 내어쓰기를 표현한다.',
      '- header/footer는 content.table + auto page fields를 우선 사용한다.',
      '- image는 text_wrap을 명시한다.',
      '- 생성 후 문단/표/이미지 개수와 핵심 텍스트 존재 여부를 검증한다.',
    ]),
    '',
    ...section('workflow', [
      '1. hwpx_create_document로 본문/표/기본 머리말·꼬리말 생성',
      '2. hwpx_set_page_layout로 페이지/여백 정렬',
      '3. hwpx_set_header_footer로 머리말·꼬리말 고급 보정',
      '4. hwpx_insert_image로 누락 이미지 및 래핑 보정',
      '5. hwpx_set_para_format/hwpx_set_char_format으로 미세 서식 보정',
      '6. 검증 결과가 기준 미달이면 차이 원인별로 재시도',
    ]),
    '',
    ...section('output_contract', [
      '- final_path: 최종 산출물 경로',
      '- tool_sequence: 실행 툴 순서 배열',
      '- verification: {paragraphs, tables, images, key_text_checks}',
      '- remaining_gaps: 남은 차이 목록(없으면 빈 배열)',
      '- next_actions: 다음 보정 제안(필요 시)',
    ]),
    '</prompt>',
  ].join('\n');
}

export const OFFICIAL_HWPX_SKILL_PROMPT: string = buildOfficialHwpxSkillPrompt();

export interface HwpxStyleExtractionPromptOptions {
  referencePath?: string;
}

/**
 * Prompt that standardizes style extraction + style-guide generation from a reference HWPX.
 * Default reference path is managed in configs.ts (HWPX_DEFAULTS.prompts.styleGuideReferencePath).
 */
export function buildHwpxStyleExtractionPrompt(
  options: HwpxStyleExtractionPromptOptions = {},
): string {
  const referencePath = options.referencePath ?? HWPX_DEFAULTS.prompts.styleGuideReferencePath;
  return [
    '<prompt>',
    ...section('role', '당신은 HWPX 서식 템플릿 분석 에이전트다.'),
    '',
    ...section('mission', `기준 문서 \`${referencePath}\`에서 서식 체계를 추출해 재사용 가능한 스타일 가이드를 만든다.`),
    '',
    ...section('workflow', [
      `1. parseTemplateStyle({ path: "${referencePath}", include_all_sections: true })`,
      '2. buildHwpxStyleGuidePrompt(extractedStyles)',
    ]),
    '',
    ...section('output', [
      '- style extraction 요약 (fonts/char/para/border/styles/effective/usage)',
      '- hwpx_create_document 호출 골격 JSON',
      '- 서식 재현 시 주의사항',
    ]),
    '</prompt>',
  ].join('\n');
}

export const HWPX_STYLE_EXTRACTION_PROMPT: string = buildHwpxStyleExtractionPrompt();

type PlainObject = Record<string, unknown>;

interface HwpxStyleUsageSummary {
  paragraphCount: number;
  runCount: number;
  tableCount: number;
  styleUsage: PlainObject;
  paraPrUsage: PlainObject;
  charPrUsage: PlainObject;
}

interface HwpxNormalizedSection {
  sectionPath: string | null;
  pageLayout: PlainObject;
  headerFooter: PlainObject;
  usage: PlainObject;
}

interface HwpxNormalizedExtractedStyles {
  sourcePath: string | null;
  metadata: PlainObject;
  fonts: PlainObject[];
  charProperties: PlainObject[];
  paraProperties: PlainObject[];
  borderFills: PlainObject[];
  styles: PlainObject[];
  effectiveStyles: PlainObject[];
  pageLayout: PlainObject;
  headerFooter: PlainObject;
  usage: HwpxStyleUsageSummary;
  sections: HwpxNormalizedSection[];
  sectionCount: number;
  markdownContent: string | null;
  markdownSource: string | null;
}

export interface HwpxStyleGuidePromptOptions {
  includeMarkdownContent?: boolean;
  maxCharPropertyRows?: number;
  maxParaPropertyRows?: number;
  maxStyleRows?: number;
}

const HWPUNIT_PER_MM = 283.46;
const DEFAULT_FONT_FACE = '맑은 고딕';

function toArray<T>(value: unknown): T[] {
  if (Array.isArray(value)) return value as T[];
  if (value === undefined || value === null) return [];
  return [value as T];
}

function asObject(value: unknown): PlainObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as PlainObject;
}

function toNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toMm(value: unknown): number | null {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number((n / HWPUNIT_PER_MM).toFixed(1));
}

function mapCount(mapLike: PlainObject, key: unknown): number {
  const direct = key !== undefined && key !== null ? mapLike[key as keyof PlainObject] : undefined;
  const fallback = mapLike[String(key)];
  const count = Number(direct ?? fallback ?? 0);
  return Number.isFinite(count) ? count : 0;
}

function buildFontFaceMap(fonts: PlainObject[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const font of fonts) {
    const id = font.id ?? font.fontId ?? font.fontID;
    const face = font.face ?? font.name ?? font.family;
    if (id === undefined || id === null) continue;
    if (typeof face !== 'string' || !face.trim()) continue;
    map[String(id)] = face;
  }
  return map;
}

function pickMostUsedCharProperty(
  charProperties: PlainObject[],
  usageMap: PlainObject,
): PlainObject {
  if (charProperties.length === 0) return {};
  const ranked = charProperties
    .map((cp) => {
      const id = cp.id ?? cp.charPrIDRef ?? cp.charPrIdRef;
      return { cp, usage: mapCount(usageMap, id) };
    })
    .sort((lhs, rhs) => {
      if (rhs.usage !== lhs.usage) return rhs.usage - lhs.usage;
      return toNumber(lhs.cp.id, 0) - toNumber(rhs.cp.id, 0);
    });
  return ranked[0]?.cp ?? charProperties[0];
}

function pickMostUsedParaProperty(
  paraProperties: PlainObject[],
  usageMap: PlainObject,
): PlainObject {
  if (paraProperties.length === 0) return {};
  const ranked = paraProperties
    .map((pp) => {
      const id = pp.id ?? pp.paraPrIDRef ?? pp.paraPrIdRef;
      return { pp, usage: mapCount(usageMap, id) };
    })
    .sort((lhs, rhs) => {
      if (rhs.usage !== lhs.usage) return rhs.usage - lhs.usage;
      return toNumber(lhs.pp.id, 0) - toNumber(rhs.pp.id, 0);
    });
  return ranked[0]?.pp ?? paraProperties[0];
}

function normalizeExtractedStyles(source: ExtractedStyles): HwpxNormalizedExtractedStyles {
  const input = asObject(source);
  const usageInput = asObject(input.usage);
  const sections = toArray<unknown>(input.sections).map((raw) => {
    const section = asObject(raw);
    return {
      sectionPath: typeof section.sectionPath === 'string' ? section.sectionPath : null,
      pageLayout: asObject(section.pageLayout),
      headerFooter: asObject(section.headerFooter),
      usage: asObject(section.usage),
    };
  });

  return {
    sourcePath: typeof input.sourcePath === 'string' ? input.sourcePath : null,
    metadata: asObject(input.metadata),
    fonts: toArray<unknown>(input.fonts).map(asObject),
    charProperties: toArray<unknown>(input.charProperties).map(asObject),
    paraProperties: toArray<unknown>(input.paraProperties).map(asObject),
    borderFills: toArray<unknown>(input.borderFills).map(asObject),
    styles: toArray<unknown>(input.styles).map(asObject),
    effectiveStyles: toArray<unknown>(input.effectiveStyles).map(asObject),
    pageLayout: asObject(input.pageLayout),
    headerFooter: asObject(input.headerFooter),
    usage: {
      paragraphCount: toNumber(usageInput.paragraphCount, 0),
      runCount: toNumber(usageInput.runCount, 0),
      tableCount: toNumber(usageInput.tableCount, 0),
      styleUsage: asObject(usageInput.styleUsage),
      paraPrUsage: asObject(usageInput.paraPrUsage),
      charPrUsage: asObject(usageInput.charPrUsage),
    },
    sections,
    sectionCount: toNumber(input.sectionCount, sections.length),
    markdownContent: typeof input.markdownContent === 'string' ? input.markdownContent : null,
    markdownSource: typeof input.markdownSource === 'string' ? input.markdownSource : null,
  };
}

function summarizeBorders(borderFills: PlainObject[]): {
  borderTypes: Record<string, number>;
  fillColors: Record<string, number>;
} {
  const borderTypes: Record<string, number> = {};
  const fillColors: Record<string, number> = {};
  for (const bf of borderFills) {
    const fillColor = bf.backgroundColor ?? bf.fillColor;
    if (typeof fillColor === 'string' && fillColor.trim()) {
      const key = fillColor.toUpperCase();
      fillColors[key] = (fillColors[key] ?? 0) + 1;
    }
    for (const side of ['top', 'bottom', 'left', 'right']) {
      const sideObj = asObject(bf[side]);
      const sideType = sideObj.type;
      if (typeof sideType === 'string' && sideType.trim()) {
        borderTypes[sideType] = (borderTypes[sideType] ?? 0) + 1;
      }
    }
  }
  return { borderTypes, fillColors };
}

function buildColorHistogram(charProperties: PlainObject[], usageMap: PlainObject): Record<string, { count: number; sizes: number[] }> {
  const histogram: Record<string, { count: number; sizes: number[] }> = {};
  for (const cp of charProperties) {
    const rawColor = cp.textColor ?? cp.color;
    if (typeof rawColor !== 'string') continue;
    const color = rawColor.toUpperCase();
    if (!/^#[0-9A-F]{6}$/.test(color)) continue;

    if (!histogram[color]) histogram[color] = { count: 0, sizes: [] };
    const id = cp.id ?? cp.charPrIDRef;
    histogram[color].count += mapCount(usageMap, id) || 1;

    const size = toNumber(cp.fontSize, NaN);
    if (Number.isFinite(size) && !histogram[color].sizes.includes(size)) {
      histogram[color].sizes.push(size);
    }
  }
  return histogram;
}

function inferHeaderFooterRoles(row: string[]): string[] {
  return row.map((cell) => {
    if (/{{PAGE}}/.test(cell) && /{{TOTAL_PAGE}}/.test(cell)) return '페이지(현재/전체)';
    if (/{{PAGE}}/.test(cell)) return '현재 페이지';
    if (/{{TOTAL_PAGE}}/.test(cell)) return '전체 페이지';
    if (/\d{4}[.\-/]\d{1,2}[.\-/]\d{1,2}/.test(cell)) return '날짜';
    if (cell.length >= 12) return '제목/설명';
    if (cell.length === 0) return '빈 셀';
    return '기관/라벨';
  });
}

function toStringArray(value: unknown): string[] {
  return toArray<unknown>(value).map((item) => String(item ?? ''));
}

function getFirstTableRow(table: PlainObject): string[] {
  const rows = toArray<unknown>(table.rows);
  if (rows.length === 0) return [];
  return toStringArray(rows[0]);
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function normalizeMarkdownForPrompt(markdown: string): string {
  // hwpx_read_markdown output can contain HTML-style tags (<p>, <span>, <br>).
  // Keep textual content while removing presentational tags for prompt readability.
  const withoutTags = markdown
    .replace(/\r\n/g, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n\n')
    .replace(/<p\b[^>]*>/gi, '')
    .replace(/<\/?span\b[^>]*>/gi, '')
    .replace(/<\/?div\b[^>]*>/gi, '')
    .replace(/<\/?strong\b[^>]*>/gi, '')
    .replace(/<\/?em\b[^>]*>/gi, '')
    .replace(/<\/?b\b[^>]*>/gi, '')
    .replace(/<\/?i\b[^>]*>/gi, '');

  return decodeHtmlEntities(withoutTags)
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

interface MarkdownContentAnalysis {
  headingCounts: Record<number, number>;
  bodyParagraphCount: number;
  listItemCount: number;
  tableRowCount: number;
  blockquoteLineCount: number;
  sentenceCount: number;
  avgSentenceLength: number;
  endingCounts: Record<string, number>;
  dominantToneLabel: string;
}

function stripMarkdownInline(text: string): string {
  return text
    .replace(/`[^`]*`/g, '')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/[*_~>#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function summarizeToneLabel(endingCounts: Record<string, number>): string {
  const polite = endingCounts.polite ?? 0;
  const declarative = endingCounts.declarative ?? 0;
  const past = endingCounts.past ?? 0;
  const other = endingCounts.other ?? 0;
  const max = Math.max(polite, declarative, past, other);
  if (max === 0) return '판별 어려움';
  if (max === polite) return '공손한 보고체(합니다체) 우세';
  if (max === declarative) return '규정/법령형 서술체(한다체) 우세';
  if (max === past) return '과거 사실 보고형 문체 우세';
  return '혼합 서술체(특정 톤 비우세)';
}

function analyzeMarkdownContent(markdown: string): MarkdownContentAnalysis {
  const lines = markdown.split(/\r?\n/);
  const headingCounts: Record<number, number> = {};
  const endingCounts: Record<string, number> = { polite: 0, declarative: 0, past: 0, other: 0 };
  let bodyParagraphCount = 0;
  let listItemCount = 0;
  let tableRowCount = 0;
  let blockquoteLineCount = 0;
  let inCodeFence = false;
  let currentParagraph: string[] = [];
  const paragraphTexts: string[] = [];

  const flushParagraph = (): void => {
    if (currentParagraph.length === 0) return;
    const text = stripMarkdownInline(currentParagraph.join(' '));
    if (text.length > 0) {
      paragraphTexts.push(text);
      bodyParagraphCount += 1;
    }
    currentParagraph = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();

    if (/^```/.test(trimmed)) {
      inCodeFence = !inCodeFence;
      flushParagraph();
      continue;
    }
    if (inCodeFence) continue;

    if (trimmed.length === 0) {
      flushParagraph();
      continue;
    }

    const headingMatch = trimmed.match(/^(#{1,6})\s+/);
    if (headingMatch) {
      flushParagraph();
      const depth = headingMatch[1].length;
      headingCounts[depth] = (headingCounts[depth] ?? 0) + 1;
      continue;
    }

    if (/^(\-|\*|\+|\d+\.)\s+/.test(trimmed)) {
      flushParagraph();
      listItemCount += 1;
      continue;
    }

    if (/^\|.*\|$/.test(trimmed)) {
      flushParagraph();
      tableRowCount += 1;
      continue;
    }

    if (/^>/.test(trimmed)) {
      flushParagraph();
      blockquoteLineCount += 1;
      continue;
    }

    if (/^[-*_]{3,}$/.test(trimmed)) {
      flushParagraph();
      continue;
    }

    currentParagraph.push(trimmed);
  }
  flushParagraph();

  const sentenceTexts: string[] = [];
  for (const paragraph of paragraphTexts) {
    const chunks = paragraph
      .split(/[.!?。]+/)
      .map((chunk) => chunk.trim())
      .filter((chunk) => chunk.length > 0);
    sentenceTexts.push(...chunks);
  }

  for (const sentence of sentenceTexts) {
    const normalized = sentence.replace(/[)"'”’]+$/g, '').trim();
    if (/(합니다|드립니다|바랍니다|입니다|됩니다)$/.test(normalized)) {
      endingCounts.polite = (endingCounts.polite ?? 0) + 1;
    } else if (/(한다|된다|있다|없다|하여야 한다|할 수 있다)$/.test(normalized)) {
      endingCounts.declarative = (endingCounts.declarative ?? 0) + 1;
    } else if (/(하였다|했다|되었다|였다)$/.test(normalized)) {
      endingCounts.past = (endingCounts.past ?? 0) + 1;
    } else {
      endingCounts.other = (endingCounts.other ?? 0) + 1;
    }
  }

  const sentenceCount = sentenceTexts.length;
  const totalSentenceChars = sentenceTexts.reduce((sum, sentence) => sum + sentence.length, 0);
  const avgSentenceLength = sentenceCount > 0 ? Number((totalSentenceChars / sentenceCount).toFixed(1)) : 0;

  return {
    headingCounts,
    bodyParagraphCount,
    listItemCount,
    tableRowCount,
    blockquoteLineCount,
    sentenceCount,
    avgSentenceLength,
    endingCounts,
    dominantToneLabel: summarizeToneLabel(endingCounts),
  };
}

/**
 * Build a reusable style-guide prompt from style extraction output.
 * Accepts sparse ExtractedStyles data and generates sections conditionally.
 */
export function buildHwpxStyleGuidePrompt(
  extractedStyles: ExtractedStyles,
  options: HwpxStyleGuidePromptOptions = {},
): string {
  const normalized = normalizeExtractedStyles(extractedStyles);
  const normalizedMarkdownContent = normalized.markdownContent
    ? normalizeMarkdownForPrompt(normalized.markdownContent)
    : null;
  const lines: string[] = [];

  const maxCharRows = Math.max(1, options.maxCharPropertyRows ?? 12);
  const maxParaRows = Math.max(1, options.maxParaPropertyRows ?? 12);
  const maxStyleRows = Math.max(1, options.maxStyleRows ?? 20);
  const includeMarkdownContent = options.includeMarkdownContent ?? true;
  const hasMarkdownSection = includeMarkdownContent && Boolean(normalizedMarkdownContent);
  const markdownSectionOffset = hasMarkdownSection ? 2 : 0;
  const pageSectionNo = 2 + markdownSectionOffset;
  const typographySectionNo = 3 + markdownSectionOffset;
  const colorSectionNo = 4 + markdownSectionOffset;
  const paragraphSectionNo = 5 + markdownSectionOffset;
  const tableSectionNo = 6 + markdownSectionOffset;
  const headerFooterSectionNo = 7 + markdownSectionOffset;
  const sectionSummarySectionNo = 8 + markdownSectionOffset;
  const styleTitleNo = (normalized.sections.length > 1 ? 9 : 8) + markdownSectionOffset;
  const templateTitleNo = (normalized.sections.length > 1 ? 10 : 9) + markdownSectionOffset;

  const fontMap = buildFontFaceMap(normalized.fonts);
  const baseCp = pickMostUsedCharProperty(normalized.charProperties, normalized.usage.charPrUsage);
  const basePp = pickMostUsedParaProperty(normalized.paraProperties, normalized.usage.paraPrUsage);
  const baseFontRef = baseCp.fontRef ?? baseCp.fontIDRef;
  const primaryFont = fontMap[String(baseFontRef)] || normalized.fonts[0]?.face || DEFAULT_FONT_FACE;
  const baseFontSize = toNumber(baseCp.fontSize, 10);
  const baseAlign = typeof basePp.alignment === 'string' ? basePp.alignment : 'JUSTIFY';
  const baseLineSpacing = toNumber(basePp.lineSpacing, 130);
  const sectionCount = normalized.sectionCount || normalized.sections.length || 1;
  const borderSummary = summarizeBorders(normalized.borderFills);
  const effectiveStyles = normalized.effectiveStyles.length > 0
    ? normalized.effectiveStyles
    : normalized.styles;
  const colorHistogram = buildColorHistogram(normalized.charProperties, normalized.usage.charPrUsage);

  lines.push('# [STYLE SYSTEM] HWPX 문서 서식 가이드');
  lines.push('');
  lines.push('> 참조 문서에서 추출한 스타일 정보를 기반으로 생성된 일반화 프롬프트입니다.');
  lines.push('> 문서 내용은 새로 작성하고, 서식 패턴만 재사용하십시오.');
  lines.push('');

  lines.push('## 1. 문서 스냅샷');
  lines.push('');
  lines.push(`- section 수: ${sectionCount}`);
  lines.push(`- 폰트 정의 수: ${normalized.fonts.length}`);
  lines.push(`- 글자 속성 수(charProperties): ${normalized.charProperties.length}`);
  lines.push(`- 문단 속성 수(paraProperties): ${normalized.paraProperties.length}`);
  lines.push(`- 스타일 정의 수(styles): ${normalized.styles.length}`);
  lines.push(`- effective 스타일 수: ${normalized.effectiveStyles.length}`);
  lines.push(`- 본문 통계: paragraph=${normalized.usage.paragraphCount}, run=${normalized.usage.runCount}, table=${normalized.usage.tableCount}`);
  if (typeof normalized.metadata.title === 'string') lines.push(`- title: ${normalized.metadata.title}`);
  if (typeof normalized.metadata.subject === 'string') lines.push(`- subject: ${normalized.metadata.subject}`);
  if (typeof normalized.metadata.creator === 'string') lines.push(`- creator: ${normalized.metadata.creator}`);
  if (typeof normalized.metadata.language === 'string') lines.push(`- language: ${normalized.metadata.language}`);
  lines.push('');

  if (hasMarkdownSection && normalizedMarkdownContent) {
    const mdAnalysis = analyzeMarkdownContent(normalizedMarkdownContent);
    const headingSummary = Object.entries(mdAnalysis.headingCounts)
      .sort((lhs, rhs) => Number(lhs[0]) - Number(rhs[0]))
      .map(([depth, count]) => `H${depth}:${count}`)
      .join(', ');

    lines.push('## 2. 원문 문단 구조/문장 톤 요약');
    lines.push('');
    lines.push(`- heading 분포: ${headingSummary || '없음'}`);
    lines.push(`- 본문 문단 수: ${mdAnalysis.bodyParagraphCount}`);
    lines.push(`- 목록 항목 수: ${mdAnalysis.listItemCount}`);
    lines.push(`- 표 행 수(마크다운): ${mdAnalysis.tableRowCount}`);
    lines.push(`- 인용 라인 수: ${mdAnalysis.blockquoteLineCount}`);
    lines.push(`- 문장 수(추정): ${mdAnalysis.sentenceCount}`);
    lines.push(`- 평균 문장 길이(문자): ${mdAnalysis.avgSentenceLength}`);
    lines.push(`- 우세한 종결 어미 톤: ${mdAnalysis.dominantToneLabel}`);
    lines.push(`- 종결 어미 분포: 합니다체=${mdAnalysis.endingCounts.polite ?? 0}, 한다체=${mdAnalysis.endingCounts.declarative ?? 0}, 과거형=${mdAnalysis.endingCounts.past ?? 0}, 기타=${mdAnalysis.endingCounts.other ?? 0}`);
    if (normalized.markdownSource) {
      lines.push(`- 변환 경로: ${normalized.markdownSource}`);
    }
    lines.push('');

    lines.push('## 3. 참조 문서 텍스트(마크다운 추출)');
    lines.push('');
    lines.push('```markdown');
    lines.push(normalizedMarkdownContent.replace(/```/g, '\\`\\`\\`'));
    lines.push('```');
    lines.push('');
  }

  lines.push(`## ${pageSectionNo}. 페이지 설정`);
  lines.push('');
  if (normalized.pageLayout.width && normalized.pageLayout.height) {
    const margins = asObject(normalized.pageLayout.margins);
    lines.push('```json');
    lines.push(JSON.stringify({
      size_mm: {
        width: toMm(normalized.pageLayout.width),
        height: toMm(normalized.pageLayout.height),
      },
      margin_mm: {
        top: toMm(margins.top),
        bottom: toMm(margins.bottom),
        left: toMm(margins.left),
        right: toMm(margins.right),
      },
    }, null, 2));
    lines.push('```');
  } else {
    lines.push('- 페이지 설정 정보가 없으므로 기본값(A4/기본 여백)을 사용합니다.');
  }
  lines.push('');

  lines.push(`## ${typographySectionNo}. 타이포그래피`);
  lines.push('');
  lines.push('| charPr ID | 폰트 | 크기(pt) | 굵기 | 기울임 | 밑줄 | 색상 | usage |');
  lines.push('|-----------|------|----------|------|--------|------|------|-------|');
  const charRows = normalized.charProperties
    .map((cp) => {
      const id = cp.id ?? cp.charPrIDRef ?? '-';
      const usage = mapCount(normalized.usage.charPrUsage, id);
      const fontFace = fontMap[String(cp.fontRef ?? cp.fontIDRef)] || primaryFont;
      return {
        id,
        usage,
        font: fontFace,
        fontSize: toNumber(cp.fontSize, baseFontSize),
        bold: !!cp.bold,
        italic: !!cp.italic,
        underline: !!cp.underline,
        color: String(cp.textColor ?? cp.color ?? '#000000'),
      };
    })
    .sort((lhs, rhs) => rhs.usage - lhs.usage);

  if (charRows.length === 0) {
    lines.push('| - | - | - | - | - | - | - | - |');
  } else {
    for (const row of charRows.slice(0, maxCharRows)) {
      lines.push(`| ${row.id} | ${row.font} | ${row.fontSize} | ${row.bold ? 'Y' : '-'} | ${row.italic ? 'Y' : '-'} | ${row.underline ? 'Y' : '-'} | ${row.color} | ${row.usage} |`);
    }
  }
  lines.push('');
  lines.push(`기본 추천값: \`font="${primaryFont}", font_size=${baseFontSize}\``);
  lines.push('');

  const colorEntries = Object.entries(colorHistogram)
    .sort((lhs, rhs) => rhs[1].count - lhs[1].count);
  if (colorEntries.length > 0) {
    lines.push(`## ${colorSectionNo}. 색상 체계`);
    lines.push('');
    lines.push('| 색상 | 사용량(대략) | 샘플 fontSize |');
    lines.push('|------|--------------|---------------|');
    for (const [color, summary] of colorEntries.slice(0, 10)) {
      lines.push(`| ${color} | ${summary.count} | ${summary.sizes.length > 0 ? summary.sizes.join('/') : '-'} |`);
    }
    lines.push('');
  }

  lines.push(`## ${paragraphSectionNo}. 문단 레이아웃`);
  lines.push('');
  lines.push(`- 기본 정렬 추정: ${baseAlign}`);
  lines.push(`- 기본 줄간격 추정: ${baseLineSpacing}`);
  if (basePp.indent !== undefined) {
    const indent = toNumber(basePp.indent, 0);
    lines.push(`- 기본 indent: ${indent} (${toMm(Math.abs(indent))}mm)`);
  }
  lines.push('');
  lines.push('| paraPr ID | alignment | lineSpacing | marginLeft | marginRight | indent | heading | usage |');
  lines.push('|-----------|-----------|-------------|------------|-------------|--------|---------|-------|');
  const paraRows = normalized.paraProperties
    .map((pp) => {
      const id = pp.id ?? pp.paraPrIDRef ?? '-';
      const heading = asObject(pp.heading);
      return {
        id,
        usage: mapCount(normalized.usage.paraPrUsage, id),
        alignment: String(pp.alignment ?? '-'),
        lineSpacing: String(pp.lineSpacing ?? '-'),
        marginLeft: String(pp.marginLeft ?? '-'),
        marginRight: String(pp.marginRight ?? '-'),
        indent: String(pp.indent ?? '-'),
        heading: heading.type ? `${String(heading.type)}:${String(heading.level ?? '-')}` : '-',
      };
    })
    .sort((lhs, rhs) => rhs.usage - lhs.usage);

  if (paraRows.length === 0) {
    lines.push('| - | - | - | - | - | - | - | - |');
  } else {
    for (const row of paraRows.slice(0, maxParaRows)) {
      lines.push(`| ${row.id} | ${row.alignment} | ${row.lineSpacing} | ${row.marginLeft} | ${row.marginRight} | ${row.indent} | ${row.heading} | ${row.usage} |`);
    }
  }
  lines.push('');

  const outlineRows = paraRows.filter((row) => row.heading.startsWith('OUTLINE:'));
  if (outlineRows.length > 0) {
    lines.push(`### ${paragraphSectionNo}.1 개요 계층(OUTLINE) 감지`);
    lines.push('');
    lines.push('| level | marginLeft | usage |');
    lines.push('|-------|------------|-------|');
    for (const row of outlineRows) {
      lines.push(`| ${row.heading.split(':')[1] ?? '-'} | ${row.marginLeft} | ${row.usage} |`);
    }
    lines.push('');
  }

  lines.push(`## ${tableSectionNo}. 표/테두리 규칙`);
  lines.push('');
  const borderEntries = Object.entries(borderSummary.borderTypes).sort((lhs, rhs) => rhs[1] - lhs[1]);
  const fillEntries = Object.entries(borderSummary.fillColors).sort((lhs, rhs) => rhs[1] - lhs[1]);
  lines.push(`- borderFill 정의 수: ${normalized.borderFills.length}`);
  lines.push(`- 추정 테두리 타입: ${borderEntries.length > 0 ? borderEntries.map(([k, v]) => `${k}(${v})`).join(', ') : '없음'}`);
  lines.push(`- 추정 배경색: ${fillEntries.length > 0 ? fillEntries.map(([k, v]) => `${k}(${v})`).join(', ') : '없음'}`);
  lines.push('');

  lines.push(`## ${headerFooterSectionNo}. 머리말/꼬리말`);
  lines.push('');
  const header = asObject(normalized.headerFooter.header);
  const footer = asObject(normalized.headerFooter.footer);
  if (Object.keys(header).length === 0 && Object.keys(footer).length === 0) {
    lines.push('- 머리말/꼬리말 정보 없음');
    lines.push('');
  } else {
    if (Object.keys(header).length > 0) {
      lines.push('### 머리말');
      const headerTable = asObject(header.table);
      const firstRow = getFirstTableRow(headerTable);
      if (firstRow.length > 0) {
        lines.push(`- 형태: 표 (${firstRow.length}열)`);
        lines.push(`- 역할 추정: ${inferHeaderFooterRoles(firstRow).join(' | ')}`);
      } else if (typeof header.text === 'string') {
        lines.push('- 형태: 텍스트');
        lines.push(`- 샘플: ${header.text.slice(0, 80)}`);
      } else {
        lines.push('- 구조는 있으나 텍스트/표 해석 정보가 없음');
      }
      lines.push('');
    }

    if (Object.keys(footer).length > 0) {
      lines.push('### 꼬리말');
      const footerTable = asObject(footer.table);
      const firstRow = getFirstTableRow(footerTable);
      if (firstRow.length > 0) {
        lines.push(`- 형태: 표 (${firstRow.length}열)`);
        lines.push(`- 역할 추정: ${inferHeaderFooterRoles(firstRow).join(' | ')}`);
      } else if (typeof footer.text === 'string') {
        lines.push('- 형태: 텍스트');
        lines.push(`- 샘플: ${footer.text.slice(0, 80)}`);
      } else {
        lines.push('- 구조는 있으나 텍스트/표 해석 정보가 없음');
      }
      if (footer.autoPageNum) lines.push('- 자동 페이지 번호: 사용');
      if (footer.autoTotalPages) lines.push('- 자동 총 페이지 번호: 사용');
      lines.push('');
    }
  }

  if (normalized.sections.length > 1) {
    lines.push(`## ${sectionSummarySectionNo}. 섹션별 요약`);
    lines.push('');
    lines.push('| section | paragraph | run | table |');
    lines.push('|---------|-----------|-----|-------|');
    normalized.sections.forEach((section, idx) => {
      lines.push(`| ${section.sectionPath ?? String(idx)} | ${toNumber(section.usage.paragraphCount, 0)} | ${toNumber(section.usage.runCount, 0)} | ${toNumber(section.usage.tableCount, 0)} |`);
    });
    lines.push('');
  }

  if (effectiveStyles.length > 0) {
    lines.push(`## ${styleTitleNo}. 스타일 레지스트리(상위 ${maxStyleRows}개)`);
    lines.push('');
    lines.push('| styleID | name | paraPrIDRef | charPrIDRef | usage |');
    lines.push('|---------|------|-------------|-------------|-------|');
    const styleRows = effectiveStyles
      .map((style) => {
        const styleId = style.id ?? style.styleID ?? style.styleId ?? '-';
        const paraPr = asObject(style.paraPr);
        const charPr = asObject(style.charPr);
        return {
          styleId,
          name: String(style.name ?? '-'),
          paraPrIDRef: String(style.paraPrIDRef ?? paraPr.id ?? '-'),
          charPrIDRef: String(style.charPrIDRef ?? charPr.id ?? '-'),
          usage: mapCount(normalized.usage.styleUsage, styleId),
        };
      })
      .sort((lhs, rhs) => rhs.usage - lhs.usage);

    for (const row of styleRows.slice(0, maxStyleRows)) {
      lines.push(`| ${row.styleId} | ${row.name} | ${row.paraPrIDRef} | ${row.charPrIDRef} | ${row.usage} |`);
    }
    lines.push('');
  }

  lines.push(`## ${templateTitleNo}. hwpx_create_document 호출 골격`);
  lines.push('');
  const template: PlainObject = {
    output_path: '<출력경로>.hwpx',
    title: '<문서 제목>',
    font: primaryFont,
    font_size: baseFontSize,
    content: [
      { paragraph: { heading: 1, text: '<문서 제목>', alignment: 'CENTER' } },
      { paragraph: { text: '<본문 내용>' } },
    ],
  };

  const pageMargins = asObject(normalized.pageLayout.margins);
  if (Object.keys(pageMargins).length > 0) {
    template.margin = {
      top: Math.round(toNumber(pageMargins.top, 0) / HWPUNIT_PER_MM),
      bottom: Math.round(toNumber(pageMargins.bottom, 0) / HWPUNIT_PER_MM),
      left: Math.round(toNumber(pageMargins.left, 0) / HWPUNIT_PER_MM),
      right: Math.round(toNumber(pageMargins.right, 0) / HWPUNIT_PER_MM),
    };
  }

  const headerTable = asObject(header.table);
  const headerRow = getFirstTableRow(headerTable);
  if (headerRow.length > 0) {
    template.header = {
      table: {
        rows: [headerRow.map(() => '<머리말 정보>')],
        columnWidths: headerTable.columnWidths ?? undefined,
      },
    };
  } else if (typeof header.text === 'string' && header.text.length > 0) {
    template.header = '<머리말 텍스트>';
  }

  const footerTable = asObject(footer.table);
  const footerRow = getFirstTableRow(footerTable);
  if (footerRow.length > 0) {
    template.footer = {
      table: {
        rows: [footerRow.map((cell) => (/{{PAGE}}/.test(cell) ? '- {{PAGE}} / {{TOTAL_PAGE}} -' : '<꼬리말 정보>'))],
        columnWidths: footerTable.columnWidths ?? undefined,
      },
    };
  } else if ((typeof footer.text === 'string' && footer.text.length > 0) || footer.autoPageNum || footer.autoTotalPages) {
    template.footer = '- {{PAGE}} / {{TOTAL_PAGE}} -';
  }

  lines.push('```json');
  lines.push(JSON.stringify(template, null, 2));
  lines.push('```');
  lines.push('');

  lines.push(`## ${templateTitleNo + 1}. 주의사항`);
  lines.push('');
  lines.push('1. 내용은 새로 작성하고, 참조 문서의 원문 문장을 복사하지 마시오.');
  lines.push('2. 혼합 서식이 필요하면 `paragraph.runs[]`를 사용하시오.');
  lines.push('3. 페이지 분할은 `{ "pageBreak": true }` 또는 `paragraph.pageBreak: true`를 사용하시오.');
  lines.push('4. 표는 borderFill 요약을 우선 따르고, 필요 시 명시적으로 테두리/배경을 지정하시오.');
  lines.push('5. 다중 섹션 문서라면 섹션별 usage를 참고해 스타일 강도를 조절하시오.');
  lines.push('');

  return [
    '<prompt>',
    ...section('style_guide_markdown', lines),
    '</prompt>',
  ].join('\n');
}
