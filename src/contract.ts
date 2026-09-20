/**
 * The single public contract. MCP, CLI, and library callers all receive these objects;
 * the text view and the JSON view are two renderings of the same value.
 */

export type Status = 'ok' | 'partial' | 'empty' | 'error'
export type Recency = 'day' | 'week' | 'month' | 'year'
export type Depth = 'fast' | 'standard' | 'deep'

export type ErrorCode =
  | 'invalid_input'
  | 'rate_limited'
  | 'budget_exhausted'
  | 'no_source_available'
  | 'upstream_error'
  | 'blocked'
  | 'login_required'
  | 'payment_required'
  | 'robots_disallowed'
  | 'not_found'
  | 'needs_javascript'
  | 'unsupported_content_type'
  | 'too_large'
  | 'timeout'
  | 'unsafe_url'
  | 'expired_ref'
  | 'parse_failed'
  | 'cancelled'
  | 'internal'

/** A failure the model can act on: what happened and what to do next. */
export interface ToolError {
  code: ErrorCode
  message: string
  retry_after_s?: number
}

// ---------------------------------------------------------------- web_search

/** Raw arguments as a model may send them. Normalization is tolerant; see search/normalize.ts. */
export interface SearchRequest {
  query?: unknown
  queries?: unknown
  max_results?: unknown
  goal?: unknown
  sites?: unknown
  recency?: unknown
  depth?: unknown
  max_tokens?: unknown
  cursor?: unknown
  [extra: string]: unknown
}

/** Execution parameters after defaults, coercion, and limits are applied. */
export interface ResolvedSearch {
  queries: string[]
  maxResults: number
  goal: string | undefined
  sites: string[]
  recency: Recency | undefined
  depth: Depth
  maxTokens: number
  /** Human-readable remarks about coercions that were applied to the input. */
  notes: string[]
}

export interface SearchHit {
  /** Full handle that works across calls and processes: "<search id>:r<n>", e.g. "k7f2:r1". */
  ref: string
  rank: number
  title: string
  url: string
  site: string
  /** ISO date (YYYY-MM-DD) when the source reports one. Never guessed. */
  published?: string
  /** Verbatim, query-relevant text supplied by the source. */
  excerpt: string
  /** Source ids that returned this URL. More than one is a cheap trust signal. */
  found_by: string[]
  /** 1-based indexes of the queries that matched. */
  q: number[]
}

export type SourceOutcome =
  'ok' | 'empty' | 'rate_limited' | 'blocked' | 'timeout' | 'error' | 'skipped'

export interface SourceStatus {
  id: string
  status: SourceOutcome
  ms?: number
  retry_after_s?: number
  detail?: string
}

export interface SearchUsage {
  provider_calls: number
  est_cost_usd: number
  /** Keyed sources this search sent a request to. Absent when only free tiers were used. */
  paid_sources?: string[]
}

export interface SearchResult {
  status: Status
  /** Local calendar date, echoed because models often append a stale year to queries. */
  today: string
  /** Search id; prefix for cross-call refs. Absent when nothing could be stored. */
  id?: string
  returned: number
  available: number
  tokens: number
  cache: 'miss' | 'hit'
  cache_age_s?: number
  results: SearchHit[]
  sources: SourceStatus[]
  usage: SearchUsage
  next_cursor?: string
  notes: string[]
  error?: ToolError
}

// ----------------------------------------------------------------- web_fetch

export interface FetchRequest {
  url?: unknown
  urls?: unknown
  ref?: unknown
  refs?: unknown
  goal?: unknown
  section?: unknown
  find?: unknown
  max_tokens?: unknown
  cursor?: unknown
  fresh?: unknown
  [extra: string]: unknown
}

export type ReadMode = 'full' | 'lead' | 'goal' | 'section' | 'find' | 'cursor'

export interface ResolvedFetch {
  /** Each target is a URL, or a ref/snapshot id that resolves to one. */
  targets: FetchTarget[]
  goal: string | undefined
  section: string | undefined
  find: string | undefined
  maxTokens: number
  cursor: string | undefined
  fresh: boolean
  notes: string[]
}

export interface FetchTarget {
  url?: string
  ref?: string
}

