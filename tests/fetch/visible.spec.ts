/** find must match what a reader sees, because that is what a model quotes. */
import { describe, expect, it } from 'vitest'
import { findMatches, foldText } from '../../src/fetch/find.ts'

const PAGE = [
  '#### `new DatabaseSync(path[, options])`',
  '',
  '| Version | Changes |',
  '| --- | --- |',
  '| v24.0.0, v22.16.0 | Add `timeout` option. |',
  '',
  '-   `path` [`<string>`](https://developer.mozilla.org/docs/Web/JavaScript/Data_structures#string_type) The path of the database.',
  '    -   `timeout` [`<number>`](https://developer.mozilla.org/docs/Web/JavaScript/Data_structures#number_type) The [busy timeout](https://sqlite.org/c3ref/busy_timeout.html "SQLite docs") in milliseconds. This is the maximum amount of time that SQLite will wait for a database lock. **Default:** `0`.',
  '',
  'Constructs a new `DatabaseSync` instance with new DatabaseSync(path\\[, options\\]) and the default busy\\_timeout value.',
  '',
  'A sentence that **really matters** and wraps',
  'across two lines, with _emphasis_ and ~~struck~~ words.',
  '',
  '> Quoted advice: call `close()` when done.',
  '',
  'See ![diagram of the lock states] and [the reference][sqlite] or <https://sqlite.org/lockingv3.html> for \u{1F600} details.',
  '',
  '```js',
  'db.exec("PRAGMA busy_timeout = 1000;") // # not a heading',
  '```',
  '',
  '[sqlite]: https://sqlite.org/',
].join('\n')

function find(markdown: string, needle: string): ReturnType<typeof findMatches> {
  return findMatches(markdown, needle, foldText(markdown))
}

function visible(text: string): string {
  return foldText(text).text.trim()
}

/** The matched span, stripped of markup, must read exactly like the needle. */
function expectMatch(needle: string, kind: 'exact' | 'normalized' = 'normalized'): string {
  const matches = find(PAGE, needle)
  expect(matches, `matches for ${JSON.stringify(needle)}`).toHaveLength(1)
  const match = matches[0]
  expect(match?.kind).toBe(kind)
  const slice = PAGE.slice(match?.start, match?.end)
  expect(visible(slice)).toBe(visible(needle))
  expect(slice.isWellFormed()).toBe(true)
  return slice
}

