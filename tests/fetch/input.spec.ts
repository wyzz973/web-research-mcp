import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.ts'
import type { StoredSearch } from '../../src/contract.ts'
import { createReader } from '../../src/fetch/index.ts'
import { normalizeFetch } from '../../src/fetch/normalize.ts'
import { resolveTargets } from '../../src/fetch/targets.ts'
import { savePool } from '../../src/search/pool.ts'
import { createHarness, expectVerbatim, fixture, manualHtml, type Harness } from './helpers.ts'

let harness: Harness | undefined
afterEach(() => {
  harness?.close()
  harness = undefined
})

const config = loadConfig({})

describe('normalizeFetch', () => {
  it('merges url, urls, ref, and refs, accepting a string where an array is expected', () => {
    const plan = normalizeFetch(
      {
        url: 'https://a.example.com/',
        urls: 'https://b.example.com/',
        ref: 'k7f2:r1',
        refs: ['s_k2m9qx'],
        goal: 'x',
      },
      config,
    )
    expect(plan.targets).toEqual([
      { url: 'https://a.example.com/' },
      { url: 'https://b.example.com/' },
      { ref: 'k7f2:r1' },
      { ref: 's_k2m9qx' },
    ])
    expect(plan.notes).toEqual([])
  })

  it('splits several addresses given in one string, plain or as JSON text', () => {
    expect(
      normalizeFetch(
        { urls: 'https://a.example.com/x, https://b.example.com/y', goal: 'g' },
        config,
      ).targets,
    ).toHaveLength(2)
    expect(
      normalizeFetch(
        { urls: '["https://a.example.com/x","https://b.example.com/y"]', goal: 'g' },
        config,
      ).targets,
    ).toHaveLength(2)
  })

  it('adds https:// to a bare host and says so', () => {
    const plan = normalizeFetch({ url: 'developer.mozilla.org/en-US/docs/Web' }, config)
    expect(plan.targets).toEqual([{ url: 'https://developer.mozilla.org/en-US/docs/Web' }])
    expect(plan.notes).toEqual(['added https:// to a URL without a scheme'])
  })

  it('leaves other schemes alone so the network policy can refuse them', () => {
    expect(normalizeFetch({ url: 'file:///etc/passwd' }, config).targets).toEqual([
      { url: 'file:///etc/passwd' },
    ])
  })

  it('moves a ref given as url, and a URL given as ref, to where they belong', () => {
    const plan = normalizeFetch(
      { url: 'k7f2:r3', ref: 'https://example.com/page', goal: 'g' },
      config,
    )
    expect(plan.targets).toEqual([{ ref: 'k7f2:r3' }, { url: 'https://example.com/page' }])
    expect(plan.notes).toHaveLength(2)
  })

  it('reads a duplicate once and keeps at most the configured number of pages', () => {
    const urls = [1, 2, 3, 4, 5, 6, 7].map((n) => `https://example.com/${n}`)
    const plan = normalizeFetch({ urls: [...urls, urls[0]], goal: 'g' }, config)
    expect(plan.targets).toHaveLength(5)
    expect(plan.notes).toEqual([
      'duplicate targets were read once',
      'only the first 5 of 7 targets were read',
    ])
  })

  it('ignores unknown parameters and lists them', () => {
    const plan = normalizeFetch(
      { url: 'https://example.com/', timeout: 5, 'weird name!': 1, format: 'md' },
      config,
    )
    expect(plan.notes).toEqual(['ignored unknown parameters: timeout, format'])
  })

  it.each([
    [undefined, 8000, []],
    ['4000', 4000, []],
    [2500.7, 2500, []],
    [50_000, 10_000, ['max_tokens was lowered to the server limit of 10000']],
    [10, 500, ['max_tokens was raised to the minimum of 500']],
    ['lots', 8000, ['max_tokens was not a positive number; used 8000']],
    [-5, 8000, ['max_tokens was not a positive number; used 8000']],
  ])('resolves max_tokens %j to %i', (value, expected, notes) => {
    const plan = normalizeFetch({ url: 'https://example.com/', max_tokens: value }, config)
    expect(plan.maxTokens).toBe(expected)
    expect(plan.notes).toEqual(notes)
  })

  it('coerces fresh, numeric section ids, and blank strings', () => {
    const plan = normalizeFetch(
      { url: 'https://example.com/', fresh: 'true', section: 13.2, goal: '  ', find: '' },
      config,
    )
    expect(plan).toMatchObject({ fresh: true, section: '13.2', goal: undefined, find: undefined })
  })

  it('notes that render is not available instead of failing', () => {
    expect(
      normalizeFetch({ url: 'https://example.com/', render: true }, config).notes[0],
    ).toContain('render is not available')
  })

  it.each([
    [{}, 'pass url, urls, ref, or refs'],
    [{ urls: [] }, 'pass url, urls, ref, or refs'],
    [{ urls: [1, 2] }, 'urls must be a string or an array of strings'],
    [{ url: { href: 'x' } }, 'url must be a string or an array of strings'],
    [{ url: 'https://example.com/', goal: ['a'] }, 'goal must be a string'],
    [
      { urls: ['https://a.example.com/', 'https://b.example.com/'], section: '2' },
      'section reads one page',
    ],
  ])('rejects %j', (request, message) => {
    expect(() => normalizeFetch(request, config)).toThrowError(
      expect.objectContaining({
        code: 'invalid_input',
        message: expect.stringContaining(message) as string,
      }),
    )
  })
})

