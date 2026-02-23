#!/usr/bin/env npx tsx
/**
 * 한국 국내 주식 현황 분석 보고서 PDF 생성 스크립트
 *
 * 구현된 19개 함수 전체를 활용하여 완성된 보고서를 단계별로 생성합니다.
 *
 *  [1] getPageCount              [2] getMetadata
 *  [3] extractText               [4] mergePdfs
 *  [5] splitPdf                  [6] rotatePdfPages
 *  [7] removePages               [8] flattenForm
 *  [9] addWatermark             [10] addHighlightAnnotation
 * [11] addStampAnnotation       [12] checkFillableFields
 * [13] extractFormFieldInfo     [14] fillFillableFields
 * [15] fillPdfFormWithAnnotations [16] extractFormStructure
 * [17] checkBoundingBoxes       [18] createValidationImage
 * [19] handlePdfTool
 */

import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import fontkit from "@pdf-lib/fontkit";
import { PNG } from "pngjs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import {
  checkFillableFields,
  extractFormFieldInfo,
  fillFillableFields,
  fillPdfFormWithAnnotations,
  extractFormStructure,
  checkBoundingBoxes,
  createValidationImage,
  getFieldInfo,
  getPageCount,
  getMetadata,
  extractText,
  mergePdfs,
  splitPdf,
  rotatePdfPages,
  removePages,
  flattenForm,
  addWatermark,
  addHighlightAnnotation,
  addStampAnnotation,
  handlePdfTool,
} from "../src/index";

// ─────────────────────────────────────────────
// Paths
// ─────────────────────────────────────────────

const OUT = path.resolve(__dirname, "../output");
const FONT = "/System/Library/Fonts/Supplemental/AppleGothic.ttf";

function p(name: string) {
  return path.join(OUT, name);
}

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function log(step: number, fn: string, msg: string) {
  console.log(`  [${String(step).padStart(2, " ")}] ${fn.padEnd(30)} → ${msg}`);
}

async function embedFont(doc: PDFDocument) {
  doc.registerFontkit(fontkit);
  return doc.embedFont(fs.readFileSync(FONT), { subset: false });
}

function header(
  page: ReturnType<PDFDocument["addPage"]>,
  font: any,
  title: string,
  w: number,
) {
  page.drawRectangle({ x: 0, y: 742, width: w, height: 50, color: rgb(0.08, 0.18, 0.38) });
  page.drawText(title, { x: 36, y: 755, size: 20, font, color: rgb(1, 1, 1) });
  // thin accent line
  page.drawRectangle({ x: 0, y: 740, width: w, height: 2, color: rgb(0.2, 0.5, 0.85) });
}

function footer(
  page: ReturnType<PDFDocument["addPage"]>,
  font: any,
  pageNum: number,
  w: number,
) {
  page.drawRectangle({ x: 0, y: 0, width: w, height: 28, color: rgb(0.95, 0.95, 0.97) });
  page.drawText(`- ${pageNum} -`, { x: w / 2 - 10, y: 8, size: 9, font, color: rgb(0.5, 0.5, 0.5) });
  page.drawText("Heureum Investment Research", { x: 36, y: 8, size: 8, font, color: rgb(0.6, 0.6, 0.6) });
  page.drawText("Confidential", { x: w - 100, y: 8, size: 8, font, color: rgb(0.6, 0.6, 0.6) });
}

function drawLines(
  page: ReturnType<PDFDocument["addPage"]>,
  font: any,
  lines: string[],
  startY: number,
  opts: { size?: number; color?: ReturnType<typeof rgb>; x?: number; lineHeight?: number } = {},
) {
  const size = opts.size ?? 11;
  const color = opts.color ?? rgb(0.12, 0.12, 0.12);
  const x = opts.x ?? 50;
  const lh = opts.lineHeight ?? 18;
  let y = startY;
  for (const line of lines) {
    if (y < 40) break;
    page.drawText(line, { x, y, size, font, color });
    y -= lh;
  }
  return y;
}

interface TableOptions {
  startX: number;
  startY: number;
  colWidths: number[];
  rowHeight: number;
  headerBg?: ReturnType<typeof rgb>;
  headerColor?: ReturnType<typeof rgb>;
  cellColor?: ReturnType<typeof rgb>;
  fontSize?: number;
  headerFontSize?: number;
  cellPaddingX?: number;
  cellPaddingY?: number;
  altRowBg?: ReturnType<typeof rgb>;
}

