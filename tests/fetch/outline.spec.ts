import { describe, expect, it } from 'vitest'
import { splitBlocks } from '../../src/fetch/blocks.ts'
import { analyze, headingPath, sectionAt } from '../../src/fetch/document.ts'
import { fitOutline } from '../../src/fetch/outline.ts'
import { findSection, nearestSectionIds } from '../../src/fetch/section.ts'
import { estimateTokens } from '../../src/tokens.ts'

const NUMBERED = [
  '# HTTP Semantics',
  '',
  'Front matter.',
  '',
  '## Abstract',
  '',
  'Abstract text.',
  '',
  '## 1. Introduction',
  '',
  'Intro text.',
  '',
  '### 1.1 Purpose',
  '',
  'Purpose text.',
  '',
  '```sh',
  '# 9. this is a shell comment, not a heading',
  '## 9.1 neither is this',
  '```',
  '',
  '### 1.2. History',
  '',
  'History text.',
  '',
  '## 13.2 Evaluation',
  '',
  'Evaluation text.',
  '',
  '#### 13.2.1 When to Evaluate',
  '',
  'Deep text.',
  '',
  '## Appendix A. Collected ABNF',
  '',
  'Grammar.',
  '',
  '### A.1 Core rules',
  '',
  'Rules.',
  '',
  '## Acknowledgements',
  '',
  'Thanks.',
].join('\n')

describe('blocks', () => {
  it('keeps code, tables, and lists whole and tiles the document without gaps', () => {
    const markdown = [
      'Intro paragraph',
      'second line of it.',
      '',
      '| a | b |',
      '| --- | --- |',
      '| 1 | 2 |',
      '',
      '-   item one',
      '',
      '    continuation of item one',
      '',
      '-   item two',
      '    1.  nested',
      '',
      'After the list.',
      '',
      '```js',
      'const a = 1',
      '',
      'const b = 2',
      '```',
      '## Heading right after code',
      'Tail.',
    ].join('\n')
    const blocks = splitBlocks(markdown)
    expect(blocks.map((block) => block.kind)).toEqual([
      'paragraph',
      'table',
      'list',
      'paragraph',
      'code',
      'heading',
      'paragraph',
    ])
    expect(markdown.slice(blocks[2]?.start, blocks[2]?.end)).toBe(
      '-   item one\n\n    continuation of item one\n\n-   item two\n    1.  nested',
    )
    expect(markdown.slice(blocks[4]?.start, blocks[4]?.end)).toBe(
      '```js\nconst a = 1\n\nconst b = 2\n```',
    )
    let cursor = 0
    let rebuilt = ''
    for (const block of blocks) {
      rebuilt += markdown.slice(cursor, block.tileEnd)
      cursor = block.tileEnd
    }
    expect(rebuilt).toBe(markdown)
  })
})

