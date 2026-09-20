/**
 * The size a result reports, and the size it was budgeted for, are promises about the text the
 * model receives. They are checked against the real text view, not against our own arithmetic.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { StoredSearch } from '../../src/contract.ts'
import { renderFetch } from '../../src/render/text.ts'
import { estimateTokens } from '../../src/tokens.ts'
import { createHarness, fixture, manualHtml, type Harness } from './helpers.ts'

let harness: Harness | undefined
afterEach(() => {
  harness?.close()
  harness = undefined
})

const LONG_PATH = `/docs/${'a-rather-long-path-segment/'.repeat(9)}page.html?version=2026-09-21&lang=en`
const routes = {
  '/manual': { body: manualHtml(40) },
  '/other': { body: manualHtml(25).replaceAll('replicated table', 'sharded ledger') },
  '/article': { body: fixture('article.html') },
  [LONG_PATH.split('?')[0] ?? '']: { body: manualHtml(12) },
  '/blocked': { status: 403 },
  '/gone': { status: 404 },
  '/slow-down': { status: 429, headers: { 'retry-after': '120' } },
}
const at = (path: string): string => `https://docs.example.com${path}`

const search: StoredSearch = {
  id: 'k7f2m9qx',
  created_at: '2026-09-21T02:00:00.000Z',
  queries: ['billing subsystem inspect'],
  hits: [
    {
      ref: 'k7f2m9qx:r1',
      rank: 1,
      title: 'Manual',
      url: at('/manual'),
      site: 'docs.example.com',
      excerpt: '',
      found_by: ['exa'],
      q: [1],
    },
    {
      ref: 'k7f2m9qx:r2',
      rank: 2,
      title: 'Gone',
      url: at('/gone'),
      site: 'docs.example.com',
      excerpt: '',
      found_by: ['exa'],
      q: [1],
    },
  ],
  sources: [],
}

const CASES: [string, Record<string, unknown>][] = [
  ['a short page in full', { url: at('/article') }],
  ['the lead of a long page', { url: at('/manual') }],
  ['the lead of a long page, small budget', { url: at('/manual'), max_tokens: 900 }],
  ['a long address', { url: at(LONG_PATH), max_tokens: 1500 }],
  ['a section', { url: at('/manual'), section: '7' }],
  [
    'find with many matches',
    { url: at('/manual'), find: 'exit code 0 means healthy', max_tokens: 2000 },
  ],
  ['find without a match', { url: at('/manual'), find: 'the billing subsystem never sleeps' }],
  [
    'goal on one page',
    { url: at('/manual'), goal: 'inspect the billing subsystem', max_tokens: 3000 },
  ],
  ['goal that matches nothing', { url: at('/manual'), goal: 'zymurgy quokka', max_tokens: 1200 }],
  [
    'several pages, all readable',
    {
      urls: [at('/manual'), at('/other'), at('/article')],
      goal: 'billing ledger',
      max_tokens: 4000,
    },
  ],
  [
    'several pages, most of them failing',
    {
      urls: [
        at('/manual'),
        at('/blocked'),
        at('/gone'),
        at('/slow-down'),
        `${at(LONG_PATH)}&missing=1#x`,
      ],
      goal: 'billing',
      max_tokens: 2500,
    },
  ],
  [
    'every page failing',
    { urls: [at('/blocked'), at('/gone'), 'http://10.0.0.1/admin'], goal: 'anything' },
  ],
  [
    'five failing pages with addresses as long as they get',
    {
      urls: [1, 2, 3, 4, 5].map((n) => `${at('/gone')}/${'very-long-segment-'.repeat(20)}${n}`),
      goal: 'anything',
      max_tokens: 1200,
    },
  ],
  [
    'refs, one of them expired',
    { refs: ['k7f2m9qx:r1', 'k7f2m9qx:r2', 'zzzz0000:r1'], max_tokens: 2500 },
  ],
  [
    'unknown parameters and a clamped budget',
    { url: at('/manual'), max_tokens: 99_999, colour: 'blue', depth: 3, format: 'md' },
  ],
]

describe('the reported size of a fetch response', () => {
  it.each(CASES)(
    'covers the text view, and the text view fits the budget: %s',
    async (_name, request) => {
      harness = await createHarness(routes)
      harness.store.putRecord('search', 'k7f2m9qx', search, 3600)
      const result = await harness.fetch(request)
      const rendered = estimateTokens(renderFetch(result))
      const budget = Math.min(
        Number(request.max_tokens ?? 8000),
        harness.config.limits.maxOutputTokens,
      )
      expect(result.tokens).toBeGreaterThanOrEqual(rendered)
      // None of these budgets is too small for its frame, so nobody is told that it was.
      expect(result.tokens).toBeLessThanOrEqual(budget)
      expect(result.notes.join(' ')).not.toContain('is below what reporting')
      expect(rendered).toBeLessThanOrEqual(budget)
      expect(renderFetch(result).length).toBeLessThanOrEqual(harness.config.limits.maxOutputChars)
      // The estimate is a promise, not a guess: it may overstate, but not wildly.
      expect(result.tokens - rendered).toBeLessThan(Math.max(250, rendered * 0.2))
    },
  )

  it('says where the goal came from when the caller gave none', async () => {
    harness = await createHarness(routes)
    harness.store.putRecord('search', 'k7f2m9qx', search, 3600)
    const inherited = await harness.fetch({
      refs: ['k7f2m9qx:r1', 'k7f2m9qx:r2'],
      max_tokens: 2500,
    })
    expect(inherited.goal).toBe('billing subsystem inspect')
    expect(inherited.notes).toContain(
      'no goal was given, so the goal of the search these refs came from was used',
    )
    expect(inherited.notes.join(' ')).not.toContain('billing')
    const given = await harness.fetch({ refs: ['k7f2m9qx:r1'], goal: 'storage', max_tokens: 2500 })
    expect(given.notes.join(' ')).not.toContain('no goal was given')
  })
})

describe('a budget smaller than the frame of the response', () => {
  const longAddress = (n: number): string =>
    `${at('/gone')}/${'a-long-path-segment-'.repeat(12)}${n}`

  it('says so when failing pages alone need more than max_tokens, and cuts nothing', async () => {
    harness = await createHarness(routes)
    const result = await harness.fetch({
      urls: [1, 2, 3, 4].map(longAddress),
      goal: 'anything',
      max_tokens: 500,
    })
    const rendered = estimateTokens(renderFetch(result))
    expect(rendered).toBeGreaterThan(500)
    expect(result.tokens).toBeGreaterThanOrEqual(rendered)
    expect(rendered).toBeLessThanOrEqual(harness.config.limits.maxOutputTokens)
    expect(result.pages).toHaveLength(4)
    expect(result.notes[0]).toMatch(
      /^max_tokens 500 is below what reporting these 4 pages needs \(~\d+ tokens\); nothing was cut$/u,
    )
    const stated = Number(/~(\d+) tokens/u.exec(result.notes[0] ?? '')?.[1])
    expect(Math.abs(stated - result.tokens)).toBeLessThanOrEqual(15)
  })

  it('says so when a readable page only gets its minimum next to failing pages', async () => {
    harness = await createHarness(routes)
    const result = await harness.fetch({
      urls: [at('/manual'), ...[1, 2, 3, 4].map(longAddress)],
      goal: 'billing',
      max_tokens: 900,
    })
    const rendered = estimateTokens(renderFetch(result))
    expect(result.tokens).toBeGreaterThanOrEqual(rendered)
    expect(rendered).toBeLessThanOrEqual(harness.config.limits.maxOutputTokens)
    expect(result.pages[0]?.parts.length).toBeGreaterThan(0)
    expect(result.notes[0]).toMatch(
      /^max_tokens 900 is below what reporting these 5 pages needs \(~\d+ tokens\); each readable page was given the minimum$/u,
    )
  })

  it('stays silent when the response fits', async () => {
    harness = await createHarness(routes)
    const result = await harness.fetch({
      urls: [at('/manual'), at('/gone')],
      goal: 'billing',
      max_tokens: 2000,
    })
    expect(result.tokens).toBeLessThanOrEqual(2000)
    expect(result.notes.join(' ')).not.toContain('max_tokens')
  })
})
