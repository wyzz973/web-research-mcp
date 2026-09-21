import { describe, expect, it } from 'vitest'
import { analyze } from '../../src/fetch/document.ts'
import { runSliced } from '../../src/fetch/slices.ts'
import { counting, countTurns, FUSE_MS, growth, mustFold } from './helpers.ts'
import {
  createFoldCache,
  findMatches,
  foldSteps,
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

const FOLDED = mustFold(MARKDOWN)

/** Small documents fold in no time; the reader folds snapshots through its cache instead. */
function find(markdown: string, needle: string): ReturnType<typeof findMatches> {
  return findMatches(markdown, needle, mustFold(markdown))
}

describe('the fold cache', () => {
  const never = (): AbortSignal => new AbortController().signal

  it('does not answer for a snapshot id that now holds different text', async () => {
    let folds = 0
    const cache = createFoldCache(async (markdown) => {
      folds += 1
      return foldText(markdown, Number.POSITIVE_INFINITY)
    })
    const first = await cache('s_reused', 'alpha alpha', never())
    expect(first?.text).toBe('alpha alpha')
    // The id was swept and issued again while this entry was still here.
    const second = await cache('s_reused', 'beta beta beta', never())
    expect(second?.text).toBe('beta beta beta')
    expect(folds).toBe(2)
    // The text it was last used for is still answered from the cache.
    expect((await cache('s_reused', 'beta beta beta', never()))?.text).toBe('beta beta beta')
    expect(folds).toBe(2)
  })
})

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
  const DENSE_FOLDED = mustFold(dense.markdown)

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
    const third = await cache('s_aaaaaa', 'Alpha  TEXT', never())
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
    const folded = mustFold(source)
    expect(folded.text).toBe('x \u{1F600} fin "q"')
    const at = folded.text.indexOf('fin')
    expect(source.slice(folded.starts[at], folded.ends[at + 2])).toBe('\uFB01n')
    expect(folded.starts).toBeInstanceOf(Int32Array)
  })
})

describe('hostile input', () => {
  // Shapes that made the first scanner quadratic: it looked ahead from every bracket.
  const shapes: [string, (chars: number) => string][] = [
    ['only opening brackets', (chars) => '['.repeat(chars)],
    ['only "]("', (chars) => ']('.repeat(chars / 2)],
    ['alternating nesting', (chars) => '[('.repeat(chars / 2)],
    ['link openers without an end', (chars) => '[a]('.repeat(chars / 4)],
    ['rules and bullets on every line', (chars) => '---\n- \n'.repeat(chars / 7)],
  ]

  it.each(shapes)('folds %s in linear time', (_name, make) => {
    const started = performance.now()
    // Without the size limit: the point is how the cost grows, up to 8 MB of input.
    const ratio = growth(make, (input) => void mustFold(input, Number.POSITIVE_INFINITY))
    expect(performance.now() - started).toBeLessThan(FUSE_MS)
    // Four times the input: about 4 when linear, about 16 when quadratic.
    if (ratio !== undefined) expect(ratio).toBeLessThanOrEqual(8)
  })

  it('gives the same result in slices as in one go', async () => {
    const input = `${'[x](https://e.example/y) **b** \\_c\\_ | d |\n'.repeat(30_000)}tail`
    const sliced = await foldTextSliced(input, new AbortController().signal)
    const whole = mustFold(input)
    expect(sliced?.text).toBe(whole.text)
    expect(sliced?.starts).toEqual(whole.starts)
    expect(sliced?.ends).toEqual(whole.ends)
  })

  it('lets the event loop run while it folds', async () => {
    const input = '[a]('.repeat(1024 * 1024)
    const { value, turns } = await countTurns(() =>
      foldTextSliced(input, new AbortController().signal, Number.POSITIVE_INFINITY),
    )
    expect(value?.text.length).toBe(input.length)
    expect(turns).toBeGreaterThanOrEqual(10)
  })

  it('stops early when cancelled: far fewer steps than a complete run', async () => {
    const input = '[a]('.repeat(1024 * 1024)
    const complete = counting(foldSteps(input, Number.POSITIVE_INFINITY))
    await runSliced(complete.work, new AbortController().signal)
    const cancelled = counting(foldSteps(input, Number.POSITIVE_INFINITY))
    const abort = new AbortController()
    setImmediate(() => abort.abort())
    await expect(runSliced(cancelled.work, abort.signal)).rejects.toMatchObject({
      code: 'cancelled',
    })
    expect(complete.steps()).toBeGreaterThan(40)
    expect(cancelled.steps()).toBeLessThan(complete.steps() / 4)
  })

  // One U+FDFA stands for 18 characters once folded; 2 million of them made a map of 36 million
  // entries and a process of 1.7 GB before the visible text had a limit of its own.
  const LIGATURE = String.fromCodePoint(0xfdfa)

  it('gives up on a text whose visible form outgrows the limit, exactly at the limit', () => {
    expect(foldText('abc def', 7)?.text).toBe('abc def')
    expect(foldText('abc defg', 7)).toBeUndefined()
    expect(foldText(LIGATURE, 18)?.text).toHaveLength(18)
    expect(foldText(LIGATURE, 17)).toBeUndefined()
    expect(foldText(LIGATURE.repeat(MAX_FOLD_CHARS / 18 + 1))).toBeUndefined()
  })

  it('stops working where the limit is reached instead of reading the rest', async () => {
    const plain = counting(foldSteps('x'.repeat(MAX_FOLD_CHARS)))
    const expanding = counting(foldSteps(LIGATURE.repeat(MAX_FOLD_CHARS), 1000))
    expect(await runSliced(plain.work, new AbortController().signal)).toBeDefined()
    expect(await runSliced(expanding.work, new AbortController().signal)).toBeUndefined()
    // The brackets of the whole text are paired first; the second pass ends after 56 characters.
    expect(expanding.steps()).toBeLessThan(plain.steps() / 2)
  })

  it('takes no step that writes much more than it reads', async () => {
    // Every character becomes 18: a step bounded only by what it reads would write a million.
    const source = LIGATURE.repeat(100_000)
    const { work, steps } = counting(foldSteps(source))
    expect((await runSliced(work, new AbortController().signal))?.text).toHaveLength(1_800_000)
    // Bounded by what it reads, the second pass took 2 steps and the whole run 17.
    expect(steps()).toBeGreaterThanOrEqual(Math.floor(1_800_000 / (64 * 1024)))
  })

  it('remembers that a snapshot has no map, so the work is not repeated for every find', async () => {
    const calls: number[] = []
    const cache = createFoldCache((markdown, signal) => {
      calls.push(markdown.length)
      return foldTextSliced(markdown, signal)
    })
    const page = LIGATURE.repeat(MAX_FOLD_CHARS / 18 + 1)
    const signal = new AbortController().signal
    expect(await cache('s_wide', page, signal)).toBeUndefined()
    expect(await cache('s_wide', page, signal)).toBeUndefined()
    expect(calls).toEqual([page.length])
    expect(findMatches(page, LIGATURE.repeat(3), undefined).length).toBeGreaterThan(0)
  })

  it('stops counting a text that occurs absurdly often', () => {
    const input = 'ab '.repeat(50_000)
    expect(findMatches(input, 'ab', mustFold(input))).toHaveLength(MAX_MATCHES)
    expect(findMatches(input, 'AB', mustFold(input))).toHaveLength(MAX_MATCHES)
  })
})
