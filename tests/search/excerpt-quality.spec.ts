/**
 * Excerpt quality, from results seen in real searches. The rules only ever leave text out and
 * mark the place with "…"; they never rewrite a word.
 */
import { describe, expect, it } from 'vitest'
import { pickExcerpt } from '../../src/search/excerpt.ts'
import { isLowInformation } from '../../src/search/low-information.ts'
import { buildTerms } from '../../src/search/terms.ts'
import { estimateTokens } from '../../src/tokens.ts'

const roomy = { tokens: 10_000, chars: 100_000 }

/**
 * The four reference lines are verbatim from a real result: query "node:sqlite DatabaseSync WAL
 * busy timeout", hit github.com/nodejs/node/commit/0df87e07a0. They were the whole excerpt.
 */
const REFERENCE_LINES = [
  '+[busy timeout]: https://sqlite.org/c3ref/busy_timeout.html',
  ' [connection]: https://www.sqlite.org/c3ref/sqlite3.html',
  ' [data types]: https://www.sqlite.org/datatype3.html',
  ' [double-quoted string literals]: https://www.sqlite.org/quirks.html#dblquote',
].join('\n')

const DOC_LINES = [
  '+* `timeout` {number} The [busy timeout][] in milliseconds. This is the maximum amount of',
  '+  time that SQLite will wait for a database lock to be released before',
  '+  returning an error. **Default:** `0`.',
].join('\n')

const terms = buildTerms(['node:sqlite DatabaseSync WAL busy timeout'], undefined)

