/**
 * Page text is hostile input and the readers run on the main thread, next to the MCP transport.
 * Whatever a page contains, work must stay linear, give the event loop its turns, and stop when
 * the caller cancels.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { analyze } from '../../src/fetch/document.ts'
import { MAX_FOLD_CHARS } from '../../src/fetch/find.ts'
import { rankPassages, rankPassagesSliced } from '../../src/fetch/goal.ts'
import { MAX_HEADINGS } from '../../src/fetch/outline.ts'
import { createHarness, expectVerbatim, type Harness } from './helpers.ts'

let harness: Harness | undefined
afterEach(() => {
  harness?.close()
  harness = undefined
})

const MB4 = 4 * 1024 * 1024

describe('document analysis', () => {
  // Measured on the development machine: about 200 ms each.
  it.each([
    ['a heading on every line', '# a\n'.repeat(MB4 / 4)],
    ['a one-word paragraph every other line', 'a\n\n'.repeat(MB4 / 3)],
    ['one list of a million items', '- a\n'.repeat(MB4 / 4)],
  ])('stays linear for 4 MB of %s', (_name, input) => {
    const started = performance.now()
    const document = analyze(input)
    expect(performance.now() - started).toBeLessThan(1500)
    expect(document.blocks.at(-1)?.tileEnd).toBe(input.length)
  })

  it('stops building outline entries at a number no real document reaches', () => {
    const document = analyze('# a\n\ntext\n\n'.repeat(MAX_HEADINGS + 50))
    expect(document.outline).toHaveLength(MAX_HEADINGS)
    expect(document.outline.at(-1)?.end).toBe(document.markdown.length)
  })
})

describe('passage ranking', () => {
  const section = (index: number): string =>
    `## 第${index}节\n\n默认超时时间是三十秒，可以按主机单独配置；重试策略只适用于幂等请求，编号${index}。`
  const big = analyze(Array.from({ length: 12_000 }, (_, index) => section(index)).join('\n\n'))
  const goal = '默认超时时间'

  it('gives the event loop its turns while it tokenizes a large page, with the same result', async () => {
    let turns = 0
    const timer = setInterval(() => (turns += 1), 1)
    const sliced = await rankPassagesSliced([big], goal, new AbortController().signal)
    clearInterval(timer)
    expect(turns).toBeGreaterThan(3)
    expect(sliced[0]?.length).toBe(rankPassages([big], goal)[0]?.length)
  })

  it('stops when the caller cancels', async () => {
    const abort = new AbortController()
    setImmediate(() => abort.abort())
    const started = performance.now()
    await expect(rankPassagesSliced([big], goal, abort.signal)).rejects.toMatchObject({
      code: 'cancelled',
    })
    expect(performance.now() - started).toBeLessThan(100)
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
