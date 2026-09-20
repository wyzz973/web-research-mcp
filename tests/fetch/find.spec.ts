import { describe, expect, it } from 'vitest'
import { analyze } from '../../src/fetch/document.ts'
import {
  createFoldCache,
  findMatches,
  foldText,
  foldTextSliced,
  MAX_FOLD_CHARS,
  MAX_MATCHES,
  readMatches,
} from '../../src/fetch/find.ts'

const filler = (label: string): string =>
  `${label} filler sentence that only exists to put distance between the interesting places. `.repeat(
    6,
  )

const MARKDOWN = [
  '# Validators',
  '',
  filler('Alpha'),
  '',
  '## 8.8.3 ETag',
  '',
  'The entity tag can be used in an If-None-Match header field to make a request conditional.',
  '',
  filler('Beta'),
  '',
  '## 13.1.2 If-None-Match',
  '',
  'A recipient MUST use the weak comparison function when comparing entity tags for \\*any\\* If\u2011None\u2011Match field, since \u201Cweak\u201D tags   can\nbe used for cache validation.',
  '',
  filler('Gamma'),
  '',
  'Servers send IF-NONE-MATCH handling notes here. \u{1F600} Emoji nearby.',
].join('\n')

const FOLDED = foldText(MARKDOWN)

/** Small documents fold in no time; the reader folds snapshots through its cache instead. */
function find(markdown: string, needle: string): ReturnType<typeof findMatches> {
  return findMatches(markdown, needle, foldText(markdown))
}

describe('findMatches', () => {
  it('finds verbatim occurrences and reports them as exact', () => {
    const matches = find(MARKDOWN, 'If-None-Match')
    const exact = matches.filter((match) => match.kind === 'exact')
    expect(exact).toHaveLength(2)
    for (const match of exact) expect(MARKDOWN.slice(match.start, match.end)).toBe('If-None-Match')
  })

  it('adds occurrences that differ only in case or dash style as normalized', () => {
    const loose = find(MARKDOWN, 'If-None-Match').filter((match) => match.kind === 'normalized')
    expect(loose.map((match) => MARKDOWN.slice(match.start, match.end))).toEqual([
      'If\u2011None\u2011Match',
      'IF-NONE-MATCH',
    ])
  })

  it('matches a quote across whitespace, quote style, and Markdown escapes', () => {
    const quote =
      'comparing entity tags for *any* If-None-Match field, since "weak" tags can be used'
    const [match, ...rest] = find(MARKDOWN, quote)
    expect(rest).toEqual([])
    expect(match?.kind).toBe('normalized')
    expect(MARKDOWN.slice(match?.start, match?.end)).toBe(
      'comparing entity tags for \\*any\\* If\u2011None\u2011Match field, since \u201Cweak\u201D tags   can\nbe used',
    )
  })

  it('returns matches in document order without overlaps', () => {
    const matches = find(MARKDOWN, 'If-None-Match')
    const starts = matches.map((match) => match.start)
    expect(starts).toEqual(starts.toSorted((a, b) => a - b))
    expect(find('aaaa', 'aa')).toHaveLength(2)
  })

  it('finds nothing for text that is not there', () => {
    expect(find(MARKDOWN, 'If-Unmodified-Since')).toEqual([])
    expect(find(MARKDOWN, '   ')).toEqual([])
  })
})

