/** Generated from schemas. Do not edit. */

/**
 * Versioned MCP business contract. Runtime validation is authoritative for external JSON.
 */
export type WebFetchOutput = {
  schema_version: '0.2-draft'
  request_id: string
  status: 'ok' | 'partial' | 'error'
  warnings: string[]
  error: null | {
    code:
      | 'CONFIGURATION_REQUIRED'
      | 'RATE_LIMITED'
      | 'UPSTREAM_BLOCKED'
      | 'UPSTREAM_UNAVAILABLE'
      | 'TIMEOUT'
      | 'FETCH_BLOCKED'
      | 'ROBOTS_DENIED'
      | 'UNSUPPORTED_CONTENT_TYPE'
      | 'RESPONSE_TOO_LARGE'
      | 'EXTRACTION_FAILED'
      | 'CURSOR_EXPIRED'
      | 'CURSOR_MISMATCH'
      | 'HTTP_ERROR'
      | 'CANCELLED'
      | 'STORAGE_UNAVAILABLE'
      | 'INTERNAL_ERROR'
      | 'INVALID_ARGUMENT'
      | 'SEARCH_BUDGET_EXHAUSTED'
    message: string
    retryable: boolean
    retry_after_ms?: number
    http_status?: number
  }
  source_id?: string
  snapshot_id?: string
  url?: string
  final_url?: string
  title?: string
  fetched_at?: string
  content_type?: string
  content?: string
  content_sha256?: string
  segments?: {
    id: string
    text: string
    start_char: number
    end_char: number
  }[]
  /**
   * True only when more snapshot content remains after this page; the final page is false even when its start offset is nonzero.
   */
  truncated?: boolean
  next_cursor?: string | null
}
