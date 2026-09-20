import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Config } from '../../src/config.ts'
import type { SearchRequest, Store, StoredSearch } from '../../src/contract.ts'
import { WebError } from '../../src/errors.ts'
import { createSearcher, type SourceAdapter } from '../../src/search/index.ts'
import { createSqliteStore } from '../../src/store/sqlite.ts'
import { delayed, fakeSource, hit, hits, never, testConfig } from './helpers.ts'

const NOW = new Date(2026, 8, 21, 9, 30)
const quick = { softMs: 40, hardMs: 80, standardTotalMs: 200 }

let store: Store
let clock: Date

beforeEach(async () => {
  store = await createSqliteStore(':memory:')
  clock = new Date(NOW)
})

afterEach(() => {
  store.close()
})

function searcherWith(sources: SourceAdapter[], config: Config = testConfig(), useStore = store) {
  return createSearcher({ config, store: useStore, sources, now: () => clock, timeouts: quick })
}

function search(sources: SourceAdapter[], request: SearchRequest, config?: Config) {
  return searcherWith(sources, config).search(request, never)
}

describe('a fresh search', () => {
  it('returns ranked results with full refs, excerpts, and an honest header', async () => {
    const exa = fakeSource('exa', hits('docs', 12))
    const result = await search([exa], { query: 'fetch abort', depth: 'fast' })

    expect(result).toMatchObject({
      status: 'ok',
      today: '2026-09-21',
      returned: 10,
      available: 12,
      cache: 'miss',
      sources: [{ id: 'exa', status: 'ok' }],
      usage: { provider_calls: 1, est_cost_usd: 0 },
      notes: [],
    })
    expect(result.id).toMatch(/^[a-z0-9]{8}$/u)
    expect(result.next_cursor).toMatch(/^c_[a-z0-9]{8}$/u)
    expect(result.error).toBeUndefined()
    expect(result.results[0]).toEqual({
      ref: `${result.id}:r1`,
      rank: 1,
      title: 'Title of https://docs.example.com/page-1',
      url: 'https://docs.example.com/page-1',
      site: 'docs.example.com',
      excerpt: 'Text 1 about fetch abort.',
      found_by: ['exa'],
      q: [1],
    })
    expect(result.tokens).toBeGreaterThan(120)
    expect(result.tokens).toBeLessThanOrEqual(5000)
  })

  it('asks each source for more than one page, so the cursor has something to read', async () => {
    const exa = fakeSource('exa', hits('docs', 3))
    await search([exa], {
      query: 'q',
      max_results: 20,
      goal: 'the goal',
      recency: 'week',
      depth: 'fast',
    })
    expect(exa.requests[0]).toMatchObject({
      queries: ['q'],
      goal: 'the goal',
      recency: 'week',
      maxResults: 30,
      now: NOW,
    })
  })

  it('freezes the pool where web_fetch can resolve its refs', async () => {
    const result = await search([fakeSource('exa', hits('docs', 3))], { query: 'q', goal: 'why' })
    const pool = store.getRecord<StoredSearch>('search', result.id ?? '')?.value
    expect(pool).toMatchObject({ id: result.id, queries: ['q'], goal: 'why' })
    expect(pool?.hits.map((entry) => [entry.ref, entry.url])).toEqual([
      [`${result.id}:r1`, 'https://docs.example.com/page-1'],
      [`${result.id}:r2`, 'https://docs.example.com/page-2'],
      [`${result.id}:r3`, 'https://docs.example.com/page-3'],
    ])
  })

  it('says so when fewer results exist than were asked for', async () => {
    const result = await search([fakeSource('exa', hits('docs', 6))], { query: 'q', depth: 'fast' })
    expect(result).toMatchObject({ status: 'ok', returned: 6, available: 6 })
    expect(result.notes).toEqual(['Only 6 results were found.'])
    expect(result.next_cursor).toBeUndefined()
  })

  it('never returns results from outside `sites` or older than `recency`', async () => {
    const exa = fakeSource('exa', [
      hit('https://docs.python.org/3/library/asyncio.html'),
      hit('https://stackoverflow.com/q/1'),
      { ...hit('https://python.org/old'), published: '2020-01-01' },
      { ...hit('https://python.org/new'), published: '2026-09-20' },
    ])
    const result = await search([exa], {
      query: 'asyncio',
      sites: ['python.org'],
      recency: 'month',
      depth: 'fast',
    })
    expect(result.results.map((entry) => entry.url)).toEqual([
      'https://docs.python.org/3/library/asyncio.html',
      'https://python.org/new',
    ])
    expect(exa.requests[0]?.sites).toEqual(['python.org'])
  })
})

