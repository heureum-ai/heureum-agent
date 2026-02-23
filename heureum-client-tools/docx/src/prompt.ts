/**
 * Reusable prompts/workflows for agents generating DOCX documents.
 */

export interface DocxPromptOptions {
  documentTitle?: string;
  authorityName?: string;
}

const DEFAULT_TITLE = '문서';
const DEFAULT_AUTHORITY = '기관';

function section(tag: string, lines: string | string[]): string[] {
  const content = Array.isArray(lines) ? lines : [lines];
  return [`<section name="${tag}">`, ...content, "</section>"];
}

export function buildDocxWorkflowPrompt(options: DocxPromptOptions = {}): string {
  const title = options.documentTitle ?? DEFAULT_TITLE;
  const authority = options.authorityName ?? DEFAULT_AUTHORITY;

  return [
    '<prompt>',
    ...section('mission', `목표: "${title}" 문서를 ${authority} 기준에 맞춰 서식이 완성된 DOCX로 생성한다.`),
    '',
    ...section('core_principles', [
      '1. 하드코딩 금지: 특정 문서 전용 분기를 만들지 않는다.',
      '2. 구조 우선: 단락/런/표/머리말/꼬리말/이미지를 툴 파라미터로 표현한다.',
      '3. 반복 보정: 1회 생성 후 편집 툴로 레이아웃/서식 차이를 줄인다.',
    ]),
    '',
    ...section('recommended_tool_order', [
      '1. docx_create_document',
      '2. docx_set_page_layout',
      '3. docx_set_header_footer',
      '4. docx_insert_image',
      '5. docx_set_para_format / docx_set_char_format',
      '6. 필요 시: docx_edit_table_cell, docx_insert_text, docx_find_replace',
    ]),
    '',
    ...section('authoring_rules', [
      '- 한 단락 내 혼합 서식은 paragraph.runs[]를 사용한다.',
      '- 내어쓰기는 음수 indent로 표현한다.',
      '- 표에는 columnWidths를 명시한다.',
      '- 페이지 번호/반복 문구는 header/footer를 사용한다.',
    ]),
    '',
    ...section('quality_gate', [
      '- 기준 문서와 문단/표/이미지 수를 비교한다.',
      '- 핵심 텍스트 존재 여부를 확인한다.',
      '- 실패 시 원인을 텍스트/서식/레이아웃으로 분리해 재시도한다.',
    ]),
    '',
    ...section('output', [
      '- 최종 산출물 경로',
      '- 툴 호출 순서 요약',
      '- 남은 차이(있다면)와 다음 보정 액션',
    ]),
    '</prompt>',
  ].join('\n');
}

export const DOCX_WORKFLOW_PROMPT: string = buildDocxWorkflowPrompt();

export function buildDocxSkillPrompt(options: DocxPromptOptions = {}): string {
  const title = options.documentTitle ?? DEFAULT_TITLE;
  const authority = options.authorityName ?? DEFAULT_AUTHORITY;

  return [
    '<prompt>',
    ...section('role', `당신은 ${authority}의 DOCX 문서 생성을 담당하는 에이전트다.`),
    '',
    ...section('mission', [
      `기준 문서 "${title}"를 DOCX 툴만으로 재현한다.`,
      '하드코딩 분기 없이 파라미터 기반 구현만 사용한다.',
    ]),
    '',
    ...section('must', [
      '- 혼합 서식은 paragraph.runs[]로 표현한다.',
      '- 내어쓰기는 음수 indent로 표현한다.',
      '- header/footer 내용을 명시한다.',
      '- 생성 후 문단/표/이미지 개수를 검증한다.',
    ]),
    '',
    ...section('workflow', [
      '1. docx_create_document로 본문/표/기본 header/footer를 생성한다.',
      '2. docx_set_page_layout로 페이지/여백 정렬을 맞춘다.',
      '3. docx_set_header_footer로 header/footer를 고도 보정한다.',
      '4. docx_insert_image로 누락 이미지를 보완한다.',
      '5. docx_set_para_format/docx_set_char_format으로 세부 서식을 조정한다.',
      '6. 검증 실패 시 원인을 분리해 재시도한다.',
    ]),
    '',
    ...section('output_contract', [
      '- final_path: 최종 파일 경로',
      '- tool_sequence: 실행한 툴 순서 배열',
      '- verification: {paragraphs, tables, images, key_text_checks}',
      '- remaining_gaps: 남은 차이 목록(없으면 빈 배열)',
      '- next_actions: 다음 보정 제안(필요 시)',
    ]),
    '</prompt>',
  ].join('\n');
}

export const DOCX_SKILL_PROMPT: string = buildDocxSkillPrompt();