function drawTable(
  page: ReturnType<PDFDocument["addPage"]>,
  font: any,
  headers: string[],
  rows: string[][],
  opts: TableOptions,
) {
  const {
    startX, startY, colWidths, rowHeight,
    headerBg = rgb(0.08, 0.18, 0.38),
    headerColor = rgb(1, 1, 1),
    cellColor = rgb(0.12, 0.12, 0.12),
    fontSize = 9,
    headerFontSize = 9.5,
    cellPaddingX = 6,
    cellPaddingY = 0,
    altRowBg,
  } = opts;

  const totalWidth = colWidths.reduce((a, b) => a + b, 0);
  const totalRows = rows.length + 1; // +1 for header
  const lineColor = rgb(0.7, 0.7, 0.7);
  const lineThickness = 0.5;

  // Header background
  page.drawRectangle({
    x: startX, y: startY - rowHeight, width: totalWidth, height: rowHeight,
    color: headerBg,
  });

  // Alternating row backgrounds
  if (altRowBg) {
    for (let r = 0; r < rows.length; r++) {
      if (r % 2 === 1) {
        page.drawRectangle({
          x: startX,
          y: startY - rowHeight * (r + 2),
          width: totalWidth,
          height: rowHeight,
          color: altRowBg,
        });
      }
    }
  }

  // Draw horizontal lines
  for (let r = 0; r <= totalRows; r++) {
    const y = startY - r * rowHeight;
    const thick = r === 0 || r === 1 || r === totalRows ? 1 : lineThickness;
    page.drawLine({
      start: { x: startX, y },
      end: { x: startX + totalWidth, y },
      thickness: thick,
      color: r === 0 || r === totalRows ? rgb(0.08, 0.18, 0.38) : lineColor,
    });
  }

  // Draw vertical lines
  let cx = startX;
  for (let c = 0; c <= colWidths.length; c++) {
    const thick = c === 0 || c === colWidths.length ? 1 : lineThickness;
    page.drawLine({
      start: { x: cx, y: startY },
      end: { x: cx, y: startY - totalRows * rowHeight },
      thickness: thick,
      color: c === 0 || c === colWidths.length ? rgb(0.08, 0.18, 0.38) : lineColor,
    });
    if (c < colWidths.length) cx += colWidths[c];
  }

  // Draw header text
  cx = startX;
  for (let c = 0; c < headers.length; c++) {
    page.drawText(headers[c], {
      x: cx + cellPaddingX,
      y: startY - rowHeight + (rowHeight - headerFontSize) / 2 + cellPaddingY,
      size: headerFontSize,
      font,
      color: headerColor,
    });
    cx += colWidths[c];
  }

  // Draw row text
  for (let r = 0; r < rows.length; r++) {
    cx = startX;
    const rowY = startY - (r + 1) * rowHeight;
    for (let c = 0; c < rows[r].length; c++) {
      page.drawText(rows[r][c], {
        x: cx + cellPaddingX,
        y: rowY - rowHeight + (rowHeight - fontSize) / 2 + cellPaddingY,
        size: fontSize,
        font,
        color: cellColor,
      });
      cx += colWidths[c];
    }
  }

  // return bottom Y for further content
  return startY - totalRows * rowHeight;
}

// ─────────────────────────────────────────────
// Section builders
// ─────────────────────────────────────────────

async function buildCover() {
  const doc = await PDFDocument.create();
  const font = await embedFont(doc);
  const page = doc.addPage([612, 792]);

  // large header block
  page.drawRectangle({ x: 0, y: 440, width: 612, height: 352, color: rgb(0.08, 0.18, 0.38) });
  page.drawRectangle({ x: 0, y: 438, width: 612, height: 4, color: rgb(0.2, 0.5, 0.85) });

  page.drawText("한국 국내 주식", { x: 130, y: 690, size: 40, font, color: rgb(1, 1, 1) });
  page.drawText("현황 분석 보고서", { x: 110, y: 635, size: 40, font, color: rgb(1, 1, 1) });
  page.drawText("Korean Domestic Equity Market Report", {
    x: 115, y: 585, size: 16, font, color: rgb(0.7, 0.78, 0.92),
  });
  page.drawText("2026년 2월 21일", { x: 220, y: 530, size: 18, font, color: rgb(0.8, 0.85, 0.95) });
  page.drawText("Q1 정기 보고", { x: 240, y: 500, size: 14, font, color: rgb(0.6, 0.7, 0.85) });

  const info = [
    "작성부서  :  투자분석팀 (Equity Research Division)",
    "작성자    :  김민수 수석연구원",
    "검토자    :  박지은 팀장",
    "승인자    :  이정훈 본부장",
    "",
    "배포 등급 :  대외비 (Confidential)",
    "보고서 ID :  RPT-2026-KR-EQ-0221",
  ];
  drawLines(page, font, info, 390, { size: 12, color: rgb(0.3, 0.3, 0.3), x: 140 });

  page.drawRectangle({ x: 50, y: 140, width: 512, height: 1, color: rgb(0.8, 0.8, 0.8) });
  drawLines(page, font, [
    "본 보고서는 내부 투자 참고 자료이며, 외부 배포를 금합니다.",
    "무단 복제 및 전재를 금지합니다.",
  ], 120, { size: 9, color: rgb(0.55, 0.55, 0.55), x: 140 });

  fs.writeFileSync(p("01_cover.pdf"), await doc.save());
}

async function buildTOC() {
  const doc = await PDFDocument.create();
  const font = await embedFont(doc);
  const page = doc.addPage([612, 792]);
  header(page, font, "목 차 (Table of Contents)", 612);
  footer(page, font, 2, 612);

  const items = [
    ["1.", "시장 요약 (Executive Summary)", "3"],
    ["2.", "KOSPI 시장 분석", "4"],
    ["  2-1.", "시가총액 상위 10개 종목", "5"],
    ["3.", "업종별 수익률 분석", "6"],
    ["4.", "외국인 · 기관 수급 동향", "7"],
    ["5.", "주요 리스크 요인", "8"],
    ["6.", "투자 전략 및 포트폴리오 제안", "9"],
    ["7.", "보고서 검토 양식", "10"],
    ["", "", ""],
    ["부록 A.", "용어 설명", "11"],
    ["부록 B.", "면책 조항", "12"],
  ];

  let y = 690;
  for (const [num, title, pg] of items) {
    if (!num && !title) { y -= 10; continue; }
    page.drawText(`${num}  ${title}`, { x: 70, y, size: 13, font, color: rgb(0.12, 0.12, 0.12) });
    if (pg) page.drawText(pg, { x: 520, y, size: 13, font, color: rgb(0.4, 0.4, 0.4) });
    // dotted line
    page.drawRectangle({ x: 70, y: y - 5, width: 472, height: 0.5, color: rgb(0.85, 0.85, 0.85) });
    y -= 28;
  }

  fs.writeFileSync(p("02_toc.pdf"), await doc.save());
}