describe('depth', () => {
  it('fast asks one source and never a second one', async () => {
    const exa = fakeSource('exa', new WebError('upstream_error', 'HTTP 500'))
    const parallel = fakeSource('parallel', hits('p', 10))
    const result = await search([exa, parallel], { query: 'q', depth: 'fast' })
    expect(result.status).toBe('error')
    expect(parallel.requests).toHaveLength(0)
  })

  it('standard asks one source when its answer is good', async () => {
    const exa = fakeSource('exa', hits('e', 10))
    const parallel = fakeSource('parallel', hits('p', 10))
    const result = await search([exa, parallel], { query: 'fetch abort' })
    expect(result.sources).toEqual([{ id: 'exa', status: 'ok', ms: expect.any(Number) as number }])
    expect(parallel.requests).toHaveLength(0)
    expect(result.notes).toEqual([])
  })

  it('standard adds a second source when the first returned few results, and fuses both', async () => {
    const exa = fakeSource('exa', [hit('https://shared.test/a'), hit('https://e.test/1')])
    const parallel = fakeSource('parallel', [hit('https://p.test/1'), hit('https://shared.test/a')])
    const result = await search([exa, parallel], { query: 'fetch abort' })

    expect(result.status).toBe('ok')
    expect(result.sources.map((source) => [source.id, source.status])).toEqual([
      ['exa', 'ok'],
      ['parallel', 'ok'],
    ])
    expect(result.results[0]).toMatchObject({
      url: 'https://shared.test/a',
      found_by: ['exa', 'parallel'],
    })
    expect(result.notes[0]).toBe('exa returned few results, so parallel was searched as well.')
    expect(result.usage.provider_calls).toBe(2)
  })

  it('standard adds a second source when the results barely match the query', async () => {
    const offTopic = Array.from({ length: 10 }, (_, index) =>
      hit(`https://e.test/${index}`, 'Completely unrelated cooking advice.', 'Pasta'),
    )
    const exa = fakeSource('exa', offTopic)
    const parallel = fakeSource('parallel', hits('p', 10))
    const result = await search([exa, parallel], { query: 'AbortController timeout semantics' })
    expect(result.notes[0]).toBe('exa barely matched the query, so parallel was searched as well.')
  })

  it('standard falls over to the next source when the first one fails', async () => {
    const exa = fakeSource('exa', new WebError('rate_limited', 'limited', 120))
    const parallel = fakeSource('parallel', hits('p', 10))
    const result = await search([exa, parallel], { query: 'fetch abort' })

    expect(result.status).toBe('partial')
    expect(result.returned).toBe(10)
    expect(result.sources).toMatchObject([
      { id: 'exa', status: 'rate_limited', retry_after_s: 120 },
      { id: 'parallel', status: 'ok' },
    ])
    expect(result.notes[0]).toBe('exa failed (rate_limited), so parallel was searched as well.')
  })

  it('deep asks up to three sources at once and fuses them', async () => {
    const sources = [
      fakeSource('exa', [hit('https://shared.test/x'), ...hits('e', 5)]),
      fakeSource('parallel', [...hits('p', 5), hit('https://shared.test/x')]),
      fakeSource('tavily', hits('t', 5)),
      fakeSource('fourth', hits('f', 5)),
    ]
    const result = await search(sources, { query: 'fetch abort', depth: 'deep', max_results: 50 })
    expect(result.sources.map((source) => source.id)).toEqual(['exa', 'parallel', 'tavily'])
    expect(result.results[0]?.url).toBe('https://shared.test/x')
    expect(result.available).toBe(16)
    expect(sources[3]?.requests).toHaveLength(0)
    expect(sources[0]?.requests[0]?.maxResults).toBe(50)
  })
})

