/**
 * Every limit in the reader is announced when it is hit: nothing is left out silently. The
 * notes are fixed sentences with our own numbers; none of them repeats page text.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { splitBlocks } from '../../src/fetch/blocks.ts'
import { CURSOR_KIND } from '../../src/fetch/cursor.ts'
import { MAX_MATCHES } from '../../src/fetch/find.ts'
import { normalizeFetch } from '../../src/fetch/normalize.ts'
import { MAX_HEADINGS } from '../../src/fetch/outline.ts'
import { loadConfig } from '../../src/config.ts'
import { createHarness, expectVerbatim, manualHtml, type Harness } from './helpers.ts'

let harness: Harness | undefined
afterEach(() => {
  harness?.close()
  harness = undefined
})

const markdown = (body: string): { body: string; headers: Record<string, string> } => ({
  body,
  headers: { 'content-type': 'text/markdown' },
})

describe('more headings than an outline holds', () => {
  const body = Array.from(
    { length: MAX_HEADINGS + 40 },
    (_, index) => `## Heading ${index}\n\ntext ${index}`,
  ).join('\n\n')

  it('says that the outline and the section ids stop at the limit, and still reads everything', async () => {
    harness = await createHarness({ '/many': markdown(body) })
    const url = 'https://example.com/many'
    const lead = await harness.fetch({ url, max_tokens: 1500 })
    const note = `page 1 has more than ${MAX_HEADINGS} headings; the outline and the section ids cover only the first ${MAX_HEADINGS}`
    expect(lead.notes).toContain(note)
    expectVerbatim(lead, harness.store)

    const beyond = await harness.fetch({ url, find: `text ${MAX_HEADINGS + 39}` })
    expect(beyond.pages[0]).toMatchObject({ find_total: 1 })
    expect(beyond.notes).toContain(note)
    const last = await harness.fetch({ url, section: String(MAX_HEADINGS), max_tokens: 1500 })
    expect(last.pages[0]?.parts[0]?.text).toContain(`text ${MAX_HEADINGS + 39}`)
  })

  it('stays silent on an ordinary page', async () => {
    harness = await createHarness({ '/manual': { body: manualHtml(40) } })
    const result = await harness.fetch({ url: 'https://example.com/manual', max_tokens: 1500 })
    expect(result.notes.join(' ')).not.toContain('headings')
  })
})

describe('an outline that loses levels', () => {
  it('says how many levels it leaves out', async () => {
    harness = await createHarness({ '/manual': { body: manualHtml(40) } })
    const result = await harness.fetch({ url: 'https://example.com/manual', max_tokens: 10_000 })
    expect(new Set(result.pages[0]?.outline?.map((entry) => entry.level))).toEqual(new Set([1, 2]))
    expect(result.notes).toContain(
      'the outline leaves out its 1 deepest heading level to fit the budget; read a section to see its subsections',
    )
  })
})

describe('lists nested deeper than they are divided', () => {
  it('keeps every character: deeper items stay inside the block of their parent', () => {
    const lines = Array.from(
      { length: 14 },
      (_, depth) =>
        `${'    '.repeat(depth)}-   level ${depth} item with enough words to make the list long enough to divide`,
    )
    const text = `Before.\n\n${lines.join('\n')}\n\nAfter.`
    const blocks = splitBlocks(text)
    let rebuilt = ''
    let cursor = 0
    for (const block of blocks) {
      rebuilt += text.slice(cursor, block.tileEnd)
      cursor = block.tileEnd
    }
    expect(rebuilt).toBe(text)
    const listBlocks = blocks.filter((block) => block.kind === 'list')
    expect(listBlocks.length).toBeGreaterThan(1)
    expect(listBlocks.length).toBeLessThan(14)
    expect(text.slice(listBlocks.at(-1)?.start, listBlocks.at(-1)?.end)).toContain('level 13 item')
  })
})

describe('a text that occurs more often than is counted', () => {
  it('reports the limit as the total and says that counting stopped', async () => {
    harness = await createHarness({
      '/log': markdown(`# Log\n\n${'tick tock\n'.repeat(MAX_MATCHES + 500)}`),
    })
    const result = await harness.fetch({
      url: 'https://example.com/log',
      find: 'tick',
      max_tokens: 1200,
    })
    expect(result.pages[0]).toMatchObject({ find_total: MAX_MATCHES, truncated: true })
    expect(result.notes).toContain(
      `counting stopped at ${MAX_MATCHES} matches; search for a longer, more specific text`,
    )
  })
})

describe('a cursor chain that cannot track more passages', () => {
  it('says so instead of silently ending', async () => {
    harness = await createHarness({ '/manual': { body: manualHtml(40) } })
    const first = await harness.fetch({
      url: 'https://example.com/manual',
      goal: 'billing subsystem',
      max_tokens: 900,
    })
    const snapshot = first.pages[0]?.snapshot ?? ''
    // A chain that has already delivered more ranges than a cursor keeps track of.
    const shown = Array.from({ length: 201 }, (_, index): [number, number] => [
      index * 2,
      index * 2 + 1,
    ])
    const cursor = harness.store.insertRecord(
      CURSOR_KIND,
      'c_',
      { kind: 'goal', snapshot, goal: 'billing subsystem', shown },
      3600,
      8,
    )
    const result = await harness.fetch({ cursor, max_tokens: 900 })
    expect(result.pages[0]?.parts.length).toBeGreaterThan(0)
    expect(result.pages[0]?.next_cursor).toBeUndefined()
    expect(result.notes).toContain(
      'more relevant passages remain than one cursor chain can track; continue with find or section',
    )
  })
})

describe('a text page whose first heading comes late', () => {
  it('has no title and is otherwise read like any other page', async () => {
    const body = `${'plain line without a heading\n'.repeat(3000)}\n# Late heading\n\nbody`
    harness = await createHarness({ '/late': markdown(body) })
    const result = await harness.fetch({ url: 'https://example.com/late', find: 'Late heading' })
    expect(result.status).toBe('ok')
    expect(result.pages[0]?.title).toBe('')
    expect(result.pages[0]).toMatchObject({ find_total: 1 })
    expect(result.pages[0]?.parts[0]?.section).toBe('1')
  })
})

describe('more unknown parameters than are listed', () => {
  it('says how many more there were', () => {
    const request = { url: 'https://example.com/', a1: 1, a2: 1, a3: 1, a4: 1, a5: 1, a6: 1, a7: 1 }
    expect(normalizeFetch(request, loadConfig({})).notes).toEqual([
      'ignored unknown parameters: a1, a2, a3, a4, a5 and 2 more',
    ])
  })
})
