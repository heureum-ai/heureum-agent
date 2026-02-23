import { describe, it, expect } from 'vitest'
import {
  SSRFError,
  validateUrl,
  validateUrlAsync,
  fetchWithSsrfGuard,
} from '../src/ssrf.js'

describe('validateUrl', () => {
  describe('allowed protocols', () => {
    it('allows https', () => {
      expect(validateUrl('https://example.com')).toBe('https://example.com')
    })

    it('allows http', () => {
      expect(validateUrl('http://example.com')).toBe('http://example.com')
    })
  })

  describe('blocked protocols', () => {
    it.each(['ftp://x.com', 'file:///etc/passwd'])(
      'blocks %s',
      (url) => {
        expect(() => validateUrl(url)).toThrow(SSRFError)
        expect(() => validateUrl(url)).toThrow(/Blocked protocol/)
      },
    )
  })

  describe('blocked hostnames', () => {
    it.each([
      'http://localhost',
      'http://metadata.google.internal',
      'http://foo.localhost',
      'http://bar.local',
      'http://baz.internal',
    ])('blocks %s', (url) => {
      expect(() => validateUrl(url)).toThrow(SSRFError)
      expect(() => validateUrl(url)).toThrow(/Blocked hostname/)
    })

    it('blocks hostname with trailing dot', () => {
      expect(() => validateUrl('http://localhost.')).toThrow(SSRFError)
    })
  })

  describe('blocked private/reserved IPs (Python _is_private_ip parity)', () => {
    const blockedIPs = [
      // 0.0.0.0/8
      '0.0.0.1',
      // 10.0.0.0/8
      '10.0.0.1',
      '10.255.255.255',
      // 100.64.0.0/10 (CGN)
      '100.64.0.1',
      '100.127.255.255',
      // 127.0.0.0/8 (loopback)
      '127.0.0.1',
      '127.255.255.255',
      // 169.254.0.0/16 (link-local)
      '169.254.0.1',
      '169.254.255.255',
      // 172.16.0.0/12
      '172.16.0.1',
      '172.31.255.255',
      // 192.0.0.0/24
      '192.0.0.1',
      // 192.0.2.0/24 (documentation)
      '192.0.2.1',
      // 192.88.99.0/24 (6to4 relay anycast)
      '192.88.99.1',
      '192.88.99.255',
      // 192.168.0.0/16
      '192.168.0.1',
      '192.168.255.255',
      // 198.18.0.0/15 (benchmark)
      '198.18.0.1',
      '198.19.255.255',
      // 198.51.100.0/24 (documentation)
      '198.51.100.1',
      // 203.0.113.0/24 (documentation)
      '203.0.113.1',
      // 224.0.0.0/4 (multicast)
      '224.0.0.1',
      '239.255.255.255',
      // 240.0.0.0/4 (reserved)
      '240.0.0.1',
      '255.255.255.255',
    ]

    it.each(blockedIPs)('blocks %s', (ip) => {
      expect(() => validateUrl(`http://${ip}`)).toThrow(SSRFError)
    })
  })

  describe('allowed public IPs', () => {
    const publicIPs = [
      '1.1.1.1',
      '8.8.8.8',
      '93.184.216.34',
      '100.63.255.255', // just below 100.64.0.0/10
      '172.15.255.255', // just below 172.16.0.0/12
      '172.32.0.1', // just above 172.31.255.255
      '192.1.0.1',
      '198.17.255.255', // just below 198.18.0.0/15
      '203.0.114.1', // just above 203.0.113.0/24
    ]

    it.each(publicIPs)('allows %s', (ip) => {
      expect(validateUrl(`http://${ip}`)).toBe(`http://${ip}`)
    })
  })
})

describe('IPv6 v4-mapped addresses (all representations)', () => {
  it.each([
    // Dotted decimal form (standard)
    'http://[::ffff:127.0.0.1]',
    // Hex form (expanded)
    'http://[0000:0000:0000:0000:0000:ffff:7f00:0001]',
    // Hex form (compressed)
    'http://[::ffff:7f00:1]',
    // Private 10.x via v4-mapped
    'http://[::ffff:10.0.0.1]',
    'http://[::ffff:a00:1]',
  ])('blocks v4-mapped private: %s', (url) => {
    expect(() => validateUrl(url)).toThrow(SSRFError)
  })
})

describe('IPv6 native addresses', () => {
  it.each([
    'http://[::1]',             // loopback
    'http://[fe80::1]',         // link-local
    'http://[fc00::1]',         // unique local
    'http://[fd00::1]',         // unique local
    'http://[ff02::1]',         // multicast
  ])('blocks private IPv6: %s', (url) => {
    expect(() => validateUrl(url)).toThrow(SSRFError)
  })
})

describe('IPv6 reserved ranges (Python ipaddress parity)', () => {
  it.each([
    // 64:ff9b::/96 (NAT64 well-known prefix)
    'http://[64:ff9b::1]',
    'http://[64:ff9b::192.168.1.1]',
    // 64:ff9b:1::/48 (NAT64 for private internets)
    'http://[64:ff9b:1::1]',
    // 100::/64 (discard prefix, RFC 6666)
    'http://[100::1]',
    'http://[100::ffff]',
    // 2001::/23 (IETF protocol assignments — includes Teredo, benchmarking)
    'http://[2001::1]',
    'http://[2001:1ff::1]',
    // 2001:db8::/32 (documentation)
    'http://[2001:db8::1]',
    'http://[2001:db8:ffff::1]',
    // 2002::/16 (6to4, may embed private IPv4)
    'http://[2002::1]',
    'http://[2002:c0a8:100::1]',
  ])('blocks reserved IPv6: %s', (url) => {
    expect(() => validateUrl(url)).toThrow(SSRFError)
  })

  it.each([
    // 2001:200::/23 boundary — just outside 2001::/23
    'http://[2001:200::1]',
    // Public IPv6
    'http://[2607:f8b0:4004:800::200e]',
  ])('allows public IPv6: %s', (url) => {
    expect(validateUrl(url)).toBe(url)
  })
})

describe('IPv4-compatible IPv6 (deprecated, all reserved)', () => {
  it.each([
    // All IPv4-compatible addresses are reserved (deprecated per RFC 4291)
    'http://[::10.0.0.1]',      // private embedded
    'http://[::127.0.0.1]',     // loopback embedded
    'http://[::192.168.1.1]',   // private embedded
    'http://[::8.8.8.8]',       // public embedded — still reserved
  ])('blocks IPv4-compatible: %s', (url) => {
    expect(() => validateUrl(url)).toThrow(SSRFError)
  })
})

describe('validateUrlAsync', () => {
  it('validates example.com', async () => {
    await expect(validateUrlAsync('https://example.com')).resolves.toBe(
      'https://example.com',
    )
  })

  it('blocks localhost', async () => {
    await expect(validateUrlAsync('http://localhost')).rejects.toThrow(
      SSRFError,
    )
  })
})

describe('fetchWithSsrfGuard', () => {
  it('throws SSRFError for blocked IP', async () => {
    await expect(fetchWithSsrfGuard('http://127.0.0.1')).rejects.toThrow(
      SSRFError,
    )
  })

  it('throws SSRFError for blocked hostname', async () => {
    await expect(fetchWithSsrfGuard('http://localhost')).rejects.toThrow(
      SSRFError,
    )
  })

  it('fetches public URL', async () => {
    const res = await fetchWithSsrfGuard('https://example.com')
    expect(res.statusCode).toBe(200)
    expect(res.text).toContain('Example Domain')
    expect(res.statusMessage).toBe('OK')
    expect(res.url).toBe('https://example.com')
  })
})
