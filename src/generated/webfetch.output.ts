/** Generated from schemas. Do not edit. */

/**
 * Versioned MCP business contract. Runtime validation is authoritative for external JSON.
 */
export type WebFetchOutput = {
  schema_version: '0.3-draft'
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
  view?: 'document' | 'evidence'
  source_metadata?: SourceMetadata
  /**
   * @maxItems 5
   */
  evidence?: Evidence[]
  has_more_evidence?: boolean
  next_evidence_cursor?: string | null
  evidence_chars?: number
}
export type Relevance = {
  score: number | null
  method: 'lexical_coverage_v1' | 'none'
  version: string | null
  basis: 'title_snippet' | 'quote'
  matched_terms: string[]
  /**
   * @minItems 1
   */
  reasons: [string, ...string[]]
}

/**
 * Display metadata from the actual page or an explicitly marked URL-only fallback. URLs are not downloaded or certified.
 */
export interface SourceMetadata {
  source_url: string
  final_url: string | null
  canonical_url: string | null
  hostname: string
  domain: string
  origin: string
  display_url: string
  site_name: string
  description: string | null
  language: string | null
  favicon_url: string | null
  logo_url: string | null
  image_url: string | null
  published_at: string | null
  modified_at: string | null
  retrieved_at: string | null
  metadata_source: 'url_only' | 'html'
  metadata_url: string | null
  assets_verified: false
  provenance: {
    site_name: 'hostname' | 'opengraph' | 'application_name'
    favicon_url: 'html_link' | 'origin_fallback' | 'none'
    logo_url: 'json_ld' | 'none'
    image_url: 'opengraph' | 'none'
    canonical_url: 'html_link' | 'none'
  }
}
export interface Evidence {
  id: string
  quote: string
  url: string
  snapshot_id: string
  snapshot_format: 'text'
  content_sha256: string
  segment_id: string
  start_char: number
  end_char: number
  fetched_at: string
  expires_at: string
  extractor_version: string
  snapshot_cursor: string
  verification: 'exact_match'
  relevance: Relevance & {
    basis?: 'quote'
    [k: string]: unknown
  }
  /**
   * @minItems 1
   */
  segment_ids: [string, ...string[]]
  selection_method: 'paragraph_context_v2'
}
