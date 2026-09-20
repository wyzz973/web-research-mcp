import { describe, expect, it } from 'vitest'
import type { ResolvedSearch, SearchRequest } from '../../src/contract.ts'
import { normalizeSearch } from '../../src/search/normalize.ts'
import { testConfig } from './helpers.ts'

const config = testConfig()

function resolve(request: SearchRequest): ResolvedSearch {
  const normalized = normalizeSearch(request, config)
  if (normalized.kind !== 'query') throw new Error('expected a query')
  return normalized.search
}

function rejection(request: SearchRequest) {
  try {
    normalizeSearch(request, config)
  } catch (error) {
    return error
  }
  throw new Error('expected a rejection')
}

describe('normalizeSearch', () => {
  it('applies the defaults', () => {
    expect(resolve({ query: 'fetch abort timeout' })).toEqual({
      queries: ['fetch abort timeout'],
      maxResults: 10,
      goal: undefined,
      sites: [],
      recency: undefined,
      depth: 'standard',
      maxTokens: 5000,
      notes: [],
    })
  })

  it('merges query and queries, removes duplicates, and keeps at most five', () => {
    const search = resolve({
      query: '  Fetch   abort ',
      queries: ['fetch abort', 'b', 'c', 'd', 'e', 'f'],
    })
    expect(search.queries).toEqual(['Fetch abort', 'b', 'c', 'd', 'e'])
    expect(search.notes).toEqual(['Only the first 5 queries were used.'])
  })

  it('reads a string given for queries as a one-item list', () => {
    const search = resolve({ queries: 'only one' })
    expect(search.queries).toEqual(['only one'])
    expect(search.notes).toEqual(['queries was a string and was read as a one-item list.'])
  })

  it('reads a JSON-encoded list and a list given for query', () => {
    expect(resolve({ queries: '["a b","c d"]' }).queries).toEqual(['a b', 'c d'])
    const search = resolve({ query: ['a b', 7] })
    expect(search.queries).toEqual(['a b', '7'])
    expect(search.notes).toEqual(['query was a list and was merged into queries.'])
  })

  it('normalizes Unicode composition and whitespace', () => {
    expect(resolve({ query: 'cafe\u0301\n\tmenu' }).queries).toEqual(['café menu'])
  })

  it('reads numeric strings as numbers without a note', () => {
    const search = resolve({ query: 'q', max_results: '20', max_tokens: ' 3000 ' })
    expect([search.maxResults, search.maxTokens, search.notes]).toEqual([20, 3000, []])
  })

  it('limits max_results to 1-50 and max_tokens to the deployment ceiling', () => {
    const high = resolve({ query: 'q', max_results: 500, max_tokens: 99_999 })
    expect([high.maxResults, high.maxTokens]).toEqual([50, 10_000])
    expect(high.notes).toEqual([
      'max_results was limited to 50.',
      'max_tokens was limited to 10000.',
    ])
    const low = resolve({ query: 'q', max_results: 0, max_tokens: 5 })
    expect([low.maxResults, low.maxTokens]).toEqual([1, 200])
  })

  it('never lets the default budget exceed a lowered ceiling', () => {
    const tight = testConfig({ WEB_RESEARCH_MAX_OUTPUT_TOKENS: '3000' })
    const normalized = normalizeSearch({ query: 'q' }, tight)
    expect(normalized.kind === 'query' && normalized.search.maxTokens).toBe(3000)
  })

  it('reduces sites to hosts: URLs, www, wildcards, operators, and plain strings', () => {
    const search = resolve({
      query: 'q',
      sites: [
        'https://Docs.Python.org/3/library/',
        'www.example.com',
        '*.mozilla.org',
        'site:nodejs.org',
      ],
    })
    expect(search.sites).toEqual(['docs.python.org', 'example.com', 'mozilla.org', 'nodejs.org'])
    expect(search.notes).toEqual(['sites entries were reduced to their domain names.'])

    const listed = resolve({ query: 'q', sites: 'a.com, b.org' })
    expect(listed.sites).toEqual(['a.com', 'b.org'])
    expect(listed.notes).toEqual(['sites was a string and was read as a list.'])
  })

  it('accepts a public suffix and rejects what is not a domain', () => {
    expect(resolve({ query: 'q', sites: ['edu', 'gov.cn'] }).sites).toEqual(['edu', 'gov.cn'])
    expect(rejection({ query: 'q', sites: ['not a domain'] })).toMatchObject({
      code: 'invalid_input',
      message: 'sites[0] is not a domain name such as "example.com"',
    })
    expect(rejection({ query: 'q', sites: ['localhost'] })).toMatchObject({ code: 'invalid_input' })
    expect(rejection({ query: 'q', sites: ['10.0.0.1'] })).toMatchObject({ code: 'invalid_input' })
  })

  it('moves site: operators from the query into sites', () => {
    const search = resolve({
      query:
        'abort fetch site:developer.mozilla.org OR site:https://nodejs.org/api/ -site:w3schools.com',
      sites: ['nodejs.org'],
    })
    expect(search.queries).toEqual(['abort fetch -site:w3schools.com'])
    expect(search.sites).toEqual(['nodejs.org', 'developer.mozilla.org'])
    expect(search.notes).toEqual(['site: operators were moved from the query into sites.'])
  })

  it('keeps words to search for when the query was only an operator', () => {
    const search = resolve({ query: 'site:example.com' })
    expect([search.queries, search.sites]).toEqual([['example.com'], ['example.com']])
  })

  it('ignores unknown arguments and lists them', () => {
    const search = resolve({ query: 'q', num: 5, 'weird key!': true, region: null, lang: '' })
    expect(search.notes).toEqual(['Unknown arguments were ignored: num, weirdkey.'])
  })

  it('treats null and empty values as absent', () => {
    const search = resolve({
      query: 'q',
      goal: '  ',
      recency: null,
      depth: '',
      sites: null,
      max_results: null,
    })
    expect(search).toMatchObject({
      goal: undefined,
      recency: undefined,
      depth: 'standard',
      sites: [],
    })
  })

  it('accepts enum values in any case and rejects unknown ones', () => {
    expect(resolve({ query: 'q', recency: ' Week ', depth: 'DEEP' })).toMatchObject({
      recency: 'week',
      depth: 'deep',
    })
    expect(rejection({ query: 'q', recency: 'fortnight' })).toMatchObject({
      code: 'invalid_input',
      message: 'recency must be one of day, week, month, year',
    })
    expect(rejection({ query: 'q', depth: 3 })).toMatchObject({
      code: 'invalid_input',
      message: 'depth must be one of fast, standard, deep',
    })
  })

  it('rejects values that cannot be repaired', () => {
    expect(rejection({})).toMatchObject({ code: 'invalid_input' })
    for (const notAnObject of [null, 'fetch abort', ['fetch abort']])
      expect(rejection(notAnObject as unknown as SearchRequest)).toMatchObject({
        code: 'invalid_input',
      })
    expect(rejection({ query: '   ' })).toMatchObject({ code: 'invalid_input' })
    expect(rejection({ query: { text: 'q' } })).toMatchObject({ message: 'query must be a string' })
    expect(rejection({ queries: [{ q: 1 }] })).toMatchObject({ code: 'invalid_input' })
    expect(rejection({ query: 'q', max_results: 'many' })).toMatchObject({
      message: 'max_results must be a whole number',
    })
    expect(rejection({ query: 'q', goal: 12 })).toMatchObject({ message: 'goal must be a string' })
  })

  it('shortens overlong queries and goals at a word boundary', () => {
    const search = resolve({ query: 'word '.repeat(120), goal: 'goal '.repeat(200) })
    expect(search.queries[0]?.length).toBeLessThanOrEqual(400)
    expect(search.queries[0]?.endsWith('word')).toBe(true)
    expect(search.goal?.length).toBeLessThanOrEqual(500)
    expect(search.notes).toEqual([
      'Queries were shortened to 400 characters.',
      'goal was shortened to 500 characters.',
    ])
  })

  it('lets a cursor stand alone and carry page-shape overrides', () => {
    expect(normalizeSearch({ cursor: ' "c_k7f2" ', max_results: '5' }, config)).toEqual({
      kind: 'cursor',
      cursor: 'c_k7f2',
      maxResults: 5,
      maxTokens: undefined,
      notes: [],
      fallback: undefined,
    })
  })

  it('keeps the query sent along with a cursor as the search to fall back on', () => {
    const gone = 'The cursor was not valid or had expired, so the query was searched again.'
    const normalized = normalizeSearch(
      { cursor: 'c_k7f2', query: 'fetch abort', sites: 'nodejs.org', max_results: 5 },
      config,
    )
    expect(normalized).toMatchObject({
      kind: 'cursor',
      cursor: 'c_k7f2',
      notes: ['cursor was given, so the other search arguments were ignored.'],
      fallback: { queries: ['fetch abort'], sites: ['nodejs.org'], maxResults: 5 },
    })
    expect(normalized.kind === 'cursor' && normalized.fallback?.notes).toEqual([
      gone,
      'sites was a string and was read as a list.',
    ])

    // While the cursor works the other arguments do not matter, so their flaws must not either.
    expect(
      normalizeSearch({ cursor: 'c_k7f2', query: 'q', recency: 'fortnight' }, config),
    ).toMatchObject({
      kind: 'cursor',
      fallback: undefined,
    })
  })

  it('searches the query straight away when the cursor is not even shaped like one', () => {
    expect(normalizeSearch({ cursor: 'page-2', query: 'fetch abort' }, config)).toMatchObject({
      kind: 'query',
      search: {
        queries: ['fetch abort'],
        notes: ['The cursor was not valid or had expired, so the query was searched again.'],
      },
    })
  })

  it('reports a malformed cursor as expired when there is nothing else to go on', () => {
    expect(rejection({ cursor: 'page-2' })).toMatchObject({
      code: 'expired_ref',
      message: 'This cursor is not valid or has expired; run web_search again.',
    })
    expect(rejection({ cursor: 7 })).toMatchObject({ code: 'invalid_input' })
  })
})
