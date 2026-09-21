/** Evidence mode on documents shaped like real API references: long option lists, tiny tables. */
import { afterEach, describe, expect, it } from 'vitest'
import type { FetchResult, PageResult } from '../../src/contract.ts'
import { splitBlocks } from '../../src/fetch/blocks.ts'
import { analyze } from '../../src/fetch/document.ts'
import { PART_OVERHEAD } from '../../src/fetch/budget.ts'
import { keepRelevant, rankPassages } from '../../src/fetch/goal.ts'
import { selectPassages } from '../../src/fetch/select.ts'
import { estimateTokens } from '../../src/tokens.ts'
import { createHarness, expectVerbatim, type Harness } from './helpers.ts'

let harness: Harness | undefined
afterEach(() => {
  harness?.close()
  harness = undefined
})

const GOAL = 'default busy timeout of DatabaseSync and how to change it'
const TIMEOUT_ITEM =
  '-   `timeout` <number> The busy timeout in milliseconds. This is the maximum amount of time that SQLite will wait for a database lock to be released before returning an error. **Default:** `0`.'

const OPTION_NAMES = [
  'open',
  'readOnly',
  'enableForeignKeyConstraints',
  'enableDoubleQuotedStringLiterals',
  'allowExtension',
  'readBigInts',
  'returnArrays',
  'allowBareNamedParameters',
  'timeout',
  'allowUnknownNamedParameters',
  'defensive',
  'limits',
]

function optionItem(name: string): string {
  if (name === 'timeout') return TIMEOUT_ITEM
  return `-   \`${name}\` <boolean> If \`true\`, the connection applies the ${name} behaviour to every statement it prepares, and the setting cannot be altered once the connection has been opened by the constructor. **Default:** \`false\`.`
}

/** Like the real reference: every API has its own history table, and the class name recurs. */
function fillerSection(index: number): string {
  const paragraph = `The statement object number ${index} prepares its SQL once and can then be executed repeatedly with different parameters, which avoids parsing the same text again. `
  const history = [
    '| Version | Changes |',
    '| --- | --- |',
    `| v22.${index}.0 | Added in: v22.${index}.0 |`,
  ].join('\n')
  return [
    `## Class: Helper${index}`,
    history,
    paragraph.repeat(3),
    `### helper${index}.run()`,
    `${paragraph.repeat(3)}It is created from a DatabaseSync connection.`,
  ].join('\n\n')
}

/** Laid out like https://nodejs.org/api/sqlite.html: a history table, a sentence, a long options list. */
function apiReference(): string {
  return [
    '# SQLite',
    'The `node:sqlite` module facilitates working with SQLite databases.',
    ...Array.from({ length: 12 }, (_, index) => fillerSection(index)),
    '## Class: DatabaseSync',
    [
      '| Version | Changes |',
      '| --- | --- |',
      '| v23.10.0 | The `path` argument now supports Buffer and URL objects. |',
      '| v22.5.0 | Added in: v22.5.0 |',
    ].join('\n'),
    'This class represents a single connection to a SQLite database. All APIs exposed by this class execute synchronously.',
    OPTION_NAMES.map(optionItem).join('\n'),
    ...Array.from({ length: 12 }, (_, index) => fillerSection(index + 12)),
  ].join('\n\n')
}

function only(result: FetchResult): PageResult {
  const page = result.pages[0]
  if (!page) throw new Error('no page')
  return page
}

function markdownRoute(body: string): { body: string; headers: Record<string, string> } {
  return { body, headers: { 'content-type': 'text/markdown; charset=utf-8' } }
}