/** A verbatim span of a snapshot. `start`/`end` are UTF-16 offsets into the snapshot Markdown. */
export interface PagePart {
  section?: string
  heading?: string
  start: number
  end: number
  text: string
  /** Present in find mode. */
  match?: 'exact' | 'normalized'
  /** Find mode: span of the first match inside this part; `start`/`end` bound the context. */
  match_start?: number
  match_end?: number
  /** Find mode: how many matches this part covers when neighbouring contexts were merged. */
  match_count?: number
  /** True when a single block larger than the budget was cut at a line, or the part resumes such a cut. */
  clipped?: true
  /** Goal mode: other pages (by `n`) that carry this same passage; reposts are not independent evidence. */
  also_in?: number[]
}

export interface OutlineEntry {
  /** Section id: the heading's own number ("5.1.1") or its ordinal path ("2.4"). */
  id: string
  level: number
  title: string
  start: number
  end: number
  tokens: number
}

export interface PageResult {
  n: number
  status: 'ok' | 'error'
  ref?: string
  url: string
  final_url?: string
  snapshot?: string
  sha256?: string
  retrieved?: string
  cache?: 'miss' | 'hit'
  cache_age_s?: number
  title?: string
  total_chars?: number
  total_tokens?: number
  mode?: ReadMode
  parts: PagePart[]
  shown_chars?: number
  truncated: boolean
  next_cursor?: string
  hidden_removed?: number
  outline?: OutlineEntry[]
  /** Find mode: total number of matches in the page. */
  find_total?: number
  error?: ToolError
}

export interface FetchResult {
  status: Status
  goal?: string
  tokens: number
  pages: PageResult[]
  notes: string[]
  error?: ToolError
}

// ------------------------------------------------------------------- storage

/** An immutable capture of one page. Citable locations are `${id}:${start}-${end}`. */
export interface Snapshot {
  id: string
  url: string
  final_url: string
  http_status: number
  content_type: string
  title: string
  markdown: string
  sha256: string
  retrieved_at: string
  hidden_removed: number
}

/** A frozen candidate pool. Cursor pages and refs read from it; nothing is re-queried. */
export interface StoredSearch {
  id: string
  created_at: string
  /**
   * SHA-256 of the normalized request. Cursors and cache entries carry the same value, so a
   * record id that was reissued after expiry can never be mistaken for the search they belong to.
   */
  query_hash?: string
  queries: string[]
  goal?: string
  hits: SearchHit[]
  sources: SourceStatus[]
}

/** Persistence used by both tools. One SQLite file; safe for several processes at once. */
export interface Store {
  /** "wal" normally; "delete" on file systems that cannot support WAL. Reported by `doctor`. */
  readonly journalMode?: string
  /** Insert under a fresh unique id of the form `${prefix}${random}` and return the id. */
  insertRecord(
    kind: string,
    prefix: string,
    value: unknown,
    ttlSeconds: number,
    /** Random characters after the prefix. Ids a model keeps in context should be 8 so an expired id is not reused. */
    idLength?: number,
  ): string
  putRecord(kind: string, id: string, value: unknown, ttlSeconds: number): void
  getRecord<T>(kind: string, id: string): { value: T; created_at: number } | undefined
  insertSnapshot(snapshot: Omit<Snapshot, 'id'>, ttlSeconds: number): Snapshot
  getSnapshot(id: string): Snapshot | undefined
  latestSnapshotForUrl(url: string): Snapshot | undefined
  addUsage(source: string, calls: number, costUsd: number): void
  /**
   * Books `calls` for today only if the day's total stays within `cap`, as one atomic statement,
   * so processes that share the state file cannot pass the cap together. False means refused.
   */
  reserveUsage(source: string, calls: number, cap: number): boolean
  /**
   * Books `calls` with their estimated cost only if today's spend across all sources stays within
   * `budgetUsd`, as one atomic statement. The caller corrects the estimate with `addUsage` once
   * the real cost is known. False means refused.
   */
  reservePaid(source: string, calls: number, estimatedCostUsd: number, budgetUsd: number): boolean
  usageToday(): { calls: number; cost_usd: number }
  usageTodayBySource(source: string): { calls: number; cost_usd: number }
  close(): void
}
