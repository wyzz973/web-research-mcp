import { describe, expect, it } from 'vitest'
import type { SearchHit } from '../../src/contract.ts'
import { PASSAGE_GAP } from '../../src/search/excerpt.ts'
import { RESERVED_TOKENS, packPage } from '../../src/search/pack.ts'
import { buildTerms } from '../../src/search/terms.ts'
import { estimateTokens } from '../../src/tokens.ts'

const terms = buildTerms(['fetch abort timeout'], undefined)
const sentence = 'AbortSignal.timeout() makes fetch abort after the given time. '

function poolOf(count: number, text = sentence.repeat(30)): SearchHit[] {
  return Array.from({ length: count }, (_, index) => ({
    ref: `k7f2:r${index + 1}`,
    rank: index + 1,
    title: `Result number ${index + 1} about fetch`,
    url: `https://example.com/articles/fetch-abort-timeout-${index + 1}`,
    site: 'example.com',
    excerpt: text.trim(),
    found_by: ['exa'],
    q: [1],
  }))
}

function page(pool: SearchHit[], overrides: Partial<Parameters<typeof packPage>[0]> = {}) {
  return packPage({
    pool,
    offset: 0,
    count: 10,
    maxTokens: 5000,
    maxChars: 30_000,
    terms,
    ...overrides,
  })
}

/** What render/text.ts prints for the results, to check the estimate against real output. */
function rendered(results: SearchHit[]): string {
  return results
    .map((hit) => `[${hit.ref}] ${hit.title} - ${hit.site}\n${hit.url}\n${hit.excerpt}\n`)
    .join('\n')
}

describe('packPage', () => {
  it('gives ten results about 450 tokens each by default', () => {
    const result = page(poolOf(30))
    expect(result.results).toHaveLength(10)
    for (const hit of result.results) {
      const tokens = estimateTokens(hit.excerpt)
      expect(tokens).toBeGreaterThan(380)
      expect(tokens).toBeLessThanOrEqual(470)
    }
    expect(result.tokens).toBeLessThanOrEqual(5000)
  })

  it('lets one result use the whole budget, up to the text it has', () => {
    const [only] = page(poolOf(1), { count: 1, maxTokens: 6000 }).results
    expect(only?.excerpt).toBe(sentence.repeat(30).trim())
    const long = page(poolOf(1, sentence.repeat(60)), { count: 1, maxTokens: 800 })
    expect(estimateTokens(long.results[0]?.excerpt ?? '')).toBeGreaterThan(550)
    expect(long.tokens).toBeLessThanOrEqual(800)
  })

  it('shrinks fifty results to a title, an address and about one sentence each', () => {
    const result = page(poolOf(60), { count: 50, maxTokens: 5000 })
    expect(result.results).toHaveLength(50)
    for (const hit of result.results) {
      expect(hit.excerpt.length).toBeGreaterThan(20)
      expect(estimateTokens(hit.excerpt)).toBeLessThanOrEqual(60)
    }
    expect(result.tokens).toBeLessThanOrEqual(5000)
  })

  it('keeps the requested count as long as every title and address fits, even without excerpts', () => {
    // 40 titles and addresses take about 1,300 of the 1,380 tokens: they fit, excerpts do not.
    const result = page(poolOf(60), { count: 40, maxTokens: 1500 })
    expect(result.results).toHaveLength(40)
    expect(result.results.every((hit) => hit.excerpt === '')).toBe(true)
    expect(result.results.every((hit) => hit.title !== '' && hit.url !== '')).toBe(true)
    expect(result.tokens).toBeLessThanOrEqual(1500)
  })

  it('returns fewer results only when even the titles and addresses do not fit', () => {
    const result = page(poolOf(60), { count: 50, maxTokens: 1500 })
    expect(result.results.length).toBeGreaterThan(20)
    expect(result.results.length).toBeLessThan(50)
    expect(result.tokens).toBeLessThanOrEqual(1500)
    expect(result.results.map((hit) => hit.rank)).toEqual(
      result.results.map((_, index) => index + 1),
    )
  })

  it('always returns one result, however small the budget', () => {
    const result = page(poolOf(5), { maxTokens: 200 })
    expect(result.results.length).toBeGreaterThanOrEqual(1)
    const tiny = page(poolOf(5), { maxTokens: 10 })
    expect(tiny.results).toHaveLength(1)
    expect(tiny.results[0]?.url).toBe('https://example.com/articles/fetch-abort-timeout-1')
  })

  it('counts the notes and the source line against the budget', () => {
    const plain = page(poolOf(10), { maxTokens: 2000 })
    const annotated = page(poolOf(10), { maxTokens: 2000, extraTokens: 300 })
    expect(annotated.tokens).toBeLessThanOrEqual(2000)
    const size = (results: SearchHit[]) =>
      results.reduce((sum, hit) => sum + estimateTokens(hit.excerpt), 0)
    expect(size(plain.results) - size(annotated.results)).toBeGreaterThan(100)
  })

  it('applies the character ceiling together with the token ceiling', () => {
    const result = page(poolOf(10), { maxTokens: 10_000, maxChars: 6000 })
    expect(result.results).toHaveLength(10)
    expect(rendered(result.results).length).toBeLessThanOrEqual(6000)
  })

  it('budgets CJK text by its real token weight', () => {
    const chinese = '使用 AbortController 可以在超时之后取消 fetch 请求。'.repeat(80)
    const result = page(poolOf(10, chinese), { maxTokens: 3000 })
    expect(result.results).toHaveLength(10)
    expect(result.tokens).toBeLessThanOrEqual(3000)
    for (const hit of result.results) expect(estimateTokens(hit.excerpt)).toBeLessThanOrEqual(270)
  })

  it('reports an estimate that covers the rendered results', () => {
    const result = page(poolOf(10), { maxTokens: 2000 })
    expect(result.tokens).toBeGreaterThanOrEqual(estimateTokens(rendered(result.results)))
    expect(result.tokens - RESERVED_TOKENS).toBeLessThanOrEqual(2000 - RESERVED_TOKENS)
  })

  it('pages through the pool without changing refs or ranks', () => {
    const pool = poolOf(25)
    const second = page(pool, { offset: 10 })
    expect(second.results.map((hit) => hit.ref)).toEqual(
      Array.from({ length: 10 }, (_, index) => `k7f2:r${index + 11}`),
    )
    expect(page(pool, { offset: 20 }).results).toHaveLength(5)
    expect(page(pool, { offset: 25 })).toEqual({ results: [], tokens: RESERVED_TOKENS })
  })

  it('splits the spare budget evenly and leaves short texts whole', () => {
    const pool = poolOf(4)
    const short = pool[1]
    if (short) short.excerpt = 'Short text.'
    const result = page(pool, { count: 4, maxTokens: 1000 })
    const sizes = result.results.map((hit) => estimateTokens(hit.excerpt))
    expect(result.results[1]?.excerpt).toBe('Short text.')
    expect(Math.abs((sizes[0] ?? 0) - (sizes[2] ?? 0))).toBeLessThanOrEqual(20)
  })

  it('keeps passages apart that the source gave as separate fragments', () => {
    const pool = poolOf(
      1,
      ['First fragment about fetch.', 'Second fragment about abort.'].join(PASSAGE_GAP),
    )
    expect(page(pool).results[0]?.excerpt).toBe(
      'First fragment about fetch. … Second fragment about abort.',
    )
  })

  it('handles results without any text', () => {
    const result = page(poolOf(3, ''))
    expect(result.results.map((hit) => hit.excerpt)).toEqual(['', '', ''])
  })
})