describe('long lists', () => {
  it('become one block per top-level item, each keeping its continuation, nested items, and code', () => {
    const list = [
      '-   first item with enough words to make the whole list longer than the limit for keeping a list in one piece, because it goes on and on',
      '    continuation line of the first item',
      '',
      '    ```yaml',
      '    - name: this is YAML inside the first item, not a list item',
      '    ```',
      '-   second item',
      '    -   nested under the second item',
      '    -   also nested under the second item',
      '-   third item that is again long enough to matter for the total length of this list, which has to pass six hundred characters in total to be divided at all, so here are some more words, and then a few more words to be safe, and a last handful of words',
    ].join('\n')
    const markdown = `Intro.\n\n${list}\n\nAfter.`
    const blocks = splitBlocks(markdown)
    expect(blocks.map((block) => block.kind)).toEqual([
      'paragraph',
      'list',
      'list',
      'list',
      'paragraph',
    ])
    expect(markdown.slice(blocks[1]?.start, blocks[1]?.end)).toContain('- name: this is YAML')
    expect(markdown.slice(blocks[2]?.start, blocks[2]?.end)).toBe(
      '-   second item\n    -   nested under the second item\n    -   also nested under the second item',
    )
    let rebuilt = ''
    let cursor = 0
    for (const block of blocks) {
      rebuilt += markdown.slice(cursor, block.tileEnd)
      cursor = block.tileEnd
    }
    expect(rebuilt).toBe(markdown)
  })

  it('stay whole when they are short', () => {
    const blocks = splitBlocks('-   one\n-   two\n    -   nested\n-   three')
    expect(blocks).toHaveLength(1)
  })

  it('divide an oversized item further: its own lead, then each nested item', () => {
    const nested = OPTION_NAMES.map((name) => `    ${optionItem(name)}`).join('\n')
    const markdown = `-   \`path\` <string> The path of the database.\n-   \`options\` <Object> Configuration options for the connection:\n${nested}`
    const texts = splitBlocks(markdown).map((block) => markdown.slice(block.start, block.end))
    expect(texts).toHaveLength(2 + OPTION_NAMES.length)
    expect(texts[1]).toBe('-   `options` <Object> Configuration options for the connection:')
    expect(texts).toContain(`    ${TIMEOUT_ITEM}`)
  })
})

describe('ranking', () => {
  const document = analyze(apiReference())

  it('puts the list item that answers the goal first, not a short table that shares one word', () => {
    const withTimeoutRow = analyze(
      apiReference().replace(
        '| v22.5.0 | Added in: v22.5.0 |',
        '| v24.0.0 | Add the `timeout` option. |',
      ),
    )
    const ranked = (rankPassages([withTimeoutRow], GOAL)[0] ?? []).sort((a, b) => b.score - a.score)
    const text = (index: number): string =>
      withTimeoutRow.markdown.slice(ranked[index]?.start, ranked[index]?.end)
    expect(text(0)).toBe(TIMEOUT_ITEM)
    const table = ranked.find((candidate) =>
      withTimeoutRow.markdown.slice(candidate.start, candidate.end).includes('| v24.0.0 |'),
    )
    expect(table).toBeDefined()
    expect(table?.score).toBeLessThan((ranked[0]?.score ?? 0) * 0.75)
  })

  it('does not reward a block for being short', () => {
    const markdown = [
      '## Locks',
      'timeout',
      'The busy timeout decides how long a writer waits for a lock before it gives up, and its default can be raised per connection when contention is expected during long transactions.',
    ].join('\n\n')
    const ranked = (rankPassages([analyze(markdown)], 'default busy timeout')[0] ?? []).sort(
      (a, b) => b.score - a.score,
    )
    expect(markdown.slice(ranked[0]?.start, ranked[0]?.end)).toContain('The busy timeout decides')
  })

  it('prefers covering several distinctive goal words over repeating one', () => {
    const markdown = [
      '## Notes',
      'Timeout, timeout, timeout: the word timeout appears in this paragraph again and again, timeout after timeout.',
      'Set the busy handler when the default is too short for your workload.',
      ...Array.from(
        { length: 20 },
        (_, index) => `Unrelated paragraph ${index} about rendering pipelines and texture atlases.`,
      ),
    ].join('\n\n')
    const ranked = (rankPassages([analyze(markdown)], 'default busy timeout')[0] ?? []).sort(
      (a, b) => b.score - a.score,
    )
    expect(markdown.slice(ranked[0]?.start, ranked[0]?.end)).toContain('Set the busy handler')
  })

  it('still finds the only matching paragraph of a plain document', () => {
    const ranked = rankPassages([document], 'represents a single connection')[0] ?? []
    expect(
      ranked.some((candidate) =>
        document.markdown.slice(candidate.start, candidate.end).includes('This class represents'),
      ),
    ).toBe(true)
  })
})