describe('several queries', () => {
  it('fans out per query, merges into one call where the source allows, and tags results', async () => {
    const exa = fakeSource('exa', (request) =>
      Promise.resolve([hit(`https://e.test/${request.queries[0]}`), hit('https://e.test/common')]),
    )
    const parallel = fakeSource('parallel', [hit('https://p.test/1')], { maxQueriesPerCall: 5 })
    const result = await search([exa, parallel], {
      queries: ['alpha', 'beta', 'gamma'],
      depth: 'deep',
    })

    expect(exa.requests.map((request) => request.queries)).toEqual([['alpha'], ['beta'], ['gamma']])
    expect(parallel.requests.map((request) => request.queries)).toEqual([
      ['alpha', 'beta', 'gamma'],
    ])
    expect(result.usage.provider_calls).toBe(4)
    const byUrl = new Map(result.results.map((entry) => [entry.url, entry.q]))
    expect(byUrl.get('https://e.test/common')).toEqual([1, 2, 3])
    expect(byUrl.get('https://e.test/beta')).toEqual([2])
    expect(byUrl.get('https://p.test/1')).toEqual([1, 2, 3])
    expect(result.results[0]?.url).toBe('https://e.test/common')
  })
})

describe('status', () => {
  it('is empty, with advice, when a source confirms there is nothing', async () => {
    const result = await search([fakeSource('exa', [])], {
      query: '"exact phrase" that nobody ever wrote down anywhere',
      sites: ['example.com'],
      depth: 'fast',
    })
    expect(result).toMatchObject({ status: 'empty', returned: 0, available: 0, results: [] })
    expect(result.error).toBeUndefined()
    expect(result.notes).toEqual([
      'No results; try removing sites, removing quotes, using fewer words.',
    ])
  })

  it('is empty, not an error, when one source failed and another confirmed nothing', async () => {
    const result = await search(
      [fakeSource('exa', new WebError('timeout', 'slow')), fakeSource('parallel', [])],
      { query: 'q' },
    )
    expect(result.status).toBe('empty')
    expect(result.sources.map((source) => source.status)).toEqual(['timeout', 'empty'])
  })

  it('is an error when every source failed, with rate_limited as the leading cause', async () => {
    const sources = [
      fakeSource('exa', new WebError('timeout', 'slow')),
      fakeSource('parallel', new WebError('rate_limited', 'limited', 45)),
      fakeSource('tavily', new WebError('blocked', 'HTTP 403')),
    ]
    const result = await search(sources, { query: 'q', depth: 'deep' })
    expect(result).toMatchObject({
      status: 'error',
      returned: 0,
      results: [],
      error: {
        code: 'rate_limited',
        message:
          'All search sources failed (exa: timeout, parallel: rate_limited, tavily: blocked); retry after 30s.',
        retry_after_s: 30,
      },
    })
    expect(result.id).toBeUndefined()
    expect(result.sources.map((source) => source.status)).toEqual([
      'timeout',
      'rate_limited',
      'blocked',
    ])
  })

  it('reports no_source_available with the way to fix it when nothing is configured', async () => {
    const result = await search([], { query: 'q' })
    expect(result).toMatchObject({ status: 'error', sources: [] })
    expect(result.error).toEqual({
      code: 'no_source_available',
      message:
        'no search source is available; set EXA_API_KEY, TAVILY_API_KEY or PARALLEL_API_KEY, or enable anonymous sources (WEB_RESEARCH_ANONYMOUS_SOURCES=1)',
    })
  })

  it('reports invalid input without calling anything', async () => {
    const exa = fakeSource('exa', hits('e', 3))
    const result = await search([exa], { query: 'q', recency: 'fortnight' })
    expect(result).toMatchObject({
      status: 'error',
      today: '2026-09-21',
      error: { code: 'invalid_input', message: 'recency must be one of day, week, month, year' },
    })
    expect(exa.requests).toHaveLength(0)
  })

  it('reports cancelled when the caller aborts', async () => {
    const controller = new AbortController()
    const exa = fakeSource('exa', (request, signal) => {
      controller.abort()
      return delayed(10_000, hits('e', 3))(request, signal)
    })
    const result = await searcherWith([exa]).search({ query: 'q' }, controller.signal)
    expect(result).toMatchObject({ status: 'error', error: { code: 'cancelled' } })
    // A cancelled call says nothing about the health of the source.
    const again = await search([exa], { query: 'other' })
    expect(again.sources[0]?.status).not.toBe('skipped')
  })

  it('keeps notes to three sentences, run notes before input notes', async () => {
    const exa = fakeSource('exa', hits('e', 2))
    const parallel = fakeSource('parallel', hits('p', 2))
    const result = await search([exa, parallel], {
      queries: 'fetch abort site:example.com',
      sites: 'https://e.example.com/x',
      max_results: 500,
      unknown_flag: true,
    })
    expect(result.notes).toHaveLength(3)
    expect(result.notes[0]).toBe('exa returned few results, so parallel was searched as well.')
    expect(result.notes[1]).toBe('Only 4 results were found.')
    expect(result.notes[2]).toMatch(/^Input was adjusted: .*max_results was limited to 50; .*\.$/u)
  })
})