async function buildSummary() {
  const doc = await PDFDocument.create();
  const font = await embedFont(doc);
  const page = doc.addPage([612, 792]);
  header(page, font, "1. 시장 요약 (Executive Summary)", 612);
  footer(page, font, 3, 612);

  const lines = [
    "2026년 2월 기준, 한국 주식시장은 글로벌 금리 인하 기대감과",
    "반도체 업종 실적 호조에 힘입어 완만한 상승세를 이어가고 있다.",
    "",
    "■ 주요 지수 현황",
    "  KOSPI  : 2,850.42  (+3.2% YTD)     KOSDAQ : 920.15  (+5.1% YTD)",
    "",
    "■ 투자자별 수급 (연초 이후 누적)",
    "  외국인 순매수  : +2.3조원           기관 순매수 : +0.8조원",
    "  개인 순매도    : -1.8조원           프로그램   : -1.3조원",
    "",
    "■ 주요 동향",
    "  - 반도체 : AI 수요 지속 확대, 삼성전자·SK하이닉스 실적 개선",
    "  - 2차전지 : 글로벌 EV 판매 둔화에도 장기 성장 전망 유지",
    "  - 바이오 : 신약 파이프라인 확대, 기술수출 기대감 상승",
    "  - 금융 : 은행주 배당 확대, 밸류업 프로그램 효과 지속",
    "",
    "■ 환율 동향",
    "  원/달러 : 1,325원 (전월 대비 -1.2%)",
    "  원/엔   : 880원 (전월 대비 +0.5%)",
    "",
    "■ 투자 의견 : 비중확대 (Overweight)",
    "  반도체·금융 업종 중심의 선별적 매수 전략을 유지하되,",
    "  환율 변동성 확대 가능성에 대비하여 포트폴리오 분산을 권고.",
  ];

  drawLines(page, font, lines, 710);

  fs.writeFileSync(p("03_summary.pdf"), await doc.save());
}

async function buildKospi() {
  const doc = await PDFDocument.create();
  const font = await embedFont(doc);

  // ── Page 1: KOSPI overview ──
  const p1 = doc.addPage([612, 792]);
  header(p1, font, "2. KOSPI 시장 분석", 612);
  footer(p1, font, 4, 612);

  p1.drawText("KOSPI 주요 지표  (2026.02.21 기준)", {
    x: 50, y: 710, size: 12, font, color: rgb(0.08, 0.18, 0.38),
  });

  const tableBottom1 = drawTable(p1, font,
    ["지표", "수치", "전월대비", "평가"],
    [
      ["KOSPI 종가", "2,850.42", "+2.1%", "상승"],
      ["시가총액", "2,180조원", "+1.8%", ""],
      ["거래대금(일평균)", "12.3조원", "+15.2%", "활발"],
      ["PER", "12.8배", "-0.3p", "적정"],
      ["PBR", "1.05배", "+0.02p", "저평가"],
      ["배당수익률", "2.1%", "+0.1%p", ""],
      ["외국인 지분율", "32.5%", "+0.3%p", ""],
    ],
    {
      startX: 50, startY: 693, colWidths: [150, 110, 90, 80],
      rowHeight: 22, altRowBg: rgb(0.95, 0.96, 0.98),
    },
  );

  const chartLines = [
    "",
    "KOSPI 월간 추이 (최근 6개월)",
    "",
    "  2,900 |                              *-----*",
    "  2,850 |                    *-----*--*",
    "  2,800 |          *--------*",
    "  2,750 |   *-----*",
    "  2,700 |--*",
    "        +--------------------------------------",
    "         9월    10월   11월    12월   1월   2월",
  ];

  drawLines(p1, font, chartLines, tableBottom1 - 5, { size: 9.5, lineHeight: 17, x: 50 });

  // ── Page 2: Top 10 stocks ──
  const p2 = doc.addPage([612, 792]);
  header(p2, font, "2-1. 시가총액 상위 10개 종목", 612);
  footer(p2, font, 5, 612);

  const stocksBottom = drawTable(p2, font,
    ["순위", "종목명", "시가총액", "현재가", "등락률"],
    [
      ["1", "삼성전자", "420.5조", "72,800원", "+4.2%"],
      ["2", "SK하이닉스", "130.2조", "189,500원", "+8.7%"],
      ["3", "LG에너지솔루션", "95.8조", "410,000원", "-2.1%"],
      ["4", "삼성바이오로직스", "62.3조", "950,000원", "+3.5%"],
      ["5", "현대자동차", "55.1조", "268,000원", "+1.8%"],
      ["6", "기아", "38.7조", "125,500원", "+2.3%"],
      ["7", "셀트리온", "35.2조", "198,000원", "+5.4%"],
      ["8", "KB금융", "28.9조", "82,400원", "+6.1%"],
      ["9", "POSCO홀딩스", "27.5조", "380,000원", "-1.2%"],
      ["10", "NAVER", "25.8조", "195,000원", "+3.8%"],
    ],
    {
      startX: 50, startY: 710, colWidths: [45, 140, 90, 100, 70],
      rowHeight: 22, altRowBg: rgb(0.95, 0.96, 0.98),
    },
  );

  const comments = [
    "",
    "분석 코멘트",
    "  - 삼성전자: HBM3E 양산 확대로 AI 반도체 매출 급증 전망",
    "  - SK하이닉스: NVIDIA 향 HBM 공급 독점적 지위 유지",
    "  - LG에너지솔루션: 미국 IRA 보조금 불확실성으로 약세",
    "  - KB금융: 밸류업 프로그램 수혜, 배당률 5.2% 매력적",
  ];

  drawLines(p2, font, comments, stocksBottom - 10, { size: 10, lineHeight: 17, x: 50 });

  fs.writeFileSync(p("04_kospi.pdf"), await doc.save());
}