describe('refs', () => {
  const search: StoredSearch = {
    id: 'k7f2',
    created_at: '2026-09-21T02:00:00.000Z',
    queries: ['retry policy exponential backoff', 'second query'],
    hits: [
      {
        ref: 'r1',
        rank: 1,
        title: 'Retry',
        url: 'https://docs.example.com/guide/retry',
        site: 'docs.example.com',
        excerpt: '',
        found_by: ['exa'],
        q: [1],
      },
      {
        ref: 'r2',
        rank: 2,
        title: 'Manual',
        url: 'https://docs.example.com/manual',
        site: 'docs.example.com',
        excerpt: '',
        found_by: ['exa'],
        q: [1],
      },
    ],
    sources: [],
  }
  const routes = {
    'https://docs.example.com/guide/retry': { body: fixture('article.html') },
    'https://docs.example.com/manual': { body: manualHtml(30) },
  }

  it('reads the URL behind a search result and keeps the ref on the page', async () => {
    harness = await createHarness(routes)
    harness.store.putRecord(
      'search',
      'k7f2',
      { ...search, goal: 'how many retries by default' },
      3600,
    )
    const result = await harness.fetch({ ref: 'k7f2:r1' })
    expect(result.goal).toBe('how many retries by default')
    expect(result.pages[0]).toMatchObject({
      status: 'ok',
      ref: 'k7f2:r1',
      url: 'https://docs.example.com/guide/retry',
    })
  })

  it('falls back to the first query as the goal, which makes refs alone enough for several pages', async () => {
    harness = await createHarness(routes)
    harness.store.putRecord('search', 'k7f2', search, 3600)
    const result = await harness.fetch({ refs: ['k7f2:r1', 'k7f2:r2'], max_tokens: 3000 })
    expect(result.status).toBe('ok')
    expect(result.goal).toBe('retry policy exponential backoff')
    expect(result.pages.map((page) => page.ref)).toEqual(['k7f2:r1', 'k7f2:r2'])
    expectVerbatim(result, harness.store)
  })

  it('resolves refs the way web_search stores them: the full ref inside the pool', async () => {
    harness = await createHarness(routes)
    const stored = {
      ...search,
      id: 'k7f2m9qx',
      hits: search.hits.map((hit) => ({ ...hit, ref: `k7f2m9qx:${hit.ref}` })),
    }
    harness.store.putRecord('search', 'k7f2m9qx', stored, 3600)
    const result = await harness.fetch({ ref: ' k7f2m9qx:r2 ', section: '3.1' })
    expect(result.pages[0]).toMatchObject({
      status: 'ok',
      url: 'https://docs.example.com/manual',
      mode: 'section',
    })
    expect((await harness.fetch({ ref: 'k7f2m9qx:r3' })).pages[0]?.error?.code).toBe('expired_ref')
  })

  it('issues cursors long enough to stay unique in a model context', async () => {
    harness = await createHarness(routes)
    const page = (await harness.fetch({ url: 'https://docs.example.com/manual', max_tokens: 1000 }))
      .pages[0]
    expect(page?.next_cursor).toMatch(/^c_[a-z0-9]{8}$/u)
  })

  it('prefers an explicit goal over the stored one', async () => {
    harness = await createHarness(routes)
    harness.store.putRecord('search', 'k7f2', { ...search, goal: 'stored goal' }, 3600)
    expect((await harness.fetch({ ref: 'k7f2:r1', goal: 'explicit goal' })).goal).toBe(
      'explicit goal',
    )
  })

  it.each([
    ['an unknown search', 'zzzz:r1'],
    ['a result number that search never had', 'k7f2:r9'],
  ])('reports %s as an expired ref without touching the network', async (_name, ref) => {
    harness = await createHarness(routes)
    harness.store.putRecord('search', 'k7f2', search, 3600)
    const result = await harness.fetch({ ref })
    expect(result.status).toBe('error')
    expect(result.pages[0]).toMatchObject({ status: 'error', ref, error: { code: 'expired_ref' } })
    expect(result.pages[0]?.error?.message).toContain('run web_search again')
    expect(harness.requests).toEqual([])
  })

  it('rejects a bare result number and a malformed stored record, page by page', async () => {
    harness = await createHarness(routes)
    harness.store.putRecord('search', 'k7f2', search, 3600)
    harness.store.putRecord('search', 'bad1', { hits: 'not an array' }, 3600)
    const result = await harness.fetch({ refs: ['r1', 'bad1:r1', 'k7f2:r1'], goal: 'retries' })
    expect(result.status).toBe('partial')
    expect(result.pages.map((page) => page.error?.code)).toEqual([
      'invalid_input',
      'expired_ref',
      undefined,
    ])
    expect(result.pages[0]?.error?.message).toBe(
      'use the full ref from web_search, for example "k7f2:r1"',
    )
    expect(harness.requests).toEqual(['https://docs.example.com/guide/retry'])
  })

  it('resolves a ref written by the search side itself (savePool), end to end', async () => {
    harness = await createHarness(routes)
    const pool = savePool(
      harness.store,
      {
        createdAt: new Date('2026-09-21T02:00:00.000Z'),
        queryHash: 'hash-of-the-first-request',
        queries: ['platform manual logging', 'second query'],
        goal: undefined,
        hits: [
          {
            url: 'https://docs.example.com/guide/retry',
            title: 'Retry',
            site: 'docs.example.com',
            passages: ['p'],
            foundBy: ['exa'],
            q: [1],
          },
          {
            url: 'https://docs.example.com/manual',
            title: 'Manual',
            site: 'docs.example.com',
            passages: ['p'],
            foundBy: ['exa'],
            q: [1],
          },
        ],
        sources: [],
      },
      3600,
    )
    const second = pool.hits[1]?.ref ?? ''
    expect(second).toBe(`${pool.id}:r2`)
    const targets = resolveTargets(harness.store, [{ ref: second }])
    expect(targets).toEqual([
      {
        kind: 'url',
        n: 1,
        url: 'https://docs.example.com/manual',
        ref: second,
        goal: 'platform manual logging',
      },
    ])
    const result = await harness.fetch({ refs: pool.hits.map((hit) => hit.ref), max_tokens: 3000 })
    expect(result.status).toBe('ok')
    expect(result.goal).toBe('platform manual logging')
    expect(result.pages.map((page) => page.url)).toEqual([
      'https://docs.example.com/guide/retry',
      'https://docs.example.com/manual',
    ])
    const withGoal = savePool(
      harness.store,
      {
        createdAt: new Date(),
        queryHash: 'hash-of-the-second-request',
        queries: ['q'],
        goal: 'the stored goal',
        hits: [
          {
            url: 'https://docs.example.com/guide/retry',
            title: 'Retry',
            site: 'docs.example.com',
            passages: [],
            foundBy: ['exa'],
            q: [1],
          },
        ],
        sources: [],
      },
      3600,
    )
    expect((await harness.fetch({ ref: withGoal.hits[0]?.ref })).goal).toBe('the stored goal')
  })

  it('reads a snapshot id without going back to the site', async () => {
    harness = await createHarness(routes)
    const first = await harness.fetch({ url: 'https://docs.example.com/manual', max_tokens: 1500 })
    const snapshot = first.pages[0]?.snapshot ?? ''
    harness.clock.now = new Date('2026-09-24T03:00:00.000Z')
    const again = await harness.fetch({ ref: snapshot, section: '2.1' })
    expect(again.pages[0]).toMatchObject({
      status: 'ok',
      snapshot,
      cache: 'hit',
      cache_age_s: 3 * 24 * 3600,
      ref: snapshot,
    })
    expect(harness.requests).toHaveLength(1)
    expect((await harness.fetch({ ref: 's_zzzzzz' })).pages[0]?.error?.code).toBe('expired_ref')
  })
})

