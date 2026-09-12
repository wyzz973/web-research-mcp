/** Generated from schemas. Do not edit. */

/**
 * Versioned MCP business contract. Runtime validation is authoritative for external JSON.
 */
export type WebFetchInput = {
  url?: string
  cursor?: string
  /**
   * Default applies to initial URL reads only; omitted format on continuation inherits the cursor format.
   */
  format?: 'markdown' | 'text'
  max_chars?: number
  /**
   * Fetch strategy for new URL reads. static uses HTTP/readability; crawl4ai renders with a protected local Chromium; auto falls back only after static EXTRACTION_FAILED or under 80 visible HTML text characters. Requires pnpm crawl4ai:setup for browser rendering.
   */
  engine?: 'static' | 'crawl4ai' | 'auto'
} & {
  [k: string]: unknown
}
