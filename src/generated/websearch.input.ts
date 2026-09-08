/** Generated from schemas. Do not edit. */

/**
 * Versioned MCP business contract. Runtime validation is authoritative for external JSON.
 */
export type WebSearchInput = {
  query: string
  limit?: number
  language?: string
  time_range?: 'any' | 'day' | 'month' | 'year'
  /**
   * Alias for sites; cannot be supplied together with sites.
   *
   * @maxItems 20
   */
  include_domains?: string[]
  /**
   * DNS hostnames only, including IDN. Runtime resolves IDNA and rejects IPs, single-label names and public suffixes.
   *
   * @maxItems 20
   */
  exclude_domains?: string[]
  cursor?: string
  /**
   * DNS hostnames only, including IDN. Runtime resolves IDNA and rejects IPs, single-label names and public suffixes.
   *
   * @maxItems 20
   */
  sites?: string[]
  include_subdomains?: boolean
  evidence_mode?: 'none' | 'extract'
  /**
   * Only valid with evidence_mode=extract; bounded by deployment limits and returned results.
   */
  max_evidence_results?: number
}
