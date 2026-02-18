import { describe, it, expect } from 'vitest'
import {
  htmlToMarkdown,
  htmlToText,
  extractContent,
  fetchFirecrawl,
} from '../src/extract.js'

describe('htmlToMarkdown', () => {
  it('extracts title', () => {
    const [, title] = htmlToMarkdown(
      '<html><head><title>My Title</title></head><body>x</body></html>',
    )
    expect(title).toBe('My Title')
  })

  it('returns null title when missing', () => {
    const [, title] = htmlToMarkdown('<html><body>x</body></html>')
    expect(title).toBeNull()
  })

  it('removes script/style/noscript', () => {
    const [md] = htmlToMarkdown(
      '<script>alert(1)</script><style>body{}</style><noscript>no</noscript><p>keep</p>',
    )
    expect(md).not.toContain('alert')
    expect(md).not.toContain('body{}')
    expect(md).not.toContain('noscript')
    expect(md).toContain('keep')
  })

  it('converts headings h1-h6', () => {
    const [md] = htmlToMarkdown(
      '<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4><h5>Five</h5><h6>Six</h6>',
    )
    expect(md).toContain('# One')
    expect(md).toContain('## Two')
    expect(md).toContain('### Three')
    expect(md).toContain('#### Four')
    expect(md).toContain('##### Five')
    expect(md).toContain('###### Six')
  })

  it('converts links', () => {
    const [md] = htmlToMarkdown('<a href="https://x.com">click</a>')
    expect(md).toContain('[click](https://x.com)')
  })

  it('falls back to bare href for empty link text', () => {
    const [md] = htmlToMarkdown('<a href="https://x.com"></a>')
    expect(md).toContain('https://x.com')
  })

  it('converts list items', () => {
    const [md] = htmlToMarkdown('<ul><li>A</li><li>B</li></ul>')
    expect(md).toContain('A')
    expect(md).toContain('B')
    expect(md).toMatch(/^- /m)
  })

  it('converts br and hr to newlines', () => {
    const [md] = htmlToMarkdown('a<br>b<hr>c')
    expect(md).toContain('a')
    expect(md).toContain('b')
    expect(md).toContain('c')
    expect(md).toContain('---')
  })

  it('decodes HTML entities', () => {
    const [md] = htmlToMarkdown(
      '<p>&amp; &lt; &gt; &quot; &#39; &#x41; &#65; &nbsp;</p>',
    )
    expect(md).toContain('&')
    expect(md).toContain('<')
    expect(md).toContain('>')
    expect(md).toContain('"')
    expect(md).toContain("'")
    expect(md).toContain('A') // &#x41 and &#65
  })
})

describe('htmlToText', () => {
  it('strips heading markers', () => {
    const [text] = htmlToText('<h1>Title</h1>')
    expect(text).not.toContain('#')
    expect(text).toContain('Title')
  })

  it('removes images', () => {
    const [text] = htmlToText('<img src="http://x.com/img.png" alt="alt">')
    expect(text).not.toContain('![')
    expect(text).not.toContain('img.png')
  })

  it('converts links to text only', () => {
    const [text] = htmlToText('<a href="http://x.com">link</a>')
    expect(text).toContain('link')
    expect(text).not.toContain('http://x.com')
  })

  it('strips inline code backticks', () => {
    const [text] = htmlToText('<code>code</code>')
    expect(text).toContain('code')
    expect(text).not.toContain('`')
  })

  it('strips bold and italic', () => {
    const [text] = htmlToText('<strong>bold</strong> and <em>italic</em>')
    expect(text).toContain('bold')
    expect(text).toContain('italic')
    expect(text).not.toContain('**')
    expect(text).not.toContain('*italic*')
  })
})

describe('extractContent', () => {
  it('extracts HTML via readability or fallback', () => {
    const result = extractContent(
      '<html><body><article><p>This is a long enough paragraph to pass the readability threshold of fifty characters for testing.</p></article></body></html>',
      { contentType: 'text/html; charset=utf-8' },
    )
    expect(['readability', 'html_fallback']).toContain(result.extractor)
    expect(result.text).toBeTruthy()
  })

  it('handles case-insensitive content-type', () => {
    const result = extractContent('<p>test</p>', { contentType: 'Text/HTML' })
    expect(result.extractor).not.toBe('raw')
  })

  it('extracts and pretty-prints JSON', () => {
    const result = extractContent('{"a":1,"b":[2,3]}', {
      contentType: 'application/json',
    })
    expect(result.extractor).toBe('json')
    expect(result.text).toContain('"a": 1')
  })

  it('handles text/json content-type', () => {
    const result = extractContent('{"x":1}', { contentType: 'text/json' })
    expect(result.extractor).toBe('json')
  })

  it('falls back to raw for invalid JSON', () => {
    const result = extractContent('not json', {
      contentType: 'application/json',
    })
    expect(result.extractor).toBe('raw')
    expect(result.text).toBe('not json')
  })

  it('returns raw for text/plain', () => {
    const result = extractContent('hello world', {
      contentType: 'text/plain',
    })
    expect(result.extractor).toBe('raw')
    expect(result.text).toBe('hello world')
  })

  it('returns raw for unknown content-type', () => {
    const result = extractContent('binary data', {
      contentType: 'application/octet-stream',
    })
    expect(result.extractor).toBe('raw')
  })

  it('text mode strips markdown formatting', () => {
    const result = extractContent(
      '<html><body><article><h1>Title</h1><p>This is a long enough paragraph to pass the readability threshold of fifty characters for testing purposes.</p></article></body></html>',
      { contentType: 'text/html', extractMode: 'text' },
    )
    expect(result.text).not.toContain('#')
  })
})

describe('fetchFirecrawl', () => {
  it('returns null when disabled', async () => {
    expect(await fetchFirecrawl('http://example.com')).toBeNull()
  })
})
