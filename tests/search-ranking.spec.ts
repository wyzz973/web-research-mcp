import { afterEach, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadConfiguration } from '../src/shared/config.ts'
import { createSnapshotStore } from '../src/storage/index.ts'
import { createWebSearch } from '../src/tools/websearch.ts'
import { parseContract } from '../src/shared/contracts.ts'
import type { SearchProvider, DocumentLoader } from '../src/shared/types.ts'
const cleanup: Array<() => void> = []
afterEach(() => {
  for (const close of cleanup.splice(0).reverse()) close()
})
it('reranks before freezing and pagination, preserves independent relevance and rejects cursor mode changes', async () => {
  const config = loadConfiguration()
  const directory = mkdtempSync(join(tmpdir(), 'research-ranking-'))
  cleanup.push(() => rmSync(directory, { recursive: true, force: true }))
  const store = createSnapshotStore({ directory, ttlSeconds: 60, maxBytes: 1024 * 1024 })
  cleanup.push(() => store.close())
  let calls = 0
  const provider: SearchProvider = {
    async searchPage() {
      calls++
      return {
        sources: [
          {
            url: 'https://example.org/general',
            title: 'Database overview',
            snippet: 'General introduction',
            publishedAt: null,
            engines: ['google'],
          },
          {
            url: 'https://example.org/error',
            title: 'SQLITE_BUSY timeout',
            snippet: 'SQLITE_BUSY occurs when another connection holds a write lock.',
            publishedAt: null,
            engines: ['google'],
          },
        ],
        errors: [],
        exhausted: true,
      }
    },
    async close() {},
  }
  const loader: DocumentLoader = {
    async load() {
      throw new Error('Unexpected evidence fetch')
    },
    async close() {},
  }
  const search = createWebSearch(config, provider, loader, store)
  const args = { query: 'SQLITE_BUSY timeout', ranking_mode: 'bm25', limit: 1 }
  const first = await search(args, new AbortController().signal)
  parseContract('websearch.output', first)
  expect(first.results[0]?.url).toBe('https://example.org/error')
  expect(first.results[0]?.ranking).toMatchObject({
    method: 'bm25',
    original_rank: 2,
    corpus_size: 2,
  })
  expect(first.results[0]?.relevance.method).toBe('lexical_coverage_v1')
  expect(first.results[0]?.confidence.fact_probability).toBeNull()
  const second = await search({ ...args, cursor: first.next_cursor }, new AbortController().signal)
  expect(second.results[0]?.url).toBe('https://example.org/general')
  expect(second.results[0]?.rank).toBe(2)
  expect(calls).toBe(1)
  const mismatch = await search(
    { ...args, cursor: first.next_cursor, ranking_mode: 'upstream' },
    new AbortController().signal,
  )
  expect(mismatch.error?.code).toBe('CURSOR_MISMATCH')
  const defaultOrder = await search({ query: args.query }, new AbortController().signal)
  expect(defaultOrder.results[0]?.url).toBe('https://example.org/general')
})
