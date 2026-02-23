/**
 * Centralized defaults for HWPX generation/parsing helpers.
 * Change values here to adjust project-wide baseline behavior.
 */

/** 1 inch = 7200 HWPUNIT, 1 inch = 25.4 mm → 1 mm = 7200/25.4 HWPUNIT */
export const HWPUNIT_PER_MM = 7200 / 25.4;

export const HWPX_PAGE_SIZES = {
  a4: { width: 59528, height: 84186 },
  b5: { width: 51592, height: 72852 },
  letter: { width: 61200, height: 79200 },
} as const;

export type HwpxPageSizeKey = keyof typeof HWPX_PAGE_SIZES;

export const HWPX_DEFAULTS = {
  document: {
    pageSize: 'a4' as HwpxPageSizeKey,
    fontName: '맑은 고딕',
    builtInFontName: '함초롬돋움',
    fontSizePt: 12,
    headingSizesPt: {
      1: 22,
      2: 16,
      3: 14,
      4: 13,
      5: 12,
      6: 12,
    } as Record<number, number>,
  },
  page: {
    marginTop: 5669,
    marginBottom: 4252,
    marginLeft: 4252,
    marginRight: 4252,
    marginHeader: 3600,
    marginFooter: 3600,
    gutter: 0,
    footNoteLineLength: -1,
    endNoteLineLength: 14692344,
    pageBorderOffset: 1417,
  },
  paragraph: {
    alignment: 'JUSTIFY' as const,
    lineSpacingType: 'PERCENT' as const,
    lineSpacingValue: 130,
    bulletMarginLeftMm: 2.8,
  },
  border: {
    type: 'NONE' as const,
    width: '0.12 mm',
    color: '#000000',
  },
  table: {
    textWrap: 'TOP_AND_BOTTOM' as const,
    textFlow: 'BOTH_SIDES' as const,
    totalWidth: 50159,
    cellHeight: 1609,
    headerFooterCellHeight: 1417,
    inMargin: { left: 510, right: 510, top: 141, bottom: 141 },
    headerFooterInMargin: { left: 0, right: 0, top: 0, bottom: 0 },
  },
  image: {
    widthMm: 100,
    heightMm: 75,
    textWrap: 'TOP_AND_BOTTOM' as const,
  },
  metadata: {
    title: 'Untitled',
    language: 'ko',
    creator: 'heureum',
    lastSaveBy: 'heureum',
  },
  officialRecreate: {
    fontName: '한양신명조',
    fontSizePt: 10,
    title: '행정업무의 운영 및 혁신에 관한 규정 시행규칙',
    imageFallbackTextWrap: 'TOP_AND_BOTTOM' as const,
    imageFallbackWidthHu: 14170,
    imageFallbackHeightHu: 8502,
  },
  runtime: {
    cacheDirName: 'heureum-hwpx',
  },
  prompts: {
    styleGuideReferencePath: './assets/행정업무_운영혁신_시행규칙_20230628_부칙포함.hwpx',
  },
} as const;
