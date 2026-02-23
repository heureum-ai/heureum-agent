/**
 * 복잡한 문서의 Markdown → DOCX → Markdown 라운드트립 검증 스크립트.
 *
 * Usage:  npx tsx scripts/test-roundtrip.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import JSZip from 'jszip';
import { DocxPipeline } from '../src/pipeline.js';
import { createDocx } from '../src/writer.js';

// ── 복잡한 테스트 마크다운 ──────────────────────────────

const COMPLEX_MARKDOWN = `# 프로젝트 기획서: AI 기반 문서 자동화 시스템

## 1. 개요

본 문서는 **AI 기반 문서 자동화 시스템**의 기획 내용을 담고 있습니다.
이 시스템은 *다양한 형식*의 문서를 자동으로 생성, 변환, 편집하는 것을 목표로 합니다.

핵심 기술 스택은 다음과 같습니다:
- **TypeScript** — 주 개발 언어
- **JSZip** — OOXML 압축 처리
- **remark** — Markdown AST 변환
- *fast-xml-parser* — XML 역파싱

## 2. 시스템 아키텍처

### 2.1 파이프라인 구조

문서 처리 파이프라인은 4단계로 구성됩니다:

1. **소스 입력** — Markdown 또는 구조화 데이터 수신
2. **AST 변환** — remark를 통한 중간 표현 생성
3. **XML 생성** — OOXML 규격에 맞는 XML 파일 생성
4. **ZIP 패키징** — 최종 .docx 아카이브 생성

### 2.2 지원 문서 형식

| 형식 | 입력 | 출력 | 상태 |
|------|------|------|------|
| DOCX | ✅ | ✅ | 완료 |
| HWPX | ✅ | ✅ | 완료 |
| PDF | ❌ | ✅ | 진행중 |
| XLSX | ❌ | ✅ | 계획 |

### 2.3 변환 성능 기준

| 항목 | 목표 | 현재 |
|------|------|------|
| Markdown → DOCX | < 500ms | 320ms |
| DOCX → Markdown | < 1000ms | 780ms |
| 스타일 추출 | < 2000ms | 1500ms |
| 라운드트립 보존율 | > 95% | 92% |

## 3. 주요 기능

### 3.1 마크다운 변환

마크다운의 모든 주요 요소를 지원합니다:

#### 인라인 서식
- **굵은 텍스트**와 *기울임 텍스트*
- ***굵은 기울임*** 조합
- \`인라인 코드\` 표현

#### 블록 요소

> 인용문은 왼쪽 테두리와 기울임 스타일로 렌더링됩니다.
> 여러 줄의 인용문도 지원합니다.

코드 블록 예시:

\`\`\`typescript
interface DocumentOptions {
  pageSize: 'a4' | 'letter' | 'b5';
  margins: {
    top: number;
    bottom: number;
    left: number;
    right: number;
  };
  defaultFont: string;
  fontSize: number;
}

async function createDocument(
  content: ContentBlock[],
  options: DocumentOptions,
): Promise<Uint8Array> {
  const pipeline = new DocxPipeline(options);
  return pipeline.generate(content);
}
\`\`\`

#### 중첩 리스트

- 1단계 항목 A
  - 2단계 항목 A-1
  - 2단계 항목 A-2
- 1단계 항목 B
  - 2단계 항목 B-1

1. 첫 번째 순서
   1. 하위 순서 1-1
   2. 하위 순서 1-2
2. 두 번째 순서
3. 세 번째 순서

---

### 3.2 구조화 문서 생성

구조화 API를 통해 세밀한 서식 제어가 가능합니다:

- 문단별 폰트, 크기, 색상 지정
- 표 셀 단위 배경색, 테두리 스타일
- 이미지 삽입 (크기, 위치 제어)
- 머리말/꼬리말 (텍스트, 표, 자동 페이지 번호)

## 4. 품질 관리

### 4.1 테스트 전략

단위 테스트와 통합 테스트를 병행합니다:

| 테스트 유형 | 도구 | 커버리지 목표 |
|-------------|------|---------------|
| 단위 테스트 | vitest | > 90% |
| 통합 테스트 | vitest | > 80% |
| E2E 테스트 | 수동 검증 | 주요 시나리오 |

### 4.2 검증 항목

1. **ZIP 구조 검증** — 필수 파일 존재 확인
2. **Content_Types 일관성** — MIME 타입 매칭
3. **라운드트립 검증** — Markdown → DOCX → Markdown 내용 보존
4. **스타일 보존** — 서식 정보 유지 확인
5. **호환성 테스트** — Word/LibreOffice에서 정상 열기

## 5. 로드맵

### Phase 1: 기반 구축 (완료)
- 프로젝트 구조 설정
- 핵심 모듈 구현

### Phase 2: 고급 기능 (진행중)
- 변경 추적 수락
- 문서 병합
- 이미지 처리 고도화

### Phase 3: 최적화
- 성능 튜닝
- 메모리 사용 최적화
- 대용량 문서 지원

---

*본 문서는 heureum 문서 자동화 시스템에 의해 생성되었습니다.*
`;

// ── 검증 유틸 ───────────────────────────────────────────

function assertContains(text: string, keyword: string, label: string) {
  if (!text.includes(keyword)) {
    console.error(`  ✗ [${label}] "${keyword}" 미발견`);
    return false;
  }
  console.log(`  ✓ [${label}] "${keyword}" 발견`);
  return true;
}

// ── 1. Markdown → DOCX 직접 생성 테스트 ────────────────

async function testDirectWrite() {
  console.log('\n═══ 1. Markdown → DOCX (createDocx) ═══\n');

  const buffer = await createDocx(COMPLEX_MARKDOWN);
  const outPath = path.join(os.tmpdir(), 'docx-test-complex-direct.docx');
  fs.writeFileSync(outPath, buffer);
  console.log(`  파일 생성: ${outPath} (${(buffer.length / 1024).toFixed(1)} KB)`);

  // ZIP 구조 검증
  const zip = await JSZip.loadAsync(buffer);
  const files = Object.keys(zip.files);
  const requiredFiles = [
    '[Content_Types].xml',
    '_rels/.rels',
    'word/document.xml',
    'word/styles.xml',
    'word/settings.xml',
    'word/numbering.xml',
    'word/fontTable.xml',
    'word/_rels/document.xml.rels',
    'docProps/core.xml',
    'docProps/app.xml',
  ];

  let allPresent = true;
  for (const f of requiredFiles) {
    if (!files.includes(f)) {
      console.error(`  ✗ 필수 파일 누락: ${f}`);
      allPresent = false;
    }
  }
  if (allPresent) console.log(`  ✓ ZIP 구조: 필수 파일 ${requiredFiles.length}개 모두 존재`);

  // document.xml 내용 검증
  const docXml = await zip.file('word/document.xml')!.async('string');

  const checks = [
    ['제목', 'Heading1'],
    ['소제목', 'Heading2'],
    ['3단 제목', 'Heading3'],
    ['4단 제목', 'Heading4'],
    ['굵은 텍스트', '<w:b/>'],
    ['기울임 텍스트', '<w:i/>'],
    ['불릿 리스트', '<w:numId w:val="1"/>'],
    ['순서 리스트', '<w:numId w:val="2"/>'],
    ['코드 블록', 'CodeBlock'],
    ['인용문', 'Quote'],
    ['테이블', '<w:tbl>'],
    ['가로선', 'w:bottom'],
    ['본문 텍스트: AI', 'AI'],
    ['본문 텍스트: TypeScript', 'TypeScript'],
    ['본문 텍스트: 로드맵', 'Phase 1'],
    ['한국어: 프로젝트', '프로젝트'],
    ['한국어: 기획서', '기획서'],
  ];

  let pass = 0;
  for (const [label, keyword] of checks) {
    if (assertContains(docXml, keyword, label)) pass++;
  }
  console.log(`\n  결과: ${pass}/${checks.length} 통과`);

  // Content_Types 검증
  const ctXml = await zip.file('[Content_Types].xml')!.async('string');
  assertContains(ctXml, 'wordprocessingml.document.main', 'Content_Types: document');
  assertContains(ctXml, 'wordprocessingml.styles', 'Content_Types: styles');
  assertContains(ctXml, 'wordprocessingml.numbering', 'Content_Types: numbering');

  return outPath;
}

// ── 2. Pipeline 단계별 Forward 테스트 ───────────────────

async function testPipelineForward() {
  console.log('\n═══ 2. Pipeline Forward (step-by-step) ═══\n');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-pipeline-'));
  const pipeline = new DocxPipeline({
    sessionId: 'complex-test',
    taskType: 'docx',
    taskId: 'forward',
    workDir,
  });

  // Step 1-2: writeMarkdown
  console.log('  Step 1-2: writeMarkdown...');
  const ast = await pipeline.writeMarkdown(COMPLEX_MARKDOWN);
  console.log(`  ✓ AST 생성 완료: ${ast.children.length}개 top-level 노드`);

  // AST 노드 타입 분포
  const typeCounts: Record<string, number> = {};
  for (const child of ast.children) {
    typeCounts[child.type] = (typeCounts[child.type] || 0) + 1;
  }
  console.log(`  AST 노드 분포: ${JSON.stringify(typeCounts)}`);

  // Step 3: writeXml
  console.log('\n  Step 3: writeXml...');
  const xmlMap = await pipeline.writeXml(ast);
  console.log(`  ✓ XML 생성 완료`);
  console.log(`  document.xml 크기: ${(xmlMap.document.length / 1024).toFixed(1)} KB`);
  console.log(`  styles.xml 크기: ${(xmlMap.styles.length / 1024).toFixed(1)} KB`);

  // Step 4: pack
  console.log('\n  Step 4: pack...');
  const outputPath = await pipeline.pack();
  const stats = fs.statSync(outputPath);
  console.log(`  ✓ DOCX 패키징 완료: ${outputPath}`);
  console.log(`  파일 크기: ${(stats.size / 1024).toFixed(1)} KB`);

  return outputPath;
}

// ── 3. Pipeline Reverse + 라운드트립 검증 ────────────────

async function testPipelineReverse(docxPath: string) {
  console.log('\n═══ 3. Pipeline Reverse (DOCX → Markdown) ═══\n');

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-pipeline-'));
  const pipeline = new DocxPipeline({
    sessionId: 'complex-test',
    taskType: 'docx',
    taskId: 'reverse',
    workDir,
  });

  // Unpack
  console.log('  unpack...');
  await pipeline.unpack(docxPath);
  console.log('  ✓ DOCX 언팩 완료');

  // readXml
  console.log('  readXml...');
  const ast = await pipeline.readXml();
  console.log(`  ✓ AST 역변환 완료: ${ast.children.length}개 top-level 노드`);

  const typeCounts: Record<string, number> = {};
  for (const child of ast.children) {
    typeCounts[child.type] = (typeCounts[child.type] || 0) + 1;
  }
  console.log(`  역변환 AST 노드 분포: ${JSON.stringify(typeCounts)}`);

  // readMarkdown
  console.log('\n  readMarkdown...');
  const markdown = await pipeline.readMarkdown(ast);
  console.log(`  ✓ Markdown 변환 완료: ${markdown.length} chars`);

  // 라운드트립 내용 보존 검증
  console.log('\n  라운드트립 내용 보존 검증:');
  const keywords = [
    '프로젝트 기획서',
    'AI 기반 문서 자동화 시스템',
    '시스템 아키텍처',
    '파이프라인 구조',
    'TypeScript',
    'JSZip',
    'remark',
    'DOCX',
    'HWPX',
    '인라인 서식',
    'interface DocumentOptions',
    'async function createDocument',
    '품질 관리',
    '테스트 전략',
    '로드맵',
    'Phase 1',
    'Phase 2',
    'Phase 3',
    'heureum',
  ];

  let preserved = 0;
  for (const kw of keywords) {
    if (markdown.includes(kw)) {
      preserved++;
      console.log(`  ✓ 보존됨: "${kw}"`);
    } else {
      console.error(`  ✗ 누락됨: "${kw}"`);
    }
  }

  const rate = ((preserved / keywords.length) * 100).toFixed(1);
  console.log(`\n  라운드트립 보존율: ${preserved}/${keywords.length} (${rate}%)`);

  // Markdown 내용 미리보기
  console.log('\n  ── 역변환 Markdown (처음 80줄) ──');
  const lines = markdown.split('\n');
  for (let i = 0; i < Math.min(80, lines.length); i++) {
    console.log(`  ${String(i + 1).padStart(3)}│ ${lines[i]}`);
  }
  if (lines.length > 80) {
    console.log(`  ... (${lines.length - 80}줄 추가)`);
  }

  return { markdown, preservedRate: Number(rate) };
}

// ── 4. 2차 라운드트립 (MD→DOCX→MD→DOCX→MD) ─────────────

async function testDoubleRoundtrip(firstMarkdown: string) {
  console.log('\n═══ 4. 2차 라운드트립 (MD→DOCX→MD 2회) ═══\n');

  // 1차 역변환 MD → DOCX
  const buffer2 = await createDocx(firstMarkdown);
  console.log(`  2차 DOCX 생성: ${(buffer2.length / 1024).toFixed(1)} KB`);

  // 2차 DOCX → MD
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-pipeline-'));
  const pipeline = new DocxPipeline({
    sessionId: 'double',
    taskType: 'docx',
    taskId: 'rt2',
    workDir,
  });

  const tmpPath = path.join(os.tmpdir(), 'docx-double-rt.docx');
  fs.writeFileSync(tmpPath, buffer2);
  const md2 = await pipeline.toMarkdown(tmpPath);

  // 1차 vs 2차 비교
  const keywords = [
    '프로젝트 기획서',
    'AI',
    'TypeScript',
    'DOCX',
    '파이프라인',
    'interface DocumentOptions',
    '품질 관리',
    'Phase 1',
    'heureum',
  ];

  let stable = 0;
  for (const kw of keywords) {
    const in1 = firstMarkdown.includes(kw);
    const in2 = md2.includes(kw);
    if (in1 && in2) {
      stable++;
      console.log(`  ✓ 안정: "${kw}"`);
    } else if (in1 && !in2) {
      console.error(`  ✗ 2차에서 손실: "${kw}"`);
    } else {
      console.log(`  ~ 1차에서 이미 손실: "${kw}"`);
    }
  }
  console.log(`\n  2차 라운드트립 안정도: ${stable}/${keywords.length}`);
}

// ── Main ────────────────────────────────────────────────

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  DOCX 라운드트립 통합 검증 스크립트          ║');
  console.log('╚══════════════════════════════════════════════╝');

  const directPath = await testDirectWrite();
  const pipelinePath = await testPipelineForward();
  const { markdown, preservedRate } = await testPipelineReverse(pipelinePath);
  await testDoubleRoundtrip(markdown);

  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  최종 요약                                   ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`  직접 생성 DOCX: ${directPath}`);
  console.log(`  파이프라인 DOCX: ${pipelinePath}`);
  console.log(`  라운드트립 보존율: ${preservedRate}%`);
  console.log(`  상태: ${preservedRate >= 80 ? '✅ PASS' : '❌ FAIL'}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
