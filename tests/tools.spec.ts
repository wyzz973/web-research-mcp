import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadConfiguration } from '../src/shared/config.ts'
import { parseContract } from '../src/shared/contracts.ts'
import { AppError } from '../src/shared/errors.ts'
import type {
  DocumentLoader,
  LoadedDocument,
  SearchProvider,
  SearchSource,
  SnapshotStore,
} from '../src/shared/types.ts'
import type { WebSearchOutput } from '../src/generated/websearch.output.ts'
import type { WebFetchOutput } from '../src/generated/webfetch.output.ts'
import { createSnapshotStore } from '../src/storage/index.ts'
import { createWebFetch } from '../src/tools/webfetch.ts'
import { createWebSearch } from '../src/tools/websearch.ts'

const directories: string[] = []
const stores: SnapshotStore[] = []
const text = '研究🙂 evidence is not a claim of factual truth.\n\n这是一段中文证据。\n'.repeat(6)

function document(url: string): LoadedDocument {
  return {
    url,
    finalUrl: url,
    title: 'Research evidence',
    contentType: 'text/plain',
    text,
    markdown: `# Research evidence\n\n${text}`,
    fetchedAt: '2026-09-08T08:00:00.000Z',
    extractorVersion: 'fixture-extractor-v1',
    warnings: [],
  }
}

function source(id: number, hostname = 'example.org'): SearchSource {
  return {
    url: `https://${hostname}/article-${id}`,
    title: `Research evidence ${id}`,
    snippet: 'Chinese research evidence',
    publishedAt: null,
    engines: ['duckduckgo'],
  }
}

function open(directory: string, ttlSeconds = 60): SnapshotStore {
  const store = createSnapshotStore({ directory, ttlSeconds, maxBytes: 4 * 1024 * 1024 })
  stores.push(store)
  return store
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), 'web-research-tools-'))
  directories.push(directory)
  const config = loadConfiguration()
  config.storage.directory = directory
  config.storage.snapshot_ttl_seconds = 60
  config.search.cache_ttl_seconds = 60
  const store = open(directory)
  const load = vi.fn<DocumentLoader['load']>(async (url) => document(url))
  const loader: DocumentLoader = { load, async close() {} }
  return { config, directory, store, loader, load }
}

function provider(searchPage: SearchProvider['searchPage']): SearchProvider {
  return { searchPage, async close() {} }
}

function signal(): AbortSignal {
  return new AbortController().signal
}

function cursor(value: string | null | undefined): string {
  expect(value).toBeTypeOf('string')
  if (typeof value !== 'string') throw new Error('Expected a continuation cursor')
  return value
}

function validateSearch(output: WebSearchOutput): WebSearchOutput {
  return parseContract<WebSearchOutput>('websearch.output', output)
}

function validateFetch(output: WebFetchOutput): WebFetchOutput {
  return parseContract<WebFetchOutput>('webfetch.output', output)
}

