import { describe, expect, it } from 'vitest'
import { analyze } from '../../src/fetch/document.ts'
import { createFoldCache, findMatches, foldText, readMatches } from '../../src/fetch/find.ts'

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

describe('findMatches', () => {
  it('finds verbatim occurrences and reports them as exact', () => {
    const matches = findMatches(MARKDOWN, 'If-None-Match')
    const exact = matches.filter((match) => match.kind === 'exact')
    expect(exact).toHaveLength(2)
    for (const match of exact) expect(MARKDOWN.slice(match.start, match.end)).toBe('If-None-Match')
  })

  it('adds occurrences that differ only in case or dash style as normalized', () => {
    const loose = findMatches(MARKDOWN, 'If-None-Match').filter(
      (match) => match.kind === 'normalized',
    )
    expect(loose.map((match) => MARKDOWN.slice(match.start, match.end))).toEqual([
      'If\u2011None\u2011Match',
      'IF-NONE-MATCH',
    ])
  })

  it('matches a quote across whitespace, quote style, and Markdown escapes', () => {
    const quote =
      'comparing entity tags for *any* If-None-Match field, since "weak" tags can be used'
    const [match, ...rest] = findMatches(MARKDOWN, quote)
    expect(rest).toEqual([])
    expect(match?.kind).toBe('normalized')
    expect(MARKDOWN.slice(match?.start, match?.end)).toBe(
      'comparing entity tags for \\*any\\* If\u2011None\u2011Match field, since \u201Cweak\u201D tags   can\nbe used',
    )
  })

  it('returns matches in document order without overlaps', () => {
    const matches = findMatches(MARKDOWN, 'If-None-Match')
    const starts = matches.map((match) => match.start)
    expect(starts).toEqual(starts.toSorted((a, b) => a - b))
    expect(findMatches('aaaa', 'aa')).toHaveLength(2)
  })

  it('finds nothing for text that is not there', () => {
    expect(findMatches(MARKDOWN, 'If-Unmodified-Since')).toEqual([])
    expect(findMatches(MARKDOWN, '   ')).toEqual([])
  })
})

describe('readMatches', () => {
  const document = analyze(MARKDOWN)
  const roomy = { tokens: 5000, chars: 20_000 }

  it('gives each match about 200 characters of verbatim context, its section, and its own span', () => {
    const { parts, total, consumed } = readMatches(document, 'If-None-Match', 0, roomy)
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
    const { parts } = readMatches(document, 'If-None-Match', 0, roomy)
    const merged = parts.find((part) => (part.match_count ?? 1) > 1)
    expect(merged).toMatchObject({ section: '13.1.2', match_count: 2, match: 'exact' })
    expect(parts.reduce((sum, part) => sum + (part.match_count ?? 1), 0)).toBe(4)
  })

  it('never splits a surrogate pair at a context edge', () => {
    for (const part of readMatches(document, 'IF-NONE-MATCH handling', 0, roomy).parts) {
      expect(part.text.isWellFormed()).toBe(true)
      expect(part.text).toContain('\u{1F600}')
    }
  })

  it('always shows one match, stops at the budget, and resumes where it stopped', () => {
    const tight = { tokens: 160, chars: 20_000 }
    const first = readMatches(document, 'If-None-Match', 0, tight)
    expect(first.parts).toHaveLength(1)
    expect(first.consumed).toBeLessThan(first.total)
    const second = readMatches(document, 'If-None-Match', first.consumed, roomy)
    expect(second.consumed).toBe(second.total)
    expect(second.parts[0]?.start).toBeGreaterThanOrEqual(first.parts[0]?.end ?? 0)
  })

  it('reports zero matches without inventing parts', () => {
    expect(readMatches(document, 'not in the page', 0, roomy)).toEqual({
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

  it('splits full groups without overlap and without losing a match', () => {
    const { parts, total, consumed } = readMatches(dense, 'needle', 0, roomy)
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
    const first = readMatches(dense, 'needle', 0, { tokens: 700, chars: 200_000 })
    const rest = readMatches(dense, 'needle', first.consumed, roomy)
    expect(
      first.consumed + rest.parts.reduce((sum, part) => sum + (part.match_count ?? 1), 0),
    ).toBe(300)
    expect(rest.parts[0]?.match_start).toBeGreaterThanOrEqual(first.parts.at(-1)?.match_end ?? 0)
  })
})

describe('fold cache', () => {
  it('folds a snapshot once and evicts the least recently used beyond its capacity', () => {
    const cache = createFoldCache(2)
    const a = cache('s_aaaaaa', 'Alpha  TEXT')
    expect(a.text).toBe('alpha text')
    expect(cache('s_aaaaaa', 'ignored because the id is known')).toBe(a)
    cache('s_bbbbbb', 'Beta')
    cache('s_aaaaaa', 'Alpha  TEXT')
    cache('s_cccccc', 'Gamma')
    expect(cache('s_aaaaaa', 'Alpha  TEXT')).toBe(a)
    expect(cache('s_bbbbbb', 'Beta')).not.toBe(undefined)
    expect(cache('s_bbbbbb', 'Beta').text).toBe('beta')
  })

  it('maps folded positions back to UTF-16 offsets of the source', () => {
    const source = 'x \u{1F600}  \uFB01n \u201Cq\u201D'
    const folded = foldText(source)
    expect(folded.text).toBe('x \u{1F600} fin "q"')
    const at = folded.text.indexOf('fin')
    expect(source.slice(folded.starts[at], folded.ends[at + 2])).toBe('\uFB01n')
    expect(folded.starts).toBeInstanceOf(Int32Array)
  })

  it('gives the same matches with and without a cached fold', () => {
    const document = analyze(MARKDOWN)
    const cached = createFoldCache()('s_zzzzzz', MARKDOWN)
    expect(findMatches(MARKDOWN, 'if-none-match', cached)).toEqual(
      findMatches(MARKDOWN, 'if-none-match'),
    )
    expect(
      readMatches(document, 'if-none-match', 0, { tokens: 5000, chars: 20_000 }, cached).total,
    ).toBe(4)
  })
})