describe('quotes taken from the visible text', () => {
  it('finds a sentence that has a link in the middle (the two needles a real model tried)', () => {
    expect(expectMatch('The busy timeout in milliseconds')).toBe(
      'The [busy timeout](https://sqlite.org/c3ref/busy_timeout.html "SQLite docs") in milliseconds',
    )
    expect(expectMatch('busy timeout in milliseconds')).toBe(
      'busy timeout](https://sqlite.org/c3ref/busy_timeout.html "SQLite docs") in milliseconds',
    )
  })

  it('finds identifiers the converter escaped', () => {
    expect(expectMatch('default busy_timeout value')).toBe('default busy\\_timeout value')
    expect(expectMatch('instance with new DatabaseSync(path[, options]) and')).toBe(
      'instance with new DatabaseSync(path\\[, options\\]) and',
    )
  })

  it('prefers the literal Markdown when the needle is already literal', () => {
    expect(expectMatch('busy\\_timeout value', 'exact')).toBe('busy\\_timeout value')
  })

  it('looks through bold, emphasis, strikethrough, inline code, and line wraps', () => {
    expect(
      expectMatch(
        'that really matters and wraps across two lines, with emphasis and struck words.',
      ),
    ).toBe(
      'that **really matters** and wraps\nacross two lines, with _emphasis_ and ~~struck~~ words.',
    )
    expect(expectMatch('Constructs a new DatabaseSync instance')).toBe(
      'Constructs a new `DatabaseSync` instance',
    )
    expect(expectMatch('Default: 0')).toBe('Default:** `0')
  })

  it('reads across table cells and ignores the delimiter row', () => {
    expect(expectMatch('v24.0.0, v22.16.0 Add timeout option.')).toBe(
      'v24.0.0, v22.16.0 | Add `timeout` option.',
    )
    expect(expectMatch('Version Changes v24.0.0')).toBe(
      'Version | Changes |\n| --- | --- |\n| v24.0.0',
    )
  })

  it('ignores heading, list, and quote markers', () => {
    expect(expectMatch('path <string> The path of the database.')).toContain(
      'path` [`<string>`](https://developer.mozilla.org/',
    )
    expect(expectMatch('Quoted advice: call close() when done.')).toBe(
      'Quoted advice: call `close()` when done.',
    )
    expect(find(PAGE, 'new DatabaseSync(path[, options])').map((match) => match.kind)).toEqual([
      'exact',
      'normalized',
    ])
  })

  it('reads image text, reference links, and autolinks as their visible text', () => {
    expect(
      expectMatch(
        'See diagram of the lock states and the reference or https://sqlite.org/lockingv3.html for',
      ),
    ).toBe(
      'See ![diagram of the lock states] and [the reference][sqlite] or <https://sqlite.org/lockingv3.html> for',
    )
  })

  it('reports UTF-16 offsets even after an emoji', () => {
    const slice = expectMatch('for \u{1F600} details.', 'exact')
    expect(slice).toBe('for \u{1F600} details.')
    const match = find(PAGE, 'details.')[0]
    expect(PAGE.slice(match?.start, match?.end)).toBe('details.')
    expect(match?.start).toBe(PAGE.indexOf('details.'))
  })

  it('finds code as it is written, without reading its markers as layout', () => {
    expect(expectMatch('db.exec("PRAGMA busy_timeout = 1000;")', 'exact')).toBe(
      'db.exec("PRAGMA busy_timeout = 1000;")',
    )
    expect(expectMatch('DB.EXEC("pragma busy_timeout = 1000;")')).toBe(
      'db.exec("PRAGMA busy_timeout = 1000;")',
    )
    expect(find(PAGE, 'js db.exec')).toEqual([])
  })

  it('does not invent matches', () => {
    expect(find(PAGE, 'The busy timeout in seconds')).toEqual([])
    // A link title is markup: it is not part of the sentence a reader sees.
    expect(find(PAGE, 'SQLite docs in milliseconds')).toEqual([])
    expect(find(PAGE, 'busy_timeout.html in milliseconds')).toEqual([])
    // Pure markup has no visible text, so only its literal occurrences can match.
    expect(find(PAGE, '**').every((match) => match.kind === 'exact')).toBe(true)
    expect(find(PAGE, '_ * `')).toEqual([])
  })
})

describe('foldText', () => {
  it('maps every visible character to the source span it came from', () => {
    const source = 'a \\[b\\] [c](https://x.example/y) **d**'
    const folded = foldText(source)
    expect(folded.text).toBe('a [b] c d')
    const at = (char: string): string => {
      const index = folded.text.indexOf(char)
      return source.slice(folded.starts[index], folded.ends[index])
    }
    expect(at('[')).toBe('\\[')
    expect(at('c')).toBe('c')
    expect(at('d')).toBe('d')
  })

  it('stays linear on hostile input', () => {
    const hostile = `${'['.repeat(20_000)}${'-'.repeat(200_000)}x\n${'\\'.repeat(50_001)}`
    const started = Date.now()
    foldText(hostile)
    expect(Date.now() - started).toBeLessThan(3000)
  })
})

describe('characters that only shape the text', () => {
  const ZWNJ = '\u200C'
  const persian = `\u0645\u06CC${ZWNJ}\u062E\u0648\u0627\u0647\u0645`
  const page = `I ${persian} a \u2764\uFE0F and a 1\uFE0F\u20E3 key.`

  it('finds a word whether or not the quote carries its joiner or its emoji selector', () => {
    const folded = foldText(page)
    const withJoiner = findMatches(page, persian, folded)
    expect(withJoiner).toHaveLength(1)
    expect(withJoiner[0]?.kind).toBe('exact')
    const without = findMatches(page, persian.replace(ZWNJ, ''), folded)
    expect(without).toHaveLength(1)
    expect(without[0]?.kind).toBe('normalized')
    expect(page.slice(without[0]?.start, without[0]?.end)).toBe(persian)
    const heart = findMatches(page, 'a \u2764 and a 1\u20E3 key', folded)
    expect(page.slice(heart[0]?.start, heart[0]?.end)).toBe(
      'a \u2764\uFE0F and a 1\uFE0F\u20E3 key',
    )
  })
})
