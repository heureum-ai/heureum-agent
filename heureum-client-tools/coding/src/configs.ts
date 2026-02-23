/**
 * Centralized defaults for coding toolkit behavior.
 * Keep tool names stable; tune runtime/workflow defaults here.
 */

export const CODING_DEFAULTS = {
  runtime: {
    cacheDirName: "heureum-coding",
  },
  workflow: {
    recommendedToolOrder: ["ls", "find", "grep", "read", "edit", "write"] as const,
  },
} as const;