afterEach(() => {
  vi.useRealTimers()
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('tool orchestration with durable SQLite state', () => {
  it('traces search evidence to an exact retained snapshot and reads that same text without another fetch', async () => {
    const f = fixture()
    const search = createWebSearch(
      f.config,
      provider(async () => ({ sources: [source(1)], errors: [], exhausted: true })),
      f.loader,
      f.store,
    )
    const output = validateSearch(
      await search({ query: 'evidence', evidence_mode: 'extract' }, signal()),
    )
    expect(output.status).toBe('ok')
    const row = output.results[0]
    const evidence = row?.evidence[0]
    if (!row || !evidence) throw new Error('Expected verified evidence')
    expect(row.evidence_status).toBe('verified')
    expect(row.confidence).toMatchObject({ level: 'high', fact_probability: null })
    const snapshot = f.store.getDocument(evidence.snapshot_id)
    expect(snapshot.contentSha256).toBe(createHash('sha256').update(text, 'utf8').digest('hex'))
    expect(evidence.content_sha256).toBe(snapshot.contentSha256)
    expect(Array.from(text).slice(evidence.start_char, evidence.end_char).join('')).toBe(
      evidence.quote,
    )
    expect(snapshot.segments.find((segment) => segment.id === evidence.segment_id)).toBeDefined()
    const fetched = validateFetch(
      await createWebFetch(
        f.config,
        f.loader,
        f.store,
      )({ cursor: evidence.snapshot_cursor }, signal()),
    )
    expect(fetched).toMatchObject({
      status: 'ok',
      source_id: row.source_id,
      snapshot_id: evidence.snapshot_id,
      content: text,
      content_sha256: evidence.content_sha256,
      fetched_at: evidence.fetched_at,
      next_cursor: null,
    })
    expect(f.load).toHaveBeenCalledTimes(1)
  })

  it('joins Unicode fetch pages after reopening storage and rejects changed formats', async () => {
    const f = fixture()
    const fetch = createWebFetch(f.config, f.loader, f.store)
    const first = validateFetch(
      await fetch({ url: source(1).url, format: 'text', max_chars: 100 }, signal()),
    )
    expect(first.status).toBe('ok')
    expect(first.truncated).toBe(true)
    const firstCursor = cursor(first.next_cursor)
    expect(
      validateFetch(await fetch({ cursor: firstCursor, format: 'markdown' }, signal())).error?.code,
    ).toBe('CURSOR_MISMATCH')
    f.store.close()
    const reopened = open(f.directory)
    const resumed = createWebFetch(f.config, f.loader, reopened)
    let next: string | null | undefined = firstCursor
    const contents = [first.content ?? '']
    while (next) {
      const page = validateFetch(await resumed({ cursor: next, max_chars: 100 }, signal()))
      expect(page.snapshot_id).toBe(first.snapshot_id)
      expect(page.fetched_at).toBe(first.fetched_at)
      expect(page.content_sha256).toBe(first.content_sha256)
      for (const segment of page.segments ?? []) {
        expect(Array.from(text).slice(segment.start_char, segment.end_char).join('')).toBe(
          segment.text,
        )
      }
      contents.push(page.content ?? '')
      next = page.next_cursor
    }
    expect(contents.join('')).toBe(text)
    expect(f.load).toHaveBeenCalledTimes(1)
  })

  it('freezes two search pages across restart and never repeats upstream search on continuation', async () => {
    const f = fixture()
    const searchPage = vi.fn<SearchProvider['searchPage']>(async () => ({
      sources: [source(1), source(2), source(3), source(4)],
      errors: [],
      exhausted: true,
    }))
    const search = createWebSearch(f.config, provider(searchPage), f.loader, f.store)
    const input = { query: 'research', limit: 2, sites: ['example.org'] }
    const first = validateSearch(await search(input, signal()))
    expect(first.results.map((row) => row.rank)).toEqual([1, 2])
    const token = cursor(first.next_cursor)
    f.store.close()
    const reopened = open(f.directory)
    const resumed = createWebSearch(f.config, undefined, f.loader, reopened)
    const second = validateSearch(await resumed({ ...input, cursor: token }, signal()))
    expect(second.results.map((row) => row.rank)).toEqual([3, 4])
    expect(second.results.map((row) => row.url)).toEqual([source(3).url, source(4).url])
    expect(second.next_cursor).toBeNull()
    const repeated = validateSearch(await resumed({ ...input, cursor: token }, signal()))
    expect(repeated.results).toEqual(second.results)
    expect(repeated.request_id).not.toBe(second.request_id)
    expect(searchPage).toHaveBeenCalledTimes(1)
    expect(f.load).not.toHaveBeenCalled()
  })

  it('shares concurrent reads of an uncached evidence page and keeps its snapshot immutable on replay', async () => {
    const f = fixture()
    const search = createWebSearch(
      f.config,
      provider(async () => ({ sources: [source(1), source(2)], errors: [], exhausted: true })),
      f.loader,
      f.store,
    )
    const input = { query: 'evidence', limit: 1, evidence_mode: 'extract' }
    const first = validateSearch(await search(input, signal()))
    const continuation = { ...input, cursor: cursor(first.next_cursor) }
    const [left, right] = await Promise.all([
      search(continuation, signal()),
      search(continuation, signal()),
    ])
    validateSearch(left)
    validateSearch(right)
    expect(left.status).toBe('ok')
    expect(right.results).toEqual(left.results)
    expect(left.request_id).not.toBe(right.request_id)
    expect(f.load).toHaveBeenCalledTimes(2)
    const replay = validateSearch(await search(continuation, signal()))
    expect(replay.results).toEqual(left.results)
    expect(f.load).toHaveBeenCalledTimes(2)
  })

  it('isolates cancellation of the first caller from another caller sharing the same cursor', async () => {
    const f = fixture()
    const search = createWebSearch(
      f.config,
      provider(async () => ({ sources: [source(1), source(2)], errors: [], exhausted: true })),
      f.loader,
      f.store,
    )
    const input = { query: 'evidence', limit: 1, evidence_mode: 'extract' }
    const firstPage = validateSearch(await search(input, signal()))
    const continuation = { ...input, cursor: cursor(firstPage.next_cursor) }
    const cleanupStarted = Promise.withResolvers<void>()
    const finishCleanup = Promise.withResolvers<void>()
    const loading = Promise.withResolvers<void>()
    f.load.mockImplementationOnce(async (_url, options) => {
      loading.resolve()
      try {
        await new Promise<void>((_, reject) =>
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          }),
        )
      } finally {
        cleanupStarted.resolve()
        await finishCleanup.promise
      }
      throw new Error('The cancelled load must reject')
    })
    const owner = new AbortController()
    const firstCaller = search(continuation, owner.signal)
    await loading.promise
    let secondReturned = false
    const secondCaller = search(continuation, signal()).then((output) => {
      secondReturned = true
      return output
    })
    owner.abort(new AppError('CANCELLED', 'Only the first caller cancelled.'))
    await cleanupStarted.promise
    expect(secondReturned).toBe(false)
    expect(f.load).toHaveBeenCalledTimes(2)
    finishCleanup.resolve()
    const [cancelled, succeeded] = await Promise.all([firstCaller, secondCaller])
    validateSearch(cancelled)
    validateSearch(succeeded)
    expect(cancelled.error?.code).toBe('CANCELLED')
    expect(succeeded.status).toBe('ok')
    expect(succeeded.results[0]).toMatchObject({ url: source(2).url, evidence_status: 'verified' })
    expect(f.load).toHaveBeenCalledTimes(3)
    const replay = validateSearch(await search(continuation, signal()))
    expect(replay.results).toEqual(succeeded.results)
    expect(f.load).toHaveBeenCalledTimes(3)
  })

  it.each([
    { query: 'different' },
    { sites: ['other.example.org'] },
    { include_subdomains: false },
    { limit: 2 },
    { evidence_mode: 'extract' },
    { language: 'zh-CN' },
  ])('rejects semantic continuation changes %j', async (patch) => {
    const f = fixture()
    const search = createWebSearch(
      f.config,
      provider(async () => ({ sources: [source(1), source(2)], errors: [], exhausted: true })),
      f.loader,
      f.store,
    )
    const input = { query: 'evidence', limit: 1, sites: ['example.org'] }
    const first = await search(input, signal())
    const output = validateSearch(
      await search({ ...input, ...patch, cursor: cursor(first.next_cursor) }, signal()),
    )
    expect(output.status).toBe('error')
    expect(output.error?.code).toBe('CURSOR_MISMATCH')
    expect(output.next_cursor).toBeNull()
  })

  it('continues past an out-of-scope first page to find in-scope candidates', async () => {
    const f = fixture()
    const searchPage = vi.fn<SearchProvider['searchPage']>(async (request) => ({
      sources: [source(request.page, request.page === 1 ? 'elsewhere.org' : 'example.org')],
      errors: [],
      exhausted: request.page === 2,
    }))
    const output = validateSearch(
      await createWebSearch(
        f.config,
        provider(searchPage),
        f.loader,
        f.store,
      )({ query: 'evidence', sites: ['example.org'] }, signal()),
    )
    expect(output.status).toBe('ok')
    expect(output.results.map((row) => row.url)).toEqual([source(2).url])
    expect(output.scope?.removed_count).toBe(1)
    expect(searchPage.mock.calls.map(([request]) => request.page)).toEqual([1, 2])
  })

  it('distinguishes exhausted empty results from a budget-limited scope miss', async () => {
    const f = fixture()
    f.config.search.retrieval.max_upstream_requests = 1
    const search = createWebSearch(
      f.config,
      provider(async () => ({
        sources: [source(1, 'elsewhere.org')],
        errors: [],
        exhausted: false,
      })),
      f.loader,
      f.store,
    )
    const limited = validateSearch(
      await search({ query: 'evidence', sites: ['example.org'] }, signal()),
    )
    expect(limited.status).toBe('error')
    expect(limited.error?.code).toBe('SEARCH_BUDGET_EXHAUSTED')
    expect(limited.next_cursor).toBeNull()
    const empty = validateSearch(
      await createWebSearch(
        f.config,
        provider(async () => ({ sources: [], errors: [], exhausted: true })),
        f.loader,
        f.store,
      )({ query: 'evidence' }, signal()),
    )
    expect(empty.status).toBe('empty')
    expect(empty.error).toBeNull()
  })

  it('retains successful branches as partial results and never maps total upstream failure to empty', async () => {
    const f = fixture()
    const search = createWebSearch(
      f.config,
      provider(async (request) => {
        if (request.site === 'a.example.org')
          return { sources: [source(1, request.site)], errors: [], exhausted: true }
        throw new AppError('UPSTREAM_BLOCKED', 'The upstream returned a challenge.')
      }),
      f.loader,
      f.store,
    )
    const partial = validateSearch(
      await search({ query: 'evidence', sites: ['a.example.org', 'b.example.org'] }, signal()),
    )
    expect(partial.status).toBe('partial')
    expect(partial.results).toHaveLength(1)
    expect(partial.warnings.join(' ')).toContain('UPSTREAM_BLOCKED')
    const failed = validateSearch(
      await search({ query: 'evidence', sites: ['b.example.org'] }, signal()),
    )
    expect(failed.status).toBe('error')
    expect(failed.error?.code).toBe('UPSTREAM_BLOCKED')
  })

  it('preserves already collected results when the total deadline interrupts a later page', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.config.search.deadline_ms = 20
    const waiting = Promise.withResolvers<void>()
    const search = createWebSearch(
      f.config,
      provider(async (request, requestSignal) => {
        if (request.page === 1) return { sources: [source(1)], errors: [], exhausted: false }
        waiting.resolve()
        return await new Promise((_, reject) =>
          requestSignal.addEventListener('abort', () => reject(requestSignal.reason), {
            once: true,
          }),
        )
      }),
      f.loader,
      f.store,
    )
    const result = search({ query: 'evidence' }, signal())
    await waiting.promise
    await vi.advanceTimersByTimeAsync(21)
    const output = validateSearch(await result)
    expect(output.status).toBe('partial')
    expect(output.results.map((row) => row.url)).toEqual([source(1).url])
    expect(output.warnings.length).toBeGreaterThan(0)
    expect(output.error).toBeNull()
  })

  it('reports failed page extraction as unavailable evidence while preserving the search source', async () => {
    const f = fixture()
    f.load.mockRejectedValue(
      new AppError('FETCH_BLOCKED', 'Domain is outside the requested scope.'),
    )
    const output = validateSearch(
      await createWebSearch(
        f.config,
        provider(async () => ({ sources: [source(1)], errors: [], exhausted: true })),
        f.loader,
        f.store,
      )({ query: 'evidence', evidence_mode: 'extract', sites: ['example.org'] }, signal()),
    )
    expect(output.status).toBe('partial')
    expect(output.results[0]).toMatchObject({
      evidence_status: 'out_of_scope',
      evidence: [],
      confidence: { level: 'low', fact_probability: null },
    })
    expect(output.results[0]?.url).toBe(source(1).url)
  })

  it('waits for every evidence loader to finish cancellation cleanup before returning', async () => {
    const f = fixture()
    const parent = new AbortController()
    const bothStarted = Promise.withResolvers<void>()
    const finishCleanup = Promise.withResolvers<void>()
    let active = 0
    let started = 0
    f.load.mockImplementation(async (_url, options) => {
      active++
      started++
      const index = started
      if (started === 2) bothStarted.resolve()
      try {
        await new Promise<void>((_, reject) =>
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          }),
        )
      } finally {
        if (index === 2) await finishCleanup.promise
        active--
      }
      throw new Error('Abort should reject the loader')
    })
    const search = createWebSearch(
      f.config,
      provider(async () => ({ sources: [source(1), source(2)], errors: [], exhausted: true })),
      f.loader,
      f.store,
    )
    let returned = false
    const pending = search({ query: 'evidence', evidence_mode: 'extract' }, parent.signal).then(
      (output) => {
        returned = true
        return output
      },
    )
    await bothStarted.promise
    parent.abort(new AppError('CANCELLED', 'The user cancelled.'))
    await Promise.resolve()
    await Promise.resolve()
    expect(active).toBe(1)
    expect(returned).toBe(false)
    finishCleanup.resolve()
    const output = validateSearch(await pending)
    expect(output.error?.code).toBe('CANCELLED')
    expect(active).toBe(0)
  })

  it('returns expired cursor errors after retention ends without silently refetching', async () => {
    vi.useFakeTimers()
    const f = fixture()
    f.config.storage.snapshot_ttl_seconds = 1
    f.config.search.cache_ttl_seconds = 1
    f.store.close()
    const store = open(f.directory, 1)
    const search = createWebSearch(
      f.config,
      provider(async () => ({ sources: [source(1), source(2)], errors: [], exhausted: true })),
      f.loader,
      store,
    )
    const first = validateSearch(
      await search({ query: 'evidence', limit: 1, evidence_mode: 'extract' }, signal()),
    )
    const token = cursor(first.next_cursor)
    const evidence = first.results[0]?.evidence[0]
    if (!evidence) throw new Error('Expected evidence before expiry')
    await vi.advanceTimersByTimeAsync(1001)
    const expiredSearch = validateSearch(
      await search(
        { query: 'evidence', limit: 1, evidence_mode: 'extract', cursor: token },
        signal(),
      ),
    )
    const expiredFetch = validateFetch(
      await createWebFetch(
        f.config,
        f.loader,
        store,
      )({ cursor: evidence.snapshot_cursor }, signal()),
    )
    expect(expiredSearch.error?.code).toBe('CURSOR_EXPIRED')
    expect(expiredFetch.error?.code).toBe('CURSOR_EXPIRED')
    expect(f.load).toHaveBeenCalledTimes(1)
  })
})
