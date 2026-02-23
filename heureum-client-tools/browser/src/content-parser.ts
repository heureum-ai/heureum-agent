/**
 * Content parsing utilities for browser page output.
 *
 * Migrated from server-side Python (normalize.py) to share
 * between client and server.
 */

const PAGE_HEADER_RE = /Page:\s*"(?<title>[^"]*)"\s*(?:URL:\s*(?<url>\S+))?/

/**
 * Check if content looks like browser page DOM output.
 * Matches the output format of content.js.
 */
export function isBrowserPageContent(content: string): boolean {
  return content.startsWith('Page:') || content.slice(0, 500).includes('[Interactive Elements]')
}

/**
 * Extract short "Page: ... URL: ..." summary from browser tool output.
 * Used for replacing stale page snapshots with compact headers.
 */
export function extractPageHeader(content: string): string {
  const match = PAGE_HEADER_RE.exec(content)
  if (match?.groups && (match.groups.title || match.groups.url)) {
    const title = match.groups.title || ''
    const url = match.groups.url || ''
    const parts = [`Page: "${title}"`]
    if (url) parts.push(`URL: ${url}`)
    return parts.join(' ')
  }
  const firstLine = content.split('\n', 1)[0] ?? ''
  return firstLine.slice(0, 120)
}
