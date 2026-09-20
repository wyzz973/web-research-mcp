/**
 * web_search core. Finds candidate pages; it never downloads them. One `search()` either runs a
 * fresh search, serves the per-query cache, or pages through a frozen pool with a cursor. It never
 * throws: every failure becomes `status: "error"` with an actionable `error`.
 */
import type { Config } from '../config.ts'
import type {
  ResolvedSearch,
  SearchRequest,
  SearchResult,
  SearchUsage,
  SourceStatus,
  Status,
  Store,
  StoredSearch,
  ToolError,
} from '../contract.ts'
import { WebError, toToolError } from '../errors.ts'
import { createApiHttp, type ApiHttp } from '../net/api-http.ts'
import { createDefaultSources } from '../sources/index.ts'
import type { SourceAdapter } from '../sources/types.ts'
import { estimateTokens } from '../tokens.ts'
import { createCooldowns } from './cooldown.ts'
import { DEFAULT_TIMEOUTS, runEngine, type EngineResult, type SearchTimeouts } from './engine.ts'
import { normalizeSearch, type NormalizedSearch } from './normalize.ts'
import { packPage } from './pack.ts'
import {
  buildPool,
  cacheKey,
  loadCursor,
  loadCursorPool,
  readCache,
  saveCursor,
  savePool,
  writeCache,
} from './pool.ts'
import { cacheable, overallStatus } from './status.ts'
import { buildTerms } from './terms.ts'

export type { SourceAdapter, SourceHit, SourceRequest } from '../sources/types.ts'
export type { SearchTimeouts } from './engine.ts'

export interface Searcher {
  search(request: SearchRequest, signal: AbortSignal): Promise<SearchResult>
  /** Releases the HTTP connections the searcher opened itself. */
  close(): Promise<void>
}

export interface SearcherDeps {
  config: Config
  store: Store
  /** Replaces the built-in sources (Exa, Parallel, Tavily). */
  sources?: SourceAdapter[]
  now?: () => Date
  /** HTTP function for the built-in sources; the caller keeps ownership of it. */
  http?: ApiHttp
  timeouts?: Partial<SearchTimeouts>
}

const NO_USAGE: SearchUsage = { provider_calls: 0, est_cost_usd: 0 }
const EXPIRED_CURSOR: ToolError = {
  code: 'expired_ref',
  message: 'This cursor has expired; run web_search again.',
}
const MAX_NOTES = 3
/** A time-sensitive pool goes stale quickly; an empty one may simply be early. */
const FRESH_TTL_S: Record<string, number> = { day: 900, week: 3600 }
const EMPTY_TTL_S = 3600
const TIME_SENSITIVE =
  /\b(?:latest|today|tonight|breaking|news|price|prices|score|weather)\b|最新|今天|今日|实时|新闻|价格/iu

interface PageShape {
  offset: number
  count: number
  maxTokens: number
}

interface Presentation {
  pool: StoredSearch
  shape: PageShape
  cache: 'miss' | 'hit'
  usage: SearchUsage
  /** Notes about this run, most important first. */
  notes: string[]
  /** Notes about repaired input; merged into one sentence when space is short. */
  inputNotes: string[]
  /** False when the pool could not be written, so no ref or cursor can be honoured later. */
  stored: boolean
}

