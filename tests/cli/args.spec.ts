import { describe, expect, it } from 'vitest'
import { exitCodeFor, fetchRequest, searchRequest } from '../../src/cli/args.ts'

describe('CLI argument mapping', () => {
  it('maps exit codes so scripts can tell results, nothing found, and failures apart', () => {
    expect(exitCodeFor('ok', undefined)).toBe(0)
    expect(exitCodeFor('partial', undefined)).toBe(0)
    expect(exitCodeFor('empty', undefined)).toBe(3)
    expect(exitCodeFor('error', { code: 'invalid_input', message: '' })).toBe(2)
    expect(exitCodeFor('error', { code: 'rate_limited', message: '' })).toBe(4)
    expect(exitCodeFor('error', { code: 'internal', message: '' })).toBe(1)
  })

  it('builds a search request and omits options that were not given', () => {
    expect(
      searchRequest(['node fetch timeout'], { 'max-results': '20', site: ['nodejs.org'] }),
    ).toEqual({
      queries: ['node fetch timeout'],
      max_results: '20',
      sites: ['nodejs.org'],
    })
  })

  it('separates URLs from refs for fetch', () => {
    expect(fetchRequest(['https://example.org/a', 'k7f2:r1', 's_k2m9qx'], { goal: 'x' })).toEqual({
      urls: ['https://example.org/a'],
      refs: ['k7f2:r1', 's_k2m9qx'],
      goal: 'x',
    })
    expect(fetchRequest(['example.org/docs'], {})).toEqual({ urls: ['example.org/docs'] })
  })
})
