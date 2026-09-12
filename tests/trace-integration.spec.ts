import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { loadConfiguration } from '../src/shared/config.ts'
import { createTraceRecorder } from '../src/shared/trace.ts'
import { createTraceStore } from '../src/storage/traces.ts'
import { createSnapshotStore } from '../src/storage/index.ts'
import { createWebSearch } from '../src/tools/websearch.ts'
import { createWebFetch } from '../src/tools/webfetch.ts'
import { createResearchRuntime } from '../src/tools/runtime.ts'
import { AppError } from '../src/shared/errors.ts'
import type { DocumentLoader, SearchProvider } from '../src/shared/types.ts'

const cleanup: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'trace-integration-'))
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

it('records actual search filtering, ranking, original evidence and snapshot continuation in order', async () => {
  const dir = directory()
  const config = loadConfiguration()
  const store = createSnapshotStore({ directory: dir, ttlSeconds: 60, maxBytes: 1024 * 1024 })
  cleanup.push(() => store.close())
  const traces = createTraceStore({ directory: dir })
  cleanup.push(() => traces.close())
  const tracer = createTraceRecorder({ store: traces, captureContent: true })
  const provider: SearchProvider = {
    async searchPage() {
      return {
        sources: [
          {
            url: 'https://other.org/article',
            title: 'wrong scope',
            snippet: 'SQLite',
            publishedAt: null,
            engines: ['brave'],
          },
          {
            url: 'https://sqlite.org/fts5.html',
            title: 'SQLite FTS5',
            snippet: 'SQLite FTS5 BM25 ranking',
            publishedAt: null,
            engines: ['brave'],
          },
        ],
        errors: ['UPSTREAM_BLOCKED: duckduckgo'],
        exhausted: true,
      }
    },
    async close() {},
  }
  const content =
    'SQLite FTS5 supports BM25 ranking. The query terms influence the score.\n\nThis is exact evidence in a saved document.'
  const loader: DocumentLoader = {
    async load(url) {
      return {
        url,
        finalUrl: url,
        title: 'SQLite FTS5',
        text: content,
        markdown: content,
        contentType: 'text/html',
        fetchedAt: new Date().toISOString(),
        extractorVersion: 'fixture',
        warnings: [],
      }
    },
    async close() {},
  }
  const search = createWebSearch(config, provider, loader, store, tracer)
  const output = await tracer.run('websearch', { query: 'SQLite BM25' }, () =>
    search(
      {
        query: 'SQLite BM25',
        sites: ['sqlite.org'],
        ranking_mode: 'bm25',
        evidence_mode: 'extract',
      },
      new AbortController().signal,
    ),
  )
  expect(output.status).toBe('partial')
  expect(output.results[0]?.evidence_status).toBe('verified')
  const run = traces.list()[0]
  if (!run) throw new Error('Missing trace')
  const trace = traces.get(run.id)
  expect(trace?.request_id).toBe(output.request_id)
  expect(trace?.status).toBe('partial')
  const names = trace?.spans.map((s) => s.name) ?? []
  for (const name of [
    'search.resolve',
    'search.collect',
    'search.provider_request',
    'search.filter_deduplicate',
    'search.rank',
    'search.freeze',
    'search.page',
    'evidence.fetch',
    'fetch.snapshot',
    'evidence.select',
    'evidence.persist',
  ])
    expect(names).toContain(name)
  expect(names.indexOf('search.rank')).toBeLessThan(names.indexOf('search.freeze'))
  expect(trace?.spans.find((s) => s.name === 'search.provider_request')?.status).toBe('partial')
  expect(trace?.spans.find((s) => s.name === 'search.collect')?.status).toBe('partial')
  expect(trace?.spans.find((s) => s.name === 'search.filter_deduplicate')?.output).toMatchObject({
    removed_scope_count: 1,
    retained_count: 1,
  })
  const cursor = output.results[0]?.evidence[0]?.snapshot_cursor
  expect(cursor).toBeTypeOf('string')
  const read = createWebFetch(config, loader, store, tracer)
  const fetched = await tracer.run('webfetch', { cursor }, () =>
    read({ cursor, format: 'text' }, new AbortController().signal),
  )
  expect(fetched.content).toBe(content)
  const record = traces.list().find((r) => r.request_id === fetched.request_id)
  if (!record) throw new Error('Missing fetch trace')
  expect(traces.get(record.id)?.spans.map((s) => s.name)).toEqual([
    'fetch.resolve',
    'fetch.read_snapshot',
    'fetch.present',
  ])
})

it('shows real network policy failure without inventing a download or parser span', async () => {
  const config = loadConfiguration()
  config.storage.directory = directory()
  const runtime = createResearchRuntime(config)
  cleanup.push(() => runtime.close())
  const output = await runtime.webfetch({ url: 'http://127.0.0.1/' }, new AbortController().signal)
  expect(output.error?.code).toBe('FETCH_BLOCKED')
  expect(output.trace_id).toBeTypeOf('string')
  const trace = runtime.traces?.get(output.trace_id ?? '')
  expect(trace?.status).toBe('error')
  expect(trace?.spans.find((s) => s.name === 'fetch.validate')?.status).toBe('ok')
  expect(trace?.spans.find((s) => s.name === 'fetch.dns')?.status).toBe('error')
  expect(trace?.spans.some((s) => s.name === 'fetch.http' || s.name === 'fetch.parse')).toBe(false)
})

it('keeps presentation failures in the webfetch error envelope when tracing is enabled', async () => {
  const config = loadConfiguration()
  const dir = directory()
  const traces = createTraceStore({ directory: dir })
  cleanup.push(() => traces.close())
  const tracer = createTraceRecorder({ store: traces })
  const store = createSnapshotStore({ directory: dir, ttlSeconds: 60, maxBytes: 1024 * 1024 })
  cleanup.push(() => store.close())
  const doc = {
    url: 'https://example.org',
    finalUrl: 'https://example.org',
    title: 'title',
    text: 'a'.repeat(200),
    markdown: 'a'.repeat(200),
    contentType: 'text/plain',
    fetchedAt: new Date().toISOString(),
    extractorVersion: 'test',
    warnings: [],
  }
  const loader: DocumentLoader = {
    async load() {
      return doc
    },
    async close() {},
  }
  const broken = {
    ...store,
    createCursor() {
      throw new AppError('STORAGE_UNAVAILABLE', 'Cursor write failed.')
    },
  }
  const fetch = createWebFetch(config, loader, broken, tracer)
  const output = await tracer.run('webfetch', {}, () =>
    fetch({ url: doc.url, max_chars: 100 }, new AbortController().signal),
  )
  expect(output.status).toBe('error')
  expect(output.error?.code).toBe('STORAGE_UNAVAILABLE')
})