describe('snapshots and cache', () => {
  const URL_A = 'https://docs.example.com/guide/retry'

  it('reuses a snapshot for a day, then fetches again', async () => {
    harness = await createHarness({ [URL_A]: { body: fixture('article.html') } })
    const first = (await harness.fetch({ url: URL_A })).pages[0]
    harness.clock.now = new Date('2026-09-21T05:00:00.000Z')
    const second = (await harness.fetch({ url: `${URL_A}#fragment` })).pages[0]
    expect(second).toMatchObject({ snapshot: first?.snapshot, cache: 'hit', cache_age_s: 7200 })
    expect(harness.requests).toHaveLength(1)
    harness.clock.now = new Date('2026-09-22T03:00:01.000Z')
    const third = (await harness.fetch({ url: URL_A })).pages[0]
    expect(third?.cache).toBe('miss')
    expect(third?.snapshot).not.toBe(first?.snapshot)
    expect(harness.requests).toHaveLength(2)
  })

  it('fresh makes a new snapshot and leaves the old one citable', async () => {
    let version = 1
    harness = await createHarness({
      [URL_A]: () => ({
        body: `# Notes\n\nThis is version ${version} of the notes.`,
        headers: { 'content-type': 'text/markdown' },
      }),
    })
    const first = (await harness.fetch({ url: URL_A })).pages[0]
    version = 2
    const fresh = (await harness.fetch({ url: URL_A, fresh: true })).pages[0]
    expect(fresh?.cache).toBe('miss')
    expect(fresh?.snapshot).not.toBe(first?.snapshot)
    expect(fresh?.sha256).not.toBe(first?.sha256)
    expect(fresh?.parts[0]?.text).toContain('version 2')
    expect(harness.store.getSnapshot(first?.snapshot ?? '')?.markdown).toContain('version 1')
    const viaOldSnapshot = (await harness.fetch({ ref: first?.snapshot, find: 'version 1' }))
      .pages[0]
    expect(viaOldSnapshot).toMatchObject({ find_total: 1, snapshot: first?.snapshot })
  })

  it('stores the sha256 of the Markdown and the final address after redirects', async () => {
    harness = await createHarness({
      '/old': { status: 301, headers: { location: '/new' } },
      '/new': {
        body: '# Moved\n\nThe page lives here now.',
        headers: { 'content-type': 'text/markdown' },
      },
    })
    const page = (await harness.fetch({ url: 'https://example.com/old' })).pages[0]
    const snapshot = harness.store.getSnapshot(page?.snapshot ?? '')
    expect(page).toMatchObject({
      url: 'https://example.com/old',
      final_url: 'https://example.com/new',
    })
    expect(snapshot).toMatchObject({
      http_status: 200,
      content_type: 'text/markdown',
      hidden_removed: 0,
    })
    const { createHash } = await import('node:crypto')
    expect(snapshot?.sha256).toBe(
      createHash('sha256')
        .update(snapshot?.markdown ?? '')
        .digest('hex'),
    )
  })

  it('reports hidden content that was stripped', async () => {
    harness = await createHarness({ '/h': { body: fixture('hidden.html') } })
    expect((await harness.fetch({ url: 'https://example.com/h' })).pages[0]?.hidden_removed).toBe(7)
  })
})

