/**
 * Web fetch content extraction utilities.
 *
 * Provides HTML→Markdown conversion (via Turndown), plain text extraction,
 * and Firecrawl fallback for content extraction.
 */

import http from 'node:http'
import https from 'node:https'

import { Readability } from '@mozilla/readability'
import { parseHTML } from 'linkedom'
import TurndownService from 'turndown'

import { settings } from './config.js'

export type ExtractMode = 'markdown' | 'text'

export interface ExtractedContent {
  title: string | null
  text: string
  extractor: string
}

// ---------------------------------------------------------------------------
// HTML / Markdown helpers (powered by Turndown)
// ---------------------------------------------------------------------------

/**
 * Create a pre-configured Turndown converter.
 */
function makeTurndown(): TurndownService {
  const td = new TurndownService({
    headingStyle: 'atx',          // # Heading
    hr: '---',
    bulletListMarker: '-',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
  })
  // Remove script/style/noscript
  td.remove(['script', 'style', 'noscript'])
  return td
}

/**
 * Strip all HTML tags and decode entities (for plain text extraction).
 */
function stripTags(value: string): string {
  // Use a minimal Turndown with everything stripped
  const text = value
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)))
  return normalizeWhitespace(text)
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
 * Convert HTML to Markdown using Turndown.
 *
 * Returns [markdownText, title].
 */
export function htmlToMarkdown(html: string): [string, string | null] {
  // Extract title before Turndown strips it
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? stripTags(titleMatch[1]).trim() : null

  const td = makeTurndown()
  let text = td.turndown(html)

  // Collapse 3+ blank lines to 2
  text = text.replace(/\n{3,}/g, '\n\n')
  text = text.trim()

  return [text, title]
}

/**
 * Convert HTML to plain text (no Markdown formatting).
 *
 * Returns [plainText, title].
 */
export function htmlToText(html: string): [string, string | null] {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)
  const title = titleMatch ? stripTags(titleMatch[1]).trim() : null

  // Convert to markdown first, then strip markdown formatting
  const td = makeTurndown()
  let text = td.turndown(html)

  // Strip markdown formatting
  text = text.replace(/!\[[^\]]*]\([^)]+\)/g, '')                     // images
  text = text.replace(/\[([^\]]+)]\([^)]+\)/g, '$1')                 // links → text
  text = text.replace(/```[\s\S]*?```/g, (m) => m.replace(/```[^\n]*\n?/g, ''))  // code blocks
  text = text.replace(/`([^`]+)`/g, '$1')                             // inline code
  text = text.replace(/^#{1,6}\s+/gm, '')                             // headings
  text = text.replace(/^\s*[-*+]\s+/gm, '')                           // unordered lists
  text = text.replace(/^\s*\d+\.\s+/gm, '')                           // ordered lists
  text = text.replace(/(\*\*|__)(.*?)\1/g, '$2')                      // bold
  text = text.replace(/(\*|_)(.*?)\1/g, '$2')                         // italic

  text = normalizeWhitespace(text)
  return [text, title]
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
      ;[text] = htmlToText(article.content)
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
  if (extractMode === 'text') {
    const [text, title] = htmlToText(body)
    return { title, text, extractor: 'html_fallback' }
  }
  const [text, title] = htmlToMarkdown(body)
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