/** Every piece between ellipses must be a verbatim part of some passage. */
function expectVerbatim(excerpt: string, passages: string[]): void {
  const pieces = excerpt
    .split(/\s*…\s*/u)
    .map((piece) => piece.replace(/\n```$/u, '').trim())
    .filter(Boolean)
  for (const piece of pieces) expect(passages.some((passage) => passage.includes(piece))).toBe(true)
}

describe('isLowInformation', () => {
  it.each([
    ['link reference definition', '[connection]: https://www.sqlite.org/c3ref/sqlite3.html'],
    [
      'link reference definition in a diff',
      '+[busy timeout]: https://sqlite.org/c3ref/busy_timeout.html',
    ],
    [
      'link reference definition with a long label',
      ' [double-quoted string literals]: https://www.sqlite.org/quirks.html#dblquote',
    ],
    [
      'link reference definition with a title',
      '[spec]: <https://example.com/spec> "The specification"',
    ],
    ['link reference definition to a relative target', '> [changelog]: ./CHANGELOG.md'],
    ['bare URL', 'https://nodejs.org/api/sqlite.html'],
    ['URL behind a bullet', '- <https://nodejs.org/api/sqlite.html>'],
    ['URL with a one-word label', 'Link: https://nodejs.org/api/sqlite.html'],
    ['two URLs', 'https://a.example/x | https://b.example/y'],
    ['breadcrumb with >', 'Home > Docs > API > SQLite'],
    ['breadcrumb with ›', 'Node.js › API › sqlite › DatabaseSync'],
    ['breadcrumb with /', 'nodejs / node / doc / api'],
    ['breadcrumb in Chinese', '首页 > 文档 > API 参考'],
    ['horizontal rule', '---'],
    ['spaced rule', '* * *'],
    ['table separator', '|---|:---:|---|'],
    ['lone list marker', '1.'],
    ['lone bullet', '•'],
    ['ellipsis line', '. . .'],
    ['result metadata', '* URL: https://github.com/node-fetch/timeout-signal'],
  ])('low: %s', (_why, text) => {
    expect(isLowInformation(text)).toBe(true)
  })

  it.each([
    [
      'prose with a link in it',
      'See https://nodejs.org/api/sqlite.html for the busy timeout option.',
    ],
    [
      'Markdown link with a label',
      '- [Busy timeout handling](https://sqlite.org/c3ref/busy_timeout.html)',
    ],
    ['footnote with real text', '[^1]: The default busy timeout is zero milliseconds.'],
    ['short real sentence', 'It works.'],
    ['short Chinese sentence', '不支持。'],
    ['one word', 'Deprecated'],
    ['table row', '| timeout | number | 0 |'],
    ['code', 'const db = new DatabaseSync(path, { timeout: 5000 })'],
    ['comparison, not a breadcrumb', 'Use a > b when both are numbers.'],
    ['two segments are not a trail', 'and / or'],
    ['path-like prose', 'Set the PRAGMA journal_mode = WAL before opening a second connection.'],
    ['heading', '## Busy timeout'],
    ['version line', 'v22.5.0'],
    ['closing brace', '}'],
    ['end of a call', '});'],
    ['comment delimiter', '*/'],
    ['footnote marker', '[1]'],
    ['call with an address in it', 'fetch("http://some-service:3000/path", {'],
    ['Markdown link with a short label', '[docs](https://example.com/docs)'],
  ])('not low: %s', (_why, text) => {
    expect(isLowInformation(text)).toBe(false)
  })
})

describe('low-information lines in excerpts', () => {
  it('does not build the excerpt out of link reference definitions (the real case)', () => {
    const passages = [`${DOC_LINES}\n${REFERENCE_LINES}`]
    const excerpt = pickExcerpt(passages, terms, { tokens: 60, chars: 1000 })
    expect(excerpt).not.toContain(']: https://')
    expect(excerpt).toContain('The [busy timeout][] in milliseconds.')
    expectVerbatim(excerpt, passages)
  })

  it('gives no score to a URL line, however many query words its address contains', () => {
    const passages = [
      'https://example.com/node-sqlite-databasesync-wal-busy-timeout',
      'Unrelated opening words that say nothing at all about the topic in question.',
      'DatabaseSync accepts a timeout in milliseconds.',
    ]
    const excerpt = pickExcerpt(passages, terms, { tokens: 20, chars: 1000 })
    expect(excerpt).toBe('DatabaseSync accepts a timeout in milliseconds.')
  })

  it('returns nothing when all a source gave is link definitions', () => {
    expect(pickExcerpt([REFERENCE_LINES], terms, roomy)).toBe('')
    expect(pickExcerpt([REFERENCE_LINES], terms, { tokens: 30, chars: 1000 })).toBe('')
  })

  it('trims such lines at both ends of the excerpt and marks what was left out', () => {
    const passage = `Home > Docs > API > SQLite\n---\n${DOC_LINES}\n${REFERENCE_LINES}`
    const excerpt = pickExcerpt([passage], terms, roomy)
    expect(excerpt).toBe(`… ${DOC_LINES} …`)
    expectVerbatim(excerpt, [passage])
  })

  it('keeps such a line when it sits between two sentences, so the text stays contiguous', () => {
    const passage =
      'WAL mode lets readers proceed while a writer holds the lock.\n[wal]: https://sqlite.org/wal.html\nThe busy timeout decides how long a second writer waits.'
    expect(pickExcerpt([passage], terms, roomy)).toBe(passage)
  })

  it('trims again after shedding sentences to fit the budget', () => {
    const passage = [
      'The busy timeout decides how long a writer waits for the lock.',
      '[busy timeout]: https://sqlite.org/c3ref/busy_timeout.html',
      'A much longer closing sentence about journal modes that will not fit into the small budget we give.',
    ].join('\n')
    const excerpt = pickExcerpt([passage], terms, { tokens: 28, chars: 1000 })
    expect(excerpt).toBe('The busy timeout decides how long a writer waits for the lock. …')
    expect(estimateTokens(excerpt)).toBeLessThanOrEqual(28)
  })

  it('never starts from a low-information line when nothing matches the query', () => {
    const passage =
      '* * *\nhttps://example.com/\nPlain opening sentence of the page. Second sentence.'
    const nothingMatches = buildTerms(['zebra'], undefined)
    expect(pickExcerpt([passage], nothingMatches, { tokens: 18, chars: 1000 })).toBe(
      '… Plain opening sentence of the page. Second sentence.',
    )
    expect(pickExcerpt([passage], nothingMatches, { tokens: 8, chars: 1000 })).toBe('… Plain…')
  })
})

describe('repeated sentences', () => {
  const a = 'The busy timeout is the time a connection waits for a lock.'
  const b = 'DatabaseSync passes it to SQLite when the database is opened.'
  const c = 'In WAL mode readers do not block the writer at all.'

  it('keeps only the first occurrence when fragments from one page overlap', () => {
    const excerpt = pickExcerpt([`${a} ${b}`, `${b} ${c}`], terms, roomy)
    expect(excerpt).toBe(`${a} ${b} … ${c}`)
    expectVerbatim(excerpt, [`${a} ${b}`, `${b} ${c}`])
  })

  it('marks the place where a repeat was left out inside a passage', () => {
    expect(pickExcerpt([`${a} ${b} ${a} ${c}`], terms, roomy)).toBe(`${a} ${b} … ${c}`)
  })

  it('does not write two ellipses where a repeat meets a gap between fragments', () => {
    const excerpt = pickExcerpt([`${a} ${b}`, `${a} ${c}`], terms, roomy)
    expect(excerpt).toBe(`${a} ${b} … ${c}`)
    expect(excerpt).not.toMatch(/…\s*…/u)
  })

  it('spends the budget a repeat would have cost on new text', () => {
    const passages = [`${a} ${a} ${a} ${b} ${c}`]
    const budget = estimateTokens(`${a} … ${b} ${c}`) + 8
    expect(pickExcerpt(passages, terms, { tokens: budget, chars: 1000 })).toBe(`${a} … ${b} ${c}`)
  })

  it('keeps an occurrence whose first appearance lies outside the excerpt', () => {
    const filler =
      'Nothing here is relevant to anything that was asked about today, really nothing.'
    const passage = `${c} ${filler} ${filler.replace('Nothing', 'Still nothing')} ${a} ${c}`
    const excerpt = pickExcerpt([passage], buildTerms(['busy timeout lock'], undefined), {
      tokens: 40,
      chars: 1000,
    })
    expect(excerpt).toBe(`… ${a} ${c}`)
  })

  it('leaves repeated code lines and short repeated phrases alone', () => {
    const code =
      'const db = new DatabaseSync(path)\ndb.close()\nconst db = new DatabaseSync(path)\ndb.close()'
    expect(pickExcerpt([code], terms, roomy)).toBe(code)
    const short = 'It works. Really. It works. Really.'
    expect(pickExcerpt([short], terms, roomy)).toBe(short)
    const fenced =
      '```\nThe same sentence, twice, inside a block.\nThe same sentence, twice, inside a block.\n```'
    expect(pickExcerpt([fenced], terms, roomy)).toBe(fenced)
  })

  it('leaves flattened code alone even where a "." makes it look like a sentence (seen in Tavily text)', () => {
    const flattened =
      "const  controller =  new  AbortController();   const  timeout =  5000;  // 5 seconds   setTimeout(()  =>  controller. abort(` custom timeout abort `),  timeout); fetch('/your-api',  {  signal:  controller. signal })"
    const twice = `${flattened} ✅ copied ${flattened}`
    expect(pickExcerpt([twice], terms, roomy)).toBe(twice)
    const chained =
      'fetch(url). then((response) => response. json()). then((response) => response. json())'
    expect(pickExcerpt([chained], terms, roomy)).toBe(chained)
    const fragments =
      '`AbortSignal.timeout` [...] some words in between. `AbortSignal.timeout` [...] more words.'
    expect(pickExcerpt([fragments], terms, roomy)).toBe(fragments)
  })

  it('recognizes a repeated sentence in Chinese, with and without spaces', () => {
    const spaced = '使用 DatabaseSync 打开数据库时可以设置 busy timeout 参数。'
    const unspaced = '超时之后请求会被中止并且返回一个错误给调用方自行处理。'
    expect(
      pickExcerpt([`${spaced}${unspaced}${spaced}${unspaced}最后一句不重复。`], terms, roomy),
    ).toBe(`${spaced}${unspaced} … 最后一句不重复。`)
  })

  it('stays within the budget and verbatim for any budget', () => {
    const passages = [
      `${DOC_LINES}\n${REFERENCE_LINES}`,
      `${a} ${b}`,
      `${b} ${c}\n${REFERENCE_LINES}`,
    ]
    for (const tokens of [10, 20, 35, 60, 90, 150, 400]) {
      const excerpt = pickExcerpt(passages, terms, { tokens, chars: 10_000 })
      expect(estimateTokens(excerpt)).toBeLessThanOrEqual(tokens)
      expectVerbatim(excerpt, passages)
      expect(excerpt).not.toMatch(/…\s*…/u)
    }
  })
})