describe('acceptance: an API reference', () => {
  it('returns the option that answers the question, verbatim, and uses the budget', async () => {
    harness = await createHarness({ '/api/sqlite.html': markdownRoute(apiReference()) })
    const result = await harness.fetch({
      url: 'https://nodejs.example.org/api/sqlite.html',
      goal: GOAL,
      max_tokens: 2500,
    })
    const page = only(result)
    expect(page.mode).toBe('goal')
    const answer = page.parts.findIndex((part) => part.text.includes(TIMEOUT_ITEM))
    expect(answer).toBeGreaterThanOrEqual(0)
    const table = page.parts.findIndex((part) => part.text.includes('| Version | Changes |'))
    expect(table === -1 || table >= answer).toBe(true)
    expect(page.parts[answer]?.section).toBe('1.13')
    expect(result.tokens).toBeGreaterThan(2500 * 0.3)
    expect(result.tokens).toBeLessThanOrEqual(2500)
    expectVerbatim(result, harness.store)
  })
})

describe('context around a passage', () => {
  const section = (name: string, sentences: string[]): string =>
    [`## ${name}`, ...sentences].join('\n\n')
  const filler = Array.from({ length: 40 }, (_, index) =>
    section(`Topic ${index}`, [
      `Paragraph about rendering topic ${index}, textures, and shader compilation. `.repeat(4),
    ]),
  )
  const target = section('Locking', [
    'Writers take a reserved lock first.',
    'The quokka threshold is the number of retries before the writer gives up.',
    'After giving up, the error code is SQLITE_BUSY.',
    'Readers are never blocked by this.',
  ])
  const body = ['# Manual', ...filler.slice(0, 20), target, ...filler.slice(20)].join('\n\n')

  it('widens a lone hit with the blocks after and before it, inside its section only', async () => {
    harness = await createHarness({ '/m': markdownRoute(body) })
    const result = await harness.fetch({
      url: 'https://example.com/m',
      goal: 'quokka threshold',
      max_tokens: 2000,
    })
    const page = only(result)
    expect(page.parts).toHaveLength(1)
    expect(page.parts[0]?.text).toBe(target)
    expect(page.parts[0]?.text).not.toContain('Topic 19')
    expectVerbatim(result, harness.store)
  })

  it('adds at most about 1,500 characters of context to one passage', async () => {
    const long = section('Locking', [
      'The quokka threshold is the number of retries before the writer gives up.',
      ...Array.from({ length: 12 }, (_, index) =>
        `Follow-up sentence ${index} that explains one more detail of the retry loop. `.repeat(4),
      ),
    ])
    harness = await createHarness({
      '/m': markdownRoute(['# Manual', ...filler, long].join('\n\n')),
    })
    const page = only(
      await harness.fetch({
        url: 'https://example.com/m',
        goal: 'quokka threshold',
        max_tokens: 3000,
      }),
    )
    expect(page.parts).toHaveLength(1)
    const hit = 'The quokka threshold is the number of retries before the writer gives up.'
    const context = (page.parts[0]?.text.length ?? 0) - hit.length - '## Locking\n\n'.length
    expect(context).toBeGreaterThan(600)
    expect(context).toBeLessThanOrEqual(1500)
  })

  it('joins passages that only whitespace separates, across a heading too', async () => {
    const doc = [
      '# Manual',
      ...filler.slice(0, 25),
      section('Alpha', ['Filler line one.', 'The zyzzyva limit closes this section.']),
      section('Beta', ['The zyzzyva limit opens the next section.', 'Filler line two.']),
      ...filler.slice(25),
    ].join('\n\n')
    harness = await createHarness({ '/m': markdownRoute(doc) })
    // A budget this small leaves no room for context, so the two hits stand on their own.
    const result = await harness.fetch({
      url: 'https://example.com/m',
      goal: 'zyzzyva limit',
      max_tokens: 500,
    })
    const page = only(result)
    const hits = page.parts.filter((part) => part.text.includes('zyzzyva'))
    expect(hits).toHaveLength(1)
    expect(hits[0]?.text).toContain('closes this section.\n\n## Beta\n\nThe zyzzyva limit opens')
    for (const [index, part] of page.parts.entries()) {
      const next = page.parts[index + 1]
      if (next) expect(next.start - part.end).toBeGreaterThan(2)
    }
    expectVerbatim(result, harness.store)
  })
})

