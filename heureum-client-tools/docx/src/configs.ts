/**
 * Centralized defaults for DOCX generation/parsing helpers.
 * Change values here to adjust project-wide baseline behavior.
 */

/** 1 inch = 1440 twips, 1 inch = 25.4 mm */
export const TWIPS_PER_MM = 1440 / 25.4;
/** 1 inch = 914400 EMU */
export const EMU_PER_MM = 914400 / 25.4;

export function mmToTwips(mm: number): number {
  return Math.round(mm * TWIPS_PER_MM);
}

export function twipsToMm(twips: number): number {
  return Number((twips / TWIPS_PER_MM).toFixed(1));
}

export function mmToEmu(mm: number): number {
  return Math.round(mm * EMU_PER_MM);
}

export function emuToMm(emu: number): number {
  return Number((emu / EMU_PER_MM).toFixed(1));
}

/** Convert pt to half-points (used for w:sz) */
export function ptToHalfPt(pt: number): number {
  return Math.round(pt * 2);
}

/** Convert half-points to pt */
export function halfPtToPt(hp: number): number {
  return hp / 2;
}

/** Convert pt to eighths of a point (used for w:spacing line) */
export function ptToEighthPt(pt: number): number {
  return Math.round(pt * 8);
}

export const DOCX_PAGE_SIZES = {
  a4: { width: mmToTwips(210), height: mmToTwips(297) },
  b5: { width: mmToTwips(176), height: mmToTwips(250) },
  letter: { width: mmToTwips(215.9), height: mmToTwips(279.4) },
} as const;

export type DocxPageSizeKey = keyof typeof DOCX_PAGE_SIZES;

export const DOCX_DEFAULTS = {
  document: {
    pageSize: 'a4' as DocxPageSizeKey,
    fontName: 'Malgun Gothic',
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
    marginTop: mmToTwips(20),
    marginBottom: mmToTwips(15),
    marginLeft: mmToTwips(15),
    marginRight: mmToTwips(15),
    marginHeader: mmToTwips(12.7),
    marginFooter: mmToTwips(12.7),
    gutter: 0,
  },
  paragraph: {
    alignment: 'both' as const,
    lineSpacingPercent: 115,
    spacingAfterPt: 8,
  },
  code: {
    fontName: 'Courier New',
    fontSizePt: 10,
  },
  table: {
    cellMarginLeft: mmToTwips(1.9),
    cellMarginRight: mmToTwips(1.9),
    cellMarginTop: 0,
    cellMarginBottom: 0,
    borderSize: 4, // eighths of a point
    borderColor: 'auto',
  },
  image: {
    widthMm: 100,
    heightMm: 75,
  },
  metadata: {
    title: 'Untitled',
    creator: 'heureum',
    lastModifiedBy: 'heureum',
  },
  runtime: {
    cacheDirName: 'heureum-docx',
  },
} as const;
