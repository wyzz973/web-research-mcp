/**
 * Offsets are UTF-16 code units of the final snapshot text, everywhere. These tests generate
 * awkward documents and check that invariant for every reading mode and many budgets.
 */
import { afterEach, describe, expect, it } from 'vitest'
import type { FetchResult, PageResult } from '../../src/contract.ts'
import { createHarness, type Harness } from './helpers.ts'

let harness: Harness | undefined
afterEach(() => {
  harness?.close()
  harness = undefined
})

const EMOJI = [
  '\u{1F600}',
  '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}',
  '\u{1F1EF}\u{1F1F5}',
  '\u{1F44D}\u{1F3FD}',
  '\u{20BB7}',
]
const COMBINING = ['e\u0301', 'n\u0303', 'a\u0308\u0304', '\u0915\u094D\u0937']
const INVISIBLE = ['\u200B', '\u200C', '\uFEFF', '\u00AD', '\u202E']
const WORDS = [
  'cache',
  'validator',
  '\u7F13\u5B58',
  '\u30AD\u30E3\u30C3\u30B7\u30E5',
  'header',
  'na\u00EFve',
  'request',
  '\u8D85\u65F6',
]

/** Small deterministic generator, so a failure can be reproduced from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x1_0000_0000
  }
}

function pick<T>(next: () => number, items: readonly T[]): T {
  return items[Math.floor(next() * items.length)] as T
}

function sentence(next: () => number): string {
  const parts: string[] = []
  const length = 6 + Math.floor(next() * 18)
  for (let index = 0; index < length; index += 1) {
    const roll = next()
    if (roll < 0.12) parts.push(pick(next, EMOJI))
    else if (roll < 0.22) parts.push(`caf${pick(next, COMBINING)}`)
    else if (roll < 0.3) parts.push(`zero${pick(next, INVISIBLE)}width`)
    else parts.push(pick(next, WORDS))
  }
  return `${parts.join(' ')}.`
}

/** Long enough to be divided at item boundaries: nested items, a fence inside an item, a loose item. */
function longList(next: () => number, index: number): string {
  const items = Array.from(
    { length: 8 },
    (_, item) => `-   item ${index}.${item} ${sentence(next)}`,
  )
  items[2] += ['', '    -   nested ' + sentence(next), '    -   nested ' + sentence(next)].join(
    '\r\n',
  )
  items[4] += [
    '',
    '',
    '    ```yaml',
    '    - name: not an item ' + pick(next, EMOJI),
    '',
    '    - run: neither',
    '    ```',
  ].join('\r\n')
  items[6] += ['', '', '    loose continuation ' + sentence(next)].join('\r\n')
  return items.join('\r\n')
}

function block(next: () => number, index: number): string {
  const roll = next()
  if (roll < 0.15)
    return [
      '```js',
      `const v${index} = "${pick(next, EMOJI)}"`,
      '',
      `# not a heading ${index}`,
      '```',
    ].join('\r\n')
  if (roll < 0.3)
    return [
      '| key | value |',
      '| --- | --- |',
      ...Array.from(
        { length: 3 + Math.floor(next() * 12) },
        (_, row) => `| k${row} ${pick(next, EMOJI)} | ${pick(next, WORDS)} |`,
      ),
    ].join('\r\n')
  if (roll < 0.4) return Array.from({ length: 3 }, () => `-   ${sentence(next)}`).join('\r\n')
  if (roll < 0.5) return longList(next, index)
  return Array.from({ length: 1 + Math.floor(next() * 3) }, () => sentence(next)).join(' ')
}

function generate(seed: number, sections: number): string {
  const next = random(seed)
  const parts = [`# Corpus ${seed} ${pick(next, EMOJI)}`]
  for (let section = 1; section <= sections; section += 1) {
    parts.push(`## ${section}. Section ${pick(next, EMOJI)} ${section}`)
    for (let index = 0; index < 4; index += 1) parts.push(block(next, section * 10 + index))
  }
  return parts.join('\r\n\r\n')
}

