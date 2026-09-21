/**
 * jsdom finds a node's position among its siblings on every removal and insertion. A cleaning
 * pass that changes many children of one parent one by one is therefore quadratic: 50,000 <br>
 * in one <pre> took five minutes, 10,000 in-page links in one paragraph four seconds. These
 * tests compare the cost of four times the elements; nothing depends on how fast the machine is.
 */
import { JSDOM, VirtualConsole } from 'jsdom'
import { describe, expect, it } from 'vitest'
import {
  normalizeCodeBlocks,
  removeHidden,
  removeNoise,
  removeOwnToc,
  removePermalinks,
  restoreHeadingLevels,
  rewriteLinks,
} from '../../src/extract/clean.ts'
import { FUSE_MS, growthOf, MAX_GROWTH } from '../fetch/helpers.ts'

const URL_OF_PAGE = 'https://docs.example.com/guide'

function parse(body: string): Document {
  const html = `<!doctype html><html><head><title>t</title></head><body>${body}</body></html>`
  return new JSDOM(html, { url: URL_OF_PAGE, virtualConsole: new VirtualConsole() }).window.document
}

const many = (count: number, make: (index: number) => string): string =>
  Array.from({ length: count }, (_, index) => make(index)).join('')

const PASSES: [string, (count: number) => string, (document: Document) => void][] = [
  [
    'line breaks inside one code block',
    (count) => `<pre>${many(count, (index) => `line ${index}<br>`)}</pre>`,
    normalizeCodeBlocks,
  ],
  [
    'in-page links inside one paragraph',
    (count) => `<p>${many(count, (index) => `<a href="#s${index}">see ${index}</a> `)}</p>`,
    (document) => rewriteLinks(document, URL_OF_PAGE),
  ],
  [
    'hidden elements between shown ones',
    (count) => `<div>${many(count, (index) => `<i hidden>h</i><b>shown ${index}</b>`)}</div>`,
    (document) => void removeHidden(document),
  ],
  [
    'comments between elements',
    (count) => `<div>${many(count, (index) => `<!-- ${index} --><b>shown</b>`)}</div>`,
    (document) => void removeHidden(document),
  ],
  [
    'scripts between paragraphs',
    (count) => `<div>${many(count, (index) => `<script>var a${index}</script><p>kept</p>`)}</div>`,
    removeNoise,
  ],
  [
    'navigation blocks between paragraphs',
    (count) => `<div>${many(count, () => '<nav><a href="/x">x</a></nav><p>kept text</p>')}</div>`,
    removeOwnToc,
  ],
  [
    'permalinks in one heading',
    (count) => `<h2>${many(count, (index) => `word <a href="#h${index}">#</a> `)}</h2>`,
    removePermalinks,
  ],
]

describe('cleaning passes with very many siblings', () => {
  it.each(PASSES)('stay linear for %s', (_name, body, pass) => {
    const started = performance.now()
    // Counts, not characters: a thousand elements are enough to measure, and enough to tell a
    // pass that touches each of them from one that scans their siblings every time. Parsing is
    // not counted, and each window is closed when its measurement is done: ten thousand parsed
    // documents at once exhaust the heap of a CI runner, and the parser's own cost, which is
    // larger than the pass's and not quite linear, would otherwise drown the ratio. One size
    // only: every pass takes 9 ms or more at a thousand elements, so there is nothing to grow
    // towards, and growing is what filled the heap. Four times the elements measured 2.2 to 4.0
    // here; scanning the siblings on every change would be about 16.
    const ratio = growthOf(
      (count) => {
        const document = parse(body(count))
        return () => {
          pass(document)
          document.defaultView?.close()
        }
      },
      // One size only: every pass takes 9 ms or more at a thousand elements, so there is
      // nothing to grow towards, and growing is what filled the heap of a CI runner. Four times
      // the elements measured 2.2 to 4.0 here; scanning the siblings on every change is about 16.
      [1000],
    )
    expect(performance.now() - started).toBeLessThan(FUSE_MS)
    // Four times the elements: about 4 when linear, about 16 when every change scans the siblings.
    // Generous, because the smallest of these passes takes about 10 ms at this size and the
    // granularity of CPU time on Windows is close to that: a Windows runner measured 8.3 for a
    // pass that is 2.2 to 4.0 here. What this has to catch is a return to scanning the siblings
    // on every change, which was 50 to 900 times slower, not a factor of two.
    if (ratio !== undefined) expect(ratio).toBeLessThanOrEqual(MAX_GROWTH)
  })

  it.each(PASSES)(
    'leave the same document on both sides of the rebuild threshold: %s',
    (_name, body, pass) => {
      // Up to 64 changes under one parent are made one by one; more rebuild the parent.
      const shape = (count: number): string => {
        const document = parse(body(count))
        pass(document)
        return document.body.innerHTML
      }
      const one = shape(1)
        .replace(/^<(\w+)>/u, '')
        .replace(/<\/(\w+)>$/u, '')
      const unit = (index: number): string => one.replaceAll('0', String(index))
      for (const count of [2, 64, 65, 200]) {
        const inner = shape(count)
          .replace(/^<(\w+)>/u, '')
          .replace(/<\/(\w+)>$/u, '')
        expect(inner.replaceAll(/\d+/gu, '#')).toBe(many(count, unit).replaceAll(/\d+/gu, '#'))
      }
    },
  )

  it('rebuilds a parent without losing, reordering, or duplicating what stays', () => {
    const document = parse(
      `<p>start ${many(200, (index) => `<a href="#a${index}">in <b>${index}</b></a>, <a href="/out/${index}">out ${index}</a>; `)}end</p>`,
    )
    const before = document.body.textContent
    rewriteLinks(document, URL_OF_PAGE)
    expect(document.body.textContent).toBe(before)
    expect(document.querySelectorAll('a')).toHaveLength(200)
    expect(document.querySelectorAll('b')).toHaveLength(200)
    expect(document.querySelector('a')?.getAttribute('href')).toBe('https://docs.example.com/out/0')
  })

  it('turns every line break of a long listing into a newline, nested ones too', () => {
    const document = parse(
      `<pre><code>${many(300, (index) => `<span>a${index}<br></span>b${index}<br>`)}</code></pre>`,
    )
    normalizeCodeBlocks(document)
    expect(document.querySelectorAll('br')).toHaveLength(0)
    expect(document.querySelector('pre')?.textContent).toBe(
      many(300, (index) => `a${index}\nb${index}\n`),
    )
  })

  it('counts hidden text once per outermost hidden element, however many there are', () => {
    const document = parse(
      `<div>${many(150, (index) => `<span style="display:none">secret ${index}<i hidden>inner</i></span><span aria-hidden="true"></span><em>shown</em>`)}</div><!-- note -->`,
    )
    expect(removeHidden(document)).toBe(151)
    expect(document.body.textContent).toBe('shown'.repeat(150))
  })

  it('restores the level of very many demoted headings', () => {
    const document = parse(
      many(100, (index) => `<h2 data-wr-level="1">Top ${index}</h2><p>text</p>`),
    )
    restoreHeadingLevels(document.body)
    expect(document.querySelectorAll('h1')).toHaveLength(100)
    expect(document.querySelectorAll('h2')).toHaveLength(0)
    expect(document.querySelector('h1')?.textContent).toBe('Top 0')
  })
})
