/**
 * Centralized defaults for browser toolkit behavior.
 */

export const BROWSER_DEFAULTS = {
  /** Default timeout for browser commands (ms) */
  commandTimeoutMs: 15_000,

  /** Default timeout for wait_for (ms) */
  waitForTimeoutMs: 10_000,

  /** Default scroll amount in pixels */
  scrollAmountPx: 400,

  /** Max interactive elements collected by content.js */
  maxElements: 200,

  /** Max visible text length collected by content.js */
  maxTextLength: 5000,

  /** Stale content length threshold for server-side compaction */
  staleThreshold: 500,
} as const
