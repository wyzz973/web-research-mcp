import { afterEach, describe, expect, it } from 'vitest'
import type { FetchResult, PageResult } from '../../src/contract.ts'
import { createHarness, expectVerbatim, fixture, manualHtml, type Harness } from './helpers.ts'

let harness: Harness | undefined
afterEach(() => {
  harness?.close()
  harness = undefined
})

const MANUAL = 'https://docs.example.com/manual'
const ARTICLE = 'https://docs.example.com/guide/retry'

function only(result: FetchResult): PageResult {
  expect(result.pages).toHaveLength(1)
  const page = result.pages[0]
  if (!page) throw new Error('no page')
  return page
}

async function manual(chapters = 40): Promise<Harness> {
  harness = await createHarness({
    [MANUAL]: { body: manualHtml(chapters) },
    [ARTICLE]: { body: fixture('article.html') },
  })
  return harness
}

describe('default reading', () => {
  it('returns a short page in full with every promise field filled in', async () => {
    const h = await manual()
    const result = await h.fetch({ url: ARTICLE })
    const page = only(result)
    expect(result.status).toBe('ok')
    expect(page).toMatchObject({
      n: 1,
      status: 'ok',
      url: ARTICLE,
      mode: 'full',
      truncated: false,
      cache: 'miss',
      title: 'Retry policy guide',
      retrieved: '2026-09-21T03:00:00.000Z',
      hidden_removed: 0,
    })
    expect(page.snapshot).toMatch(/^s_[a-z0-9]{6,}$/u)
    expect(page.sha256).toMatch(/^[0-9a-f]{64}$/u)
    expect(page.next_cursor).toBeUndefined()
    expect(page.outline).toBeUndefined()
    expect(page.shown_chars).toBe(page.total_chars)
    expect(page.total_tokens).toBeGreaterThan(100)
    expectVerbatim(result, h.store)
  })

  it('returns the lead of a long page with an outline and a cursor', async () => {
    const h = await manual()
    const result = await h.fetch({ url: MANUAL, max_tokens: 2000 })
    const page = only(result)
    expect(page).toMatchObject({ mode: 'lead', truncated: true })
    expect(page.parts).toHaveLength(1)
    expect(page.parts[0]?.start).toBe(0)
    expect(page.next_cursor).toMatch(/^c_/u)
    expect(page.shown_chars).toBeLessThan(page.total_chars ?? 0)
    expect(result.tokens).toBeLessThanOrEqual(2000)
    expect(page.outline?.map((entry) => entry.id).slice(0, 3)).toEqual(['p1', '1', '2'])
    expectVerbatim(result, h.store)
  })

  it('keeps the outline within 15% of the budget: deepest level first, then fewer entries', async () => {
    const h = await manual()
    const roomy = await h.fetch({ url: MANUAL, max_tokens: 10_000 })
    const all = only(roomy).outline ?? []
    expect(new Set(all.map((entry) => entry.level))).toEqual(new Set([1, 2]))
    expect(all).toHaveLength(41)
    expect(roomy.notes.join(' ')).not.toContain('outline was shortened')
    const tight = await h.fetch({ url: MANUAL, max_tokens: 2000 })
    const kept = only(tight).outline ?? []
    expect(kept.length).toBeGreaterThan(5)
    expect(kept.length).toBeLessThan(41)
    expect(kept).toEqual(all.slice(0, kept.length))
    expect(tight.notes).toContain(
      `the outline was shortened by ${41 - kept.length} entries to fit the budget`,
    )
  })

  it('ends a lead read on a block boundary and never inside code', async () => {
    const h = await manual()
    const page = only(await h.fetch({ url: MANUAL, max_tokens: 1500 }))
    const text = page.parts[0]?.text ?? ''
    expect((text.match(/^```/gmu) ?? []).length % 2).toBe(0)
    expect(text.endsWith('\n\n')).toBe(true)
  })
})

describe('cursor', () => {
  it('reads a long page piece by piece, and the pieces concatenate to the whole snapshot', async () => {
    const h = await manual(25)
    let result = await h.fetch({ url: MANUAL, max_tokens: 1200 })
    const snapshot = h.store.getSnapshot(only(result).snapshot ?? '')
    let text = ''
    let calls = 0
    for (;;) {
      const page = only(result)
      expectVerbatim(result, h.store)
      expect(page.parts).toHaveLength(1)
      expect(page.parts[0]?.start).toBe(text.length)
      text += page.parts[0]?.text ?? ''
      calls += 1
      if (!page.next_cursor) {
        expect(page.truncated).toBe(false)
        break
      }
      expect(page.truncated).toBe(true)
      result = await h.fetch({ cursor: page.next_cursor, max_tokens: 1200 })
      expect(only(result).mode).toBe('cursor')
    }
    expect(text).toBe(snapshot?.markdown)
    expect(calls).toBeGreaterThan(5)
    expect(h.requests).toEqual([MANUAL])
  })

  it('cuts a single block that is larger than the whole budget at a line boundary and says so', async () => {
    const lines = Array.from(
      { length: 900 },
      (_, index) => `row ${index} of a very long generated listing`,
    )
    harness = await createHarness({
      '/big': {
        body: `# Listing\n\n\`\`\`text\n${lines.join('\n')}\n\`\`\`\n\nAfter the listing.`,
        headers: { 'content-type': 'text/markdown' },
      },
    })
    let result = await harness.fetch({ url: 'https://example.com/big', max_tokens: 1000 })
    expect(result.notes.join(' ')).toContain('cut at a line boundary')
    const snapshot = harness.store.getSnapshot(only(result).snapshot ?? '')
    let text = ''
    let clipped = 0
    for (;;) {
      const page = only(result)
      const part = page.parts[0]
      text += part?.text ?? ''
      if (part?.clipped) {
        clipped += 1
        if (page.next_cursor) expect(part.text.endsWith('\n')).toBe(true)
      }
      if (!page.next_cursor) break
      result = await harness.fetch({ cursor: page.next_cursor, max_tokens: 1000 })
    }
    expect(clipped).toBeGreaterThan(2)
    expect(text).toBe(snapshot?.markdown)
  })

  it('reports an unknown or expired cursor as recoverable', async () => {
    const h = await manual()
    const result = await h.fetch({ cursor: 'c_zzzz' })
    expect(result).toMatchObject({ status: 'error', pages: [], error: { code: 'expired_ref' } })
  })

  it('ignores other arguments when a cursor is given, and says so', async () => {
    const h = await manual()
    const first = only(await h.fetch({ url: MANUAL, max_tokens: 1200 }))
    const result = await h.fetch({ cursor: first.next_cursor, url: ARTICLE, section: '2' })
    expect(only(result).url).toBe(MANUAL)
    expect(result.notes.join(' ')).toContain('cursor continues an earlier read')
  })
})

