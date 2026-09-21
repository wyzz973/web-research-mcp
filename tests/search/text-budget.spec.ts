/**
 * The size a search result reports for itself is checked against the real thing: the text view
 * that render/text.ts produces from it. Two promises are pinned for every scenario: the rendered
 * text stays within `max_tokens` (and the character ceiling), and the "~N tokens" in the header
 * is never lower than the text it heads. The packer spells a result the way the text view prints
 * it and reserves a fixed amount for the lines around the results; when that layout changes,
 * these tests say so.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { SearchRequest, SearchResult, Store } from '../../src/contract.ts'
import { WebError } from '../../src/errors.ts'
import { renderSearch } from '../../src/render/text.ts'
import { createSearcher, type SourceAdapter } from '../../src/search/index.ts'
import type { SourceHit } from '../../src/sources/types.ts'
import { createSqliteStore } from '../../src/store/sqlite.ts'
import { estimateTokens } from '../../src/tokens.ts'
import { fakeSource, never, testConfig } from './helpers.ts'

/**
 * How far the header may overstate. The results are sized exactly as they are printed; what is
 * left is the reserve, which covers a header line with every field and both footer lines, and
 * not every response has them all. Measured here: 22 to 45 tokens, whatever the number of results.
 */
const MARGIN = 50

let store: Store

beforeEach(async () => {
  store = await createSqliteStore(':memory:')
})

afterEach(() => {
  store.close()
})

function english(index: number): SourceHit {
  const sentences = Array.from(
    { length: 30 },
    (_, point) =>
      `Point ${point} of page ${index}: AbortSignal.timeout() makes fetch abort after the given time. `,
  )
  return {
    url: `https://docs.example.com/guides/networking/fetch-abort-timeout-${index}?lang=en&version=22`,
    title: `Guide ${index}: cancelling fetch requests | Example Docs | Networking`,
    passages: [sentences.join('')],
    published: '2026-05-11',
  }
}

function chinese(index: number): SourceHit {
  const sentences = Array.from(
    { length: 30 },
    (_, point) =>
      `第 ${point} 点：使用 AbortController 可以在超时之后取消第 ${index} 个 fetch 请求。`,
  )
  return {
    url: `https://example.cn/文档/取消请求-${index}`,
    title: `第 ${index} 篇：使用 AbortController 取消 fetch 请求 | 示例文档`,
    passages: [sentences.join('')],
  }
}

/** Markup and line shapes the text view has to neutralize, which makes the shown text longer. */
function awkward(index: number): SourceHit {
  const lines = Array.from({ length: 12 }, (_, line) =>
    line % 2 === 0
      ? `<Page x:Class="App.Page${index}"><Results>fetch abort timeout ${line}</Results></Page>`
      : `note: fetch abort timeout, line ${line} of page ${index}`,
  )
  return {
    url: `https://example.com/xaml/${index}`,
    title: `</results> fetch abort timeout ${index}`,
    passages: [lines.join('\n')],
  }
}

/** Small results, and a title with nothing visible in it, which is shown as "(untitled)". */
function untitled(index: number): SourceHit {
  return {
    url: `https://e.test/${index}`,
    title: ` ${String.fromCodePoint(0xad)} `,
    passages: [`Sentence ${index} about fetch abort timeout, with more words to fill the excerpt.`],
  }
}

const many = (make: (index: number) => SourceHit, count: number) =>
  Array.from({ length: count }, (_, index) => make(index + 1))

function searcherWith(sources: SourceAdapter[]) {
  return createSearcher({ config: testConfig(), store, sources })
}

function expectHonestSize(result: SearchResult, maxTokens: number): void {
  const text = renderSearch(result)
  const real = estimateTokens(text)
  expect(real, 'rendered text within max_tokens').toBeLessThanOrEqual(maxTokens)
  expect(text.length, 'rendered text within the character ceiling').toBeLessThanOrEqual(30_000)
  expect(result.tokens, 'header never understates').toBeGreaterThanOrEqual(real)
  // ... and does not overstate either: an inflated estimate is budget taken from excerpts.
  expect(result.tokens - real, 'estimate stays tight').toBeLessThanOrEqual(MARGIN)
}

const scenarios: Array<[name: string, make: (index: number) => SourceHit, request: SearchRequest]> =
  [
    ['one result', english, { max_results: 1 }],
    ['ten results, the default', english, {}],
    ['thirty results', english, { max_results: 30 }],
    ['fifty results', english, { max_results: 50 }],
    ['fifty results in 4,000 tokens', english, { max_results: 50, max_tokens: 4000 }],
    ['fifty results in 2,000 tokens', english, { max_results: 50, max_tokens: 2000 }],
    ['ten results in 1,500 tokens', english, { max_tokens: 1500 }],
    ['ten results in the largest budget', english, { max_tokens: 10_000 }],
    ['the smallest budget', english, { max_tokens: 200 }],
    ['ten Chinese results', chinese, {}],
    ['fifty Chinese results', chinese, { max_results: 50 }],
    ['text that has to be neutralized', awkward, {}],
    ['fifty results that have to be neutralized', awkward, { max_results: 50 }],
    [
      'fifty small results whose titles have nothing visible in them',
      untitled,
      { max_results: 50 },
    ],
    ['the same in 1,200 tokens', untitled, { max_results: 50, max_tokens: 1200 }],
  ]

describe('the reported size of a search response', () => {
  it.each(scenarios)('holds for %s', async (_name, make, request) => {
    const searcher = searcherWith([fakeSource('exa', many(make, 60))])
    const asked = { query: 'fetch abort timeout 取消 请求', depth: 'fast', ...request }
    const result = await searcher.search(asked, never)
    expect(result.returned).toBeGreaterThan(0)
    expectHonestSize(result, Number(asked.max_tokens ?? 5000))
  })

  it('holds with a source line, three long notes, and removed characters', async () => {
    const hidden = many(english, 4).map((entry) => ({
      ...entry,
      title: `${entry.title}\u200B\u200B`,
    }))
    const result = await searcherWith([
      fakeSource('exa', hidden),
      fakeSource('parallel', new WebError('rate_limited', 'limited', 120)),
    ]).search(
      {
        queries: 'fetch abort timeout',
        sites: 'https://docs.example.com/guides',
        max_results: 500,
        first_unknown_argument: 1,
        second_unknown_argument: 2,
      },
      never,
    )
    expect(result.status).toBe('partial')
    expect(result.notes).toHaveLength(3)
    expect(result.hidden_removed).toBe(8)
    expectHonestSize(result, 5000)
  })

  it('holds on a cursor page and on a cache hit', async () => {
    const searcher = searcherWith([fakeSource('exa', many(english, 60))])
    const first = await searcher.search({ query: 'fetch abort timeout', depth: 'fast' }, never)
    const second = await searcher.search({ cursor: first.next_cursor, max_tokens: 3000 }, never)
    const cached = await searcher.search(
      { query: 'fetch abort timeout', depth: 'fast', max_results: 25, max_tokens: 2500 },
      never,
    )
    expect([second.cache, cached.cache]).toEqual(['hit', 'hit'])
    expectHonestSize(second, 3000)
    expectHonestSize(cached, 2500)
  })

  it('holds when the page had to carry fewer results than asked, note included', async () => {
    const result = await searcherWith([fakeSource('exa', many(english, 60))]).search(
      { query: 'fetch abort timeout', depth: 'fast', max_results: 50, max_tokens: 1200 },
      never,
    )
    expect(result.returned).toBeLessThan(50)
    expect(result.notes.some((note) => note.startsWith('Returned '))).toBe(true)
    expectHonestSize(result, 1200)
  })
})