function localDate(now: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function composeNotes(notes: readonly string[], inputNotes: readonly string[]): string[] {
  const roomy = notes.length + inputNotes.length <= MAX_NOTES
  const input =
    roomy || inputNotes.length < 2
      ? inputNotes
      : [`Input was adjusted: ${inputNotes.map((note) => note.replace(/\.$/u, '')).join('; ')}.`]
  return [...notes, ...input].slice(0, MAX_NOTES)
}

function fitNote(returned: number, expected: number, continues: boolean): string {
  const how = continues ? '; continue with the cursor' : ''
  return `Returned ${returned} of ${expected} results to fit the output budget${how}.`
}

/**
 * The lines of the text view that vary with the response, spelled as render/text.ts prints them,
 * so that they are counted against the budget: one line per note, and the source line, which
 * appears only when some source did not simply answer.
 */
function variableLines(notes: readonly string[], sources: readonly SourceStatus[]): string[] {
  const lines = notes.map((note) => `note: ${note}`)
  if (sources.every((source) => source.status === 'ok' || source.status === 'empty')) return lines
  const entries = sources.map((source) => {
    const retry = source.retry_after_s === undefined ? '' : ` retry ${source.retry_after_s}s`
    return `${source.id} ${source.status}${retry}`
  })
  return [...lines, `sources: ${entries.join(' | ')}`]
}

function emptyAdvice(search: ResolvedSearch): string {
  const tips = [
    search.sites.length ? 'removing sites' : undefined,
    search.recency ? 'removing recency' : undefined,
    search.queries.some((query) => query.includes('"')) ? 'removing quotes' : undefined,
    search.queries.some((query) => query.split(' ').length > 6) ? 'using fewer words' : undefined,
  ].filter(Boolean)
  return `No results; try ${tips.length ? tips.join(', ') : 'different or fewer words'}.`
}

function cacheTtl(search: ResolvedSearch, config: Config, empty: boolean): number {
  const fresh = search.recency ? FRESH_TTL_S[search.recency] : undefined
  const sensitive = search.queries.some((query) => TIME_SENSITIVE.test(query)) ? 3600 : undefined
  const limits = [config.ttl.queryCacheSeconds, fresh, sensitive, empty ? EMPTY_TTL_S : undefined]
  return Math.min(...limits.filter((limit): limit is number => limit !== undefined))
}

function resolveSources(deps: SearcherDeps): { sources: SourceAdapter[]; close(): Promise<void> } {
  const nothingToClose = () => Promise.resolve()
  if (deps.sources) return { sources: deps.sources, close: nothingToClose }
  if (deps.http)
    return { sources: createDefaultSources(deps.config, deps.http), close: nothingToClose }
  const client = createApiHttp({ userAgent: deps.config.userAgent })
  return { sources: createDefaultSources(deps.config, client.request), close: client.close }
}

export function createSearcher(deps: SearcherDeps): Searcher {
  const { config, store } = deps
  const now = deps.now ?? (() => new Date())
  const { sources, close } = resolveSources(deps)
  const engine = {
    config,
    store,
    sources,
    cooldowns: createCooldowns(now, store),
    now,
    timeouts: { ...DEFAULT_TIMEOUTS, ...deps.timeouts },
  }

  function failure(error: ToolError, extra: Partial<SearchResult> = {}): SearchResult {
    const notes = extra.notes ?? []
    return {
      status: 'error',
      today: localDate(now()),
      returned: 0,
      available: 0,
      tokens: estimateTokens([error.message, ...notes].join('\n')) + 40,
      cache: 'miss',
      results: [],
      sources: [],
      usage: NO_USAGE,
      ...extra,
      notes,
      error,
    }
  }

  function nextCursor(view: Presentation, shown: number): string | undefined {
    const offset = view.shape.offset + shown
    if (!view.stored || shown === 0 || offset >= view.pool.hits.length) return undefined
    try {
      const cursor = {
        search_id: view.pool.id,
        query_hash: view.pool.query_hash ?? '',
        offset,
        page_size: view.shape.count,
        max_tokens: view.shape.maxTokens,
      }
      return saveCursor(store, cursor, config.ttl.searchSeconds)
    } catch {
      return undefined
    }
  }

  /** Packs the page with `notes` counted against the budget, as the text view will print them. */
  function pack(view: Presentation, notes: readonly string[]) {
    return packPage({
      pool: view.pool.hits,
      ...view.shape,
      maxChars: config.limits.maxOutputChars,
      extraLines: variableLines(composeNotes(notes, view.inputNotes), view.pool.sources),
      terms: buildTerms(view.pool.queries, view.pool.goal),
    })
  }

  function present(view: Presentation): SearchResult {
    const { pool, shape } = view
    const expected = Math.min(shape.count, Math.max(pool.hits.length - shape.offset, 0))
    let page = pack(view, view.notes)
    // Saying that results were left out takes room as well: pack again with that note counted.
    if (page.results.length < expected)
      page = pack(view, [...view.notes, fitNote(page.results.length, expected, true)])
    const returned = page.results.length
    const cursor = nextCursor(view, returned)
    const notes =
      returned < expected
        ? [...view.notes, fitNote(returned, expected, cursor !== undefined)]
        : view.notes
    const status: Status = overallStatus(returned, pool.sources)
    const age = Math.round((now().getTime() - Date.parse(pool.created_at)) / 1000)
    return {
      status,
      today: localDate(now()),
      ...(view.stored ? { id: pool.id } : {}),
      returned,
      available: pool.hits.length,
      tokens: page.tokens,
      cache: view.cache,
      ...(view.cache === 'hit' ? { cache_age_s: Math.max(0, age) } : {}),
      results: page.results,
      ...(page.hiddenRemoved > 0 ? { hidden_removed: page.hiddenRemoved } : {}),
      sources: pool.sources,
      usage: view.usage,
      ...(cursor ? { next_cursor: cursor } : {}),
      notes: composeNotes(notes, view.inputNotes),
    }
  }

  function presentPool(pool: StoredSearch, search: ResolvedSearch, rest: Partial<Presentation>) {
    const notes = [...(rest.notes ?? [])]
    if (pool.hits.length === 0) notes.push(emptyAdvice(search))
    else if (pool.hits.length < search.maxResults)
      notes.push(`Only ${pool.hits.length} results were found.`)
    return present({
      pool,
      shape: { offset: 0, count: search.maxResults, maxTokens: search.maxTokens },
      cache: 'miss',
      usage: NO_USAGE,
      inputNotes: search.notes,
      stored: true,
      ...rest,
      notes,
    })
  }

  /** Freezes the pool. Without storage the results are still returned, only without refs. */
  function freeze(
    search: ResolvedSearch,
    run: EngineResult,
  ): { pool: StoredSearch; stored: boolean } {
    const draft = {
      createdAt: now(),
      queryHash: cacheKey(search),
      queries: search.queries,
      goal: search.goal,
      hits: run.pool,
      sources: run.sources,
    }
    try {
      const pool = savePool(store, draft, config.ttl.searchSeconds)
      if (cacheable(run.sources))
        writeCache(store, search, pool.id, cacheTtl(search, config, pool.hits.length === 0))
      return { pool, stored: true }
    } catch {
      return { pool: buildPool('', draft), stored: false }
    }
  }

  /** A cache entry that cannot be read is a miss, not a failed search. */
  function cachedPool(search: ResolvedSearch): StoredSearch | undefined {
    try {
      return readCache(store, search)
    } catch {
      return undefined
    }
  }

  async function fresh(search: ResolvedSearch, signal: AbortSignal): Promise<SearchResult> {
    const cached = cachedPool(search)
    if (cached) return presentPool(cached, search, { cache: 'hit' })

    const run = await runEngine(engine, search, buildTerms(search.queries, search.goal), signal)
    const usage: SearchUsage = {
      provider_calls: run.calls,
      est_cost_usd: Number(run.costUsd.toFixed(4)),
      ...(run.paidSources.length ? { paid_sources: run.paidSources } : {}),
    }
    if (signal.aborted)
      return failure(
        { code: 'cancelled', message: 'The request was cancelled.' },
        { sources: run.sources, usage },
      )
    if (run.error)
      return failure(run.error, {
        sources: run.sources,
        usage,
        notes: composeNotes(run.notes, search.notes),
      })
    const { pool, stored } = freeze(search, run)
    const notes = stored
      ? run.notes
      : ['Results could not be stored, so refs and cursors will not work.', ...run.notes]
    return presentPool(pool, search, { usage, notes, stored })
  }

  /** Undefined when the cursor is gone but the caller also said what to search for. */
  function page(request: Extract<NormalizedSearch, { kind: 'cursor' }>): SearchResult | undefined {
    const cursor = loadCursor(store, request.cursor)
    const pool = cursor ? loadCursorPool(store, cursor) : undefined
    if ((!cursor || !pool) && request.fallback) return undefined
    if (!cursor || !pool) throw new WebError(EXPIRED_CURSOR.code, EXPIRED_CURSOR.message)
    const result = present({
      pool,
      shape: {
        offset: cursor.offset,
        count: request.maxResults ?? cursor.page_size,
        maxTokens: request.maxTokens ?? cursor.max_tokens,
      },
      cache: 'hit',
      usage: NO_USAGE,
      notes: [],
      inputNotes: request.notes,
      stored: true,
    })
    if (result.returned > 0) return result
    const done = 'no more stored results; run a new web_search to get different results'
    return { ...result, notes: composeNotes([done], request.notes) }
  }

  return {
    async search(request, signal) {
      try {
        const normalized = normalizeSearch(request, config)
        if (normalized.kind === 'query') return await fresh(normalized.search, signal)
        const paged = page(normalized)
        if (paged || !normalized.fallback) return paged ?? failure(EXPIRED_CURSOR)
        return await fresh(normalized.fallback, signal)
      } catch (error) {
        return failure(toToolError(error))
      }
    },
    close,
  }
}
