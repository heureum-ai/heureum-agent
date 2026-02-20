/**
 * Web fetch tool.
 *
 * Fetches a URL and extracts readable content using Node.js native http + Readability.
 * Uses DNS-pinned transport with manual redirect handling for SSRF protection.
 * Falls back to Firecrawl when primary extraction fails.
 */

import { fetchCache, makeCacheKey } from './cache.js'
import { settings } from './config.js'
import { wrapAndTruncate } from './content-safety.js'
import { type ExtractMode, extractContent, fetchFirecrawl } from './extract.js'
import { SSRFError, fetchWithSsrfGuard } from './ssrf.js'

/**
 * JSON.stringify matching Python's json.dumps(obj, ensure_ascii=False).
 * Python default separators: (', ', ': ')
 */
function jsonDumps(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  if (typeof value === 'number') return Object.is(value, -0) ? '0' : String(value)
  if (typeof value === 'string') return JSON.stringify(value)
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]'
    const items = value.map(jsonDumps)
    return '[' + items.join(', ') + ']'
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
    if (entries.length === 0) return '{}'
    const pairs = entries
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${JSON.stringify(k)}: ${jsonDumps(v)}`)
    return '{' + pairs.join(', ') + '}'
  }
  return String(value)
}

/**
 * UTC ISO format matching Python's datetime.now(timezone.utc).isoformat().
 * Python: "2024-01-01T00:00:00.123456+00:00"
 */
function utcIsoformat(): string {
  const now = new Date()
  const iso = now.toISOString() // "2024-01-01T00:00:00.123Z"
  // Replace .123Z → .123000+00:00 (pad ms to μs, +00:00 suffix)
  return iso.replace(/\.(\d{3})Z$/, '.$1000+00:00')
}

export async function webFetch(params: {
  url: string
  max_length?: number
  start_index?: number
  extract_mode?: string
  headers?: Record<string, string>
}): Promise<string> {
  const {
    url,
    max_length = settings.WEB_FETCH_MAX_LENGTH,
    start_index = 0,
    extract_mode = 'markdown',
    headers,
  } = params

  const start = performance.now()
  const mode: ExtractMode = extract_mode === 'text' ? 'text' : 'markdown'

  // Skip cache if custom headers
  const cacheKey = makeCacheKey('fetch', url, String(max_length), String(start_index), mode)
  // Python: bool(headers) — bool({}) is False, bool({"k":"v"}) is True
  const hasCustomHeaders = headers != null && Object.keys(headers).length > 0

  if (settings.CACHE_ENABLED && !hasCustomHeaders) {
    const cached = fetchCache.get(cacheKey)
    if (cached != null) {
      cached.cached = true
      cached.took_ms = Math.floor(performance.now() - start)
      return jsonDumps(cached)
    }
  }

  const requestHeaders: Record<string, string> = {
    'User-Agent': settings.WEB_FETCH_USER_AGENT,
  }
  if (headers) {
    Object.assign(requestHeaders, headers)
  }

  let response: Awaited<ReturnType<typeof fetchWithSsrfGuard>> | null = null
  try {
    response = await fetchWithSsrfGuard(url, {
      headers: requestHeaders,
      timeout: settings.WEB_FETCH_TIMEOUT,
    })
  } catch (e: unknown) {
    if (e instanceof SSRFError) {
      return jsonDumps({
        error: e.message,
        url,
        blocked: true,
      })
    }

    // Fallback 1: network / HTTP error → try Firecrawl
    const fcResult = await fetchFirecrawl(url)
    if (fcResult != null) {
      return buildResult({
        url,
        finalUrl: url,
        statusCode: 0,
        contentType: '',
        title: fcResult.title ?? '',
        text: fcResult.text,
        extractor: fcResult.extractor,
        mode,
        maxLength: max_length,
        startIndex: start_index,
        startTime: start,
        cacheKey: hasCustomHeaders ? null : cacheKey,
        sourceUrl: url,
      })
    }

    let errorMsg: string
    if (e instanceof Error && e.message.includes('timed out')) {
      errorMsg = `Request timed out after ${settings.WEB_FETCH_TIMEOUT}s`
    } else {
      errorMsg = `Fetch failed: ${e instanceof Error ? e.message : String(e)}`
    }

    return jsonDumps({ error: errorMsg, url })
  }

  // Fallback 2: non-success HTTP status → try Firecrawl
  if (response.statusCode < 200 || response.statusCode >= 300) {
    const fcResult = await fetchFirecrawl(url)
    if (fcResult != null) {
      return buildResult({
        url,
        finalUrl: url,
        statusCode: response.statusCode,
        contentType: '',
        title: fcResult.title ?? '',
        text: fcResult.text,
        extractor: fcResult.extractor,
        mode,
        maxLength: max_length,
        startIndex: start_index,
        startTime: start,
        cacheKey: hasCustomHeaders ? null : cacheKey,
        sourceUrl: url,
      })
    }

    return jsonDumps({
      error: `HTTP ${response.statusCode}: ${response.statusMessage}`,
      url,
      status: response.statusCode,
    })
  }

  const contentType = (response.headers['content-type'] as string) ?? ''
  const finalUrl = response.url
  const statusCode = response.statusCode

  let extracted = extractContent(response.text, {
    contentType,
    url: finalUrl,
    extractMode: mode,
  })

  // Fallback 3: empty extraction → try Firecrawl
  if (!extracted.text.trim()) {
    const fcResult = await fetchFirecrawl(url)
    if (fcResult != null) {
      extracted = fcResult
    }
  }

  return buildResult({
    url,
    finalUrl,
    statusCode,
    contentType,
    title: extracted.title ?? '',
    text: extracted.text,
    extractor: extracted.extractor,
    mode,
    maxLength: max_length,
    startIndex: start_index,
    startTime: start,
    cacheKey: hasCustomHeaders ? null : cacheKey,
    sourceUrl: url,
  })
}

function buildResult(opts: {
  url: string
  finalUrl: string
  statusCode: number
  contentType: string
  title: string
  text: string
  extractor: string
  mode: string
  maxLength: number
  startIndex: number
  startTime: number
  cacheKey: string | null
  sourceUrl: string
}): string {
  const {
    url,
    finalUrl,
    statusCode,
    contentType,
    title,
    extractor,
    mode,
    maxLength,
    startIndex,
    startTime,
    cacheKey,
    sourceUrl,
  } = opts

  let { text } = opts

  const totalLength = text.length
  if (startIndex > 0) {
    text = text.slice(startIndex)
  }

  const [wrappedText, truncated] = wrapAndTruncate(text, {
    maxLength,
    source: 'web_fetch',
    includeWarning: true,
    sourceUrl,
  })

  const contentLength = Math.min(text.length, maxLength)
  const remaining = Math.max(0, totalLength - (startIndex + contentLength))
  const nextStartIndex = remaining > 0 ? startIndex + contentLength : null
  const tookMs = Math.floor(performance.now() - startTime)

  // Strip params like charset
  const normalizedCt = contentType ? contentType.split(';')[0].trim() : ''

  const result: Record<string, unknown> = {
    url,
    final_url: finalUrl,
    status: statusCode,
    content_type: normalizedCt,
    title,
    extract_mode: mode,
    extractor,
    truncated,
    start_index: startIndex,
    total_length: totalLength,
    length: contentLength,
    remaining,
    next_start_index: nextStartIndex,
    fetched_at: utcIsoformat(),
    took_ms: tookMs,
    cached: false,
    text: wrappedText,
  }

  if (cacheKey != null && settings.CACHE_ENABLED) {
    fetchCache.set(cacheKey, result)
  }

  return jsonDumps(result)
}