async function buildSector() {
  const doc = await PDFDocument.create();
  const font = await embedFont(doc);
  const page = doc.addPage([612, 792]);
  header(page, font, "3. 업종별 수익률 분석", 612);
  footer(page, font, 6, 612);

  const lines = [
    "업종별 YTD 수익률  (2026.01.02 ~ 2026.02.21)",
    "",
    "  반도체      ████████████████████████████  +12.5%  ★ Top",
    "  금융        ████████████████████████      +10.2%",
    "  바이오      ███████████████████████       + 9.8%",
    "  자동차      █████████████████████         + 8.1%",
    "  IT/소프트웨어 ██████████████████           + 7.3%",
    "  화학        ████████████████              + 6.5%",
    "  철강/소재    ████████████                  + 4.2%",
    "  건설/인프라   ███████                      + 2.8%",
    "  유틸리티     █████                         + 1.9%",
    "  2차전지     ██                             - 1.5%  ▼ Bottom",
    "",
    "▶ 업종별 핵심 분석",
    "",
    "  [반도체 +12.5%]",
    "  AI 데이터센터 투자 확대에 따른 메모리 수요 급증.",
    "  HBM, DDR5 등 고부가가치 제품 비중 확대가 실적 견인.",
    "",
    "  [금융 +10.2%]",
    "  밸류업 프로그램 본격 시행으로 배당확대·자사주매입 증가.",
    "  은행 NIM(순이자마진) 안정적 유지, ROE 10% 이상 달성.",
    "",
    "  [2차전지 -1.5%]",
    "  유럽 EV 보조금 축소, 미국 IRA 정책 불확실성 부각.",
    "  단기 조정이나 장기 성장 스토리는 유효. 분할매수 추천.",
  ];

  drawLines(page, font, lines, 710, { size: 10.5, lineHeight: 17 });

  fs.writeFileSync(p("05_sector.pdf"), await doc.save());
}

async function buildSupply() {
  const doc = await PDFDocument.create();
  const font = await embedFont(doc);
  const page = doc.addPage([612, 792]);
  header(page, font, "4. 외국인 · 기관 수급 동향", 612);
  footer(page, font, 7, 612);

  page.drawText("투자자별 순매매 추이 (단위: 억원)", {
    x: 50, y: 710, size: 12, font, color: rgb(0.08, 0.18, 0.38),
  });

  const supplyBottom = drawTable(page, font,
    ["구분", "외국인", "기관", "개인", "기타"],
    [
      ["1월", "+12,500", "+4,200", "-15,300", "-1,400"],
      ["2월", "+10,800", "+3,800", "-3,200", "+1,200"],
      ["YTD 합계", "+23,300", "+8,000", "-18,500", "-200"],
    ],
    {
      startX: 50, startY: 693, colWidths: [90, 100, 100, 100, 100],
      rowHeight: 24, altRowBg: rgb(0.95, 0.96, 0.98),
    },
  );

  const supplyLines = [
    "",
    "외국인 매매 상위 종목 (연초 이후 누적)",
    "",
    "  순매수 Top 5                          순매도 Top 5",
    "  1. 삼성전자       +8,200억            1. LG에너지솔루션    -3,100억",
    "  2. SK하이닉스     +5,100억            2. 삼성SDI           -2,400억",
    "  3. KB금융         +2,300억            3. 카카오             -1,800억",
    "  4. 현대자동차     +1,800억            4. 네이버             -1,200억",
    "  5. 셀트리온       +1,500억            5. POSCO홀딩스       -  900억",
    "",
    "수급 시사점",
    "  외국인은 반도체/금융 중심 순매수 지속. 2차전지는 순매도 전환.",
    "  기관은 연기금 중심으로 저가 매수세 유입, 밸류업 수혜주 선호.",
    "  개인은 차익 실현 매도 지속, 레버리지 ETF 거래 비중 증가 주의.",
  ];

  drawLines(page, font, supplyLines, supplyBottom - 10, { size: 10, lineHeight: 17, x: 50 });

  fs.writeFileSync(p("06_supply.pdf"), await doc.save());
}

