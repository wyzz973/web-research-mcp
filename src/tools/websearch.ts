/** Search bounded candidate pools, then optionally acquire exact page evidence. */
import { createHash, randomUUID } from 'node:crypto'
import type { WebSearchInput } from '../generated/websearch.input.ts'
import type { WebSearchOutput } from '../generated/websearch.output.ts'
import type { RuntimeConfiguration } from '../generated/config.ts'
import type { DocumentLoader, DomainScope, SearchProvider, SnapshotStore } from '../shared/types.ts'
import { AppError, throwIfAborted } from '../shared/errors.ts'
import { makeSourceId } from '../shared/ids.ts'
import { parseContract } from '../shared/contracts.ts'
import { canonicalUrl, matchesScope, resolveScope } from '../shared/domain-scope.ts'
import { scoreRelevance } from '../ranking/lexical.ts'
import { selectPassages } from '../ranking/passages.ts'
import { type SearchResult, toolError, wireRelevance, withDeadline } from './common.ts'

interface SearchSpec {
  query: string
  scope: DomainScope
  language: string
  timeRange: 'any' | 'day' | 'month' | 'year'
  limit: number
  evidenceMode: 'none' | 'extract'
  evidenceResults: number
}

interface SavedPool {
  version: 1
  fingerprint: string
  spec: SearchSpec
  sources: SearchResult[]
  warnings: string[]
  removedCount: number
  expiresAt: string
}

function fingerprint(spec: SearchSpec, config: RuntimeConfiguration): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        spec,
        search: config.search,
        node: process.versions.node,
        icu: process.versions.icu,
      }),
    )
    .digest('hex')
}

function resolve(input: WebSearchInput, config: RuntimeConfiguration): SearchSpec {
  const query = input.query.trim()
  if (!query) throw new AppError('INVALID_ARGUMENT', 'Query cannot be blank.')
  const scope = resolveScope({
    ...input,
    include_subdomains: input.include_subdomains ?? config.search.scope.include_subdomains,
  })
  if (
    scope.sites.length > config.search.scope.max_sites ||
    scope.exclude_domains.length > config.search.scope.max_sites
  )
    throw new AppError('INVALID_ARGUMENT', 'Too many sites for this deployment.')
  const language = input.language ?? 'auto'
  scoreRelevance(query, '', 'title_snippet', language)
  const evidenceMode = input.evidence_mode ?? 'none'
  const evidenceResults =
    evidenceMode === 'extract'
      ? (input.max_evidence_results ?? config.search.evidence.default_max_results)
      : 0
  if (evidenceResults > config.search.evidence.max_results)
    throw new AppError('INVALID_ARGUMENT', 'Evidence request exceeds the deployment limit.')
  return {
    query,
    scope: {
      ...scope,
      sites: [...scope.sites].sort(),
      exclude_domains: [...scope.exclude_domains].sort(),
    },
    language,
    timeRange: input.time_range ?? 'any',
    limit: input.limit ?? config.search.limit,
    evidenceMode,
    evidenceResults,
  }
}

