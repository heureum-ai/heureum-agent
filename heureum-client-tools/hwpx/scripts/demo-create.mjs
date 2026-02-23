/**
 * Demo: hwpx_create_document 를 사용한 샘플 행정문서 생성.
 *
 * prompt.ts 의 권장 툴 순서:
 *   1. hwpx_create_document  → 본문/표/머리말·꼬리말 생성
 *   2. hwpx_set_page_layout  → 페이지/여백 조정 (필요 시)
 *   3. (이후 보정 단계)
 *
 * Usage:
 *   node scripts/demo-create.mjs [output_path]
 */

import fs from 'node:fs';
import path from 'node:path';

async function main() {
  // Dynamic import to avoid ESM named-export static analysis issues with tsup bundle
  const mod = await import('../dist/index.js');
  const { createDocument } = mod;

  const outputPath = path.resolve(
    process.argv[2] || './output/demo-document.hwpx',
  );

  const params = {
    output_path: outputPath,
    title: '업무 처리 규정 (제2026-001호)',
    page_size: 'a4',
    font: '맑은 고딕',
    font_size: 10,
    margin: { top: 20, bottom: 15, left: 15, right: 15 },

    // ── 머리말 · 꼬리말 ──
    header: {
      table: {
        rows: [['업무 처리 규정', '관리번호: DOC-2026-001']],
        columnWidths: [35000, 15000],
      },
    },
    footer: {
      text: '- {{PAGE}} / {{TOTAL_PAGE}} -',
      auto_page_num: true,
      auto_total_pages: true,
    },

    // ── 본문 콘텐츠 ──
    content: [
      // ===== 표지 =====
      {
        paragraph: {
          text: '',
          spacing: { before: 4000 },
        },
      },
      {
        paragraph: {
          heading: 1,
          text: '업무 처리 규정',
          alignment: 'CENTER',
        },
      },
      {
        paragraph: {
          text: '(제2026-001호)',
          alignment: 'CENTER',
          fontSize: 14,
          color: '#555555',
          spacing: { after: 1200 },
        },
      },
      {
        paragraph: {
          runs: [
            { text: '시행일: ', bold: true },
            { text: '2026년 3월 1일' },
          ],
          alignment: 'CENTER',
        },
      },
      {
        paragraph: {
          runs: [
            { text: '작성부서: ', bold: true },
            { text: '총무과 행정지원팀' },
          ],
          alignment: 'CENTER',
          spacing: { after: 2000 },
        },
      },

      // ===== 페이지 브레이크 =====
      { pageBreak: true },

      // ===== 제1장 총칙 =====
      {
        paragraph: {
          heading: 2,
          text: '제1장 총칙',
        },
      },
      {
        paragraph: {
          runs: [
            { text: '제1조(목적) ', bold: true },
            {
              text: '이 규정은 ○○기관의 업무 처리 절차 및 기준에 관한 사항을 정함으로써 ' +
                '행정 업무의 효율적 수행과 투명한 운영을 도모함을 목적으로 한다.',
            },
          ],
          indent: -800,
          marginLeft: 800,
          spacing: { after: 200 },
        },
      },
      {
        paragraph: {
          runs: [
            { text: '제2조(적용범위) ', bold: true },
            {
              text: '이 규정은 ○○기관 소속 전 부서 및 직원에게 적용한다. ' +
                '다만, 별도의 규정이 있는 경우에는 그에 따른다.',
            },
          ],
          indent: -800,
          marginLeft: 800,
          spacing: { after: 200 },
        },
      },
      {
        paragraph: {
          runs: [
            { text: '제3조(정의) ', bold: true },
            { text: '이 규정에서 사용하는 용어의 뜻은 다음과 같다.' },
          ],
          indent: -800,
          marginLeft: 800,
          spacing: { after: 100 },
        },
      },
      {
        paragraph: {
          text: '1. "업무"란 기관의 설립 목적을 달성하기 위하여 수행하는 일련의 활동을 말한다.',
          marginLeft: 1200,
          indent: -400,
        },
      },
      {
        paragraph: {
          text: '2. "결재"란 기관의 의사를 결정하기 위해 결재권자가 승인하는 행위를 말한다.',
          marginLeft: 1200,
          indent: -400,
        },
      },
      {
        paragraph: {
          text: '3. "공문서"란 기관에서 공무상 작성하거나 시행하는 문서를 말한다.',
          marginLeft: 1200,
          indent: -400,
          spacing: { after: 400 },
        },
      },

      // ===== 제2장 업무 처리 절차 =====
      {
        paragraph: {
          heading: 2,
          text: '제2장 업무 처리 절차',
        },
      },
      {
        paragraph: {
          runs: [
            { text: '제4조(기안) ', bold: true },
            {
              text: '① 업무 담당자는 업무의 내용을 기안문으로 작성하여 ' +
                '소속 부서장에게 결재를 요청하여야 한다.',
            },
          ],
          indent: -800,
          marginLeft: 800,
          spacing: { after: 100 },
        },
      },
      {
        paragraph: {
          text: '② 기안문에는 제목, 내용, 근거, 시행일 등을 명확히 기재하여야 한다.',
          marginLeft: 800,
          spacing: { after: 200 },
        },
      },
      {
        paragraph: {
          runs: [
            { text: '제5조(결재) ', bold: true },
            {
              text: '결재 단계는 다음 표에 따른다.',
            },
          ],
          indent: -800,
          marginLeft: 800,
          spacing: { after: 200 },
        },
      },

      // ── 결재 단계 표 ──
      {
        table: {
          rows: [
            ['구분', '결재 단계', '결재권자', '비고'],
            ['일반문서', '2단계', '과장', ''],
            ['중요문서', '3단계', '국장', '합의 포함'],
            ['대외문서', '4단계', '기관장', '법무 검토 필수'],
            ['긴급문서', '2단계', '과장', '사후 보고'],
          ],
          headerRow: true,
          headerBackground: '#2E5090',
          columnWidths: [10000, 12000, 12000, 16000],
          cellBorder: {
            topBorderType: 'SOLID',
            bottomBorderType: 'SOLID',
            leftBorderType: 'SOLID',
            rightBorderType: 'SOLID',
          },
          cellCharFormat: {
            fontSize: 9,
          },
        },
      },

      {
        paragraph: {
          text: '',
          spacing: { after: 200 },
        },
      },

      // ===== 제3장 문서 관리 =====
      {
        paragraph: {
          heading: 2,
          text: '제3장 문서 관리',
        },
      },
      {
        paragraph: {
          runs: [
            { text: '제6조(보존기간) ', bold: true },
            {
              text: '문서의 보존기간은 다음 각 호와 같다.',
            },
          ],
          indent: -800,
          marginLeft: 800,
          spacing: { after: 100 },
        },
      },

      // ── 보존기간 표 ──
      {
        table: {
          rows: [
            ['보존기간', '대상 문서', '관리 방법'],
            ['영구', '법규, 조례, 인사 기록', '전자문서 시스템 + 서고 보관'],
            ['30년', '재정 관련 문서', '전자문서 시스템'],
            ['10년', '일반 행정 문서', '전자문서 시스템'],
            ['5년', '참고 자료, 경미한 업무', '부서별 관리'],
            ['1년', '단순 통지, 안내문', '담당자 관리 후 폐기'],
          ],
          headerRow: true,
          headerBackground: '#3A7D44',
          columnWidths: [10000, 18000, 22000],
          cellBorder: {
            topBorderType: 'SOLID',
            bottomBorderType: 'SOLID',
            leftBorderType: 'SOLID',
            rightBorderType: 'SOLID',
          },
          cellCharFormat: {
            fontSize: 9,
          },
        },
      },

      {
        paragraph: {
          text: '',
          spacing: { after: 400 },
        },
      },

      // ===== 부칙 =====
      {
        paragraph: {
          heading: 2,
          text: '부칙',
        },
      },
      {
        paragraph: {
          runs: [
            { text: '제1조(시행일) ', bold: true },
            { text: '이 규정은 2026년 3월 1일부터 시행한다.' },
          ],
          indent: -800,
          marginLeft: 800,
          spacing: { after: 100 },
        },
      },
      {
        paragraph: {
          runs: [
            { text: '제2조(경과조치) ', bold: true },
            {
              text: '이 규정 시행 전에 종전의 규정에 따라 처리된 사항은 ' +
                '이 규정에 따라 처리된 것으로 본다.',
            },
          ],
          indent: -800,
          marginLeft: 800,
          spacing: { after: 400 },
        },
      },

      // ── 서명란 ──
      {
        paragraph: {
          text: '',
          spacing: { before: 2000 },
        },
      },
      {
        paragraph: {
          text: '2026년 2월 22일',
          alignment: 'RIGHT',
          spacing: { after: 400 },
        },
      },
      {
        paragraph: {
          runs: [
            { text: '○ ○ 기 관 장', bold: true, fontSize: 14 },
          ],
          alignment: 'RIGHT',
        },
      },
    ],
  };

  console.log('[info] Creating HWPX document...');

  // createDocument returns Uint8Array (low-level), so we write it ourselves
  const buffer = await createDocument(params);
  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, buffer);

  console.log('[done] HWPX document created successfully');
  console.log('[path]', outputPath);

  // Quick stats
  const stats = fs.statSync(outputPath);
  console.log('[size]', (stats.size / 1024).toFixed(1), 'KB');
}

main().catch((err) => {
  console.error('[error]', err?.stack || err?.message || String(err));
  process.exit(1);
});