async function buildRisk() {
  const doc = await PDFDocument.create();
  const font = await embedFont(doc);
  const page = doc.addPage([612, 792]);
  header(page, font, "5. 주요 리스크 요인", 612);
  footer(page, font, 8, 612);

  page.drawText("리스크 매트릭스", {
    x: 50, y: 710, size: 12, font, color: rgb(0.08, 0.18, 0.38),
  });

  const riskBottom = drawTable(page, font,
    ["리스크 요인", "확률", "영향도", "종합등급"],
    [
      ["미중 무역갈등 재점화", "중", "상", "경계"],
      ["원/달러 1,400원 돌파", "중", "상", "경계"],
      ["미 연준 금리인하 지연", "하", "중", "주의"],
      ["중국 경기 둔화 심화", "중", "중", "주의"],
      ["북한 지정학적 리스크", "하", "상", "주의"],
      ["국내 가계부채 증가", "상", "중", "경계"],
      ["AI 버블 우려", "하", "상", "주의"],
    ],
    {
      startX: 50, startY: 693, colWidths: [200, 65, 65, 100],
      rowHeight: 22, altRowBg: rgb(0.95, 0.96, 0.98),
    },
  );

  const riskLines = [
    "",
    "종합 리스크 평가 : 보통 (Moderate)",
    "",
    "핵심 시나리오별 대응",
    "",
    "  [Base Case - 60%]  완만한 상승 지속, KOSPI 2,800~3,000 밴드",
    "  -> 반도체/금융 비중 유지, 2차전지 저점 분할매수",
    "",
    "  [Bull Case - 25%]  미 금리 인하 + 반도체 슈퍼사이클",
    "  -> 공격적 비중 확대, 성장주 중심 포트폴리오",
    "",
    "  [Bear Case - 15%]  무역갈등 + 환율 급등 + 경기침체",
    "  -> 방어주(통신/유틸리티) 전환, 현금 비중 30% 이상 확보",
  ];

  drawLines(page, font, riskLines, riskBottom - 10, { size: 10, lineHeight: 17, x: 50 });

  fs.writeFileSync(p("07_risk.pdf"), await doc.save());
}

async function buildStrategy() {
  const doc = await PDFDocument.create();
  const font = await embedFont(doc);
  const page = doc.addPage([612, 792]);
  header(page, font, "6. 투자 전략 및 포트폴리오 제안", 612);
  footer(page, font, 9, 612);

  page.drawText("추천 포트폴리오 배분 (모델 포트폴리오)", {
    x: 50, y: 710, size: 12, font, color: rgb(0.08, 0.18, 0.38),
  });

  const stratBottom = drawTable(page, font,
    ["자산군", "비중", "대표 종목/ETF"],
    [
      ["반도체", "30%", "삼성전자, SK하이닉스"],
      ["금융", "20%", "KB금융, 신한지주"],
      ["바이오", "15%", "삼성바이오, 셀트리온"],
      ["자동차", "10%", "현대차, 기아"],
      ["2차전지", "10%", "LG에너지솔루션 (분할매수)"],
      ["현금/채권", "15%", "국고채 3년, MMF"],
    ],
    {
      startX: 50, startY: 693, colWidths: [110, 70, 250],
      rowHeight: 24, altRowBg: rgb(0.95, 0.96, 0.98),
    },
  );

  const stratLines = [
    "",
    "기대 수익률: 연 8~12% (Base Case 기준)",
    "리밸런싱 주기: 분기 1회",
    "",
    "핵심 투자 아이디어",
    "",
    "  1. AI 반도체 수퍼사이클",
    "     HBM, AI 가속기 수요가 2027년까지 연 40% 이상 성장 전망.",
    "     삼성전자 목표가 85,000원, SK하이닉스 목표가 220,000원.",
    "",
    "  2. 밸류업 프로그램 수혜주",
    "     PBR 1배 미만 금융/지주사의 기업가치 재평가 기대.",
    "     KB금융 목표가 95,000원 (배당수익률 5.2%).",
    "",
    "  3. 바이오 기술수출 모멘텀",
    "     글로벌 빅파마 향 기술수출 딜 증가 추세.",
    "     셀트리온 바이오시밀러 미국 시장 점유율 확대 중.",
  ];

  drawLines(page, font, stratLines, stratBottom - 10, { size: 10, lineHeight: 17, x: 50 });

  fs.writeFileSync(p("08_strategy.pdf"), await doc.save());
}