describe('cursor', () => {
  it('pages through the frozen pool without any upstream call', async () => {
    const exa = fakeSource('exa', hits('docs', 25))
    const searcher = searcherWith([exa])
    const first = await searcher.search(
      { query: 'fetch abort', depth: 'fast', max_tokens: 3000 },
      never,
    )
    exa.answer = new WebError('internal', 'the network must not be touched')

    const second = await searcher.search({ cursor: first.next_cursor }, never)
    expect(exa.requests).toHaveLength(1)
    expect(second).toMatchObject({
      status: 'ok',
      id: first.id,
      returned: 10,
      available: 25,
      cache: 'hit',
      usage: { provider_calls: 0, est_cost_usd: 0 },
    })
    expect(second.results.map((entry) => entry.ref)).toEqual(
      Array.from({ length: 10 }, (_, index) => `${first.id}:r${index + 11}`),
    )
    expect(second.tokens).toBeLessThanOrEqual(3000)

    const third = await searcher.search({ cursor: second.next_cursor }, never)
    expect(third.results.map((entry) => entry.rank)).toEqual([21, 22, 23, 24, 25])
    expect(third.next_cursor).toBeUndefined()
    expect(exa.requests).toHaveLength(1)
  })

  it('is repeatable and works from another searcher on the same store', async () => {
    const first = await search([fakeSource('exa', hits('docs', 15))], { query: 'q', depth: 'fast' })
    const elsewhere = searcherWith([])
    const once = await elsewhere.search({ cursor: first.next_cursor }, never)
    const twice = await elsewhere.search({ cursor: first.next_cursor }, never)
    expect(once.results).toEqual(twice.results)
    expect(once.returned).toBe(5)
  })

  it('accepts a different page shape for the continuation', async () => {
    const searcher = searcherWith([fakeSource('exa', hits('docs', 25))])
    const first = await searcher.search({ query: 'q', depth: 'fast' }, never)
    const next = await searcher.search({ cursor: first.next_cursor, max_results: '3' }, never)
    expect(next.results.map((entry) => entry.rank)).toEqual([11, 12, 13])
    const after = await searcher.search({ cursor: next.next_cursor }, never)
    expect(after.results.map((entry) => entry.rank)).toEqual([14, 15, 16])
  })

  it('reports an unknown or expired cursor as expired_ref', async () => {
    const result = await search([fakeSource('exa', hits('e', 3))], { cursor: 'c_zzzz' })
    expect(result).toMatchObject({
      status: 'error',
      error: { code: 'expired_ref', message: 'This cursor has expired; run web_search again.' },
    })
  })

  it('keeps reporting a failed source on later pages of a partial search', async () => {
    const searcher = searcherWith([
      fakeSource('exa', new WebError('blocked', 'HTTP 403')),
      fakeSource('parallel', hits('p', 12)),
    ])
    const first = await searcher.search({ query: 'fetch abort' }, never)
    const second = await searcher.search({ cursor: first.next_cursor }, never)
    expect([first.status, second.status]).toEqual(['partial', 'partial'])
    expect(second.returned).toBe(2)
  })
})

