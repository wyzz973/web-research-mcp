/** Generated from schemas. Do not edit. */

export interface RuntimeConfiguration {
  transport: 'stdio'
  search: {
    provider: 'searxng'
    base_url: string | null
    limit: number
    deadline_ms: number
    provider_timeout_ms: number
    cache_ttl_seconds: number
    upstream_policy: {
      access_mode: 'public-anonymous'
      requires_account: false
      requires_api_key: false
      requires_payment: false
      allow_keyed_fallback: false
      allow_paid_proxy_dependency: false
    }
    engine_allowlist: string[]
    evidence: {
      default_mode: 'none'
      default_max_results: number
      max_results: number
      max_passages_per_result: number
      max_chars_per_passage: number
      total_deadline_ms: number
      max_chars_per_result: number
      max_candidate_passages: number
    }
    scope: {
      include_subdomains: boolean
      max_sites: number
    }
    retrieval: {
      max_upstream_requests: number
      max_pages_per_query: number
      max_candidates: number
    }
  }
  fetch: {
    deadline_ms: number
    max_redirects: number
    max_decompressed_bytes: number
    max_chars: number
    per_host_concurrency: number
    public_urls_only: true
    respect_robots: true
    browser_fallback: boolean
    global_concurrency: number
    parser_worker_concurrency: number
    parser_timeout_ms: number
    max_compressed_bytes: number
    max_output_chars: number
    allow_https_downgrade: false
    parser_memory_mb: number
    user_agent: string
    default_engine: 'static' | 'crawl4ai' | 'auto'
    crawl4ai: {
      enabled: boolean
      deadline_ms: number
      wait_ms: number
      concurrency: number
    }
  }
  ranking: {
    mode: 'upstream' | 'bm25' | 'bm25_mmr'
    rrf_enabled: false
    rrf_k: number
    embeddings_enabled: false
    reranker_enabled: false
    relevance_method: 'lexical_coverage_v1'
    confidence_method: 'traceability_v1'
  }
  storage: {
    directory: string
    snapshot_ttl_seconds: number
    max_bytes: number
  }
  logging: {
    stream: 'stderr'
    include_query_text: false
  }
  observability?: {
    enabled: boolean
    /**
     * Record bounded query and text previews locally. False records only operational metadata.
     */
    capture_content: boolean
  }
}
