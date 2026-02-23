/**
 * SSRF (Server-Side Request Forgery) protection with DNS pinning.
 *
 * Validates URLs and resolved IPs to prevent requests to internal/private networks.
 * Uses DNS pinning (pre-resolved IP → transport binding) to prevent DNS rebinding,
 * and manual redirect handling to validate each hop independently.
 */

import dns from 'node:dns/promises'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'

import { settings } from './config.js'

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
])
const BLOCKED_HOSTNAME_SUFFIXES = [
  '.localhost',
  '.local',
  '.internal',
]

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const MAX_REDIRECTS = 5

export class SSRFError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SSRFError'
  }
}

/**
 * Parse an IPv6 address string into 8 groups of 16-bit values.
 * Handles :: expansion and embedded dotted-decimal IPv4.
 */
function parseIPv6Groups(ip: string): number[] | null {
  const clean = ip.split('%')[0] // remove zone ID

  // Check for embedded IPv4 (e.g., ::ffff:10.0.0.1)
  const lastColon = clean.lastIndexOf(':')
  const lastPart = clean.substring(lastColon + 1)
  const hasEmbeddedV4 = lastPart.includes('.')
  let hexPart = hasEmbeddedV4 ? clean.substring(0, lastColon) : clean

  let groups: number[]
  if (hexPart.includes('::')) {
    const idx = hexPart.indexOf('::')
    const left = hexPart.substring(0, idx)
    const right = hexPart.substring(idx + 2)
    const leftGroups = left ? left.split(':').map((h) => parseInt(h, 16)) : []
    const rightGroups = right ? right.split(':').map((h) => parseInt(h, 16)) : []
    const targetLen = hasEmbeddedV4 ? 6 : 8
    const missing = targetLen - leftGroups.length - rightGroups.length
    if (missing < 0) return null
    groups = [...leftGroups, ...Array(missing).fill(0), ...rightGroups]
  } else {
    groups = hexPart ? hexPart.split(':').map((h) => parseInt(h, 16)) : []
  }

  if (hasEmbeddedV4) {
    const v4Parts = lastPart.split('.').map(Number)
    if (v4Parts.length !== 4 || v4Parts.some((p) => isNaN(p) || p < 0 || p > 255)) return null
    groups.push((v4Parts[0] << 8) | v4Parts[1])
    groups.push((v4Parts[2] << 8) | v4Parts[3])
  }

  return groups.length === 8 && groups.every((g) => !isNaN(g) && g >= 0 && g <= 0xffff)
    ? groups
    : null
}

/**
 * Extract the IPv4 address from an IPv4-mapped IPv6 address.
 * Handles all representations: ::ffff:10.0.0.1, ::ffff:a00:1, 0:0:0:0:0:ffff:a00:1, etc.
 */
