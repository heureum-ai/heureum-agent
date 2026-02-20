/**
 * Simple TTL cache using Map + performance.now().
 *
 * No external dependencies required.
 */

import crypto from 'node:crypto'

import { settings } from './config.js'

export class TTLCache {
  private _ttl: number
  private _maxSize: number
  private _store = new Map<string, { value: unknown; expireAt: number }>()

  constructor(ttl: number = 900.0, maxSize: number = 100) {
    this._ttl = ttl * 1000 // convert seconds → ms
    this._maxSize = maxSize
  }

  /**
   * Return a shallow copy of cached value if present and not expired, else null.
   */
  get(key: string): any {
    const entry = this._store.get(key)
    if (entry == null) return null
    if (performance.now() > entry.expireAt) {
      this._store.delete(key)
      return null
    }
    const { value } = entry
    if (value != null && typeof value === 'object') {
      if (Array.isArray(value)) return [...value]
      return { ...value }
    }
    return value
  }

  /**
   * Store a value with TTL. Evicts oldest entries if over maxSize.
   */
  set(key: string, value: unknown): void {
    this._evictExpired()
    while (this._store.size >= this._maxSize) {
      const oldestKey = this._store.keys().next().value!
      this._store.delete(oldestKey)
    }
    this._store.set(key, { value, expireAt: performance.now() + this._ttl })
  }

  clear(): void {
    this._store.clear()
  }

  private _evictExpired(): void {
    const now = performance.now()
    for (const [k, entry] of this._store) {
      if (now > entry.expireAt) {
        this._store.delete(k)
      }
    }
  }
}

/**
 * Create a deterministic cache key from parts (SHA-256 hex digest).
 */
export function makeCacheKey(...parts: string[]): string {
  const raw = parts.map(String).join(':')
  return crypto.createHash('sha256').update(raw).digest('hex')
}

export const fetchCache = new TTLCache(settings.CACHE_TTL, settings.CACHE_MAX_SIZE)