function check(result: FetchResult, markdown: string): PageResult {
  const page = result.pages[0]
  if (!page || page.status !== 'ok')
    throw new Error(`expected an ok page, got ${page?.error?.code}`)
  let previousEnd = 0
  for (const part of page.parts) {
    expect(markdown.slice(part.start, part.end)).toBe(part.text)
    expect(part.text.isWellFormed()).toBe(true)
    expect(part.start).toBeGreaterThanOrEqual(previousEnd)
    expect(part.end).toBeGreaterThan(part.start)
    previousEnd = part.end
    if (part.match_start !== undefined && part.match_end !== undefined) {
      expect(part.match_start).toBeGreaterThanOrEqual(part.start)
      expect(part.match_end).toBeLessThanOrEqual(part.end)
    }
    if (!part.clipped && page.mode !== 'find') {
      expect((part.text.match(/^\s*```/gmu) ?? []).length % 2).toBe(0)
      for (const line of part.text.split('\n'))
        if (line.startsWith('|')) expect(line.endsWith('|')).toBe(true)
    }
  }
  expect(page.shown_chars).toBe(page.parts.reduce((sum, part) => sum + part.text.length, 0))
  expect(page.total_chars).toBe(markdown.length)
  return page
}

async function serve(
  seed: number,
  sections: number,
): Promise<{ url: string; markdown: string; h: Harness }> {
  const url = `https://corpus.example.com/doc-${seed}`
  harness = await createHarness({
    [url]: {
      body: generate(seed, sections),
      headers: { 'content-type': 'text/markdown; charset=utf-8' },
    },
  })
  const first = await harness.fetch({ url, max_tokens: 500 })
  const markdown = harness.store.getSnapshot(first.pages[0]?.snapshot ?? '')?.markdown ?? ''
  return { url, markdown, h: harness }
}

describe('snapshot text', () => {
  it('is final before any offset exists: no CR, no invisible characters, all of them counted', async () => {
    const source = generate(7, 6)
    const { markdown, h, url } = await serve(7, 6)
    expect(markdown).not.toMatch(/\r|[\u200B\u200C\uFEFF\u00AD\u202E]/u)
    const stripped = [...source.matchAll(/[\u200B\u200C\uFEFF\u00AD\u202E]/gu)].length
    expect(stripped).toBeGreaterThan(10)
    expect((await h.fetch({ url })).pages[0]?.hidden_removed).toBe(stripped)
    // Joiners inside emoji sequences are visible text and survive.
    expect(markdown).toContain('\u{1F468}\u200D\u{1F469}\u200D\u{1F467}')
    expect(markdown).toContain('e\u0301')
  })
})

describe.each([11, 23, 42])('corpus %i', (seed) => {
  it('tiles the whole document through cursors at several budgets, without overlap or gap', async () => {
    const { url, markdown, h } = await serve(seed, 14)
    for (const maxTokens of [500, 730, 1100, 2600]) {
      let result = await h.fetch({ url, max_tokens: maxTokens })
      let text = ''
      for (let guard = 0; guard < 400; guard += 1) {
        const page = check(result, markdown)
        expect(page.parts[0]?.start ?? text.length).toBe(text.length)
        text += page.parts.map((part) => part.text).join('')
        if (!page.next_cursor) break
        expect(page.truncated).toBe(true)
        result = await h.fetch({ cursor: page.next_cursor, max_tokens: maxTokens })
      }
      expect(text).toBe(markdown)
    }
  })

  it('keeps every part verbatim in section, find, and goal reads', async () => {
    const { url, markdown, h } = await serve(seed, 14)
    for (const section of ['1', '7', '14', 'p1'])
      check(await h.fetch({ url, section, max_tokens: 600 }), markdown)
    for (const needle of [
      '\u{1F600}',
      'cafe\u0301',
      'CACHE',
      '\u7F13\u5B58',
      '| --- |',
      'zerowidth',
    ]) {
      const page = check(await h.fetch({ url, find: needle, max_tokens: 900 }), markdown)
      expect(page.find_total).toBeGreaterThan(0)
      for (const part of page.parts) {
        const hit = markdown.slice(part.match_start, part.match_end)
        expect(hit.normalize('NFKC').toLowerCase()).toBe(needle.normalize('NFKC').toLowerCase())
      }
    }
    for (const goal of [
      'cache validator header',
      '\u7F13\u5B58 \u8D85\u65F6',
      'na\u00EFve request',
    ]) {
      let page = check(await h.fetch({ url, goal, max_tokens: 800 }), markdown)
      for (let guard = 0; page.next_cursor && guard < 30; guard += 1)
        page = check(await h.fetch({ cursor: page.next_cursor, max_tokens: 800 }), markdown)
    }
  })
})

describe('an oversized table', () => {
  it('is cut only between rows, flagged, reported as truncated, and continues at the cursor', async () => {
    const rows = Array.from(
      { length: 1500 },
      (_, row) => `| row ${row} ${EMOJI[row % EMOJI.length]} | value ${row} |`,
    )
    const body = [
      '# Big table',
      '',
      '| key | value |',
      '| --- | --- |',
      ...rows,
      '',
      'After the table.',
    ].join('\n')
    harness = await createHarness({ '/t': { body, headers: { 'content-type': 'text/markdown' } } })
    let result = await harness.fetch({ url: 'https://example.com/t', max_tokens: 1500 })
    const markdown = harness.store.getSnapshot(result.pages[0]?.snapshot ?? '')?.markdown ?? ''
    let text = ''
    let clipped = 0
    for (let guard = 0; guard < 200; guard += 1) {
      const page = result.pages[0]
      const part = page?.parts[0]
      expect(markdown.slice(part?.start, part?.end)).toBe(part?.text)
      if (part?.clipped) {
        clipped += 1
        expect(page?.truncated || !page?.next_cursor).toBe(true)
        for (const line of (part.text ?? '').split('\n'))
          if (line.startsWith('|')) expect(line.endsWith('|')).toBe(true)
      }
      text += part?.text ?? ''
      if (!page?.next_cursor) break
      result = await harness.fetch({ cursor: page.next_cursor, max_tokens: 1500 })
    }
    expect(clipped).toBeGreaterThan(3)
    expect(text).toBe(markdown)
  })
})