async function buildReviewForm() {
  const doc = await PDFDocument.create();
  const font = await embedFont(doc);
  const page = doc.addPage([612, 792]);
  header(page, font, "7. 보고서 검토 양식", 612);
  footer(page, font, 10, 612);

  page.drawText("아래 항목을 기입한 후 서명하여 제출하세요.", {
    x: 50, y: 700, size: 13, font, color: rgb(0.2, 0.2, 0.2),
  });

  const form = doc.getForm();

  const labels = ["검토자 성명", "소속 부서", "검토 일자", "검토 의견"];
  const yPositions = [650, 610, 570, 480];
  const fieldNames = ["reviewer_name", "department", "review_date", "comments"];
  const heights = [25, 25, 25, 70];

  for (let i = 0; i < labels.length; i++) {
    page.drawText(labels[i] + " :", { x: 60, y: yPositions[i] + 5, size: 12, font, color: rgb(0.3, 0.3, 0.3) });
    const tf = form.createTextField(fieldNames[i]);
    tf.addToPage(page, { x: 180, y: yPositions[i], width: 350, height: heights[i] });
  }

  page.drawText("투자의견 동의 :", { x: 60, y: 435, size: 12, font, color: rgb(0.3, 0.3, 0.3) });
  const cb = form.createCheckBox("investment_agree");
  cb.addToPage(page, { x: 180, y: 430, width: 18, height: 18 });
  page.drawText("동의함", { x: 205, y: 435, size: 11, font, color: rgb(0.3, 0.3, 0.3) });

  page.drawText("최종 승인 :", { x: 60, y: 400, size: 12, font, color: rgb(0.3, 0.3, 0.3) });
  const cb2 = form.createCheckBox("final_approve");
  cb2.addToPage(page, { x: 180, y: 395, width: 18, height: 18 });
  page.drawText("승인", { x: 205, y: 400, size: 11, font, color: rgb(0.3, 0.3, 0.3) });

  fs.writeFileSync(p("09_review_form.pdf"), await doc.save());
}

async function buildAppendix() {
  const doc = await PDFDocument.create();
  const font = await embedFont(doc);

  // ── 부록 A ──
  const pA = doc.addPage([612, 792]);
  header(pA, font, "부록 A. 용어 설명 (Glossary)", 612);
  footer(pA, font, 11, 612);

  const terms = [
    "PER  (Price Earnings Ratio)    : 주가수익비율 = 주가 / 주당순이익",
    "PBR  (Price Book-value Ratio)  : 주가순자산비율 = 주가 / 주당순자산",
    "EPS  (Earnings Per Share)      : 주당순이익 = 당기순이익 / 발행주식수",
    "ROE  (Return On Equity)        : 자기자본이익률 = 당기순이익 / 자기자본",
    "NIM  (Net Interest Margin)     : 순이자마진 = 이자수익 / 운용자산",
    "HBM  (High Bandwidth Memory)   : 고대역폭 메모리, AI 가속기 핵심 부품",
    "YTD  (Year-To-Date)            : 연초 이후 누적 기간/수익률",
    "IRA  (Inflation Reduction Act) : 미국 인플레이션 감축법, EV 보조금",
    "EV   (Electric Vehicle)        : 전기차",
    "밸류업 프로그램                  : 기업 주주환원 및 기업가치 제고 정책",
    "DDR5                            : 차세대 DRAM 규격 (5세대)",
    "바이오시밀러                     : 바이오의약품 복제약",
  ];

  drawLines(pA, font, terms, 700, { size: 10, lineHeight: 20 });

  // ── 부록 B ──
  const pB = doc.addPage([612, 792]);
  header(pB, font, "부록 B. 면책 조항 (Disclaimer)", 612);
  footer(pB, font, 12, 612);

  const disclaimer = [
    "1. 본 보고서는 투자 정보 제공을 목적으로 작성되었으며,",
    "   특정 금융상품의 매수·매도를 권유하지 않습니다.",
    "",
    "2. 본 보고서에 수록된 내용은 신뢰할 만한 자료 및 정보에",
    "   기초하여 작성되었으나, 그 정확성이나 완전성을 보장하지 않습니다.",
    "",
    "3. 본 보고서의 어떠한 내용도 미래 주가 움직임을 보장하지 않으며,",
    "   투자로 인한 손실에 대해 당사는 일절 책임을 지지 않습니다.",
    "",
    "4. 본 보고서는 대외비 자료로서 당사의 사전 서면 동의 없이",
    "   복제, 배포, 전송, 인용할 수 없습니다.",
    "",
    "5. 과거의 수익률이 미래의 수익률을 보장하지 않습니다.",
    "",
    "6. 본 보고서에 사용된 모든 데이터의 기준일은 2026년 2월 21일이며,",
    "   이후 시장 상황 변화에 따라 내용이 변경될 수 있습니다.",
    "",
    "",
    "                              Heureum Investment Research",
    "                              서울특별시 강남구 테헤란로 152",
    "                              대표전화 02-1234-5678",
  ];

  drawLines(pB, font, disclaimer, 700, { size: 10.5, lineHeight: 19 });

  fs.writeFileSync(p("10_appendix.pdf"), await doc.save());
}

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// MAIN
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

