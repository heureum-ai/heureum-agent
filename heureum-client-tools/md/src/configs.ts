export const MD_DEFAULTS = {
  runtime: {
    cacheDirName: "heureum-md",
  },
  format: {
    trimTrailingSpaces: true,
    collapseBlankLines: true,
    ensureTrailingNewline: true,
    mode: "normalize" as const,
  },
  toc: {
    minDepth: 2,
    maxDepth: 3,
    includeH1: false,
    ordered: false,
    startMarker: "<!-- TOC -->",
    endMarker: "<!-- /TOC -->",
  },
} as const;