describe('outline', () => {
  const document = analyze(NUMBERED)
  const ids = document.outline.map((entry) => entry.id)

  it("uses a heading's own number and strips it from the title", () => {
    expect(ids).toEqual(['p1', 'p1.1', '1', '1.1', '1.2', '13.2', '13.2.1', 'A', 'A.1', 'p1.5'])
    expect(document.outline.map((entry) => entry.title)).toEqual([
      'HTTP Semantics',
      'Abstract',
      'Introduction',
      'Purpose',
      'History',
      'Evaluation',
      'When to Evaluate',
      'Collected ABNF',
      'Core rules',
      'Acknowledgements',
    ])
  })

  it('ignores # lines inside fenced code', () => {
    expect(ids).not.toContain('9')
    expect(ids).not.toContain('9.1')
  })

  it('ends a section before the next heading of the same or a higher level', () => {
    const intro = document.outline.find((entry) => entry.id === '1')
    const purpose = document.outline.find((entry) => entry.id === '1.1')
    const deep = document.outline.find((entry) => entry.id === '13.2.1')
    expect(NUMBERED.slice(intro?.start, intro?.end)).toMatch(
      /^## 1\. Introduction[\s\S]*History text\.\n\n$/u,
    )
    expect(NUMBERED.slice(purpose?.start, purpose?.end)).toMatch(
      /^### 1\.1 Purpose[\s\S]*```\n\n$/u,
    )
    expect(NUMBERED.slice(deep?.start, deep?.end)).toBe(
      '#### 13.2.1 When to Evaluate\n\nDeep text.\n\n',
    )
    expect(document.outline[0]?.end).toBe(NUMBERED.length)
  })

  it('estimates section sizes with the shared estimator', () => {
    for (const entry of document.outline) {
      const exact = estimateTokens(NUMBERED.slice(entry.start, entry.end))
      expect(entry.tokens).toBeGreaterThanOrEqual(exact)
      expect(entry.tokens).toBeLessThanOrEqual(exact + 12)
    }
  })

  it('uses positional paths when the document numbers nothing', () => {
    const plain = analyze(
      '# Guide\n\ntext\n\n## Install\n\ntext\n\n## Use\n\ntext\n\n### Flags\n\ntext\n\n#### Deep\n\ntext\n\n## FAQ\n\ntext\n\n# Second\n\n### Skipped level\n\ntext',
    )
    expect(plain.outline.map((entry) => `${entry.id} ${entry.title}`)).toEqual([
      '1 Guide',
      '1.1 Install',
      '1.2 Use',
      '1.2.1 Flags',
      '1.2.1.1 Deep',
      '1.3 FAQ',
      '2 Second',
      '2.1 Skipped level',
    ])
  })

  it('does not read a year or a count as a section number, and keeps duplicates distinct', () => {
    const tricky = analyze(
      '## 2024 roadmap\n\na\n\n## 3 ways to cache\n\nb\n\n## 1. Setup\n\nc\n\n## 1. Setup\n\nd',
    )
    expect(tricky.outline.map((entry) => entry.id)).toEqual(['p1', 'p2', '1', '1-2'])
  })

  it('does not take an absurdly long number for a section id', () => {
    const long = `1.${'2.'.repeat(30)}3`
    const document = analyze(`## ${long} Title\n\ntext\n\n## 2. Real\n\ntext`)
    expect(document.outline.map((entry) => entry.id)).toEqual(['p1', '2'])
    expect(document.outline.every((entry) => entry.id.length <= 24)).toBe(true)
  })

  it('reads plain titles out of linked or emphasized headings', () => {
    const linked = analyze('## [Install](https://example.com/i) the *CLI* `tool`\n\ntext')
    expect(linked.outline[0]?.title).toBe('Install the CLI tool')
  })

  it('takes link text out of a title like the pattern it replaced, bracket by bracket', () => {
    const titles = (markdown: string): string[] =>
      analyze(markdown).outline.map((entry) => entry.title)
    expect(
      titles(
        [
          '## [a](https://x.example) and [c](d)',
          '## ![logo](x.png) Name',
          '## [not a link] (x)',
          '## [[a](b)',
          '## [a](b',
          '## ]( [x](y) )',
          '## [](empty) text',
        ].join('\n\ntext\n\n'),
      ),
    ).toEqual(['a and c', 'logo Name', '[not a link] (x)', '[a', '[a](b', ']( x )', 'text'])
  })

  it('shortens a title that is too long to be one, and finds the section by what it shows', () => {
    const heading = `## ${'very long title '.repeat(40)}`
    const long = analyze(`${heading}\n\nbody text\n\n## Next\n\nmore`)
    const title = long.outline[0]?.title ?? ''
    expect(title).toBe(`${'very long title '.repeat(40).slice(0, 200).trimEnd()}\u2026`)
    expect(findSection(long.outline, title)?.id).toBe('1')
    // The page text is untouched: the heading block still holds the whole line.
    expect(long.markdown.slice(long.outline[0]?.start, long.blocks[0]?.end)).toBe(heading)
    const pair = analyze(`## ${'a'.repeat(199)}\u{1F600} tail\n\ntext`).outline[0]?.title ?? ''
    expect(pair.isWellFormed()).toBe(true)
  })

  it('locates the section and heading path of any offset', () => {
    const offset = NUMBERED.indexOf('Deep text.')
    expect(sectionAt(document, offset)?.id).toBe('13.2.1')
    expect(headingPath(document, offset).map((entry) => entry.id)).toEqual(['13.2.1', '13.2', 'p1'])
    expect(sectionAt(analyze('no headings at all'), 3)).toBeUndefined()
  })
})

describe('fitOutline', () => {
  const document = analyze(NUMBERED)

  it('returns everything when it fits', () => {
    expect(fitOutline(document.outline, 10_000)).toMatchObject({
      dropped: 0,
      entries: document.outline,
    })
  })

  it('drops the deepest level first, then the next', () => {
    const levels = (limit: number): number[] => [
      ...new Set(fitOutline(document.outline, limit).entries.map((entry) => entry.level)),
    ]
    const full = fitOutline(document.outline, 10_000).tokens
    expect(levels(full - 1)).toEqual([1, 2, 3])
    const threeLevels = fitOutline(document.outline, full - 1).tokens
    expect(levels(threeLevels - 1)).toEqual([1, 2])
  })

  it('cuts a flat outline short and says how much was cut', () => {
    const flat = analyze(
      Array.from({ length: 40 }, (_, index) => `## Topic number ${index}\n\ntext`).join('\n\n'),
    )
    const fitted = fitOutline(flat.outline, 60)
    expect(fitted.tokens).toBeLessThanOrEqual(60)
    expect(fitted.entries.length).toBeGreaterThan(0)
    expect(fitted.dropped).toBe(40 - fitted.entries.length)
  })
})

describe('section lookup', () => {
  const { outline } = analyze(NUMBERED)

  it.each([
    ['13.2.1', '13.2.1'],
    ['Section 13.2.1.', '13.2.1'],
    ['§ 1.1', '1.1'],
    ['a', 'A'],
    ['Appendix A', 'A'],
    ['a.1', 'A.1'],
    ['Acknowledgements', 'p1.5'],
    ['13.2 evaluation', '13.2'],
  ])('resolves %s', (requested, id) => {
    expect(findSection(outline, requested)?.id).toBe(id)
  })

  it('suggests the family of the nearest existing ancestor', () => {
    expect(findSection(outline, '13.2.7')).toBeUndefined()
    expect(nearestSectionIds(outline, '13.2.7')).toEqual(['13.2', '13.2.1'])
    expect(nearestSectionIds(outline, '1.9')).toEqual(['1', '1.1', '1.2'])
  })

  it('falls back to the closest spellings: shared prefix first, then fewest edits', () => {
    expect(nearestSectionIds(outline, '12', 3)).toEqual(['1', '1.2', '1.1'])
  })
})