async function main() {
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  한국 국내 주식 현황 분석 보고서 생성");
  console.log("  모든 19개 PDF 함수 활용 데모");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log();

  fs.mkdirSync(OUT, { recursive: true });

  // ──────────────────────────────────────────────
  // Phase 1: 개별 섹션 PDF 생성
  // ──────────────────────────────────────────────
  console.log("Phase 1: 개별 섹션 PDF 생성");
  await Promise.all([
    buildCover(),
    buildTOC(),
    buildSummary(),
    buildKospi(),
    buildSector(),
    buildSupply(),
    buildRisk(),
    buildStrategy(),
    buildReviewForm(),
    buildAppendix(),
  ]);
  console.log("  → 10개 섹션 PDF 생성 완료\n");

  // ──────────────────────────────────────────────
  // [1] getPageCount — 각 섹션 페이지 수 확인
  // ──────────────────────────────────────────────
  let step = 1;
  const sections = [
    "01_cover.pdf", "02_toc.pdf", "03_summary.pdf", "04_kospi.pdf",
    "05_sector.pdf", "06_supply.pdf", "07_risk.pdf", "08_strategy.pdf",
    "09_review_form.pdf", "10_appendix.pdf",
  ];
  let totalPages = 0;
  for (const sec of sections) {
    const r = await getPageCount(p(sec));
    const cnt = JSON.parse(r.output).page_count;
    totalPages += cnt;
  }
  log(step, "getPageCount", `총 ${totalPages}페이지 (${sections.length}개 파일)`);

  // ──────────────────────────────────────────────
  // [2] getMetadata — 커버 메타데이터 확인
  // ──────────────────────────────────────────────
  step = 2;
  const metaResult = await getMetadata(p("01_cover.pdf"));
  const meta = JSON.parse(metaResult.output);
  log(step, "getMetadata", `커버: ${meta.pages[0].width}x${meta.pages[0].height}pt, ${meta.page_count}페이지`);

  // ──────────────────────────────────────────────
  // [3] extractText — 시장 요약 텍스트 추출
  // ──────────────────────────────────────────────
  step = 3;
  const textResult = await extractText(p("03_summary.pdf"), p("summary_text.txt"));
  log(step, "extractText", textResult.output.split("\n")[0]);

  // ──────────────────────────────────────────────
  // [4] mergePdfs — 전체 보고서 병합
  // ──────────────────────────────────────────────
  step = 4;
  const allSections = sections.map((s) => p(s));
  const mergeResult = await mergePdfs(allSections, p("report_merged.pdf"));
  log(step, "mergePdfs", mergeResult.output);

  // ──────────────────────────────────────────────
  // [5] splitPdf — 본문/부록 분리
  // ──────────────────────────────────────────────
  step = 5;
  const splitResult = await splitPdf(p("report_merged.pdf"), ["1-10", "11-12"], p("split"));
  log(step, "splitPdf", splitResult.output.split("\n")[0]);

  // ──────────────────────────────────────────────
  // [6] rotatePdfPages — 부록 가로 모드 테스트
  // ──────────────────────────────────────────────
  step = 6;
  const rotResult = await rotatePdfPages(p("10_appendix.pdf"), 90, [1], p("appendix_landscape.pdf"));
  log(step, "rotatePdfPages", rotResult.output);

  // ──────────────────────────────────────────────
  // [7] removePages — 면책조항 페이지 제거 버전
  // ──────────────────────────────────────────────
  step = 7;
  const rmResult = await removePages(p("10_appendix.pdf"), [2], p("appendix_no_disclaimer.pdf"));
  log(step, "removePages", rmResult.output);

  // ──────────────────────────────────────────────
  // [8] checkFillableFields — 검토 양식 폼 확인
  // ──────────────────────────────────────────────
  step = 8;
  const fillCheck = await checkFillableFields(p("09_review_form.pdf"));
  log(step, "checkFillableFields", fillCheck.output);

  // ──────────────────────────────────────────────
  // [9] extractFormFieldInfo — 필드 정보 추출
  // ──────────────────────────────────────────────
  step = 9;
  const fieldResult = await extractFormFieldInfo(p("09_review_form.pdf"), p("review_fields.json"));
  log(step, "extractFormFieldInfo", fieldResult.output);

  // ──────────────────────────────────────────────
  // [10] fillFillableFields — 체크박스 채우기
  // ──────────────────────────────────────────────
  step = 10;
  const fields = await getFieldInfo(p("09_review_form.pdf"));
  const approveField = fields.find((f) => f.field_id === "final_approve" || f.field_id === "investment_agree");
  if (approveField && approveField.type === "checkbox") {
    fs.writeFileSync(p("fill_values.json"), JSON.stringify([
      { field_id: approveField.field_id, page: approveField.page, value: approveField.checked_value },
    ]));
    const fillResult = await fillFillableFields(p("09_review_form.pdf"), p("fill_values.json"), p("review_checked.pdf"));
    log(step, "fillFillableFields", `${approveField.field_id} 체크 → success=${fillResult.success}`);
  } else {
    log(step, "fillFillableFields", "체크박스 필드 사용 (폼 존재 확인됨)");
  }

  // ──────────────────────────────────────────────
  // [11] flattenForm — 검토 완료 폼 고정
  // ──────────────────────────────────────────────
  step = 11;
  const flatResult = await flattenForm(p("09_review_form.pdf"), p("review_flattened.pdf"));
  log(step, "flattenForm", flatResult.output);

  // ──────────────────────────────────────────────
  // [12] fillPdfFormWithAnnotations — 커버에 주석
  // ──────────────────────────────────────────────
  step = 12;
  const annotData = {
    pages: [{ page_number: 1, pdf_width: 612, pdf_height: 792 }],
    form_fields: [
      {
        page_number: 1,
        label_bounding_box: [50, 70, 130, 90],
        entry_bounding_box: [140, 70, 400, 90],
        description: "Report ID",
        entry_text: { text: "RPT-2026-KR-EQ-0221", font_size: 9, font_color: "555555" },
      },
      {
        page_number: 1,
        label_bounding_box: [50, 50, 130, 68],
        entry_bounding_box: [140, 50, 400, 68],
        description: "Printed Date",
        entry_text: { text: "Printed: 2026-02-21 17:30 KST", font_size: 8, font_color: "888888" },
      },
    ],
  };
  fs.writeFileSync(p("cover_annot.json"), JSON.stringify(annotData));
  const annotResult = await fillPdfFormWithAnnotations(p("01_cover.pdf"), p("cover_annot.json"), p("cover_annotated.pdf"));
  log(step, "fillPdfFormWithAnnotations", annotResult.output.split("\n").pop()!);

  // ──────────────────────────────────────────────
  // [13] extractFormStructure — 업종 분석 구조
  // ──────────────────────────────────────────────
  step = 13;
  const structResult = await extractFormStructure(p("05_sector.pdf"), p("sector_structure.json"));
  log(step, "extractFormStructure", structResult.output.split("\n").slice(0, 3).join(" / "));

  // ──────────────────────────────────────────────
  // [14] checkBoundingBoxes — 주석 위치 검증
  // ──────────────────────────────────────────────
  step = 14;
  const bboxData = {
    pages: [{ page_number: 1 }],
    form_fields: [
      {
        page_number: 1,
        label_bounding_box: [50, 300, 140, 320],
        entry_bounding_box: [150, 300, 400, 320],
        description: "KOSPI 지수",
        entry_text: { text: "2,850.42", font_size: 12 },
      },
      {
        page_number: 1,
        label_bounding_box: [50, 330, 140, 350],
        entry_bounding_box: [150, 330, 400, 350],
        description: "KOSDAQ 지수",
        entry_text: { text: "920.15", font_size: 12 },
      },
    ],
  };
  fs.writeFileSync(p("bbox_check.json"), JSON.stringify(bboxData));
  const bboxResult = checkBoundingBoxes(p("bbox_check.json"));
  log(step, "checkBoundingBoxes", bboxResult.output.split("\n").pop()!);

  // ──────────────────────────────────────────────
  // [15] addWatermark — 대외비 워터마크
  // ──────────────────────────────────────────────
  step = 15;
  const wmResult = await addWatermark(p("report_merged.pdf"), p("report_watermarked.pdf"), {
    text: "CONFIDENTIAL",
    font_size: 60,
    opacity: 0.12,
    rotation: -45,
    color: "CC0000",
  });
  log(step, "addWatermark", wmResult.output);

  // ──────────────────────────────────────────────
  // [16] addHighlightAnnotation — 핵심 지표 강조
  // ──────────────────────────────────────────────
  step = 16;
  const hlResult = await addHighlightAnnotation(
    p("report_watermarked.pdf"),
    [
      { page_number: 3, rect: [50, 650, 500, 670], color: "FFFF00" },  // KOSPI
      { page_number: 3, rect: [50, 630, 500, 650], color: "90EE90" },  // KOSDAQ
    ],
    p("report_highlighted.pdf"),
  );
  log(step, "addHighlightAnnotation", hlResult.output);

  // ──────────────────────────────────────────────
  // [17] addStampAnnotation — 승인 스탬프
  // ──────────────────────────────────────────────
  step = 17;
  const stResult = await addStampAnnotation(
    p("report_highlighted.pdf"),
    [
      { page_number: 1, rect: [400, 50, 570, 150], stamp_name: "Approved" },
      { page_number: 10, rect: [400, 700, 570, 780], stamp_name: "Confidential" },
    ],
    p("report_stamped.pdf"),
  );
  log(step, "addStampAnnotation", stResult.output);

  // ──────────────────────────────────────────────
  // [18] createValidationImage — 바운딩 박스 시각화
  // ──────────────────────────────────────────────
  step = 18;
  const png = new PNG({ width: 612, height: 792 });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = 255; png.data[i + 1] = 255; png.data[i + 2] = 255; png.data[i + 3] = 255;
  }
  fs.writeFileSync(p("blank_page.png"), PNG.sync.write(png));
  const valResult = createValidationImage(1, p("bbox_check.json"), p("blank_page.png"), p("validation_overlay.png"));
  log(step, "createValidationImage", valResult.output);

  // ──────────────────────────────────────────────
  // [19] handlePdfTool — 디스패처로 최종 확인
  // ──────────────────────────────────────────────
  step = 19;
  const dispatchResult = await handlePdfTool("pdf_get_pagecount", { path: p("report_stamped.pdf") });
  const finalCount = JSON.parse(dispatchResult.output).page_count;
  log(step, "handlePdfTool", `최종 보고서: ${finalCount}페이지 (pdf_get_pagecount via dispatcher)`);

  // ──────────────────────────────────────────────
  // Final: 최종 보고서를 별도 이름으로 복사
  // ──────────────────────────────────────────────
  fs.copyFileSync(p("report_stamped.pdf"), p("FINAL_한국주식현황분석보고서_2026Q1.pdf"));

  console.log();
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  완료! 생성된 파일 목록:");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  const files = fs.readdirSync(OUT).sort();
  for (const f of files) {
    const stat = fs.statSync(path.join(OUT, f));
    const sizeKB = (stat.size / 1024).toFixed(1);
    console.log(`  ${f.padEnd(50)} ${sizeKB.padStart(8)} KB`);
  }
  console.log();
  console.log(`  출력 디렉토리: ${OUT}`);
  console.log(`  최종 보고서  : ${p("FINAL_한국주식현황분석보고서_2026Q1.pdf")}`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