describe('readMatches', () => {
  const document = analyze(MARKDOWN)
  const roomy = { tokens: 5000, chars: 20_000 }

  it('gives each match about 200 characters of verbatim context, its section, and its own span', () => {
    const { parts, total, consumed } = readMatches(document, 'If-None-Match', 0, roomy, FOLDED)
    expect(total).toBe(4)
    expect(consumed).toBe(4)
    const first = parts[0]
    expect(first).toMatchObject({ match: 'exact', section: '8.8.3', heading: 'ETag' })
    expect(first?.text).toBe(MARKDOWN.slice(first?.start, first?.end))
    expect(MARKDOWN.slice(first?.match_start, first?.match_end)).toBe('If-None-Match')
    expect((first?.match_start ?? 0) - (first?.start ?? 0)).toBeGreaterThan(150)
    expect((first?.match_start ?? 0) - (first?.start ?? 0)).toBeLessThan(260)
    expect((first?.end ?? 0) - (first?.match_end ?? 0)).toBeLessThan(260)
  })

  it('merges neighbouring matches into one context and counts them', () => {
    const { parts } = readMatches(document, 'If-None-Match', 0, roomy, FOLDED)
    const merged = parts.find((part) => (part.match_count ?? 1) > 1)
    expect(merged).toMatchObject({ section: '13.1.2', match_count: 2, match: 'exact' })
    expect(parts.reduce((sum, part) => sum + (part.match_count ?? 1), 0)).toBe(4)
  })

  it('never splits a surrogate pair at a context edge', () => {
    for (const part of readMatches(document, 'IF-NONE-MATCH handling', 0, roomy, FOLDED).parts) {
      expect(part.text.isWellFormed()).toBe(true)
      expect(part.text).toContain('\u{1F600}')
    }
  })

  it('always shows one match, stops at the budget, and resumes where it stopped', () => {
    const tight = { tokens: 160, chars: 20_000 }
    const first = readMatches(document, 'If-None-Match', 0, tight, FOLDED)
    expect(first.parts).toHaveLength(1)
    expect(first.consumed).toBeLessThan(first.total)
    const second = readMatches(document, 'If-None-Match', first.consumed, roomy, FOLDED)
    expect(second.consumed).toBe(second.total)
    expect(second.parts[0]?.start).toBeGreaterThanOrEqual(first.parts[0]?.end ?? 0)
  })

  it('reports zero matches without inventing parts', () => {
    expect(readMatches(document, 'not in the page', 0, roomy, FOLDED)).toEqual({
      parts: [],
      total: 0,
      consumed: 0,
    })
  })
})

describe('dense matches', () => {
  // 300 matches a few characters apart: every context overlaps its neighbours, so groups fill up.
  const dense = analyze(
    `# Log\n\n${Array.from({ length: 300 }, (_, index) => `needle ${index} hay`).join(' ')}`,
  )
  const roomy = { tokens: 50_000, chars: 200_000 }
  const DENSE_FOLDED = foldText(dense.markdown)

  it('splits full groups without overlap and without losing a match', () => {
    const { parts, total, consumed } = readMatches(dense, 'needle', 0, roomy, DENSE_FOLDED)
    expect(total).toBe(300)
    expect(consumed).toBe(300)
    expect(parts.length).toBeGreaterThan(3)
    expect(parts.reduce((sum, part) => sum + (part.match_count ?? 1), 0)).toBe(300)
    for (const [index, part] of parts.entries()) {
      expect(part.text).toBe(dense.markdown.slice(part.start, part.end))
      expect(part.end - part.start).toBeLessThanOrEqual(1200)
      expect(part.match_start).toBeGreaterThanOrEqual(part.start)
      expect(part.match_end).toBeLessThanOrEqual(part.end)
      for (const other of parts.slice(index + 1))
        expect(part.end <= other.start || other.end <= part.start).toBe(true)
    }
  })

  it('keeps parts disjoint across a cursor boundary too', () => {
    const first = readMatches(dense, 'needle', 0, { tokens: 700, chars: 200_000 }, DENSE_FOLDED)
    const rest = readMatches(dense, 'needle', first.consumed, roomy, DENSE_FOLDED)
    expect(
      first.consumed + rest.parts.reduce((sum, part) => sum + (part.match_count ?? 1), 0),
    ).toBe(300)
    expect(rest.parts[0]?.match_start).toBeGreaterThanOrEqual(first.parts.at(-1)?.match_end ?? 0)
  })
})

