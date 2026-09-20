/**
 * Persistence of frozen candidate pools, page cursors, and the per-query cache. Everything read
 * back is checked: the state file is shared between processes and versions.
 */
import { createHash } from 'node:crypto'
import type { ResolvedSearch, SearchHit, SourceStatus, Store, StoredSearch } from '../contract.ts'
import { PASSAGE_GAP } from './excerpt.ts'
import type { FusedHit } from './fuse.ts'

const SEARCH_KIND = 'search'
const CURSOR_KIND = 'search_cursor'
const CACHE_KIND = 'search_cache'
/** Bump when the meaning of a cached pool changes, so old entries stop matching. */
const CACHE_VERSION = 1
/** Search ids and cursors stay in a model's context; long enough that an expired one is never reissued. */
const ID_LENGTH = 8

export interface StoredCursor {
  search_id: string
  /** Must equal the pool's `query_hash`; see `loadCursorPool`. */
  query_hash: string
  offset: number
  page_size: number
  max_tokens: number
}

interface CacheEntry {
  search_id: string
  query_hash: string
  /** Page size of the request that built the pool; a bigger request needs a bigger pool. */
  max_results: number
}

export interface PoolDraft {
  createdAt: Date
  /** `cacheKey` of the request. Without it the pool can be read by ref but not continued by cursor. */
  queryHash?: string
  queries: string[]
  goal: string | undefined
  hits: readonly FusedHit[]
  sources: SourceStatus[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isHit(value: unknown): value is SearchHit {
  return (
    isRecord(value) &&
    typeof value.ref === 'string' &&
    typeof value.rank === 'number' &&
    typeof value.title === 'string' &&
    typeof value.url === 'string' &&
    typeof value.site === 'string' &&
    typeof value.excerpt === 'string' &&
    isStringList(value.found_by) &&
    Array.isArray(value.q)
  )
}

function isStoredSearch(value: unknown): value is StoredSearch {
  return (
    isRecord(value) &&
    typeof value.id === 'string' &&
    typeof value.created_at === 'string' &&
    isStringList(value.queries) &&
    Array.isArray(value.hits) &&
    value.hits.every(isHit) &&
    Array.isArray(value.sources)
  )
}

/** Pool entries keep the whole source text in `excerpt`; pages cut their excerpts from it. */
function toPoolHit(hit: FusedHit, searchId: string, index: number): SearchHit {
  return {
    ref: searchId ? `${searchId}:r${index + 1}` : `r${index + 1}`,
    rank: index + 1,
    title: hit.title,
    url: hit.url,
    site: hit.site,
    ...(hit.published ? { published: hit.published } : {}),
    excerpt: hit.passages.join(PASSAGE_GAP),
    found_by: hit.foundBy,
    q: hit.q,
  }
}

/** An empty `id` builds a pool that lives only in this response: its refs cannot be resolved later. */
export function buildPool(id: string, draft: PoolDraft): StoredSearch {
  return {
    id,
    created_at: draft.createdAt.toISOString(),
    ...(draft.queryHash ? { query_hash: draft.queryHash } : {}),
    queries: draft.queries,
    ...(draft.goal ? { goal: draft.goal } : {}),
    hits: draft.hits.map((hit, index) => toPoolHit(hit, id, index)),
    sources: draft.sources,
  }
}

/** Refs embed the search id, so the id is allocated first and the pool written under it. */
export function savePool(store: Store, draft: PoolDraft, ttlSeconds: number): StoredSearch {
  const id = store.insertRecord(SEARCH_KIND, '', { pending: true }, ttlSeconds, ID_LENGTH)
  const pool = buildPool(id, draft)
  store.putRecord(SEARCH_KIND, id, pool, ttlSeconds)
  return pool
}

export function loadPool(store: Store, id: string): StoredSearch | undefined {
  const value = store.getRecord<unknown>(SEARCH_KIND, id)?.value
  return isStoredSearch(value) ? value : undefined
}

export function saveCursor(store: Store, cursor: StoredCursor, ttlSeconds: number): string {
  return store.insertRecord(CURSOR_KIND, 'c_', cursor, ttlSeconds, ID_LENGTH)
}

export function loadCursor(store: Store, id: string): StoredCursor | undefined {
  const value = store.getRecord<unknown>(CURSOR_KIND, id)?.value
  if (!isRecord(value) || typeof value.search_id !== 'string') return undefined
  const { offset, page_size: pageSize, max_tokens: maxTokens, query_hash: queryHash } = value
  if (typeof offset !== 'number' || typeof pageSize !== 'number' || typeof maxTokens !== 'number')
    return undefined
  if (typeof queryHash !== 'string') return undefined
  return {
    search_id: value.search_id,
    query_hash: queryHash,
    offset,
    page_size: pageSize,
    max_tokens: maxTokens,
  }
}

/**
 * The pool a cursor continues. Record ids are short and reissued after expiry, so the id alone
 * does not prove that the pool is the search this cursor was cut from; the query hash does.
 */
export function loadCursorPool(store: Store, cursor: StoredCursor): StoredSearch | undefined {
  const pool = loadPool(store, cursor.search_id)
  return pool?.query_hash !== undefined && pool.query_hash === cursor.query_hash ? pool : undefined
}

/** Page size and token budget are not part of the key: one pool serves any page shape. */
export function cacheKey(search: ResolvedSearch): string {
  const material = JSON.stringify({
    v: CACHE_VERSION,
    queries: search.queries.map((query) => query.toLowerCase()),
    sites: search.sites.toSorted(),
    recency: search.recency ?? null,
    depth: search.depth,
    goal: search.goal?.toLowerCase() ?? null,
  })
  return createHash('sha256').update(material).digest('hex')
}

export function readCache(store: Store, search: ResolvedSearch): StoredSearch | undefined {
  const key = cacheKey(search)
  const entry = store.getRecord<unknown>(CACHE_KIND, key)?.value
  if (!isRecord(entry) || typeof entry.search_id !== 'string') return undefined
  const pool = loadPool(store, entry.search_id)
  if (!pool || pool.query_hash !== key) return undefined
  const builtFor = typeof entry.max_results === 'number' ? entry.max_results : 0
  return builtFor >= search.maxResults || pool.hits.length >= search.maxResults ? pool : undefined
}

export function writeCache(
  store: Store,
  search: ResolvedSearch,
  poolId: string,
  ttlSeconds: number,
): void {
  const key = cacheKey(search)
  const entry: CacheEntry = { search_id: poolId, query_hash: key, max_results: search.maxResults }
  store.putRecord(CACHE_KIND, key, entry, ttlSeconds)
}