describe('query cache', () => {
  it('serves the same request from the stored pool and says how old it is', async () => {
    const exa = fakeSource('exa', hits('docs', 12))
    const searcher = searcherWith([exa])
    const first = await searcher.search({ query: 'Fetch  Abort', depth: 'fast' }, never)
    clock = new Date(NOW.getTime() + 90_000)

    const second = await searcher.search(
      { queries: ['fetch abort'], depth: 'fast', max_tokens: 2000 },
      never,
    )
    expect(exa.requests).toHaveLength(1)
    expect(second).toMatchObject({
      status: 'ok',
      id: first.id,
      cache: 'hit',
      cache_age_s: 90,
      usage: { provider_calls: 0, est_cost_usd: 0 },
    })
    expect(second.results.map((entry) => entry.ref)).toEqual(
      first.results.map((entry) => entry.ref),
    )
    expect(first.cache_age_s).toBeUndefined()
  })

  it('keys on queries, sites, recency, depth and goal', async () => {
    const exa = fakeSource('exa', hits('docs', 12))
    const searcher = searcherWith([exa])
    const base = { query: 'fetch abort', depth: 'fast' }
    await searcher.search(base, never)
    for (const variant of [
      { ...base, goal: 'a goal' },
      { ...base, sites: ['docs.example.com'] },
      { ...base, recency: 'year' },
      { ...base, depth: 'deep' },
      { ...base, query: 'fetch abort signal' },
    ])
      expect((await searcher.search(variant, never)).cache).toBe('miss')
    expect(exa.requests).toHaveLength(6)
  })

  it('does not serve a pool that was built for fewer results than are now wanted', async () => {
    const exa = fakeSource('exa', (request) => Promise.resolve(hits('docs', request.maxResults)))
    const searcher = searcherWith([exa])
    await searcher.search({ query: 'q', depth: 'fast', max_results: 5 }, never)
    expect(
      (await searcher.search({ query: 'q', depth: 'fast', max_results: 8 }, never)).cache,
    ).toBe('hit')
    expect(
      (await searcher.search({ query: 'q', depth: 'fast', max_results: 40 }, never)).cache,
    ).toBe('miss')
  })

  it('never caches a search in which a source failed', async () => {
    const exa = fakeSource('exa', new WebError('timeout', 'slow'))
    const parallel = fakeSource('parallel', hits('p', 12))
    const searcher = searcherWith([exa, parallel])
    const first = await searcher.search({ query: 'fetch abort' }, never)
    expect(first.status).toBe('partial')
    clock = new Date(NOW.getTime() + 3600_000)
    exa.answer = hits('e', 12)
    const second = await searcher.search({ query: 'fetch abort' }, never)
    expect(second).toMatchObject({ status: 'ok', cache: 'miss' })
  })

  it('caches a confirmed empty answer', async () => {
    const exa = fakeSource('exa', [])
    const searcher = searcherWith([exa])
    await searcher.search({ query: 'nothing here', depth: 'fast' }, never)
    const second = await searcher.search({ query: 'nothing here', depth: 'fast' }, never)
    expect(second).toMatchObject({ status: 'empty', cache: 'hit' })
    expect(exa.requests).toHaveLength(1)
  })
})