function confidence(
  level: 'high' | 'medium' | 'low' | 'unknown',
  reason: string,
): SearchResult['confidence'] {
  return {
    scope: 'evidence_traceability',
    level,
    method: 'traceability_v1',
    reasons: [reason],
    fact_probability: null,
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function savedPool(value: unknown, expected: string): SavedPool {
  if (
    !isRecord(value) ||
    value.version !== 1 ||
    value.fingerprint !== expected ||
    !Array.isArray(value.sources) ||
    !isRecord(value.spec) ||
    typeof value.expiresAt !== 'string' ||
    typeof value.removedCount !== 'number' ||
    !Array.isArray(value.warnings)
  ) {
    throw new AppError('CURSOR_MISMATCH', 'The saved search does not match these query settings.')
  }
  // Validate all stored public results using the author-owned schema before using the internal envelope.
  parseContract<WebSearchOutput>('websearch.output', {
    schema_version: '0.2-draft',
    request_id: 'durable-validation',
    status: value.sources.length ? 'ok' : 'empty',
    query: 'durable-validation',
    results: value.sources,
    warnings: [],
    error: null,
    providers: [],
    next_cursor: null,
    scope: {
      sites: [],
      exclude_domains: [],
      include_subdomains: true,
      enforcement: 'none',
      upstream_mode: 'none',
      removed_count: 0,
    },
    evidence_summary: { mode: 'none', target_results: 0, verified_results: 0 },
  })
  return value as unknown as SavedPool
}

async function collect(
  spec: SearchSpec,
  config: RuntimeConfiguration,
  provider: SearchProvider,
  signal: AbortSignal,
): Promise<SavedPool> {
  const sites = spec.scope.sites.length ? spec.scope.sites : [undefined]
  const sources: SearchResult[] = []
  const seen = new Map<string, SearchResult>()
  const warnings: string[] = []
  const finished = new Set<number>()
  let removedCount = 0
  let requests = 0
  let candidates = 0
  let truncated = false
  let lastFailure: unknown
  outer: for (let page = 1; page <= config.search.retrieval.max_pages_per_query; page++) {
    for (const [index, site] of sites.entries()) {
      if (finished.has(index)) continue
      if (
        requests >= config.search.retrieval.max_upstream_requests ||
        candidates >= config.search.retrieval.max_candidates
      ) {
        truncated = true
        break outer
      }
      if (
        signal.aborted &&
        signal.reason instanceof AppError &&
        signal.reason.code === 'TIMEOUT' &&
        sources.length
      ) {
        truncated = true
        break outer
      }
      throwIfAborted(signal)
      requests++
      try {
        const response = await provider.searchPage(
          {
            query: spec.query,
            language: spec.language,
            timeRange: spec.timeRange,
            page,
            ...(site === undefined ? {} : { site }),
          },
          signal,
        )
        warnings.push(...response.errors.map((error) => `Search branch ${index + 1}: ${error}`))
        if (response.errors.length)
          lastFailure = new AppError(
            'UPSTREAM_UNAVAILABLE',
            'One or more search engines failed.',
            true,
          )
        if (response.exhausted) finished.add(index)
        for (const source of response.sources) {
          if (candidates >= config.search.retrieval.max_candidates) {
            truncated = true
            break
          }
          candidates++
          if (!matchesScope(source.url, spec.scope)) {
            removedCount++
            continue
          }
          const url = canonicalUrl(source.url)
          const existing = seen.get(url)
          if (existing) {
            existing.providers = [...new Set([...existing.providers, ...source.engines])] as [
              string,
              ...string[],
            ]
            continue
          }
          const row: SearchResult = {
            source_id: makeSourceId(url),
            url,
            title: source.title,
            snippet: source.snippet,
            published_at: source.publishedAt,
            rank: sources.length + 1,
            providers: [source.engines[0] ?? 'searxng', ...source.engines.slice(1)],
            evidence_level: 'search_snippet',
            evidence_status: 'not_requested',
            evidence: [],
            relevance: wireRelevance(
              scoreRelevance(
                spec.query,
                `${source.title}\n${source.snippet}`,
                'title_snippet',
                spec.language,
              ),
              'title_snippet',
            ),
            confidence: confidence('unknown', 'Page evidence has not been requested.'),
            warnings: [],
          }
          sources.push(row)
          seen.set(url, row)
        }
      } catch (error) {
        if (
          signal.aborted &&
          signal.reason instanceof AppError &&
          signal.reason.code === 'TIMEOUT' &&
          sources.length
        ) {
          truncated = true
          break outer
        }
        throwIfAborted(signal)
        lastFailure = error
        warnings.push(`Search branch ${index + 1} failed: ${toolError(error).code}`)
        finished.add(index)
      }
    }
  }
  if (finished.size < sites.length) truncated = true
  if (truncated)
    warnings.push(
      'Candidate collection reached its configured request, page, or candidate budget; coverage is bounded.',
    )
  if (!sources.length && lastFailure) throw lastFailure
  if (!sources.length && truncated)
    throw new AppError(
      'SEARCH_BUDGET_EXHAUSTED',
      'No in-scope candidates were found before the collection budget ended. Narrow the query or sites.',
    )
  if (!spec.scope.sites.length && /(?:^|\s)-?site:/iu.test(spec.query))
    warnings.push(
      'Inline site syntax is engine-dependent. Use structured sites for strict filtering.',
    )
  return {
    version: 1,
    fingerprint: fingerprint(spec, config),
    spec,
    sources,
    warnings: [...new Set(warnings)],
    removedCount,
    expiresAt: new Date(
      Date.now() +
        Math.min(config.search.cache_ttl_seconds, config.storage.snapshot_ttl_seconds) * 1000,
    ).toISOString(),
  }
}

async function enrich(
  row: SearchResult,
  spec: SearchSpec,
  config: RuntimeConfiguration,
  loader: DocumentLoader,
  store: SnapshotStore,
  signal: AbortSignal,
): Promise<void> {
  try {
    const document = await loader.load(row.url, { signal, scope: spec.scope })
    throwIfAborted(signal)
    const snapshot = store.saveDocument(document, 'text')
    const passages = selectPassages(spec.query, snapshot, {
      maxPassages: config.search.evidence.max_passages_per_result,
      maxChars: config.search.evidence.max_chars_per_passage,
      language: spec.language,
    })
    row.warnings.push(...snapshot.warnings)
    if (!passages.length) {
      row.evidence_status = 'no_match'
      row.confidence = confidence('low', 'The fetched text contains no query-matching passage.')
      return
    }
    const cursor = store.createCursor(
      'fetch',
      { snapshotId: snapshot.snapshotId, offset: 0 },
      snapshot.expiresAt,
    )
    row.evidence = passages.map((p) => {
      if (Array.from(snapshot.content).slice(p.start_char, p.end_char).join('') !== p.quote)
        throw new AppError('INTERNAL_ERROR', 'Passage failed exact snapshot verification.')
      return {
        id: `${snapshot.snapshotId}:${p.start_char}:${p.end_char}`,
        quote: p.quote,
        url: snapshot.finalUrl,
        snapshot_id: snapshot.snapshotId,
        snapshot_format: 'text',
        content_sha256: snapshot.contentSha256,
        segment_id: p.segment_id,
        start_char: p.start_char,
        end_char: p.end_char,
        fetched_at: snapshot.fetchedAt,
        expires_at: snapshot.expiresAt,
        extractor_version: snapshot.extractorVersion,
        snapshot_cursor: cursor,
        verification: 'exact_match',
        relevance: wireRelevance(p.relevance, 'quote'),
      }
    })
    row.evidence_level = 'page_excerpt'
    row.evidence_status = 'verified'
    row.confidence = confidence(
      snapshot.warnings.length ? 'medium' : 'high',
      snapshot.warnings.length
        ? 'Exact saved text is available with extraction warnings.'
        : 'Exact excerpt, content hash, and retained snapshot are available; factual truth is not assessed.',
    )
  } catch (error) {
    if (signal.aborted && !(signal.reason instanceof AppError && signal.reason.code === 'TIMEOUT'))
      throwIfAborted(signal)
    row.evidence_status =
      error instanceof AppError &&
      error.code === 'FETCH_BLOCKED' &&
      /scope|domain|site/iu.test(error.message)
        ? 'out_of_scope'
        : 'unavailable'
    row.confidence = confidence('low', 'Requested page evidence could not be verified.')
    row.warnings.push(`Evidence unavailable: ${toolError(error).code}`)
  }
}

export function createWebSearch(
  config: RuntimeConfiguration,
  provider: SearchProvider | undefined,
  loader: DocumentLoader,
  store: SnapshotStore,
) {
  const pending = new Map<string, Promise<WebSearchOutput>>()
  const run = async (raw: unknown, parent: AbortSignal): Promise<WebSearchOutput> => {
    const requestId = randomUUID()
    const isExtract = isRecord(raw) && raw.evidence_mode === 'extract'
    const deadline = withDeadline(
      parent,
      isExtract ? config.search.evidence.total_deadline_ms : config.search.deadline_ms,
    )
    let spec: SearchSpec | undefined
    try {
      const args = parseContract<WebSearchInput>('websearch.input', raw)
      spec = resolve(args, config)
      throwIfAborted(deadline.signal)
      let pool: SavedPool
      let poolId: string
      let offset = 0
      if (args.cursor) {
        const cursor = store.getCursor(args.cursor, 'search').payload
        if (
          !isRecord(cursor) ||
          typeof cursor.poolId !== 'string' ||
          typeof cursor.offset !== 'number' ||
          !Number.isSafeInteger(cursor.offset) ||
          cursor.offset < 0
        )
          throw new AppError('CURSOR_MISMATCH', 'Invalid saved search cursor.')
        poolId = cursor.poolId
        offset = cursor.offset
        pool = savedPool(store.getSearch(poolId), fingerprint(spec, config))
        try {
          const cachedPage = store.getSearch(`${poolId}/page/${offset}`)
          return {
            ...parseContract<WebSearchOutput>('websearch.output', cachedPage),
            request_id: requestId,
          }
        } catch (error) {
          if (!(error instanceof AppError && error.code === 'CURSOR_EXPIRED')) throw error
        }
      } else {
        if (!provider)
          throw new AppError(
            'CONFIGURATION_REQUIRED',
            'Configure SEARXNG_URL and an explicit SEARXNG_ENGINES allowlist.',
          )
        pool = await collect(spec, config, provider, deadline.signal)
        poolId = randomUUID()
        store.putSearch(poolId, pool, pool.expiresAt)
      }
      if (offset > pool.sources.length)
        throw new AppError('CURSOR_MISMATCH', 'Cursor offset exceeds the saved candidate pool.')
      const results = structuredClone(pool.sources.slice(offset, offset + spec.limit))
      const target =
        spec.evidenceMode === 'extract' ? Math.min(spec.evidenceResults, results.length) : 0
      if (spec.evidenceMode === 'extract') {
        for (const row of results) {
          row.evidence_status = 'skipped_budget'
          row.confidence = confidence('unknown', 'Outside this page evidence budget.')
        }
        // The target count is capped at five; network and parser layers enforce shared global/domain limits.
        const resolvedSpec = spec
        const outcomes = await Promise.allSettled(
          results
            .slice(0, target)
            .map((row) => enrich(row, resolvedSpec, config, loader, store, deadline.signal)),
        )
        const failed = outcomes.find(
          (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
        )
        if (failed) throw failed.reason
      }
      throwIfAborted(parent)
      const verified = results.filter((row) => row.evidence_status === 'verified').length
      const warnings = [...pool.warnings]
      if (verified < target)
        warnings.push(`Page evidence verified for ${verified} of ${target} targeted results.`)
      const nextOffset = offset + results.length
      const output: WebSearchOutput = {
        schema_version: '0.2-draft',
        request_id: requestId,
        status: results.length ? (warnings.length ? 'partial' : 'ok') : 'empty',
        query: spec.query,
        results,
        warnings,
        error: null,
        providers: [
          {
            id: 'searxng',
            status: pool.warnings.length ? 'partial' : 'ok',
            message: pool.warnings.length ? pool.warnings.join('; ') : null,
          },
        ],
        scope: {
          sites: [...spec.scope.sites],
          exclude_domains: [...spec.scope.exclude_domains],
          include_subdomains: spec.scope.include_subdomains,
          enforcement:
            spec.scope.sites.length || spec.scope.exclude_domains.length ? 'application' : 'none',
          upstream_mode: spec.scope.sites.length
            ? 'query_rewrite'
            : spec.scope.exclude_domains.length
              ? 'post_filter_only'
              : 'none',
          removed_count: pool.removedCount,
        },
        evidence_summary: {
          mode: spec.evidenceMode,
          target_results: target,
          verified_results: verified,
        },
        next_cursor: null,
      }
      if (nextOffset < pool.sources.length)
        output.next_cursor = store.createCursor(
          'search',
          { poolId, offset: nextOffset },
          pool.expiresAt,
        )
      store.putSearch(`${poolId}/page/${offset}`, output, pool.expiresAt)
      return output
    } catch (error) {
      return {
        schema_version: '0.2-draft',
        request_id: requestId,
        status: 'error',
        query:
          spec?.query ??
          (isRecord(raw) && typeof raw.query === 'string' && raw.query
            ? raw.query
            : 'invalid query'),
        results: [],
        providers: [],
        warnings: [],
        next_cursor: null,
        scope: null,
        evidence_summary: {
          mode: isExtract ? 'extract' : 'none',
          target_results: 0,
          verified_results: 0,
        },
        error: toolError(error),
      }
    } finally {
      deadline.dispose()
    }
  }
  const execute = async (raw: unknown, parent: AbortSignal): Promise<WebSearchOutput> => {
    let key: string | undefined
    try {
      const args = parseContract<WebSearchInput>('websearch.input', raw)
      if (args.cursor) key = `${args.cursor}:${fingerprint(resolve(args, config), config)}`
    } catch {
      return run(raw, parent)
    }
    if (!key) return run(raw, parent)
    const existing = pending.get(key)
    if (existing) {
      let abort: () => void = () => {}
      try {
        const cancelled = new Promise<never>((_, reject) => {
          abort = () => reject(new AppError('CANCELLED', 'The request was cancelled.'))
          if (parent.aborted) abort()
          else parent.addEventListener('abort', abort, { once: true })
        })
        const shared = await Promise.race([existing, cancelled])
        if (shared.error?.code === 'CANCELLED' && !parent.aborted) {
          if (pending.get(key) === existing) pending.delete(key)
          return execute(raw, parent)
        }
        return { ...shared, request_id: randomUUID() }
      } catch (error) {
        return {
          schema_version: '0.2-draft',
          request_id: randomUUID(),
          status: 'error',
          query: 'cancelled query',
          results: [],
          providers: [],
          warnings: [],
          next_cursor: null,
          scope: null,
          evidence_summary: { mode: 'none', target_results: 0, verified_results: 0 },
          error: toolError(error),
        }
      } finally {
        parent.removeEventListener('abort', abort)
      }
    }
    const task = run(raw, parent)
    pending.set(key, task)
    try {
      return await task
    } finally {
      if (pending.get(key) === task) pending.delete(key)
    }
  }
  return execute
}
