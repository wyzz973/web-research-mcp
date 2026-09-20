import { describe, expect, it } from 'vitest'
import { createTavilySource, parseTavilyJson } from '../../src/sources/tavily.ts'
import { jsonBody, never, scriptedHttp, sourceRequest } from './helpers.ts'

const answer = JSON.stringify({
  query: 'abort fetch timeout',
  answer: null,
  results: [
    {
      title: 'AbortSignal: timeout() static method',
      url: 'https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static',
      content: 'The AbortSignal.timeout() static method returns an AbortSignal.',
      score: 0.91,
      raw_content: null,
    },
    {
      title: 'News item',
      url: 'https://news.example.com/item',
      content: 'Something happened.',
      score: 0.5,
      published_date: 'Tue, 14 Jan 2025 17:15:24 GMT',
    },
    { title: 'no url', content: 'x' },
  ],
  response_time: 1.2,
})

describe('parseTavilyJson', () => {
  it('reads results and both date formats', () => {
    expect(parseTavilyJson(answer)).toEqual([
      {
        url: 'https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static',
        title: 'AbortSignal: timeout() static method',
        passages: ['The AbortSignal.timeout() static method returns an AbortSignal.'],
      },
      {
        url: 'https://news.example.com/item',
        title: 'News item',
        passages: ['Something happened.'],
        published: '2025-01-14',
      },
    ])
  })

  it('reads an exhausted keyless allowance as rate_limited, not as zero results', () => {
    const body = JSON.stringify({
      detail: { error: 'Keyless usage limit reached. Sign up for a free API key to continue.' },
    })
    expect(() => parseTavilyJson(body)).toThrowError(
      expect.objectContaining({ code: 'rate_limited' }),
    )
  })

  it('refuses unknown shapes', () => {
    expect(() => parseTavilyJson('{"query":"x"}')).toThrowError(
      expect.objectContaining({ code: 'parse_failed' }),
    )
    expect(() => parseTavilyJson('[]')).toThrowError(
      expect.objectContaining({ code: 'parse_failed' }),
    )
  })
})

describe('createTavilySource', () => {
  it('without a key uses the documented keyless header and no authorization', async () => {
    const { http, requests } = scriptedHttp(() => ({ body: answer }))
    const source = createTavilySource({ http, apiKey: undefined })
    const hits = await source.search(sourceRequest({ maxResults: 30 }), never)

    expect(hits).toHaveLength(2)
    expect(source.free()).toBe(true)
    expect(source.unitCostUsd?.()).toBe(0)
    expect(requests[0]?.url).toBe('https://api.tavily.com/search')
    expect(requests[0]?.headers).toEqual({
      'x-tavily-access-mode': 'keyless',
      accept: 'application/json',
    })
    expect(requests[0]?.quotaStatuses).toEqual([432, 433])
    expect(jsonBody(requests[0])).toEqual({
      query: 'abort fetch timeout',
      search_depth: 'basic',
      max_results: 20,
      include_answer: false,
      include_raw_content: false,
    })
  })

  it('with a key authenticates with Bearer and filters natively', async () => {
    const { http, requests } = scriptedHttp(() => ({ body: answer }))
    const source = createTavilySource({ http, apiKey: 'tvly-key' })
    await source.search(sourceRequest({ sites: ['nodejs.org'], recency: 'week' }), never)

    expect(source.free()).toBe(false)
    expect(source.nativeFilters?.()).toBe(true)
    expect(source.unitCostUsd?.()).toBe(0.008)
    expect(requests[0]?.headers).toEqual({
      authorization: 'Bearer tvly-key',
      accept: 'application/json',
    })
    expect(jsonBody(requests[0])).toMatchObject({
      include_domains: ['nodejs.org'],
      time_range: 'week',
    })
  })
})