describe('budget after widening', () => {
  it.each([400, 700, 1200, 2500])(
    'never spends more than %i tokens, context included',
    (tokens) => {
      const documents = [
        analyze(apiReference()),
        analyze(apiReference().replaceAll('timeout', 'deadline')),
      ]
      const budget = { tokens, chars: tokens * 4 }
      const candidates = keepRelevant(rankPassages(documents, 'busy timeout deadline default'))
      const selections = selectPassages(documents, candidates, budget)
      const parts = selections.flatMap((selection) => selection.parts)
      // No single block of this document is longer than 400 characters.
      const widened = parts.filter((part) => part.text.length > 400)
      expect(parts.length).toBeGreaterThan(0)
      if (tokens >= 1200) expect(widened.length).toBeGreaterThan(0)
      const spentTokens = parts.reduce(
        (sum, part) => sum + estimateTokens(part.text) + PART_OVERHEAD.tokens,
        0,
      )
      const spentChars = parts.reduce(
        (sum, part) => sum + part.text.length + PART_OVERHEAD.chars,
        0,
      )
      expect(spentTokens).toBeLessThanOrEqual(budget.tokens)
      expect(spentChars).toBeLessThanOrEqual(budget.chars)
    },
  )
})

describe('pages that fit their share', () => {
  const big = apiReference()
  const small =
    '# Issue 57597\n\nnode:sqlite: the busy timeout cannot be changed after the database was opened.\n\nA maintainer replied that the `timeout` option of the constructor is the supported way.'

  it('returns a small page whole and untruncated next to a large page that is excerpted', async () => {
    harness = await createHarness({ '/big': markdownRoute(big), '/small': markdownRoute(small) })
    const result = await harness.fetch({
      urls: ['https://example.com/big', 'https://example.com/small'],
      goal: GOAL,
      max_tokens: 2500,
    })
    const [first, second] = result.pages
    expect(first?.mode).toBe('goal')
    expect(first?.parts.some((part) => part.text.includes(TIMEOUT_ITEM))).toBe(true)
    expect(second).toMatchObject({ mode: 'full', truncated: false, shown_chars: small.length })
    expect(second?.parts).toHaveLength(1)
    expect(second?.next_cursor).toBeUndefined()
    expect(result.tokens).toBeGreaterThan(2500 * 0.3)
    expect(result.tokens).toBeLessThanOrEqual(2500)
    expectVerbatim(result, harness.store)
  })

  it('recomputes the share after each grant, so a mid-sized page is whole when the rest is tiny', async () => {
    const mid = [
      '# Mid',
      ...Array.from({ length: 28 }, (_, index) =>
        `Paragraph ${index} about the busy timeout and its default. `.repeat(5),
      ),
    ].join('\n\n')
    harness = await createHarness({ '/mid': markdownRoute(mid), '/small': markdownRoute(small) })
    const result = await harness.fetch({
      urls: ['https://example.com/mid', 'https://example.com/small'],
      goal: GOAL,
      max_tokens: 3000,
    })
    // The mid page alone is more than half of the budget, but fits once the small page is placed.
    expect(result.pages.map((page) => [page.mode, page.truncated])).toEqual([
      ['full', false],
      ['full', false],
    ])
    expect(result.pages[0]?.total_tokens).toBeGreaterThan((3000 - 460) / 2)
  })

  it('records a repost of a whole page on the page that is shown whole', async () => {
    const copy = [
      '# Mirror',
      ...Array.from({ length: 30 }, (_, index) =>
        `Mirror filler ${index} about nothing in particular. `.repeat(6),
      ),
      small.split('\n\n')[1] ?? '',
    ].join('\n\n')
    harness = await createHarness({ '/small': markdownRoute(small), '/copy': markdownRoute(copy) })
    const result = await harness.fetch({
      urls: ['https://example.com/small', 'https://mirror.example.net/copy'],
      goal: 'busy timeout cannot be changed',
      max_tokens: 1200,
    })
    expect(result.pages[0]).toMatchObject({ mode: 'full' })
    expect(result.pages[0]?.parts[0]?.also_in).toEqual([2])
    expect(
      result.pages[1]?.parts.some((part) => part.text.includes('cannot be changed after')),
    ).toBe(false)
  })
})

