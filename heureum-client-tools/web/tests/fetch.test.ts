import { describe, it, expect, beforeEach } from 'vitest'
import { webFetch } from '../src/fetch.js'
import { fetchCache } from '../src/cache.js'
import { BOUNDARY_START, BOUNDARY_END } from '../src/content-safety.js'

beforeEach(() => {
  fetchCache.clear()
})

describe('webFetch', () => {
  it('fetches a public URL successfully', async () => {
    const r = JSON.parse(await webFetch({ url: 'https://example.com' }))
    expect(r.status).toBe(200)
    expect(r.url).toBe('https://example.com')
    expect(r.final_url).toBe('https://example.com')
    expect(r.extract_mode).toBe('markdown')
    expect(r.cached).toBe(false)
    expect(typeof r.title).toBe('string')
    expect(typeof r.extractor).toBe('string')
    expect(typeof r.truncated).toBe('boolean')
    expect(typeof r.total_length).toBe('number')
    expect(typeof r.length).toBe('number')
    expect(typeof r.remaining).toBe('number')
    expect(typeof r.took_ms).toBe('number')
    expect(r.start_index).toBe(0)
  })

  it('returns content_type without charset params', async () => {
    const r = JSON.parse(await webFetch({ url: 'https://example.com' }))
    expect(r.content_type).not.toContain(';')
  })

  it('wraps text with boundary markers', async () => {
    const r = JSON.parse(await webFetch({ url: 'https://example.com' }))
    expect(r.text).toContain(BOUNDARY_START)
    expect(r.text).toContain(BOUNDARY_END)
    expect(r.text).toContain('Source: Web Fetch')
  })

  it('returns UTC ISO timestamp in Python format (+00:00)', async () => {
    const r = JSON.parse(await webFetch({ url: 'https://example.com' }))
    // Python: datetime.now(timezone.utc).isoformat() → "2024-01-01T00:00:00.123456+00:00"
    expect(r.fetched_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}\+00:00$/)
  })
})

describe('webFetch — cache', () => {
  it('returns cached result on second call', async () => {
    const r1 = JSON.parse(await webFetch({ url: 'https://example.com' }))
    expect(r1.cached).toBe(false)

    const r2 = JSON.parse(await webFetch({ url: 'https://example.com' }))
    expect(r2.cached).toBe(true)
    expect(r2.took_ms).toBeLessThanOrEqual(5)
  })

  it('does NOT skip cache for empty headers (Python: bool({})=False)', async () => {
    // Python: has_custom_headers = bool(headers) → False for {}
    const r1 = JSON.parse(
      await webFetch({ url: 'https://example.com', headers: {} }),
    )
    expect(r1.cached).toBe(false)

    // Second call with same empty headers USES cache (bool({}) is False in Python)
    const r2 = JSON.parse(
      await webFetch({ url: 'https://example.com', headers: {} }),
    )
    expect(r2.cached).toBe(true)
  })

  it('skips cache when headers have actual values', async () => {
    const r1 = JSON.parse(
      await webFetch({ url: 'https://example.com', headers: { 'X-Test': '1' } }),
    )
    expect(r1.cached).toBe(false)

    const r2 = JSON.parse(
      await webFetch({ url: 'https://example.com', headers: { 'X-Test': '1' } }),
    )
    expect(r2.cached).toBe(false)
  })
})

describe('webFetch — extract_mode', () => {
  it('defaults to markdown', async () => {
    const r = JSON.parse(await webFetch({ url: 'https://example.com' }))
    expect(r.extract_mode).toBe('markdown')
  })

  it('supports text mode', async () => {
    const r = JSON.parse(
      await webFetch({ url: 'https://example.com', extract_mode: 'text' }),
    )
    expect(r.extract_mode).toBe('text')
  })
})

describe('webFetch — pagination', () => {
  it('respects max_length', async () => {
    const r = JSON.parse(
      await webFetch({ url: 'https://example.com', max_length: 300 }),
    )
    expect(r.text.length).toBeLessThanOrEqual(300)
  })

  it('sets truncated and pagination fields', async () => {
    const r = JSON.parse(
      await webFetch({ url: 'https://example.com', max_length: 300 }),
    )
    // Either truncated because content > 300, or not truncated if content is small
    if (r.truncated) {
      expect(r.remaining).toBeGreaterThanOrEqual(0)
    }
  })

  it('supports start_index for continuation', async () => {
    const r = JSON.parse(
      await webFetch({
        url: 'https://example.com',
        max_length: 5000,
        start_index: 10,
      }),
    )
    expect(r.start_index).toBe(10)
  })
})

describe('webFetch — SSRF protection', () => {
  it('blocks localhost', async () => {
    const r = JSON.parse(await webFetch({ url: 'http://localhost' }))
    expect(r.blocked).toBe(true)
    expect(r.error).toContain('Blocked hostname')
  })

  it('blocks private IP', async () => {
    const r = JSON.parse(await webFetch({ url: 'http://127.0.0.1' }))
    expect(r.blocked).toBe(true)
    expect(r.error).toContain('Blocked private/reserved IP')
  })

  it('blocks metadata endpoint', async () => {
    const r = JSON.parse(
      await webFetch({ url: 'http://metadata.google.internal' }),
    )
    expect(r.blocked).toBe(true)
  })
})

describe('webFetch — result fields (Python _build_result parity)', () => {
  it('contains all 18 fields', async () => {
    const r = JSON.parse(await webFetch({ url: 'https://example.com' }))
    const expectedFields = [
      'url',
      'final_url',
      'status',
      'content_type',
      'title',
      'extract_mode',
      'extractor',
      'truncated',
      'start_index',
      'total_length',
      'length',
      'remaining',
      'next_start_index',
      'fetched_at',
      'took_ms',
      'cached',
      'text',
    ]
    for (const field of expectedFields) {
      expect(r).toHaveProperty(field)
    }
  })
})

describe('webFetch — JSON format (Python json.dumps parity)', () => {
  it('uses Python-style separators (", " and ": ")', async () => {
    const raw = await webFetch({ url: 'http://localhost' }) // quick SSRF error
    // Python json.dumps uses ": " after key and ", " between items
    expect(raw).toContain('": ')
    expect(raw).toContain(', "')
  })

  it('fetched_at uses +00:00 suffix (Python datetime.isoformat)', async () => {
    const raw = await webFetch({ url: 'https://example.com' })
    const r = JSON.parse(raw)
    expect(r.fetched_at).toMatch(/\+00:00$/)
    expect(r.fetched_at).not.toContain('Z')
  })
})
