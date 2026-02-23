import { describe, it, expect } from 'vitest'
import { isBrowserPageContent, extractPageHeader } from '../src/content-parser.js'

describe('isBrowserPageContent', () => {
  it('returns true for content starting with "Page:"', () => {
    expect(isBrowserPageContent('Page: "Example" URL: https://example.com')).toBe(true)
  })

  it('returns true for content containing "[Interactive Elements]"', () => {
    const content = 'Some prefix text\n[Interactive Elements]\n1. [button] "Submit"'
    expect(isBrowserPageContent(content)).toBe(true)
  })

  it('returns false for non-browser content', () => {
    expect(isBrowserPageContent('Hello world')).toBe(false)
    expect(isBrowserPageContent('Error: page not found')).toBe(false)
    expect(isBrowserPageContent('')).toBe(false)
  })

  it('only checks first 500 chars for [Interactive Elements]', () => {
    const padding = 'x'.repeat(600)
    expect(isBrowserPageContent(padding + '[Interactive Elements]')).toBe(false)
  })
})

describe('extractPageHeader', () => {
  it('extracts title and URL from standard format', () => {
    const content = 'Page: "Google" URL: https://google.com\n[Interactive Elements]\n...'
    expect(extractPageHeader(content)).toBe('Page: "Google" URL: https://google.com')
  })

  it('extracts title only when URL is missing', () => {
    const content = 'Page: "My Site"\nSome other text'
    expect(extractPageHeader(content)).toBe('Page: "My Site"')
  })

  it('falls back to first line when no match', () => {
    const content = 'Some random content\nSecond line'
    expect(extractPageHeader(content)).toBe('Some random content')
  })

  it('truncates fallback to 120 chars', () => {
    const long = 'A'.repeat(200)
    expect(extractPageHeader(long).length).toBe(120)
  })
})
