import { describe, expect, it } from 'vitest'
import { loadConfig } from '../../src/config.ts'
import { createDefaultSources } from '../../src/sources/index.ts'
import { cleanText, cleanTitle, toIsoDate, vendorFailure } from '../../src/sources/shared.ts'
import { scriptedHttp } from './helpers.ts'

describe('toIsoDate', () => {
  it('keeps the calendar day of ISO dates and timestamps', () => {
    expect(toIsoDate('2026-02-02')).toBe('2026-02-02')
    expect(toIsoDate('2021-10-20T15:26:08.000Z')).toBe('2021-10-20')
    expect(toIsoDate('Tue, 14 Jan 2025 17:15:24 GMT')).toBe('2025-01-14')
  })

  it('never guesses', () => {
    for (const value of [
      'N/A',
      '',
      'yesterday',
      '2026-13-45',
      '1970-01-01T00:00:00Z',
      '2',
      null,
      5,
    ])
      expect(toIsoDate(value)).toBeUndefined()
  })
})

describe('cleanText', () => {
  it('normalizes line endings and blank runs without touching words', () => {
    expect(cleanText('  a\r\nb  \n\n\n\nc\u0000\u200B ')).toBe('a\nb\n\nc')
    expect(cleanText(42)).toBe('')
  })

  it('keeps the joiners that Persian and Indic words are spelled with', () => {
    expect(cleanText('می\u200Cخواهم')).toBe('می\u200Cخواهم')
  })

  it('strips bidirectional overrides', () => {
    expect(cleanTitle('safe\u202Eevil\u202C  title')).toBe('safeevil title')
  })
})

describe('vendorFailure', () => {
  it.each([
    ['Rate limit exceeded', 'rate_limited'],
    ['HTTP 429', 'rate_limited'],
    ['This request exceeds your plan usage limit', 'rate_limited'],
    ['Unauthorized: missing or invalid API key.', 'blocked'],
    ['internal error', 'upstream_error'],
  ])('%s -> %s', (text, code) => {
    const error = vendorFailure(text, 'tavily')
    expect(error.code).toBe(code)
    expect(error.message).not.toContain(text)
  })
})

describe('createDefaultSources', () => {
  const { http } = scriptedHttp(() => ({}))
  const config = (env: Record<string, string>) =>
    loadConfig({ WEB_RESEARCH_DATA_DIR: '/tmp/x', ...env })

  it('offers all three anonymous tiers by default', () => {
    const sources = createDefaultSources(config({}), http)
    expect(sources.map((source) => [source.id, source.free()])).toEqual([
      ['exa', true],
      ['parallel', true],
      ['tavily', true],
    ])
  })

  it('offers only keyed sources when the anonymous tiers are switched off', () => {
    const sources = createDefaultSources(
      config({ WEB_RESEARCH_ANONYMOUS_SOURCES: '0', TAVILY_API_KEY: 'tvly-key' }),
      http,
    )
    expect(sources.map((source) => [source.id, source.free()])).toEqual([['tavily', false]])
    expect(createDefaultSources(config({ WEB_RESEARCH_ANONYMOUS_SOURCES: '0' }), http)).toEqual([])
  })
})