describe('never throws', () => {
  it('turns a failing store into an internal error result', async () => {
    harness = await createHarness({})
    const broken = createReader({
      config,
      store: {
        ...harness.store,
        getRecord: () => {
          throw new Error('disk on fire')
        },
      },
    })
    const result = await broken.fetch({ cursor: 'c_abcd' }, new AbortController().signal)
    expect(result).toMatchObject({ status: 'error', pages: [], error: { code: 'internal' } })
    expect(result.error?.message).not.toContain('disk on fire')
  })

  it('turns garbage arguments into invalid_input', async () => {
    harness = await createHarness({})
    const result = await harness.fetch({ url: 42 })
    expect(result).toMatchObject({ status: 'error', error: { code: 'invalid_input' } })
  })

  it('reports an unparseable address on its page', async () => {
    harness = await createHarness({})
    const result = await harness.fetch({ url: 'https://' })
    expect(result.pages[0]?.error?.code).toBe('invalid_input')
  })
})

describe('close', () => {
  it('cancels reads in flight, waits for them, and refuses new work', async () => {
    harness = await createHarness({
      '/slow': { body: 'partial', hang: true, headers: { 'content-type': 'text/plain' } },
    })
    const pending = harness.fetch({ url: 'https://example.com/slow' })
    await new Promise((resolve) => setTimeout(resolve, 30))
    let settled = false
    void pending.then(() => (settled = true))
    await harness.reader.close()
    expect(settled).toBe(true)
    expect((await pending).pages[0]?.error?.code).toBe('cancelled')
    const after = await harness.fetch({ url: 'https://example.com/slow' })
    expect(after.pages[0]?.error?.code).toBe('cancelled')
    expect(harness.requests).toHaveLength(1)
  })
})
