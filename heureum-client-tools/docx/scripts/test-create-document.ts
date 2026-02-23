/**
 * 구조화 API(createDocument)로 복잡한 문서를 생성하고 검증하는 스크립트.
 *
 * Usage:  npx tsx scripts/test-create-document.ts
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import JSZip from 'jszip';
import { createDocument, type DocxCreateDocumentParams } from '../src/create-document.js';
import { DocxPipeline } from '../src/pipeline.js';

async function main() {
  console.log('╔══════════════════════════════════════════════╗');
  console.log('║  구조화 API (createDocument) 복잡 문서 검증   ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  const params: DocxCreateDocumentParams = {
    output_path: path.join(os.tmpdir(), 'docx-test-structured.docx'),
    title: '2024년 AI 기술 동향 보고서',
    page_size: 'a4',
    font: 'Malgun Gothic',
    font_size: 11,
    margin: { top: 25, bottom: 20, left: 20, right: 20 },
    header: '2024 AI 기술 동향 보고서 — Confidential',
    footer: '© 2024 Heureum Inc. All rights reserved.',
    content: [
      // ── 표지 ──
      { paragraph: { text: '', lineSpacing: 300 } },
      { paragraph: { text: '2024년', fontSize: 18, alignment: 'CENTER', color: '#666666' } },
      { paragraph: { text: 'AI 기술 동향 보고서', heading: 1, alignment: 'CENTER', fontSize: 28 } },
      { paragraph: { text: '', lineSpacing: 200 } },
      {
        paragraph: {
          runs: [
            { text: '작성자: ', color: '#888888', fontSize: 12 },
            { text: 'AI Research Team', bold: true, fontSize: 12 },
          ],
          alignment: 'CENTER',
        },
      },
      {
        paragraph: {
          runs: [
            { text: '작성일: ', color: '#888888', fontSize: 12 },
            { text: '2024-03-15', fontSize: 12 },
          ],
          alignment: 'CENTER',
        },
      },
      { paragraph: { text: '', lineSpacing: 200 } },
      {
        table: {
          rows: [
            ['문서 번호', 'RPT-2024-AI-001'],
            ['보안 등급', 'Confidential'],
            ['배포 대상', '경영진, R&D 부서'],
            ['버전', 'v2.1'],
          ],
          columnWidths: [50, 100],
          headerRow: false,
        },
      },

      // ── 페이지 브레이크 후 목차 ──
      { pageBreak: true },
      { paragraph: { text: '목 차', heading: 1, alignment: 'CENTER' } },
      { paragraph: { text: '' } },
      { paragraph: { text: '1. 개요 ............................................. 3', marginLeft: 10 } },
      { paragraph: { text: '2. 주요 기술 동향 .................................... 4', marginLeft: 10 } },
      { paragraph: { text: '  2.1 대규모 언어 모델 (LLM) ......................... 4', marginLeft: 15 } },
      { paragraph: { text: '  2.2 멀티모달 AI .................................... 5', marginLeft: 15 } },
      { paragraph: { text: '  2.3 AI 에이전트 .................................... 6', marginLeft: 15 } },
      { paragraph: { text: '3. 산업별 적용 현황 .................................. 7', marginLeft: 10 } },
      { paragraph: { text: '4. 결론 및 제언 ...................................... 9', marginLeft: 10 } },

      // ── 1장: 개요 ──
      { pageBreak: true },
      { paragraph: { text: '1. 개요', heading: 1 } },
      { paragraph: { text: '' } },
      {
        paragraph: {
          runs: [
            { text: '2024년은 AI 기술의 ' },
            { text: '상용화와 고도화', bold: true },
            { text: '가 동시에 진행된 해로 평가됩니다. 특히 ' },
            { text: 'GPT-4, Claude 3, Gemini', italic: true },
            { text: ' 등 대규모 언어 모델의 성능이 비약적으로 향상되면서, 기업 환경에서의 AI 도입이 가속화되었습니다.' },
          ],
        },
      },
      { paragraph: { text: '' } },
      {
        paragraph: {
          text: '본 보고서는 2024년 AI 기술의 주요 발전 사항을 정리하고, 향후 전략적 방향을 제시합니다.',
        },
      },
      { paragraph: { text: '' } },
      { paragraph: { text: '보고서의 핵심 논점:', bold: true } },
      { paragraph: { text: 'LLM의 성능 향상과 비용 절감이 동시 달성', bullet: true } },
      { paragraph: { text: '멀티모달 AI가 텍스트를 넘어 이미지·영상·음성 통합 처리', bullet: true } },
      { paragraph: { text: 'AI 에이전트의 등장으로 자율적 작업 수행 가능', bullet: true } },
      { paragraph: { text: '규제 및 윤리 프레임워크의 본격 도입', bullet: true } },

      // ── 2장: 주요 기술 동향 ──
      { pageBreak: true },
      { paragraph: { text: '2. 주요 기술 동향', heading: 1 } },

      { paragraph: { text: '2.1 대규모 언어 모델 (LLM)', heading: 2 } },
      { paragraph: { text: '' } },
      {
        paragraph: {
          text: 'LLM 분야에서는 모델 크기와 성능 간의 최적 균형점을 찾는 연구가 활발했습니다. ' +
            '특히 "Mixture of Experts (MoE)" 아키텍처의 채택으로, 적은 연산량으로 높은 성능을 달성하는 모델이 등장했습니다.',
        },
      },
      { paragraph: { text: '' } },
      {
        table: {
          rows: [
            ['모델', '파라미터', '벤치마크(MMLU)', '출시일', '개발사'],
            ['GPT-4 Turbo', '~1.8T (추정)', '86.4%', '2024-01', 'OpenAI'],
            ['Claude 3 Opus', '비공개', '86.8%', '2024-03', 'Anthropic'],
            ['Gemini Ultra', '비공개', '83.7%', '2024-02', 'Google'],
            ['Llama 3 70B', '70B', '79.5%', '2024-04', 'Meta'],
            ['Mistral Large', '비공개', '81.2%', '2024-02', 'Mistral AI'],
          ],
          headerRow: true,
          headerBackground: '#2E5090',
          columnWidths: [35, 30, 30, 25, 30],
        },
      },
      { paragraph: { text: '' } },

      { paragraph: { text: '주요 관찰사항:', bold: true, italic: true } },
      { paragraph: { text: '오픈소스 모델의 급격한 성능 향상 (Llama 3, Mistral 등)', numbered: true } },
      { paragraph: { text: '추론 비용의 지속적 감소 (GPT-4 대비 3배 저렴)', numbered: true } },
      { paragraph: { text: '도메인 특화 미세조정의 효과 검증', numbered: true } },
      { paragraph: { text: 'RAG(검색 증강 생성) 기법의 표준화', numbered: true } },

      { paragraph: { text: '' } },
      { paragraph: { text: '2.2 멀티모달 AI', heading: 2 } },
      { paragraph: { text: '' } },
      {
        paragraph: {
          runs: [
            { text: '멀티모달 AI는 ' },
            { text: '텍스트, 이미지, 음성, 영상', underline: true },
            { text: '을 통합적으로 처리하는 기술로, 2024년에 실질적 활용 단계에 진입했습니다. ' },
            { text: 'GPT-4V', bold: true },
            { text: '와 ' },
            { text: 'Gemini Pro Vision', bold: true },
            { text: '의 출시가 핵심 전환점이 되었습니다.' },
          ],
        },
      },
      { paragraph: { text: '' } },
      {
        table: {
          rows: [
            ['활용 분야', '기술', '성숙도', '도입 사례'],
            ['문서 분석', '시각적 이해 + OCR', '높음', '계약서 자동 검토'],
            ['이미지 생성', 'Diffusion 모델', '높음', '마케팅 콘텐츠'],
            ['영상 생성', 'Sora, Runway', '초기', '프로토타이핑'],
            ['음성 합성', 'TTS + 감정 모델', '중간', '고객 서비스'],
          ],
          headerRow: true,
          headerBackground: '#4A7C59',
          columnWidths: [30, 40, 20, 60],
        },
      },

      { paragraph: { text: '' } },
      { paragraph: { text: '2.3 AI 에이전트', heading: 2 } },
      { paragraph: { text: '' } },
      {
        paragraph: {
          text: 'AI 에이전트는 사용자의 지시를 받아 자율적으로 계획을 수립하고 실행하는 시스템입니다. ' +
            '2024년에는 도구 사용(Tool Use) 능력의 발전으로, 에이전트가 API 호출, 파일 조작, 웹 검색 등을 ' +
            '독립적으로 수행할 수 있게 되었습니다.',
        },
      },
      { paragraph: { text: '' } },
      {
        paragraph: {
          runs: [
            { text: '에이전트 아키텍처 핵심 요소:', bold: true, lineBreak: true },
            { text: '① 계획 수립 (Planning)', lineBreak: true },
            { text: '② 도구 사용 (Tool Use)', lineBreak: true },
            { text: '③ 메모리 관리 (Memory)', lineBreak: true },
            { text: '④ 자기 반성 (Self-Reflection)' },
          ],
        },
      },

      // ── 3장: 산업별 적용 ──
      { pageBreak: true },
      { paragraph: { text: '3. 산업별 적용 현황', heading: 1 } },
      { paragraph: { text: '' } },
      {
        table: {
          rows: [
            ['산업', 'AI 적용 분야', '투자 규모', 'ROI 기대치', '대표 기업'],
            ['금융', '리스크 분석, 사기 탐지', '$15.2B', '300%+', 'JP Morgan, Goldman'],
            ['의료', '진단 보조, 신약 개발', '$12.8B', '200%+', 'Google Health, IBM'],
            ['제조', '예지 정비, 품질 검사', '$8.4B', '150%+', 'Siemens, GE'],
            ['리테일', '수요 예측, 개인화', '$7.1B', '180%+', 'Amazon, Walmart'],
            ['법률', '계약 분석, 판례 검색', '$3.2B', '250%+', 'Harvey AI, CaseText'],
          ],
          headerRow: true,
          headerBackground: '#8B4513',
          columnWidths: [20, 40, 25, 25, 40],
        },
      },

      // ── 4장: 결론 ──
      { pageBreak: true },
      { paragraph: { text: '4. 결론 및 제언', heading: 1 } },
      { paragraph: { text: '' } },
      {
        paragraph: {
          text: '2024년 AI 기술은 실험실 단계를 넘어 비즈니스 현장에 본격적으로 정착하는 전환점을 맞이했습니다. ' +
            '다음 세 가지 전략적 방향을 제언합니다:',
        },
      },
      { paragraph: { text: '' } },
      {
        paragraph: {
          runs: [
            { text: '1. AI 내재화 전략 수립', bold: true, fontSize: 13, lineBreak: true },
            { text: '단순 도입을 넘어 핵심 비즈니스 프로세스에 AI를 내재화하는 전략이 필요합니다. ' +
              '이를 위해 내부 데이터 파이프라인 구축과 인력 양성에 투자해야 합니다.' },
          ],
        },
      },
      { paragraph: { text: '' } },
      {
        paragraph: {
          runs: [
            { text: '2. 책임 있는 AI 거버넌스 확립', bold: true, fontSize: 13, lineBreak: true },
            { text: 'EU AI Act 등 규제 환경 변화에 선제적으로 대응하기 위해, ' +
              'AI 윤리 위원회 구성과 모델 감사 체계를 마련해야 합니다.' },
          ],
        },
      },
      { paragraph: { text: '' } },
      {
        paragraph: {
          runs: [
            { text: '3. 에이전트 기반 업무 자동화 추진', bold: true, fontSize: 13, lineBreak: true },
            { text: 'AI 에이전트 기술의 성숙도가 높아짐에 따라, 반복적이고 규칙 기반의 업무를 ' +
              '에이전트에 위임하는 방안을 적극 검토해야 합니다.' },
          ],
        },
      },

      // ── 면책조항 ──
      { paragraph: { text: '' } },
      { paragraph: { text: '' } },
      {
        paragraph: {
          text: '본 보고서의 내용은 공개된 정보를 바탕으로 작성되었으며, ' +
            '투자 조언이나 특정 제품의 추천을 목적으로 하지 않습니다.',
          fontSize: 9,
          color: '#999999',
          italic: true,
          alignment: 'CENTER',
        },
      },
    ],
  };

  // ── 생성 ──
  console.log('1. 구조화 문서 생성...');
  const buffer = await createDocument(params);
  const outPath = path.resolve(params.output_path);
  fs.writeFileSync(outPath, buffer);
  console.log(`   ✓ ${outPath} (${(buffer.length / 1024).toFixed(1)} KB)`);

  // ── ZIP 검증 ──
  console.log('\n2. ZIP 구조 검증...');
  const zip = await JSZip.loadAsync(buffer);
  const files = Object.keys(zip.files);
  console.log(`   파일 수: ${files.length}`);
  for (const f of files) {
    const size = zip.files[f].dir ? 'DIR' : `${((await zip.files[f].async('uint8array')).length / 1024).toFixed(1)} KB`;
    console.log(`   ${f} — ${size}`);
  }

  // ── document.xml 검증 ──
  console.log('\n3. document.xml 내용 검증...');
  const docXml = await zip.file('word/document.xml')!.async('string');

  const checks = [
    ['제목: AI 기술 동향 보고서', 'AI'],
    ['Heading1', 'Heading1'],
    ['Heading2', 'Heading2'],
    ['굵은 텍스트', '<w:b/>'],
    ['기울임 텍스트', '<w:i/>'],
    ['밑줄', 'w:u w:val="single"'],
    ['색상', 'w:color'],
    ['폰트 크기', 'w:sz'],
    ['테이블', '<w:tbl>'],
    ['테이블 헤더', '<w:tblHeader/>'],
    ['배경색', 'w:shd'],
    ['불릿 리스트', 'w:numId w:val="1"'],
    ['순서 리스트', 'w:numId w:val="2"'],
    ['페이지 브레이크', 'w:type="page"'],
    ['정렬: center', 'w:val="center"'],
    ['한국어: 개요', '개요'],
    ['한국어: 결론', '결론'],
    ['GPT-4', 'GPT-4'],
    ['Claude', 'Claude'],
    ['AI 에이전트', '에이전트'],
  ];

  let pass = 0;
  for (const [label, keyword] of checks) {
    if (docXml.includes(keyword)) {
      pass++;
      console.log(`   ✓ ${label}`);
    } else {
      console.error(`   ✗ ${label} ("${keyword}" 미발견)`);
    }
  }
  console.log(`\n   결과: ${pass}/${checks.length} 통과`);

  // ── 헤더/푸터 검증 ──
  console.log('\n4. 헤더/푸터 검증...');
  const headerXml = await zip.file('word/header1.xml')?.async('string');
  const footerXml = await zip.file('word/footer1.xml')?.async('string');
  if (headerXml?.includes('Confidential')) console.log('   ✓ 헤더: "Confidential" 포함');
  else console.error('   ✗ 헤더 내용 확인 실패');
  if (footerXml?.includes('Heureum')) console.log('   ✓ 푸터: "Heureum" 포함');
  else console.error('   ✗ 푸터 내용 확인 실패');

  // ── 역변환 테스트 ──
  console.log('\n5. 역변환 (DOCX → Markdown)...');
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docx-structured-'));
  const pipeline = new DocxPipeline({
    sessionId: 'structured-test',
    taskType: 'docx',
    taskId: 'reverse',
    workDir,
  });

  const md = await pipeline.toMarkdown(outPath);
  console.log(`   Markdown 길이: ${md.length} chars`);

  const mdKeywords = [
    'AI 기술 동향 보고서',
    '대규모 언어 모델',
    'GPT-4 Turbo',
    'Claude 3 Opus',
    '멀티모달',
    '에이전트',
    '금융',
    '의료',
    '결론 및 제언',
    'AI 내재화',
  ];

  let mdPass = 0;
  for (const kw of mdKeywords) {
    if (md.includes(kw)) {
      mdPass++;
      console.log(`   ✓ MD 보존: "${kw}"`);
    } else {
      console.error(`   ✗ MD 누락: "${kw}"`);
    }
  }
  console.log(`\n   역변환 보존율: ${mdPass}/${mdKeywords.length} (${((mdPass / mdKeywords.length) * 100).toFixed(0)}%)`);

  // ── 요약 ──
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║  최종 요약                                   ║');
  console.log('╚══════════════════════════════════════════════╝');
  console.log(`  출력 파일: ${outPath}`);
  console.log(`  XML 검증: ${pass}/${checks.length}`);
  console.log(`  MD 역변환: ${mdPass}/${mdKeywords.length}`);
  console.log(`  상태: ${pass >= checks.length * 0.9 && mdPass >= mdKeywords.length * 0.8 ? '✅ PASS' : '❌ FAIL'}`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
