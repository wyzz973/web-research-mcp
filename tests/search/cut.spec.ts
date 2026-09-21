import { describe, expect, it } from 'vitest'
import { headOf } from '../../src/search/cut.ts'
import { fuse } from '../../src/search/fuse.ts'
import { normalizeSearch } from '../../src/search/normalize.ts'
import { hit, testConfig } from './helpers.ts'

const FACE = String.fromCodePoint(0x1f600)
const HALF_A_PAIR = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u

describe('headOf', () => {
  it('cuts by UTF-16 units and steps back rather than leave half of a pair', () => {
    const text = `ab${FACE}cd`
    expect(headOf(text, 2)).toBe('ab')
    expect(headOf(text, 3)).toBe('ab')
    expect(headOf(text, 4)).toBe(`ab${FACE}`)
    expect(headOf(text, 5)).toBe(`ab${FACE}c`)
  })

  it('returns the whole text when it fits, and nothing for no room', () => {
    expect(headOf(`ab${FACE}`, 4)).toBe(`ab${FACE}`)
    expect(headOf(`ab${FACE}`, 99)).toBe(`ab${FACE}`)
    expect(headOf(`${FACE}`, 1)).toBe('')
    expect(headOf('abc', 0)).toBe('')
    expect(headOf('abc', -5)).toBe('')
  })

  it('keeps a pair that ends exactly at the cut, at every offset of a mixed text', () => {
    const text = `${FACE}a${FACE}${FACE}bc${FACE}`
    for (let units = 0; units <= text.length + 1; units += 1) {
      const head = headOf(text, units)
      expect(HALF_A_PAIR.test(head)).toBe(false)
      expect(text.startsWith(head)).toBe(true)
      expect(units - head.length).toBeLessThanOrEqual(units > text.length ? units : 1)
    }
  })
})

describe('every place the search side shortens text', () => {
  const english = { sites: [], since: undefined, languages: new Set(['en']) }

  it.each([197, 198, 199])(
    'a long title or passage with an emoji at the cut (%i units before it)',
    (pad) => {
      const title = `${'a'.repeat(pad)}${FACE.repeat(10)}`
      const passage = `${'b'.repeat(pad + 3800)}${FACE.repeat(10)}`
      const [fused] = fuse(
        [{ source: 'exa', queries: [1], hits: [hit('https://a.test/long', passage, title)] }],
        english,
      )
      expect(fused?.title.endsWith('…')).toBe(true)
      expect(fused?.passages[0]?.endsWith('…')).toBe(true)
      expect(HALF_A_PAIR.test(`${fused?.title ?? ''}${fused?.passages[0] ?? ''}`)).toBe(false)
    },
  )

  it('an overlong query with an emoji at the cut', () => {
    for (const pad of [0, 1, 2, 3]) {
      const query = `${'q'.repeat(pad)}${FACE.repeat(400)}`
      const normalized = normalizeSearch({ query }, testConfig())
      if (normalized.kind !== 'query') throw new Error('expected a query')
      for (const text of normalized.search.queries) expect(HALF_A_PAIR.test(text)).toBe(false)
    }
  })
})
