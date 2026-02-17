import { describe, it, expect } from 'vitest'
import { TTLCache, makeCacheKey } from '../src/cache.js'

describe('TTLCache', () => {
  it('get returns value and shallow copies dicts', () => {
    const c = new TTLCache(10, 5)
    c.set('d', { a: 1, b: 2 })
    const d1 = c.get('d')
    expect(d1).toEqual({ a: 1, b: 2 })
    d1.a = 999
    expect(c.get('d').a).toBe(1) // original not mutated
  })

  it('get returns shallow copy of arrays', () => {
    const c = new TTLCache(10, 5)
    c.set('l', [1, 2, 3])
    const l1 = c.get('l')
    l1.push(4)
    expect(c.get('l')).toEqual([1, 2, 3])
  })

  it('passes through primitives', () => {
    const c = new TTLCache(10, 5)
    c.set('n', 42)
    expect(c.get('n')).toBe(42)
    c.set('s', 'hello')
    expect(c.get('s')).toBe('hello')
    c.set('b', true)
    expect(c.get('b')).toBe(true)
  })

  it('returns null for missing keys', () => {
    const c = new TTLCache(10, 5)
    expect(c.get('nonexistent')).toBeNull()
  })

  it('returns null for null values', () => {
    const c = new TTLCache(10, 5)
    c.set('null', null)
    expect(c.get('null')).toBeNull()
  })

  it('evicts oldest entries when over max_size (FIFO)', () => {
    const c = new TTLCache(10, 3)
    c.set('a', 1)
    c.set('b', 2)
    c.set('c', 3)
    c.set('d', 4) // evicts 'a'
    expect(c.get('a')).toBeNull()
    expect(c.get('b')).toBe(2)
    expect(c.get('d')).toBe(4)
  })

  it('expires entries after TTL', async () => {
    const c = new TTLCache(0.001, 10) // 1ms TTL
    c.set('exp', 'val')
    await new Promise((r) => setTimeout(r, 10))
    expect(c.get('exp')).toBeNull()
  })

  it('clear removes all entries', () => {
    const c = new TTLCache(10, 5)
    c.set('a', 1)
    c.set('b', 2)
    c.clear()
    expect(c.get('a')).toBeNull()
    expect(c.get('b')).toBeNull()
  })
})

describe('makeCacheKey', () => {
  it('returns 64-char SHA-256 hex digest', () => {
    const k = makeCacheKey('fetch', 'http://example.com', '5000', '0', 'markdown')
    expect(k).toHaveLength(64)
    expect(k).toMatch(/^[0-9a-f]{64}$/)
  })

  it('is deterministic', () => {
    const k1 = makeCacheKey('fetch', 'http://example.com', '5000', '0', 'markdown')
    const k2 = makeCacheKey('fetch', 'http://example.com', '5000', '0', 'markdown')
    expect(k1).toBe(k2)
  })

  it('different inputs produce different keys', () => {
    const k1 = makeCacheKey('fetch', 'http://example.com', '5000', '0', 'markdown')
    const k2 = makeCacheKey('fetch', 'http://example.com', '5000', '0', 'text')
    const k3 = makeCacheKey('fetch', 'http://other.com', '5000', '0', 'markdown')
    expect(k1).not.toBe(k2)
    expect(k1).not.toBe(k3)
  })
})
