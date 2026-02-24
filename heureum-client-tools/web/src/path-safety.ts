import { createHash } from 'node:crypto'

const WINDOWS_RESERVED_BASENAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'com5',
  'com6',
  'com7',
  'com8',
  'com9',
  'lpt1',
  'lpt2',
  'lpt3',
  'lpt4',
  'lpt5',
  'lpt6',
  'lpt7',
  'lpt8',
  'lpt9',
])

function shortHash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 6)
}

function isWindowsReservedBasename(value: string): boolean {
  const basename = value.split('.')[0].toLowerCase()
  return WINDOWS_RESERVED_BASENAMES.has(basename)
}

type SanitizeOptions = {
  fallback?: string
  maxLength?: number
  hashOnChange?: boolean
}

function normalizeToken(value: string): string {
  return value
    .trim()
    .replace(/[^\p{L}\p{N}._-]+/gu, '_')
    .replace(/_+/g, '_')
    .replace(/^[_.\s-]+|[_.\s-]+$/g, '')
}

function finalizeToken(value: string, fallback: string): string {
  let token = value

  if (!token || token === '.' || token === '..') {
    token = fallback
  }

  if (isWindowsReservedBasename(token)) {
    token = `${token}_`
  }

  token = token.replace(/[.\s]+$/g, '')

  if (!token || token === '.' || token === '..') {
    token = fallback
  }

  if (isWindowsReservedBasename(token)) {
    token = `${token}_`
  }

  return token
}

export function sanitizeFileToken(value: string, options: SanitizeOptions = {}): string {
  const fallback = normalizeToken(options.fallback ?? 'item') || 'item'
  const maxLength = Math.max(8, options.maxLength ?? 80)
  const raw = value ?? ''

  let token = finalizeToken(normalizeToken(raw), fallback)

  if (options.hashOnChange && raw.trim() !== token) {
    const hash = shortHash(raw)
    const keepLength = Math.max(1, maxLength - hash.length - 1)
    token = `${token.slice(0, keepLength)}-${hash}`
  }

  token = finalizeToken(token.slice(0, maxLength), fallback)
  return token.slice(0, maxLength)
}

export function sanitizePathSegment(
  value: string,
  options: Omit<SanitizeOptions, 'hashOnChange'> = {},
): string {
  return sanitizeFileToken(value, {
    fallback: options.fallback ?? 'segment',
    maxLength: options.maxLength ?? 64,
    hashOnChange: true,
  })
}

export function escapePathForReadHint(filePath: string): string {
  return filePath
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
}
