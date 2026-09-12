/** Generated from schemas. Do not edit. */

/**
 * Versioned MCP business contract. Runtime validation is authoritative for external JSON.
 */
export type WebSearchOutput = {
  schema_version: '0.3-draft'
  request_id: string
  status: 'ok' | 'partial' | 'empty' | 'error'
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
  query: string
  results: {
    source_id: string
    title: string
    url: string
    snippet: string
    rank: number
    /**
     * @minItems 1
     */
    providers: [string, ...string[]]
    evidence_level: 'search_snippet' | 'page_excerpt'
    published_at: string | null
    evidence_status:
      'not_requested' | 'verified' | 'unavailable' | 'no_match' | 'skipped_budget' | 'out_of_scope'
    /**
     * @maxItems 5
     */
    evidence: Evidence[]
    relevance: Relevance & {
      basis?: 'title_snippet'
      [k: string]: unknown
    }
    confidence: Confidence
    warnings: string[]
    source_metadata: SourceMetadata
    has_more_evidence: boolean
    next_evidence_cursor: string | null
    evidence_chars: number
    ranking?: {
      method: 'upstream' | 'bm25' | 'bm25_mmr'
      /**
       * Raw BM25 lexical score, not a probability. In bm25_mmr mode the final order also accounts for redundancy; this value does not include the MMR diversity penalty.
       */
      score: number | null
      original_rank: number
      corpus_size: number
      version: string
    }
  }[]
  providers: {
    id: string
    status: 'ok' | 'partial' | 'error'
    message: string | null
  }[]
  next_cursor: string | null
  scope: null | Scope
  evidence_summary: EvidenceSummary
  /**
   * Optional local execution trace identifier. No hosted tracing account is required.
   */
  trace_id?: string
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
export type EvidenceSummary = {
  mode: 'none' | 'extract'
  target_results: number
  verified_results: number
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
export interface Confidence {
  scope: 'evidence_traceability'
  level: 'high' | 'medium' | 'low' | 'unknown'
  method: 'traceability_v1'
  /**
   * @minItems 1
   */
  reasons: [string, ...string[]]
  fact_probability: null
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
export interface Scope {
  sites: string[]
  exclude_domains: string[]
  include_subdomains: boolean
  enforcement: 'application' | 'none'
  upstream_mode: 'none' | 'native' | 'query_rewrite' | 'post_filter_only' | 'mixed'
  removed_count: number
}
