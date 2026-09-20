import { describe, expect, it } from 'vitest'
import { stripInvisible, withoutInvisible } from '../../src/search/invisible.ts'

describe('stripInvisible', () => {
  it('removes zero-width spaces, bidirectional controls and control characters, and counts them', () => {
    expect(stripInvisible('safe\u200B\u200Bword')).toEqual({ text: 'safeword', removed: 2 })
    expect(stripInvisible('read\u202Esiht\u202C carefully')).toEqual({
      text: 'readsiht carefully',
      removed: 2,
    })
    expect(stripInvisible('a\u0000b\u0008c\u009Fd\uFEFF\u2060\u2066\u2069')).toEqual({
      text: 'abcd',
      removed: 7,
    })
  })

  it('leaves everything a reader can see, line breaks and tabs included', () => {
    const text = 'Line one.' + '\n' + '\tindented — “quoted” 中文 🙂'
    expect(stripInvisible(text)).toEqual({ text, removed: 0 })
  })

  it('keeps the joiners that Persian and Indic words and emoji sequences are spelled with', () => {
    const persian = 'می\u200Cخواهم'
    const family = '👨' + '\u200D' + '👩' + '\u200D' + '👧'
    expect(stripInvisible(persian)).toEqual({ text: persian, removed: 0 })
    expect(stripInvisible(family)).toEqual({ text: family, removed: 0 })
  })

  it('has a plain variant for comparing text', () => {
    expect(withoutInvisible('Abort\u200BController')).toBe('AbortController')
  })
})
