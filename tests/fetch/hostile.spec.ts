/**
 * Page text is hostile input and the readers run on the main thread, next to the MCP transport.
 * Whatever a page contains, work must stay linear, give the event loop its turns, and stop when
 * the caller cancels. Nothing here depends on how fast the machine is: linearity is a ratio of
 * two timings, responsiveness is a count of event-loop turns, and work done is a count of steps.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { analyze, analyzeSteps, createDocumentCache } from '../../src/fetch/document.ts'
import { MAX_FOLD_CHARS } from '../../src/fetch/find.ts'
import { rankPassages, rankSteps } from '../../src/fetch/goal.ts'
import { MAX_HEADINGS } from '../../src/fetch/outline.ts'
import { runSliced } from '../../src/fetch/slices.ts'
import {
  counting,
  countTurns,
  createHarness,
  expectVerbatim,
  FUSE_MS,
  growth,
  type Harness,
} from './helpers.ts'

let harness: Harness | undefined
afterEach(() => {
  harness?.close()
  harness = undefined
})

const MB = 1024 * 1024
const never = (): AbortSignal => new AbortController().signal

const SHAPES: [string, (chars: number) => string][] = [
  ['a heading on every line', (chars) => '# a\n'.repeat(chars / 4)],
  ['a one-word paragraph every other line', (chars) => 'a\n\n'.repeat(chars / 3)],
  ['one list of very many items', (chars) => '- a\n'.repeat(chars / 4)],
  ['a list item followed by a long run of blank lines', (chars) => `- a\n${'\n'.repeat(chars)}- b`],
  ['items nested ever deeper', (chars) => nestedList(chars)],
]

function nestedList(chars: number): string {
  const lines: string[] = []
  for (let depth = 0, size = 0; size < chars; depth += 1) {
    const line = `${' '.repeat(Math.min(depth, 400) * 2)}- item number ${depth} with a few words`
    lines.push(line)
    size += line.length + 1
  }
  return lines.join('\n')
}

describe('document analysis', () => {
  it.each(SHAPES)('stays linear for %s', (_name, make) => {
    const started = performance.now()
    const ratio = growth(make, (input) => void analyze(input))
    expect(performance.now() - started).toBeLessThan(FUSE_MS)
    // Four times the input: about 4 when linear, about 16 when quadratic.
    if (ratio !== undefined) expect(ratio).toBeLessThanOrEqual(8)
  })

  it('tiles hostile shapes completely, like any other document', () => {
    for (const [, make] of SHAPES) {
      const input = make(200_000)
      const document = analyze(input)
      expect(document.blocks.at(-1)?.tileEnd).toBe(input.length)
      expect(document.blocks[0]?.start).toBe(0)
    }
  })

  it('stops building outline entries at a number no real document reaches', () => {
    const document = analyze('# a\n\ntext\n\n'.repeat(MAX_HEADINGS + 50))
    expect(document.outline).toHaveLength(MAX_HEADINGS)
    expect(document.outline.at(-1)?.end).toBe(document.markdown.length)
  })

  it('gives the same result in slices as in one go', async () => {
    for (const [, make] of SHAPES) {
      const input = make(60_000)
      expect(await runSliced(analyzeSteps(input), never())).toEqual(analyze(input))
    }
  })

  it('lets the event loop run while it works', async () => {
    const input = 'a\n\n'.repeat(MB)
    const { value, turns } = await countTurns(() => runSliced(analyzeSteps(input), never()))
    expect(value.blocks).toHaveLength(MB)
    expect(turns).toBeGreaterThanOrEqual(10)
  })

  it('stops early when cancelled: far fewer steps than a complete run', async () => {
    const input = '# a\n'.repeat(MB)
    const complete = counting(analyzeSteps(input))
    await runSliced(complete.work, never())
    const cancelled = counting(analyzeSteps(input))
    const abort = new AbortController()
    setImmediate(() => abort.abort())
    await expect(runSliced(cancelled.work, abort.signal)).rejects.toMatchObject({
      code: 'cancelled',
    })
    expect(complete.steps()).toBeGreaterThan(100)
    expect(cancelled.steps()).toBeLessThan(complete.steps() / 4)
  })
})

describe('document cache', () => {
  function countingAnalysis(): { calls: string[]; cache: ReturnType<typeof createDocumentCache> } {
    const calls: string[] = []
    const cache = createDocumentCache((markdown, signal) => {
      calls.push(markdown.slice(0, 10))
      return runSliced(analyzeSteps(markdown), signal)
    })
    return { calls, cache }
  }

  it('analyzes a snapshot once, however often and however concurrently it is read', async () => {
    const { calls, cache } = countingAnalysis()
    const [first, second] = await Promise.all([
      cache('s_a', '# One\n\ntext', never()),
      cache('s_a', '# One\n\ntext', never()),
    ])
    expect(second).toBe(first)
    expect(await cache('s_a', 'ignored: the id is known', never())).toBe(first)
    expect(calls).toEqual(['# One\n\ntex'])
  })

  it('lets a waiter carry on when the caller that started the analysis is cancelled', async () => {
    const { calls, cache } = countingAnalysis()
    const big = '# a\n'.repeat(MB / 2)
    const owner = new AbortController()
    const started = cache('s_big', big, owner.signal)
    const waiter = cache('s_big', big, never())
    setImmediate(() => owner.abort())
    await expect(started).rejects.toMatchObject({ code: 'cancelled' })
    expect((await waiter).blocks).toHaveLength(MB / 2)
    expect(calls).toHaveLength(2)
  })
})

describe('passage ranking', () => {
  const section = (index: number): string =>
    `## 第${index}节\n\n默认超时时间是三十秒，可以按主机单独配置；重试策略只适用于幂等请求，编号${index}。`
  const big = analyze(Array.from({ length: 12_000 }, (_, index) => section(index)).join('\n\n'))
  const goal = '默认超时时间'

  it('stays linear when every block of a huge page matches', () => {
    const started = performance.now()
    const ratio = growth(
      (chars) => 'a\n\n'.repeat(chars / 3),
      (input) => void rankPassages([analyze(input)], 'a'),
    )
    expect(performance.now() - started).toBeLessThan(FUSE_MS)
    if (ratio !== undefined) expect(ratio).toBeLessThanOrEqual(8)
  })

  it('lets the event loop run while it tokenizes a large page, with the same result', async () => {
    const { value, turns } = await countTurns(() => runSliced(rankSteps([big], goal), never()))
    expect(turns).toBeGreaterThanOrEqual(10)
    expect(value).toEqual(rankPassages([big], goal))
  })

  it('stops early when cancelled: far fewer steps than a complete run', async () => {
    const complete = counting(rankSteps([big], goal))
    await runSliced(complete.work, never())
    const cancelled = counting(rankSteps([big], goal))
    const abort = new AbortController()
    setImmediate(() => abort.abort())
    await expect(runSliced(cancelled.work, abort.signal)).rejects.toMatchObject({
      code: 'cancelled',
    })
    expect(cancelled.steps()).toBeLessThan(complete.steps() / 4)
  })
})

describe('hostile pages through the reader', () => {
  const markdown = (body: string): { body: string; headers: Record<string, string> } => ({
    body,
    headers: { 'content-type': 'text/markdown' },
  })

  it.each([
    ['only opening brackets, find', '['.repeat(1_900_000), { find: 'needle' }],
    ['a heading on every line, default read', '# a\n'.repeat(MB), {}],
    ['a million list items, default read', '- a\n'.repeat(MB), {}],
    ['one-word paragraphs, default read', 'a\n\n'.repeat((4 * MB) / 3), {}],
    ['one-word paragraphs, goal', 'a\n\n'.repeat((4 * MB) / 3), { goal: 'a' }],
  ])('keeps the event loop turning: %s', async (_name, body, extra) => {
    harness = await createHarness({ '/page.md': markdown(body) })
    const h = harness
    const started = performance.now()
    const { value, turns } = await countTurns(() =>
      h.fetch({ url: 'https://example.com/page.md', ...extra }),
    )
    expect(performance.now() - started).toBeLessThan(FUSE_MS)
    expect(value.status).toBe('ok')
    expect(turns).toBeGreaterThanOrEqual(10)
    expectVerbatim(value, h.store)
  })

  it('cancels while a stored page is being analyzed, and reads it on the next call', async () => {
    harness = await createHarness({ '/page.md': markdown('# a\n'.repeat(MB)) })
    const url = 'https://example.com/page.md'
    const abort = new AbortController()
    const insertSnapshot = harness.store.insertSnapshot.bind(harness.store)
    harness.store.insertSnapshot = (snapshot, ttl) => {
      // The page is stored; analysis is what comes next. Cancel as soon as the loop turns.
      setImmediate(() => abort.abort())
      return insertSnapshot(snapshot, ttl)
    }
    const cancelled = await harness.fetch({ url }, abort.signal)
    expect(cancelled.pages[0]?.error?.code).toBe('cancelled')
    expect(harness.store.latestSnapshotForUrl(url)).toBeDefined()
    const again = await harness.fetch({ url, max_tokens: 600 })
    expect(again.pages[0]).toMatchObject({ status: 'ok', cache: 'hit', mode: 'lead' })
    expect(harness.requests).toHaveLength(1)
  })
})

describe('a snapshot too large for visible-text matching', () => {
  const sentence = 'The **busy** timeout decides how long a writer waits for the lock.'
  const body = `# Dump\n\n${sentence}\n\n${'filler line of the dump\n'.repeat(MAX_FOLD_CHARS / 23 + 10)}`

  it('is searched literally only, and the result says so', async () => {
    harness = await createHarness({
      '/dump.md': { body, headers: { 'content-type': 'text/markdown' } },
    })
    const url = 'https://example.com/dump.md'
    const literal = await harness.fetch({ url, find: 'The **busy** timeout' })
    expect(literal.pages[0]).toMatchObject({ mode: 'find', find_total: 1 })
    expect(literal.pages[0]?.parts[0]?.match).toBe('exact')
    expect(literal.notes.join(' ')).toContain('only exact (literal) matches were looked for')
    expectVerbatim(literal, harness.store)

    const visible = await harness.fetch({ url, find: 'the busy timeout decides' })
    expect(visible.pages[0]).toMatchObject({ mode: 'find', find_total: 0 })
    expect(visible.notes.join(' ')).toContain(`larger than ${MAX_FOLD_CHARS} characters`)
    expect(visible.notes.join(' ')).toContain('NOT a match')
  })

  it('cancels a find on a large page while its text is being folded', async () => {
    const large = `# Big\n\n${'[a]('.repeat(450_000)}\n\nneedle in the haystack`
    harness = await createHarness({
      '/big.md': { body: large, headers: { 'content-type': 'text/markdown' } },
    })
    const url = 'https://example.com/big.md'
    await harness.fetch({ url, section: '1', max_tokens: 500 })
    const abort = new AbortController()
    setImmediate(() => abort.abort())
    const result = await harness.fetch({ url, find: 'Needle In The Haystack' }, abort.signal)
    expect(result).toMatchObject({ status: 'error', error: { code: 'cancelled' } })
    const again = await harness.fetch({ url, find: 'Needle In The Haystack' })
    expect(again.pages[0]).toMatchObject({ find_total: 1 })
    expect(again.pages[0]?.parts[0]?.match).toBe('normalized')
  })
})