describe('cooldown', () => {
  it('leaves a failed source alone, reports it as skipped, and tries it again later', async () => {
    const exa = fakeSource('exa', new WebError('rate_limited', 'limited'))
    const parallel = fakeSource('parallel', hits('p', 12))
    const searcher = searcherWith([exa, parallel])
    await searcher.search({ query: 'one' }, never)
    expect(exa.requests).toHaveLength(1)

    exa.answer = hits('e', 12)
    const during = await searcher.search({ query: 'two' }, never)
    expect(exa.requests).toHaveLength(1)
    expect(during.status).toBe('ok')
    expect(during.sources).toMatchObject([
      { id: 'parallel', status: 'ok' },
      { id: 'exa', status: 'skipped', retry_after_s: 300 },
    ])

    clock = new Date(NOW.getTime() + 301_000)
    const after = await searcher.search({ query: 'three', depth: 'deep' }, never)
    expect(exa.requests).toHaveLength(2)
    // exa was used less today, so it leads again.
    expect(after.sources.map((source) => [source.id, source.status])).toEqual([
      ['exa', 'ok'],
      ['parallel', 'ok'],
    ])
  })

  it('answers rate_limited with the time to wait when every source is cooling down', async () => {
    const exa = fakeSource('exa', new WebError('rate_limited', 'limited'))
    const parallel = fakeSource('parallel', new WebError('upstream_error', 'HTTP 502'))
    const searcher = searcherWith([exa, parallel])
    await searcher.search({ query: 'one', depth: 'deep' }, never)
    clock = new Date(NOW.getTime() + 10_000)

    const result = await searcher.search({ query: 'two' }, never)
    expect(result).toMatchObject({
      status: 'error',
      error: {
        code: 'rate_limited',
        message: 'every search source is cooling down after a failure; retry after 20s',
        retry_after_s: 20,
      },
      usage: { provider_calls: 0 },
    })
    expect(result.sources.map((source) => source.status)).toEqual(['skipped', 'skipped'])
    expect(exa.requests.length + parallel.requests.length).toBe(2)
  })
})

