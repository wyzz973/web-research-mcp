/** Search bounded candidate pools, then optionally acquire exact page evidence. */
import { noOpTraceRecorder, type TraceRecorder } from '../shared/trace.ts'
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
import { rankCandidates, RETRIEVAL_VERSION } from '../ranking/retrieval.ts'
import { selectPassages } from '../ranking/passages.ts'
import { createSourceMetadata } from '../shared/source-metadata.ts'
import { prepareEvidence } from './evidence.ts'
import { type SearchResult, toolError, wireRelevance, withDeadline } from './common.ts'

interface SearchSpec {
  query: string
  scope: DomainScope
  language: string
  timeRange: 'any' | 'day' | 'month' | 'year'
  limit: number
  evidenceMode: 'none' | 'extract'
  evidenceResults: number
  rankingMode: 'upstream' | 'bm25' | 'bm25_mmr'
  fetchEngine: 'static' | 'crawl4ai' | 'auto'
}

interface SavedPool {
  version: 2
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
        evidencePolicy: 'paragraph_context_v2',
        rankingVersion: RETRIEVAL_VERSION,
        fetchPolicy: config.fetch.crawl4ai,
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
  const rankingMode = input.ranking_mode ?? config.ranking.mode
  if (rankingMode !== 'upstream' && config.search.retrieval.max_candidates > 200)
    throw new AppError(
      'INVALID_ARGUMENT',
      'Experimental ranking supports at most 200 candidates; reduce the deployment candidate budget.',
    )
  return {
    rankingMode,
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
    fetchEngine:
      evidenceMode === 'extract' ? (input.fetch_engine ?? config.fetch.default_engine) : 'static',
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
    value.version !== 2 ||
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
    schema_version: '0.3-draft',
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
  trace: TraceRecorder,
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
        const response = await trace.span(
          'search.provider_request',
          { query: spec.query, site, page, language: spec.language },
          async () => {
            const pageResult = await provider.searchPage(
              {
                query: spec.query,
                language: spec.language,
                timeRange: spec.timeRange,
                page,
                ...(site === undefined ? {} : { site }),
              },
              signal,
            )
            if (pageResult.errors.length) trace.annotate({ errors: pageResult.errors }, 'partial')
            return pageResult
          },
          (value) => ({
            candidate_count: value.sources.length,
            errors: value.errors,
            exhausted: value.exhausted,
            sources: value.sources.slice(0, 5),
          }),
        )
        if (response.errors.length)
          trace.event('search.branch_partial', 'partial', {
            errors: response.errors,
            candidate_count: response.sources.length,
          })
        warnings.push(...response.errors.map((error) => `Search branch ${index + 1}: ${error}`))
        if (response.errors.length)
          lastFailure = new AppError(
            'UPSTREAM_UNAVAILABLE',
            'One or more search engines failed.',
            true,
          )
        if (response.exhausted) finished.add(index)
        const decisions: { url: string; decision: string }[] = []
        await trace.span(
          'search.filter_deduplicate',
          { incoming_count: response.sources.length, scope: spec.scope },
          async () => {
            for (const source of response.sources) {
              if (candidates >= config.search.retrieval.max_candidates) {
                truncated = true
                break
              }
              candidates++
              if (!matchesScope(source.url, spec.scope)) {
                removedCount++
                decisions.push({ url: source.url, decision: 'outside_scope' })
                continue
              }
              const url = canonicalUrl(source.url)
              const existing = seen.get(url)
              if (existing) {
                decisions.push({ url, decision: 'duplicate' })
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
                source_metadata: createSourceMetadata(url),
                evidence_chars: 0,
                has_more_evidence: false,
                next_evidence_cursor: null,
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
              decisions.push({ url, decision: 'accepted' })
              sources.push(row)
              seen.set(url, row)
            }
          },
          () => ({
            retained_count: sources.length,
            removed_scope_count: removedCount,
            decisions: decisions.slice(0, 20),
          }),
        )
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
    version: 2,
    fingerprint: fingerprint(spec, config),
    spec,
    sources: await trace.span(
      'search.rank',
      { mode: spec.rankingMode, candidate_count: sources.length, version: RETRIEVAL_VERSION },
      async () =>
        spec.rankingMode === 'upstream'
          ? sources
          : rankCandidates(spec.query, sources, {
              mode: spec.rankingMode,
              language: spec.language,
            }).map(({ candidate, score, originalIndex }, index) => ({
              ...candidate,
              rank: index + 1,
              ranking: {
                method: spec.rankingMode,
                score,
                original_rank: originalIndex + 1,
                corpus_size: sources.length,
                version: RETRIEVAL_VERSION,
              },
            })),
      (rows) => ({
        mode: spec.rankingMode,
        candidate_count: rows.length,
        results: rows
          .slice(0, 8)
          .map((row) => ({ title: row.title, url: row.url, rank: row.rank, ranking: row.ranking })),
      }),
    ),
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
  trace: TraceRecorder,
): Promise<void> {
  try {
    const document = await trace.span(
      'evidence.fetch',
      { url: row.url, rank: row.rank },
      () => loader.load(row.url, { signal, scope: spec.scope, engine: spec.fetchEngine }),
      (value) => ({
        title: value.title,
        text_chars: Array.from(value.text).length,
        warnings: value.warnings,
      }),
    )
    throwIfAborted(signal)
    const snapshot = await trace.span(
      'fetch.snapshot',
      { url: document.finalUrl, format: 'text' },
      async () => store.saveDocument(document, 'text'),
      (value) => ({
        snapshot_id: value.snapshotId,
        content_sha256: value.contentSha256,
        segments: value.segments.length,
        expires_at: value.expiresAt,
      }),
    )
    const passages = await trace.span(
      'evidence.select',
      {
        query: spec.query,
        snapshot_id: snapshot.snapshotId,
        method: 'paragraph_context_v2',
        max_passages: config.search.evidence.max_candidate_passages,
      },
      async () =>
        selectPassages(spec.query, snapshot, {
          maxPassages: config.search.evidence.max_candidate_passages,
          maxChars: config.search.evidence.max_chars_per_passage,
          language: spec.language,
        }),
      (value) => ({ passage_count: value.length, passages: value.slice(0, 3) }),
    )
    row.fetch_backend = snapshot.fetchBackend ?? 'static'
    row.warnings.push(...snapshot.warnings)
    row.source_metadata =
      snapshot.sourceMetadata ??
      createSourceMetadata(snapshot.url, snapshot.finalUrl, snapshot.fetchedAt)
    if (!passages.length) {
      trace.event('evidence.no_match', 'partial', {
        url: row.url,
        reason: 'Fetched text had no matching complete paragraph.',
      })
      row.evidence_status = 'no_match'
      row.confidence = confidence('low', 'The fetched text contains no query-matching passage.')
      return
    }
    Object.assign(
      row,
      await trace.span(
        'evidence.persist',
        { snapshot_id: snapshot.snapshotId, selected_passages: passages.length },
        async () =>
          prepareEvidence(snapshot, passages, store, {
            perPage: config.search.evidence.max_passages_per_result,
            maxChars: config.search.evidence.max_chars_per_result,
          }),
        (value) => ({
          returned_passages: value.evidence.length,
          evidence_chars: value.evidence_chars,
          has_more: value.has_more_evidence,
        }),
      ),
    )
    if (passages.length === config.search.evidence.max_candidate_passages)
      row.warnings.push(
        'Evidence selection reached its candidate cap; the complete snapshot may contain additional relevant text.',
      )
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
    trace.event('evidence.unavailable', 'partial', { url: row.url, error: toolError(error) })
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
  trace: TraceRecorder = noOpTraceRecorder,
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
      const { args, resolved } = await trace.span(
        'search.resolve',
        raw,
        async () => {
          const args = parseContract<WebSearchInput>('websearch.input', raw)
          return { args, resolved: resolve(args, config) }
        },
        (value) => value.resolved,
      )
      spec = resolved
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
        pool = await trace.span(
          'search.read_pool',
          { pool_id: poolId, offset },
          async () => savedPool(store.getSearch(poolId), fingerprint(resolved, config)),
          (value) => ({ candidate_count: value.sources.length, expires_at: value.expiresAt }),
        )
        try {
          const cachedPage = store.getSearch(`${poolId}/page/${offset}`)
          trace.event('search.cached_page', 'ok', { offset, network_requested: false })
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
        const configuredProvider = provider
        pool = await trace.span(
          'search.collect',
          {
            query: spec.query,
            scope: spec.scope,
            max_candidates: config.search.retrieval.max_candidates,
            max_requests: config.search.retrieval.max_upstream_requests,
          },
          async () => {
            const value = await collect(
              resolved,
              config,
              configuredProvider,
              deadline.signal,
              trace,
            )
            if (value.warnings.length) trace.annotate({ warnings: value.warnings }, 'partial')
            return value
          },
          (value) => ({ candidate_count: value.sources.length, warnings: value.warnings }),
        )
        poolId = randomUUID()
        const frozenPool = pool
        const frozenId = poolId
        await trace.span(
          'search.freeze',
          { pool_id: poolId, candidate_count: pool.sources.length },
          async () => store.putSearch(frozenId, frozenPool, frozenPool.expiresAt),
          () => ({ expires_at: frozenPool.expiresAt, storage: 'SQLite' }),
        )
      }
      if (offset > pool.sources.length)
        throw new AppError('CURSOR_MISMATCH', 'Cursor offset exceeds the saved candidate pool.')
      const results = await trace.span(
        'search.page',
        { offset, limit: spec.limit, candidate_count: pool.sources.length },
        async () => structuredClone(pool.sources.slice(offset, offset + resolved.limit)),
        (value) => ({
          returned_count: value.length,
          sources: value
            .slice(0, 8)
            .map((row) => ({ url: row.url, title: row.title, rank: row.rank })),
        }),
      )
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
          results.slice(0, target).map((row) =>
            trace.span('evidence.result', { url: row.url, rank: row.rank }, async () => {
              await enrich(row, resolvedSpec, config, loader, store, deadline.signal, trace)
              return {
                status: row.evidence_status === 'verified' ? 'ok' : 'partial',
                evidence_status: row.evidence_status,
                evidence_chars: row.evidence_chars,
                passage_count: row.evidence.length,
                warnings: row.warnings,
              }
            }),
          ),
        )
        const failed = outcomes.find(
          (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
        )
        if (failed) throw failed.reason
      }
      if (spec.evidenceMode !== 'extract')
        trace.event('evidence.skipped', 'skipped', {
          reason: 'evidence_mode=none; only search snippets were requested.',
        })
      throwIfAborted(parent)
      const verified = results.filter((row) => row.evidence_status === 'verified').length
      const warnings = [...pool.warnings]
      if (verified < target)
        warnings.push(`Page evidence verified for ${verified} of ${target} targeted results.`)
      const nextOffset = offset + results.length
      const output: WebSearchOutput = {
        schema_version: '0.3-draft',
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
        schema_version: '0.3-draft',
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
          schema_version: '0.3-draft',
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
