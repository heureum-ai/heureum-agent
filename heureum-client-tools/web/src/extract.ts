/**
 * Web fetch content extraction utilities.
 *
 * Provides HTML→Markdown conversion, plain text extraction, content truncation,
 * and Firecrawl fallback for content extraction.
 */

import http from 'node:http'
import https from 'node:https'

import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'

import { settings } from './config.js'

export type ExtractMode = 'markdown' | 'text'

export interface ExtractedContent {
  title: string | null
  text: string
  extractor: string
}

/**
 * Decode common HTML entities.
 */
function decodeEntities(value: string): string {
  value = value.replace(/&nbsp;/g, ' ')
  value = value.replace(/&amp;/g, '&')
  value = value.replace(/&quot;/g, '"')
  value = value.replace(/&#39;/g, "'")
  value = value.replace(/&lt;/g, '<')
  value = value.replace(/&gt;/g, '>')
  value = value.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
  value = value.replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
  return value
}

/**
 * Remove all HTML tags and decode entities.
 */
function stripTags(value: string): string {
  return decodeEntities(value.replace(/<[^>]+>/g, ''))
}

/**
 * Collapse excessive whitespace.
 */
function normalizeWhitespace(value: string): string {
  value = value.replace(/\r/g, '')
  value = value.replace(/[ \t]+\n/g, '\n')
  value = value.replace(/\n{3,}/g, '\n\n')
  value = value.replace(/[ \t]{2,}/g, ' ')
  return value.trim()
}

/**
 * Convert HTML to Markdown, preserving links, headings, and lists.
 *
 * Returns [markdownText, title].
 */
export function htmlToMarkdown(html: string): [string, string | null] {
  // Extract title
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? normalizeWhitespace(stripTags(titleMatch[1])) : null

  let text = html

  // Remove script/style/noscript blocks
  text = text.replace(/<script[\s\S]*?<\/script>/gi, '')
  text = text.replace(/<style[\s\S]*?<\/style>/gi, '')
  text = text.replace(/<noscript[\s\S]*?<\/noscript>/gi, '')

  // Convert links: <a href="url">text</a> → [text](url)
  text = text.replace(
    /<a\s+[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    (_, href, body) => {
      const cleaned = normalizeWhitespace(stripTags(body))
      if (!cleaned) return href
      return `[${cleaned}](${href})`
    },
  )

  // Convert headings: <h1>text</h1> → # text
  text = text.replace(
    /<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi,
    (_, level, body) => {
      const lvl = Math.max(1, Math.min(6, parseInt(level, 10)))
      const prefix = '#'.repeat(lvl)
      const cleaned = normalizeWhitespace(stripTags(body))
      return `\n${prefix} ${cleaned}\n`
    },
  )

  // Convert list items: <li>text</li> → - text
  text = text.replace(
    /<li[^>]*>([\s\S]*?)<\/li>/gi,
    (_, body) => {
      const cleaned = normalizeWhitespace(stripTags(body))
      return cleaned ? `\n- ${cleaned}` : ''
    },
  )

  // Convert breaks and block elements
  text = text.replace(/<(br|hr)\s*\/?>/gi, '\n')
  text = text.replace(
    /<\/(p|div|section|article|header|footer|table|tr|ul|ol)>/gi,
    '\n',
  )

  // Strip remaining tags and normalize
  text = stripTags(text)
  text = normalizeWhitespace(text)

  return [text, title]
}

/**
 * Strip Markdown formatting to plain text.
 */
export function markdownToText(markdown: string): string {
  let text = markdown
  // Remove images
  text = text.replace(/!\[[^\]]*]\([^)]+\)/g, '')
  // Convert links to just the label
  text = text.replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
  // Strip code blocks
  text = text.replace(/```[\s\S]*?```/g, (m) => m.replace(/```[^\n]*\n?/g, ''))
  // Strip inline code
  text = text.replace(/`([^`]+)`/g, '$1')
  // Strip heading markers
  text = text.replace(/^#{1,6}\s+/gm, '')
  // Strip list markers
  text = text.replace(/^\s*[-*+]\s+/gm, '')
  text = text.replace(/^\s*\d+\.\s+/gm, '')
  return normalizeWhitespace(text)
}

/**
 * Extract readable content from an HTTP response body.
 */
export function extractContent(
  body: string,
  options: {
    contentType: string
    url?: string
    extractMode?: ExtractMode
  },
): ExtractedContent {
  const { contentType, url = '', extractMode = 'markdown' } = options
  const ctLower = contentType.toLowerCase()

  if (ctLower.includes('text/html')) {
    return extractHtml(body, { url, extractMode })
  }

  if (ctLower.includes('application/json') || ctLower.includes('text/json')) {
    return extractJson(body)
  }

  // Plain text or unknown: return as-is
  return { title: null, text: body.trim(), extractor: 'raw' }
}

/**
 * Extract content from HTML using Readability with Markdown/text fallback.
 */
function extractHtml(
  body: string,
  options: { url: string; extractMode: ExtractMode },
): ExtractedContent {
  const { url, extractMode } = options

  try {
    const { document } = parseHTML(body)
    const reader = new Readability(document)
    const article = reader.parse()

    if (!article || !article.content || article.content.trim().length < 50) {
      return fallbackHtml(body, extractMode)
    }

    const title = article.title || null

    let text: string
    if (extractMode === 'text') {
      text = normalizeWhitespace(stripTags(article.content))
    } else {
      ;[text] = htmlToMarkdown(article.content)
    }

    if (!text.trim()) {
      return fallbackHtml(body, extractMode)
    }

    return { title, text, extractor: 'readability' }
  } catch {
    return fallbackHtml(body, extractMode)
  }
}

function fallbackHtml(body: string, extractMode: ExtractMode): ExtractedContent {
  const [mdText, title] = htmlToMarkdown(body)
  const text = extractMode === 'text' ? markdownToText(mdText) : mdText
  return { title, text, extractor: 'html_fallback' }
}

function extractJson(body: string): ExtractedContent {
  try {
    const parsed = JSON.parse(body)
    const text = JSON.stringify(parsed, null, 2)
    return { title: null, text, extractor: 'json' }
  } catch {
    return { title: null, text: body.trim(), extractor: 'raw' }
  }
}

/**
 * Fallback: extract content via Firecrawl API.
 */
export async function fetchFirecrawl(url: string): Promise<ExtractedContent | null> {
  if (!settings.FIRECRAWL_ENABLED || !settings.FIRECRAWL_API_KEY) {
    return null
  }

  try {
    const body = JSON.stringify({
      url,
      formats: ['markdown'],
      onlyMainContent: true,
      timeout: Math.floor(settings.FIRECRAWL_TIMEOUT * 1000),
    })

    const apiUrl = new URL('/v1/scrape', settings.FIRECRAWL_BASE_URL)
    const isHttps = apiUrl.protocol === 'https:'
    const httpMod = isHttps ? https : http

    const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
      const req = httpMod.request(
        {
          hostname: apiUrl.hostname,
          port: apiUrl.port || (isHttps ? 443 : 80),
          path: apiUrl.pathname,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${settings.FIRECRAWL_API_KEY}`,
            'Content-Length': Buffer.byteLength(body),
          },
          timeout: settings.FIRECRAWL_TIMEOUT * 1000,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode ?? 0,
              body: Buffer.concat(chunks).toString('utf-8'),
            })
          })
          res.on('error', reject)
        },
      )
      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy()
        reject(new Error('Firecrawl request timed out'))
      })
      req.write(body)
      req.end()
    })

    if (response.statusCode < 200 || response.statusCode >= 300) {
      return null
    }

    const data = JSON.parse(response.body)
    if (!data.success) return null

    const content = data.data ?? {}
    const markdown = content.markdown ?? ''
    if (!markdown) return null

    const metadata = content.metadata ?? {}
    const title = metadata.title ?? null

    return { title, text: markdown, extractor: 'firecrawl' }
  } catch {
    return null
  }
}
