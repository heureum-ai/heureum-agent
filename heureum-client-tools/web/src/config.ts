/**
 * Web fetch configuration settings.
 *
 * Mirrors the web-fetch-related settings from Python config.py.
 */

export const settings = {
  WEB_FETCH_MAX_LENGTH: 5000,
  WEB_FETCH_TIMEOUT: 30.0,
  WEB_FETCH_USER_AGENT: 'HeureumMCP/0.1',
  SSRF_PROTECTION_ENABLED: true,
  CACHE_ENABLED: true,
  CACHE_TTL: 900.0,
  CACHE_MAX_SIZE: 100,
  SNIPPET_LENGTH: 1500,
  CONTENT_WRAPPING_ENABLED: true,
  FIRECRAWL_ENABLED: false,
  FIRECRAWL_API_KEY: '',
  FIRECRAWL_BASE_URL: 'https://api.firecrawl.dev',
  FIRECRAWL_TIMEOUT: 30.0,
}