describe('section', () => {
  it('returns exactly the requested section', async () => {
    const h = await manual()
    const result = await h.fetch({ url: MANUAL, section: '7.2' })
    const page = only(result)
    expect(page).toMatchObject({ mode: 'section', truncated: false })
    expect(page.parts[0]).toMatchObject({ section: '7.2', heading: 'search detail 2' })
    expect(page.parts[0]?.text).toMatch(/^### 7\.2 search detail 2\n/u)
    expect(page.parts[0]?.text).toContain('--chapter 7 --section 2')
    expect(page.parts[0]?.text).not.toContain('7.3')
    expectVerbatim(result, h.store)
  })

  it('includes subsections when a parent section is requested', async () => {
    const h = await manual()
    const page = only(await h.fetch({ url: MANUAL, section: 'Section 7.' }))
    expect(page.parts[0]?.text).toContain('### 7.3 search detail 3')
    expect(page.parts[0]?.text).not.toContain('## 8.')
  })

  it('gives the front of an oversized section, its sub-outline, and a cursor that stays inside it', async () => {
    const h = await manual()
    let result = await h.fetch({ url: MANUAL, section: 'p1', max_tokens: 1500 })
    let page = only(result)
    expect(page).toMatchObject({ mode: 'section', truncated: true })
    expect(page.outline?.[0]?.id).toBe('1')
    const small = await h.fetch({ url: MANUAL, section: '3', max_tokens: 600 })
    page = only(small)
    expect(page.truncated).toBe(true)
    expect(page.outline?.map((entry) => entry.id)).toEqual(['3.1', '3.2', '3.3'])
    let text = page.parts[0]?.text ?? ''
    while (page.next_cursor) {
      result = await h.fetch({ cursor: page.next_cursor, max_tokens: 600 })
      page = only(result)
      text += page.parts[0]?.text ?? ''
    }
    expect(text).toMatch(/^## 3\. About logging 3\n/u)
    expect(text).toContain('### 3.3 logging detail 3')
    expect(text).not.toContain('## 4.')
  })

  it('reports a missing section with the closest ids and no page text', async () => {
    const h = await manual()
    const result = await h.fetch({ url: MANUAL, section: '7.9' })
    expect(result.status).toBe('error')
    expect(only(result).error).toEqual({
      code: 'invalid_input',
      message:
        'No such section in this page. Closest section ids: 7, 7.1, 7.2, 7.3. Omit section to get the outline.',
    })
  })

  it('refuses section for several pages', async () => {
    const h = await manual()
    const result = await h.fetch({ urls: [MANUAL, ARTICLE], section: '1' })
    expect(result).toMatchObject({ status: 'error', pages: [], error: { code: 'invalid_input' } })
    expect(h.requests).toEqual([])
  })
})

describe('find through the reader', () => {
  it('lists matches with their total, and continues with a cursor', async () => {
    const h = await manual()
    const result = await h.fetch({
      url: MANUAL,
      find: 'exit code 0 means healthy',
      max_tokens: 800,
    })
    const page = only(result)
    expect(page).toMatchObject({ mode: 'find', find_total: 120, truncated: true })
    expect(page.parts.every((part) => part.match === 'exact')).toBe(true)
    expectVerbatim(result, h.store)
    const next = only(await h.fetch({ cursor: page.next_cursor, max_tokens: 800 }))
    expect(next).toMatchObject({ mode: 'find', find_total: 120 })
    expect(next.parts[0]?.start).toBeGreaterThanOrEqual(page.parts.at(-1)?.end ?? 0)
  })

  it('answers not found with zero matches on a successful page', async () => {
    const h = await manual()
    const result = await h.fetch({ url: ARTICLE, find: 'a sentence that is not on the page' })
    expect(result.status).toBe('ok')
    expect(only(result)).toMatchObject({ mode: 'find', find_total: 0, parts: [], truncated: false })
  })

  it('takes priority over section and goal', async () => {
    const h = await manual()
    const page = only(
      await h.fetch({ url: ARTICLE, find: 'exponential', section: '1.1', goal: 'limits' }),
    )
    expect(page.mode).toBe('find')
  })
})

describe('goal', () => {
  it('returns a page that fits in full instead of excerpts', async () => {
    const h = await manual()
    const result = await h.fetch({ url: ARTICLE, goal: 'maximum number of retries' })
    expect(result.goal).toBe('maximum number of retries')
    expect(only(result)).toMatchObject({ mode: 'full', truncated: false })
  })

  it('picks the relevant passages of a long page and lists them in document order', async () => {
    const h = await manual()
    const result = await h.fetch({
      url: MANUAL,
      goal: 'inspect the billing subsystem chapter 14',
      max_tokens: 1500,
    })
    const page = only(result)
    expect(page).toMatchObject({ mode: 'goal', truncated: true })
    expect(page.parts.length).toBeGreaterThan(1)
    const starts = page.parts.map((part) => part.start)
    expect(starts).toEqual(starts.toSorted((a, b) => a - b))
    expect(page.parts.every((part) => /billing/iu.test(part.text))).toBe(true)
    expect(page.parts.some((part) => part.section?.startsWith('14'))).toBe(true)
    expect(
      page.parts.every((part) => part.section !== undefined && part.heading !== undefined),
    ).toBe(true)
    expect(page.outline?.length).toBeGreaterThan(0)
    expect(result.tokens).toBeLessThanOrEqual(1500)
    expectVerbatim(result, h.store)
  })

  it('never cuts a code block or a table out of a passage', async () => {
    const h = await manual()
    const page = only(
      await h.fetch({ url: MANUAL, goal: 'platform billing inspect exit code', max_tokens: 1200 }),
    )
    for (const part of page.parts) expect((part.text.match(/^```/gmu) ?? []).length % 2).toBe(0)
  })

  it('continues with further passages, never repeating one, until relevance runs out', async () => {
    const h = await manual()
    let page = only(await h.fetch({ url: MANUAL, goal: 'billing subsystem', max_tokens: 900 }))
    const seen: [number, number][] = []
    for (let call = 0; call < 40; call += 1) {
      for (const part of page.parts) {
        expect(seen.some(([start, end]) => part.start < end && part.end > start)).toBe(false)
        seen.push([part.start, part.end])
      }
      if (!page.next_cursor) break
      page = only(await h.fetch({ cursor: page.next_cursor, max_tokens: 900 }))
      expect(page.mode).toBe('goal')
    }
    expect(page.next_cursor).toBeUndefined()
    expect(seen.length).toBeGreaterThan(3)
  })

  it('says so when nothing on the page is relevant', async () => {
    const h = await manual()
    const result = await h.fetch({ url: MANUAL, goal: 'zymurgy quokka', max_tokens: 1500 })
    expect(result.status).toBe('ok')
    expect(only(result)).toMatchObject({ mode: 'goal', parts: [], truncated: true })
    expect(result.notes).toContain('no relevant passage')
  })

  it('matches Chinese goals against Chinese text', async () => {
    const filler =
      '<p>This paragraph talks about something else entirely and only pads the page. </p>'.repeat(
        60,
      )
    harness = await createHarness({
      '/zh': {
        body: `<html><head><title>指南</title></head><body><article><h1>重试指南</h1>${filler}<h2>超时</h2><p>默认超时时间是三十秒，可以按主机单独配置。</p>${filler}</article></body></html>`,
      },
    })
    const page = only(
      await harness.fetch({ url: 'https://example.com/zh', goal: '默认超时时间', max_tokens: 700 }),
    )
    expect(page.mode).toBe('goal')
    expect(page.parts.map((part) => part.text).join('\n')).toContain('默认超时时间是三十秒')
  })
})

describe('several pages', () => {
  const routes = {
    '/a': { body: manualHtml(30) },
    '/b': { body: manualHtml(12).replaceAll('replicated table', 'sharded ledger') },
    '/blocked': { status: 403, body: 'Forbidden' },
    '/gone': { status: 404 },
  }
  const A = 'https://a.example.com/a'
  const B = 'https://b.example.com/b'

  it('shares one budget: every page gets a passage first, then the best passages anywhere', async () => {
    harness = await createHarness(routes)
    const result = await harness.fetch({
      urls: [A, B],
      goal: 'billing subsystem ledger',
      max_tokens: 3000,
    })
    expect(result.status).toBe('ok')
    expect(result.pages.map((page) => page.n)).toEqual([1, 2])
    for (const page of result.pages) {
      expect(page.mode).toBe('goal')
      expect(page.parts.length).toBeGreaterThan(0)
      expect(page.outline).toBeUndefined()
    }
    expect(result.tokens).toBeLessThanOrEqual(3000)
    // The first page has four billing chapters and the second only one, so after each page got
    // its guaranteed passage the rest of the budget follows the scores to the first page.
    expect(result.pages[0]?.shown_chars).toBeGreaterThan(result.pages[1]?.shown_chars ?? 0)
    expectVerbatim(result, harness.store)
  })

  it('keeps a passage repeated on another page only once and records where else it was', async () => {
    harness = await createHarness({
      '/a': { body: manualHtml(30) },
      '/copy': { body: manualHtml(30) },
    })
    const result = await harness.fetch({
      urls: [A, 'https://mirror.example.net/copy'],
      goal: 'billing subsystem',
      max_tokens: 2500,
    })
    expect(result.pages[0]?.parts.length).toBeGreaterThan(0)
    expect(result.pages[0]?.parts.some((part) => part.also_in?.includes(2))).toBe(true)
    expect(result.pages[1]?.parts).toEqual([])
  })

  it('reports each page separately and the call as partial when some pages fail', async () => {
    harness = await createHarness(routes)
    const result = await harness.fetch({
      urls: [A, 'https://a.example.com/blocked', B, 'https://a.example.com/gone'],
      goal: 'billing subsystem',
      max_tokens: 3000,
    })
    expect(result.status).toBe('partial')
    expect(result.error).toBeUndefined()
    expect(result.pages.map((page) => [page.n, page.status, page.error?.code])).toEqual([
      [1, 'ok', undefined],
      [2, 'error', 'blocked'],
      [3, 'ok', undefined],
      [4, 'error', 'not_found'],
    ])
    expectVerbatim(result, harness.store)
  })

  it('is an error only when every page failed', async () => {
    harness = await createHarness(routes)
    const result = await harness.fetch({
      urls: ['https://a.example.com/blocked', 'https://a.example.com/gone'],
      goal: 'anything',
    })
    expect(result.status).toBe('error')
    expect(result.error?.code).toBe('blocked')
    expect(result.pages).toHaveLength(2)
  })

  it('requires a goal or find for several pages', async () => {
    harness = await createHarness(routes)
    const result = await harness.fetch({ urls: [A, B] })
    expect(result).toMatchObject({ status: 'error', error: { code: 'invalid_input' }, pages: [] })
    expect(harness.requests).toEqual([])
  })

  it('searches every page with find under one budget', async () => {
    harness = await createHarness(routes)
    const result = await harness.fetch({ urls: [A, B], find: 'sharded ledger', max_tokens: 1500 })
    expect(result.pages.map((page) => page.find_total)).toEqual([0, 144])
    expect(result.pages[1]?.truncated).toBe(true)
    expect(result.tokens).toBeLessThanOrEqual(1500)
    expectVerbatim(result, harness.store)
  })

  it('never runs more than three page loads at once', async () => {
    let active = 0
    let peak = 0
    const slow = (): { body: string } => ({ body: manualHtml(2) })
    harness = await createHarness({
      '/p1': slow,
      '/p2': slow,
      '/p3': slow,
      '/p4': slow,
      '/p5': slow,
    })
    const original = harness.store.insertSnapshot.bind(harness.store)
    harness.store.insertSnapshot = (snapshot, ttl) => {
      active -= 1
      return original(snapshot, ttl)
    }
    const connect = harness.requests.push.bind(harness.requests)
    harness.requests.push = (...urls: string[]) => {
      active += 1
      peak = Math.max(peak, active)
      return connect(...urls)
    }
    const result = await harness.fetch({
      urls: [1, 2, 3, 4, 5].map((n) => `https://example.com/p${n}`),
      goal: 'storage',
    })
    expect(result.status).toBe('ok')
    expect(peak).toBeLessThanOrEqual(3)
    expect(peak).toBeGreaterThan(1)
  })
})