describe('usage ledger and limits', () => {
  it('records every upstream call, with a price only for keyed sources', async () => {
    const tavily = fakeSource('tavily', hits('t', 12), { paid: 0.008 })
    const exa = fakeSource('exa', hits('e', 12))
    const result = await search([exa, tavily], { queries: ['a', 'b'], depth: 'deep' })

    expect(result.usage).toEqual({
      provider_calls: 4,
      est_cost_usd: 0.016,
      paid_sources: ['tavily'],
    })
    expect(store.usageTodayBySource('tavily')).toEqual({ calls: 2, cost_usd: 0.016 })
    expect(store.usageTodayBySource('exa')).toEqual({ calls: 2, cost_usd: 0 })
  })

  it('does not charge for a call the vendor refused', async () => {
    const tavily = fakeSource('tavily', new WebError('blocked', 'HTTP 401'), { paid: 0.008 })
    await search([tavily], { query: 'q', depth: 'fast' })
    expect(store.usageTodayBySource('tavily')).toEqual({ calls: 1, cost_usd: 0 })
  })

  it('prefers a keyed source, and never books a call that would pass the daily budget', async () => {
    const tavily = fakeSource('tavily', hits('t', 12), { paid: 0.008 })
    const exa = fakeSource('exa', hits('e', 12))
    const config = testConfig({ WEB_RESEARCH_DAILY_BUDGET_USD: '0.02' })
    const searcher = searcherWith([exa, tavily], config)

    expect((await searcher.search({ query: 'one' }, never)).sources[0]?.id).toBe('tavily')
    expect((await searcher.search({ query: 'two' }, never)).sources[0]?.id).toBe('tavily')
    // A third call would make 0.024: it is refused before it is sent, not after.
    const third = await searcher.search({ query: 'three' }, never)
    expect(third.sources).toMatchObject([
      { id: 'exa', status: 'ok' },
      { id: 'tavily', status: 'skipped', detail: 'daily budget reached' },
    ])
    expect(third.usage.paid_sources).toBeUndefined()
    expect(third.notes).toEqual([
      'The daily budget is spent, so paid sources (tavily) were not used.',
    ])
    expect(tavily.requests).toHaveLength(2)
    expect(store.usageToday().cost_usd).toBeCloseTo(0.016, 6)
  })

  it('reports budget_exhausted when only paid sources exist and the budget is spent', async () => {
    store.addUsage('tavily', 200, 1.6)
    const result = await search([fakeSource('tavily', hits('t', 3), { paid: 0.008 })], {
      query: 'q',
    })
    expect(result).toMatchObject({ status: 'error', error: { code: 'budget_exhausted' } })
  })

  it('holds every anonymous source to its self-imposed daily cap', async () => {
    const config = testConfig({ WEB_RESEARCH_ANONYMOUS_DAILY_CAP: '3' })
    const exa = fakeSource('exa', hits('e', 12))
    const searcher = searcherWith([exa], config)
    for (const query of ['one', 'two', 'three'])
      expect((await searcher.search({ query, depth: 'fast' }, never)).status).toBe('ok')

    const result = await searcher.search({ query: 'four', depth: 'fast' }, never)
    expect(result).toMatchObject({ status: 'error', error: { code: 'budget_exhausted' } })
    expect(result.error?.message).toContain('WEB_RESEARCH_ANONYMOUS_DAILY_CAP')
    expect(exa.requests).toHaveLength(3)
  })

  it('spreads searches across equally ranked sources', async () => {
    const exa = fakeSource('exa', hits('e', 12))
    const parallel = fakeSource('parallel', hits('p', 12))
    const searcher = searcherWith([exa, parallel])
    for (const query of ['one', 'two', 'three', 'four']) await searcher.search({ query }, never)
    expect([exa.requests.length, parallel.requests.length]).toEqual([2, 2])
  })
})

describe('never throws', () => {
  it('still returns results when the pool cannot be stored, without refs that would not resolve', async () => {
    const broken: Store = {
      ...store,
      insertRecord() {
        throw new Error('disk full')
      },
    }
    const result = await searcherWith(
      [fakeSource('exa', hits('e', 12))],
      testConfig(),
      broken,
    ).search({ query: 'q', depth: 'fast' }, never)
    expect(result).toMatchObject({ status: 'ok', returned: 10, available: 12 })
    expect(result.id).toBeUndefined()
    expect(result.next_cursor).toBeUndefined()
    expect(result.results[0]?.ref).toBe('r1')
    expect(result.notes[0]).toBe('Results could not be stored, so refs and cursors will not work.')
  })

  it('turns an unexpected failure into an internal error', async () => {
    const faulty = fakeSource('exa', hits('e', 3))
    faulty.free = () => {
      throw new TypeError('bug in a custom adapter')
    }
    const result = await searcherWith([faulty]).search({ query: 'q' }, never)
    expect(result).toMatchObject({
      status: 'error',
      error: { code: 'internal', message: 'An unexpected internal error occurred.' },
    })
  })

  it('survives a ledger that cannot be written', async () => {
    const broken: Store = {
      ...store,
      addUsage() {
        throw new Error('database is locked')
      },
    }
    const result = await searcherWith(
      [fakeSource('exa', hits('e', 12))],
      testConfig(),
      broken,
    ).search({ query: 'q', depth: 'fast' }, never)
    expect(result.status).toBe('ok')
  })

  it('closes cleanly', async () => {
    await expect(searcherWith([]).close()).resolves.toBeUndefined()
  })
})
