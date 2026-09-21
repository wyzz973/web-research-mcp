import type { Recency } from '../contract.ts'

/** What the searcher asks of one upstream call. */
export interface SourceRequest {
  /** At least one query; never more than the adapter's `maxQueriesPerCall`. */
  queries: string[]
  /** The caller's own words about what they hope to find. */
  goal: string | undefined
  /** Registrable domains or hosts; subdomains count. Empty means the whole web. */
  sites: string[]
  recency: Recency | undefined
  maxResults: number
  /** Reference time for recency windows, so a request is reproducible. */
  now: Date
}

export interface SourceHit {
  url: string
  title: string
  /** Verbatim text from the source, in its order. Passages are not contiguous with each other. */
  passages: string[]
  /** YYYY-MM-DD, only when the source reports one. */
  published?: string
}

/**
 * One upstream search product. `search` performs exactly one upstream call and either resolves
 * (an empty list is a confirmed "no results") or throws a WebError; it never retries.
 */
export interface SourceAdapter {
  readonly id: string
  /**
   * How many queries one upstream call can carry. Defaults to 1, and anything that is not a
   * number of at least 1 is read as 1.
   */
  readonly maxQueriesPerCall?: number
  /** True when calls go to a vendor's anonymous tier and cost nothing. */
  free(): boolean
  /** The most results one call can return; "few results" is judged against what was possible. */
  maxResultsPerCall?(): number
  /** True when `sites` and `recency` are applied upstream rather than only hinted at. */
  nativeFilters?(): boolean
  /** Estimated price of one call in USD. Defaults to 0. */
  unitCostUsd?(): number
  search(request: SourceRequest, signal: AbortSignal): Promise<SourceHit[]>
}
