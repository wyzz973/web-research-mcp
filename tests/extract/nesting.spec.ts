/**
 * Main-content detection and the Markdown conversion walk up from every node, so a page that
 * nests its elements deeply costs far more than its size suggests: 13 KB of tables nested 400
 * deep (1,600 levels of elements, since a table nesting is table, tbody, tr, td) held a worker
 * for 16.6 seconds and produced one character (seventh audit round). Neither the byte limit nor
 * the timeout helps, so the nesting itself is measured and refused.
 */
import { describe, expect, it } from 'vitest'
import { extractFromHtml } from '../../src/extract/html.ts'

const filler = 'Ordinary sentence of a page, long enough to be read as an article. '.repeat(10)

/** `levels` is levels of elements, which is what the limit counts. */
function nested(levels: number, kind: 'div' | 'table' = 'div'): Uint8Array {
  const [open, close] =
    kind === 'table' ? ['<table><tr><td>', '</td></tr></table>'] : ['<div>', '</div>']
  const times = kind === 'table' ? Math.ceil(levels / 4) : levels
  return new TextEncoder().encode(
    `<!doctype html><meta charset="utf-8"><title>T</title><body>${open.repeat(times)}${filler}${close.repeat(times)}</body>`,
  )
}

const read = (html: Uint8Array) =>
  extractFromHtml({ html, url: 'https://example.org/', contentType: 'text/html; charset=utf-8' })

describe('deeply nested documents', () => {
  it('refuses a page nested past the limit, and does so at once', () => {
    const started = process.cpuUsage()
    const reply = read(nested(1600, 'table'))
    const spent = process.cpuUsage(started)
    expect(reply).toEqual({ ok: false, reason: 'too_deep' })
    // Parsing 13 KB is the only work allowed here; converting it took 16.6 s before this guard.
    expect((spent.user + spent.system) / 1000).toBeLessThan(1000)
  })

  it('reads a page nested as deeply as real pages are', () => {
    // Measured with the same walk: GitHub 39 levels, the Node documentation 19, RFC 9110 13.
    for (const levels of [13, 39, 80]) {
      const reply = read(nested(levels))
      expect(reply.ok, `${levels} levels`).toBe(true)
      if (reply.ok) expect(reply.value.markdown).toContain('Ordinary sentence')
    }
    const tables = read(nested(80, 'table'))
    expect(tables.ok).toBe(true)
  })

  it('counts levels of elements, whatever the elements are', () => {
    expect(read(nested(101))).toEqual({ ok: false, reason: 'too_deep' })
    expect(read(nested(104, 'table'))).toEqual({ ok: false, reason: 'too_deep' })
  })

  it('answers, rather than overflowing a stack, on a document nested far past the limit', () => {
    // At this depth jsdom overflows the stack when the document is torn down, which used to
    // replace the answer with a parser error.
    expect(read(nested(3000))).toEqual({ ok: false, reason: 'too_deep' })
  })

  it('refuses what the parser itself could not survive, by reading the source first', () => {
    // A parser recurses, so at this depth it spends the whole deadline, or overflows, before
    // there is a tree to measure: 400 KB of div took more than 30 seconds through the worker.
    const started = process.cpuUsage()
    expect(read(nested(40_000))).toEqual({ ok: false, reason: 'too_deep' })
    const spent = process.cpuUsage(started)
    expect((spent.user + spent.system) / 1000).toBeLessThan(1000)
  })

  it('does not count elements that hold nothing as nesting', () => {
    // A page with thousands of line breaks or images is ordinary; reading depth from the source
    // must not take their opening tags for levels.
    // Just over the source limit of 1,000 opening tags, which is all this has to prove: the
    // conversion itself is slow per element, and a CI machine is several times slower again.
    const voids = '<br><img src="i.png"><hr><input value="x">'.repeat(300)
    const html = new TextEncoder().encode(
      `<!doctype html><meta charset="utf-8"><title>T</title><body><article>${filler}${voids}${filler}</article></body>`,
    )
    const reply = read(html)
    expect(reply.ok).toBe(true)
    if (reply.ok) expect(reply.value.markdown).toContain('Ordinary sentence')
  })

  it('does not count a tag that closes itself', () => {
    const selfClosing = '<div/>'.repeat(1100)
    const html = new TextEncoder().encode(
      `<!doctype html><meta charset="utf-8"><title>T</title><body><article>${filler}${selfClosing}</article></body>`,
    )
    // In HTML `<div/>` opens a div, so the tree really is deep; the source reading must not be
    // the thing that says so, or a page of `<path/>` in an SVG would be refused for nothing.
    expect(read(html)).toEqual({ ok: false, reason: 'too_deep' })
  })
})