function getIPv4FromMappedIPv6(ip: string): string | null {
  const groups = parseIPv6Groups(ip)
  if (groups == null || groups.length !== 8) return null

  // IPv4-mapped: first 5 groups = 0, 6th = 0xffff
  if (
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
    groups[3] === 0 && groups[4] === 0 && groups[5] === 0xffff
  ) {
    const hi = groups[6]
    const lo = groups[7]
    return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`
  }
  return null
}

/**
 * Check if an IP address is private, reserved, loopback, or link-local.
 */
function isPrivateIp(ipStr: string): boolean {
  // Try IPv4
  if (net.isIPv4(ipStr)) {
    const parts = ipStr.split('.').map(Number)
    const [a, b, c, d] = parts

    // 0.0.0.0/8
    if (a === 0) return true
    // 10.0.0.0/8
    if (a === 10) return true
    // 100.64.0.0/10
    if (a === 100 && b >= 64 && b <= 127) return true
    // 127.0.0.0/8 (loopback)
    if (a === 127) return true
    // 169.254.0.0/16 (link-local)
    if (a === 169 && b === 254) return true
    // 172.16.0.0/12
    if (a === 172 && b >= 16 && b <= 31) return true
    // 192.0.0.0/24
    if (a === 192 && b === 0 && c === 0) return true
    // 192.0.2.0/24 (documentation)
    if (a === 192 && b === 0 && c === 2) return true
    // 192.88.99.0/24 (6to4 relay anycast)
    if (a === 192 && b === 88 && c === 99) return true
    // 192.168.0.0/16
    if (a === 192 && b === 168) return true
    // 198.18.0.0/15 (benchmark)
    if (a === 198 && (b === 18 || b === 19)) return true
    // 198.51.100.0/24 (documentation)
    if (a === 198 && b === 51 && c === 100) return true
    // 203.0.113.0/24 (documentation)
    if (a === 203 && b === 0 && c === 113) return true
    // 224.0.0.0/4 (multicast)
    if (a >= 224 && a <= 239) return true
    // 240.0.0.0/4 (reserved)
    if (a >= 240) return true

    return false
  }

  // IPv6
  if (net.isIPv6(ipStr)) {
    // Check IPv4-mapped ::ffff:x.x.x.x in all representations
    const v4Mapped = getIPv4FromMappedIPv6(ipStr)
    if (v4Mapped != null) return isPrivateIp(v4Mapped)

    // Parse into 8 x 16-bit groups for precise checks
    const groups = parseIPv6Groups(ipStr)
    if (groups == null) return true // unparseable → block

    // :: (unspecified)  — all zeros
    if (groups.every((g) => g === 0)) return true
    // ::1 (loopback)   — all zeros except last = 1
    if (groups[7] === 1 && groups.slice(0, 7).every((g) => g === 0)) return true

    // IPv4-compatible ::x.x.x.x (deprecated per RFC 4291, all reserved)
    // Already filtered :: and ::1 above, so groups[0-5]=0 means IPv4-compatible
    if (groups[0] === 0 && groups[1] === 0 && groups[2] === 0 &&
        groups[3] === 0 && groups[4] === 0 && groups[5] === 0) return true

    // 64:ff9b::/96 (NAT64 well-known prefix)
    if (groups[0] === 0x0064 && groups[1] === 0xff9b &&
        groups[2] === 0 && groups[3] === 0 && groups[4] === 0 && groups[5] === 0) return true
    // 64:ff9b:1::/48 (NAT64 for private internets)
    if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 0x0001) return true
    // 100::/64 (discard prefix, RFC 6666)
    if (groups[0] === 0x0100 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0) return true
    // 2001::/23 (IETF protocol assignments — includes Teredo, benchmarking)
    if (groups[0] === 0x2001 && groups[1] < 0x0200) return true
    // 2001:db8::/32 (documentation, separate from 2001::/23)
    if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true
    // 2002::/16 (6to4, may embed private IPv4)
    if (groups[0] === 0x2002) return true
    // fe80::/10 (link-local) — first 10 bits = 0xfe80
    if ((groups[0] & 0xffc0) === 0xfe80) return true
    // fc00::/7 (unique local) — first 7 bits = 0xfc00
    if ((groups[0] & 0xfe00) === 0xfc00) return true
    // ff00::/8 (multicast) — first 8 bits = 0xff00
    if ((groups[0] & 0xff00) === 0xff00) return true

    return false
  }

  // Unparseable → block
  return true
}

function checkHostname(hostname: string): void {
  const lower = hostname.toLowerCase().replace(/^\.+|\.+$/g, '')
  if (BLOCKED_HOSTNAMES.has(lower)) {
    throw new SSRFError(`Blocked hostname: ${hostname}`)
  }
  for (const suffix of BLOCKED_HOSTNAME_SUFFIXES) {
    if (lower.endsWith(suffix)) {
      throw new SSRFError(`Blocked hostname: ${hostname}`)
    }
  }
}

function checkIp(ipStr: string): void {
  if (isPrivateIp(ipStr)) {
    throw new SSRFError(`Blocked private/reserved IP: ${ipStr}`)
  }
}

/**
 * Strip square brackets from IPv6 hostname (URL parser returns "[::1]" not "::1").
 */
function stripBrackets(hostname: string): string {
  if (hostname.startsWith('[') && hostname.endsWith(']')) {
    return hostname.slice(1, -1)
  }
  return hostname
}

function isIpLiteral(hostname: string): boolean {
  return net.isIP(stripBrackets(hostname)) !== 0
}

/**
 * Validate a URL for SSRF safety (synchronous, no DNS resolution).
 */
export function validateUrl(url: string): string {
  if (!settings.SSRF_PROTECTION_ENABLED) return url

  const parsed = new URL(url)

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SSRFError(`Blocked protocol: ${parsed.protocol.replace(':', '')}`)
  }

  const hostname = parsed.hostname
  if (!hostname) {
    throw new SSRFError('Missing hostname in URL')
  }

  checkHostname(hostname)

  if (isIpLiteral(hostname)) {
    checkIp(stripBrackets(hostname))
  }

  return url
}

/**
 * Validate a URL for SSRF safety with async DNS resolution.
 */
export async function validateUrlAsync(url: string): Promise<string> {
  if (!settings.SSRF_PROTECTION_ENABLED) return url

  const parsed = new URL(url)

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new SSRFError(`Blocked protocol: ${parsed.protocol.replace(':', '')}`)
  }

  const hostname = parsed.hostname
  if (!hostname) {
    throw new SSRFError('Missing hostname in URL')
  }

  checkHostname(hostname)

  if (isIpLiteral(hostname)) {
    checkIp(stripBrackets(hostname))
    return url
  }

  let addresses: { address: string; family: number }[]
  try {
    addresses = await dns.lookup(hostname, { all: true })
  } catch {
    throw new SSRFError(`DNS resolution failed for: ${hostname}`)
  }

  if (addresses.length === 0) {
    throw new SSRFError(`DNS resolution returned no results for: ${hostname}`)
  }

  for (const addr of addresses) {
    checkIp(addr.address)
  }

  return url
}

/**
 * Resolve hostname, validate all IPs, return {hostname: pinnedIp} map.
 */
async function resolveAndPin(hostname: string): Promise<Map<string, string>> {
  let addresses: { address: string; family: number }[]
  try {
    addresses = await dns.lookup(hostname, { all: true })
  } catch {
    throw new SSRFError(`DNS resolution failed for: ${hostname}`)
  }

  if (addresses.length === 0) {
    throw new SSRFError(`DNS resolution returned no results for: ${hostname}`)
  }

  const seen = new Set<string>()
  const validIps: string[] = []
  for (const addr of addresses) {
    checkIp(addr.address)
    if (!seen.has(addr.address)) {
      seen.add(addr.address)
      validIps.push(addr.address)
    }
  }

  if (validIps.length === 0) {
    throw new SSRFError(`No valid public IPs for: ${hostname}`)
  }

  return new Map([[hostname, validIps[0]]])
}

export interface FetchResponse {
  statusCode: number
  statusMessage: string
  headers: Record<string, string | string[] | undefined>
  text: string
  url: string
}

/**
 * Create an http.Agent or https.Agent that pins connections to pre-resolved IPs.
 *
 * Overrides `createConnection` on the instance (NOT via constructor options,
 * which Node.js silently ignores). Delegates to the original prototype method
 * with the host replaced by the pinned IP, preserving TLS/SNI behavior.
 */
function createPinnedAgent(
  addressMap: Map<string, string>,
  isHttps: boolean,
): http.Agent | https.Agent {
  const agent = isHttps ? new https.Agent() : new http.Agent()
  const origCreateConnection = agent.createConnection
  ;(agent as any).createConnection = function (options: any, oncreate: any) {
    const pinnedIp = addressMap.get(options.host) ?? options.host
    return origCreateConnection.call(this, { ...options, host: pinnedIp }, oncreate)
  }
  return agent
}

/**
 * Make an HTTP(S) request using Node.js native http/https modules.
 */
async function nativeRequest(
  url: string,
  options: {
    headers?: Record<string, string>
    agent?: http.Agent | https.Agent
    timeout?: number
    servername?: string
  },
): Promise<FetchResponse> {
  return await new Promise((resolve, reject) => {
    const parsed = new URL(url)
    const isHttps = parsed.protocol === 'https:'
    const mod = isHttps ? https : http

    const reqOpts: http.RequestOptions = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: options.headers,
      agent: options.agent,
      timeout: options.timeout,
    }

    if (isHttps && options.servername) {
      ;(reqOpts as https.RequestOptions).servername = options.servername
    }

    const req = mod.request(reqOpts, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const buf = Buffer.concat(chunks)
        // Detect charset from Content-Type (mirrors Python httpx auto-detection)
        const ct = res.headers['content-type'] ?? ''
        const charsetMatch = /charset=["']?([^\s;"']+)/i.exec(String(ct))
        const charset = charsetMatch ? charsetMatch[1] : 'utf-8'
        let text: string
        try {
          text = new TextDecoder(charset).decode(buf)
        } catch {
          text = buf.toString('utf-8')
        }
        const headers: Record<string, string | string[] | undefined> = {}
        for (const [key, value] of Object.entries(res.headers)) {
          headers[key] = value
        }
        resolve({
          statusCode: res.statusCode ?? 0,
          statusMessage: res.statusMessage ?? '',
          headers,
          text,
          url,
        })
      })
      res.on('error', reject)
    })

    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error(`Request timed out after ${options.timeout}ms`))
    })

    req.end()
  })
}

/**
 * Fetch URL with SSRF protection, DNS pinning, and manual redirect handling.
 *
 * For each hop (including redirects):
 *   1. Validates protocol, hostname blocklist, IP literals
 *   2. Resolves DNS and validates all resolved IPs
 *   3. Pins transport to the validated IP (prevents DNS rebinding)
 *   4. Makes the request through the pinned connection
 */
export async function fetchWithSsrfGuard(
  url: string,
  options: {
    headers?: Record<string, string>
    maxRedirects?: number
    timeout?: number
  } = {},
): Promise<FetchResponse> {
  const {
    headers,
    maxRedirects = MAX_REDIRECTS,
    timeout = 30.0,
  } = options
  const timeoutMs = timeout * 1000

  if (!settings.SSRF_PROTECTION_ENABLED) {
    // Python httpx.AsyncClient defaults to follow_redirects=False
    return nativeRequest(url, { headers, timeout: timeoutMs })
  }

  const visited = new Set<string>()
  let currentUrl = url
  let redirectCount = 0

  while (true) {
    const parsed = new URL(currentUrl)

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new SSRFError(`Blocked protocol: ${parsed.protocol.replace(':', '')}`)
    }

    const hostname = parsed.hostname
    if (!hostname) {
      throw new SSRFError('Missing hostname in URL')
    }

    checkHostname(hostname)

    let addressMap: Map<string, string>

    if (isIpLiteral(hostname)) {
      const bareIp = stripBrackets(hostname)
      checkIp(bareIp)
      addressMap = new Map([[hostname, bareIp]])
    } else {
      addressMap = await resolveAndPin(hostname)
    }

    const isHttps = parsed.protocol === 'https:'
    const agent = createPinnedAgent(addressMap, isHttps)

    let response: FetchResponse
    try {
      response = await nativeRequest(currentUrl, {
        headers,
        agent,
        timeout: timeoutMs,
        servername: hostname,
      })
    } finally {
      agent.destroy()
    }

    if (!REDIRECT_STATUSES.has(response.statusCode)) {
      return response
    }

    const location = response.headers['location']
    const locationStr = Array.isArray(location) ? location[0] : location
    if (!locationStr) {
      throw new SSRFError(
        `Redirect missing Location header (${response.statusCode})`,
      )
    }

    redirectCount++
    if (redirectCount > maxRedirects) {
      throw new SSRFError(`Too many redirects (limit: ${maxRedirects})`)
    }

    const nextUrl = new URL(locationStr, currentUrl).href

    if (visited.has(nextUrl)) {
      throw new SSRFError('Redirect loop detected')
    }

    visited.add(nextUrl)
    currentUrl = nextUrl
  }
}
