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
} & {
  [k: string]: unknown
}