describe('fold cache', () => {
  const never = (): AbortSignal => new AbortController().signal

  function counting(): {
    fold: (markdown: string, signal: AbortSignal) => ReturnType<typeof foldTextSliced>
    calls: string[]
  } {
    const calls: string[] = []
    return {
      calls,
      fold: (markdown, signal) => {
        calls.push(markdown.slice(0, 12))
        return foldTextSliced(markdown, signal)
      },
    }
  }

  it('folds a snapshot once, however often and however concurrently it is searched', async () => {
    const { fold, calls } = counting()
    const cache = createFoldCache(fold)
    const [first, second] = await Promise.all([
      cache('s_aaaaaa', 'Alpha  TEXT', never()),
      cache('s_aaaaaa', 'Alpha  TEXT', never()),
    ])
    const third = await cache('s_aaaaaa', 'ignored because the id is known', never())
    expect(first?.text).toBe('alpha text')
    expect(second).toBe(first)
    expect(third).toBe(first)
    expect(calls).toEqual(['Alpha  TEXT'])
  })

  it('keeps a few snapshots and evicts the least recently used', async () => {
    const { fold, calls } = counting()
    const cache = createFoldCache(fold)
    for (const id of ['a', 'b', 'c', 'd']) await cache(`s_${id}`, `text ${id}`, never())
    await cache('s_a', 'text a', never())
    await cache('s_e', 'text e', never())
    await cache('s_a', 'text a', never())
    await cache('s_b', 'text b', never())
    expect(calls).toEqual(['text a', 'text b', 'text c', 'text d', 'text e', 'text b'])
  })

  it('does not fold a snapshot that is too large, so only literal matches are reported', async () => {
    const { fold, calls } = counting()
    const huge = `The Busy Timeout. ${'x'.repeat(MAX_FOLD_CHARS)}`
    expect(await createFoldCache(fold)('s_huge', huge, never())).toBeUndefined()
    expect(calls).toEqual([])
    expect(findMatches(huge, 'the busy timeout', undefined)).toEqual([])
    expect(findMatches(huge, 'The Busy Timeout', undefined)).toHaveLength(1)
  })

  it('lets a waiter carry on when the caller that started the fold is cancelled', async () => {
    const cache = createFoldCache()
    const big = 'word '.repeat(400_000)
    const owner = new AbortController()
    const started = cache('s_big', big, owner.signal)
    const waiter = cache('s_big', big, never())
    setImmediate(() => owner.abort())
    await expect(started).rejects.toMatchObject({ code: 'cancelled' })
    expect((await waiter)?.text.length).toBeGreaterThan(1_000_000)
  })

  it('maps folded positions back to UTF-16 offsets of the source', () => {
    const source = 'x \u{1F600}  \uFB01n \u201Cq\u201D'
    const folded = foldText(source)
    expect(folded.text).toBe('x \u{1F600} fin "q"')
    const at = folded.text.indexOf('fin')
    expect(source.slice(folded.starts[at], folded.ends[at + 2])).toBe('\uFB01n')
    expect(folded.starts).toBeInstanceOf(Int32Array)
  })
})

describe('hostile input', () => {
  const MB4 = 4 * 1024 * 1024
  // Measured on the development machine: 40 to 130 ms each. The old scanner took 1 to 7.6 s.
  const LIMIT_MS = 600

  it.each([
    ['only opening brackets', '['.repeat(MB4)],
    ['only "]("', ']('.repeat(MB4 / 2)],
    ['alternating nesting', '[('.repeat(MB4 / 2)],
    ['link openers without an end', '[a]('.repeat(MB4 / 4)],
    ['rules and bullets on every line', '---\n- \n'.repeat(MB4 / 7)],
  ])('folds 4 MB of %s in linear time', (_name, input) => {
    const started = performance.now()
    const folded = foldText(input)
    expect(performance.now() - started).toBeLessThan(LIMIT_MS)
    expect(folded.starts.length).toBe(folded.text.length)
  })

  it('gives the same result in slices as in one go', async () => {
    const input = `${'[x](https://e.example/y) **b** \\_c\\_ | d |\n'.repeat(30_000)}tail`
    const sliced = await foldTextSliced(input, new AbortController().signal)
    const whole = foldText(input)
    expect(sliced.text).toBe(whole.text)
    expect(sliced.starts).toEqual(whole.starts)
    expect(sliced.ends).toEqual(whole.ends)
  })

  it('lets the event loop run while folding, and stops when cancelled', async () => {
    const input = '[a]('.repeat((4 * MB4) / 4)
    let turns = 0
    const timer = setInterval(() => (turns += 1), 1)
    const fullStarted = performance.now()
    await foldTextSliced(input, new AbortController().signal)
    const full = performance.now() - fullStarted
    clearInterval(timer)
    expect(turns).toBeGreaterThan(5)

    const abort = new AbortController()
    setImmediate(() => abort.abort())
    const cancelStarted = performance.now()
    await expect(foldTextSliced(input, abort.signal)).rejects.toMatchObject({ code: 'cancelled' })
    const cancelled = performance.now() - cancelStarted
    expect(cancelled).toBeLessThan(100)
    expect(cancelled).toBeLessThan(full / 3)
  })

  it('stops counting a text that occurs absurdly often', () => {
    const input = 'ab '.repeat(50_000)
    expect(findMatches(input, 'ab', foldText(input))).toHaveLength(MAX_MATCHES)
    expect(findMatches(input, 'AB', foldText(input))).toHaveLength(MAX_MATCHES)
  })
})