/**
 * A long document contains something that looks like a match for almost any goal. Asked what
 * RFC 9110 says about baking sourdough bread, evidence mode returned two passages of HTTP
 * specification, each with a citable location, and said nothing about the page being unrelated
 * (ninth audit round). Neither the score nor the share of the goal's terms that a page contains
 * tells that case from a real one, so what is required is the term that says what the goal is
 * about.
 */
const SPEC_PAGE = [
  '# Caching in HTTP',
  '',
  '## 3.6 Origin Server',
  '',
  'The most familiar form of origin server are large public websites, where a home page is the '.repeat(
    3,
  ),
  '',
  '## 4.2 Freshness',
  '',
  'A response is fresh while its age has not passed its freshness lifetime, which a server may '.repeat(
    3,
  ),
  '',
  '## 5.1 Conditional requests',
  '',
  'A conditional request carries a validator, and the entity tag is the one a server sends. '.repeat(
    3,
  ),
].join('\n')

const RECIPE_PAGE = [
  '# Sourdough at home',
  '',
  '## Feeding the starter',
  '',
  'A sourdough starter is flour and water kept warm, and you feed it every day until it rises. '.repeat(
    3,
  ),
  '',
  '## Baking',
  '',
  'Bake the bread in a covered pot so that the crust of the sourdough stays soft while it rises. '.repeat(
    3,
  ),
].join('\n')

describe('a page that is not about the goal', () => {
  const read = (markdown: string, goal: string) =>
    keepRelevant(rankPassages([analyze(markdown)], goal))[0] ?? []

  it('offers nothing, rather than whatever words it happens to share', () => {
    // "home" occurs in the specification, and used to be enough.
    expect(read(SPEC_PAGE, 'how do I bake sourdough bread at home')).toEqual([])
    expect(read(RECIPE_PAGE, 'what does an entity tag do in a conditional request')).toEqual([])
  })

  it('still offers passages when the goal is what the page is about', () => {
    const spec = read(SPEC_PAGE, 'what does an entity tag do in a conditional request')
    const recipe = read(RECIPE_PAGE, 'how do I bake sourdough bread at home')
    expect(spec.length).toBeGreaterThan(0)
    expect(recipe.length).toBeGreaterThan(0)
    expect(SPEC_PAGE.slice(spec[0]?.start, spec[0]?.end)).toContain('conditional')
    expect(RECIPE_PAGE.slice(recipe[0]?.start, recipe[0]?.end)).toContain('sourdough')
  })

  it('is told apart from the pages that do answer, in one request', () => {
    const goal = 'how do I bake sourdough bread at home'
    const ranked = rankPassages([analyze(SPEC_PAGE), analyze(RECIPE_PAGE)], goal)
    expect(ranked[0]).toEqual([])
    expect(ranked[1]?.length).toBeGreaterThan(0)
  })

  it('takes every equally defining term, so that any one of them is enough', () => {
    // Both are as long as the other; a page about either is about the goal.
    const onlyOne = [
      '# Sourdough',
      '',
      'A sourdough starter is flour and water, fed daily. '.repeat(6),
    ].join('\n')
    expect(read(onlyOne, 'sourdough and chocolate together').length).toBeGreaterThan(0)
  })
})
