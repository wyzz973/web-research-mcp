import { describe, expect, it } from 'vitest'
import { createParallelSource, parseParallelJson } from '../../src/sources/parallel.ts'
import {
  failure,
  fixture,
  jsonBody,
  never,
  scriptedHttp,
  sourceRequest,
  toolResult,
} from './helpers.ts'

const hostedJson = fixture('parallel-mcp-abortcontroller.json')

describe('parseParallelJson', () => {
  const hits = parseParallelJson(hostedJson)

  it('reads every result of the recorded hosted-MCP answer', () => {
    expect(hits).toHaveLength(10)
    expect(hits[0]).toMatchObject({
      url: 'https://github.com/node-fetch/node-fetch/blob/main/README.md',
      title: 'node-fetch/README.md at main · node-fetch/node-fetch · GitHub',
    })
    expect(hits[0]?.passages[0]).toMatch(/^Request cancellation with AbortSignal\n/u)
  })

  it('reports a date only where the source gave one', () => {
    expect(hits[0]).not.toHaveProperty('published')
    expect(hits.find((hit) => hit.url.includes('issues/523'))?.published).toBe('2018-09-20')
  })

  it('reads prose answers as vendor failures, never as zero results', () => {
    expect(() => parseParallelJson('Rate limit exceeded, slow down.')).toThrowError(
      expect.objectContaining({ code: 'rate_limited' }),
    )
    expect(() => parseParallelJson('Something went wrong')).toThrowError(
      expect.objectContaining({ code: 'upstream_error' }),
    )
    expect(() => parseParallelJson('{"search_id":"x"}')).toThrowError(
      expect.objectContaining({ code: 'parse_failed' }),
    )
  })

  it('accepts a confirmed empty list', () => {
    expect(parseParallelJson('{"search_id":"x","results":[]}')).toEqual([])
  })
})

describe('createParallelSource', () => {
  it('without a key sends all queries in one hosted MCP call', async () => {
    const { http, requests } = scriptedHttp(() => ({ body: toolResult(hostedJson) }))
    const source = createParallelSource({ http, apiKey: undefined })
    const queries = ['abort fetch timeout', 'AbortSignal.timeout node']
    const hits = await source.search(sourceRequest({ queries }), never)

    expect(hits).toHaveLength(10)
    expect(source.maxQueriesPerCall).toBe(5)
    expect(source.free()).toBe(true)
    expect(source.nativeFilters?.()).toBe(false)
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe('https://search.parallel.ai/mcp')
    expect(jsonBody(requests[0]).params).toEqual({
      name: 'web_search',
      arguments: {
        objective: 'abort fetch timeout; AbortSignal.timeout node',
        search_queries: queries,
      },
    })
  })

  it('prefers the goal as the objective and adds the restrictions as hints', async () => {
    const { http, requests } = scriptedHttp(() => ({ body: toolResult(hostedJson) }))
    await createParallelSource({ http, apiKey: undefined }).search(
      sourceRequest({ goal: 'how to cancel', sites: ['mdn.dev', 'nodejs.org'] }),
      never,
    )
    const params = jsonBody(requests[0]).params as { arguments: { objective: string } }
    expect(params.arguments.objective).toBe(
      'how to cancel Only include results from: mdn.dev, nodejs.org.',
    )
  })

  it('with a key calls the REST API with a pinned mode and native filters', async () => {
    const { http, requests } = scriptedHttp(() => ({ body: hostedJson }))
    const source = createParallelSource({ http, apiKey: 'parallel-key' })
    await source.search(
      sourceRequest({ sites: ['nodejs.org'], recency: 'year', maxResults: 50 }),
      never,
    )

    expect(source.free()).toBe(false)
    expect(source.unitCostUsd?.()).toBe(0.005)
    expect(requests[0]).toMatchObject({
      url: 'https://api.parallel.ai/v1/search',
      headers: { 'x-api-key': 'parallel-key' },
    })
    expect(jsonBody(requests[0])).toEqual({
      objective: 'abort fetch timeout',
      search_queries: ['abort fetch timeout'],
      mode: 'basic',
      advanced_settings: {
        max_results: 20,
        source_policy: { include_domains: ['nodejs.org'], after_date: '2025-09-20' },
      },
    })
  })

  it('omits the source policy when nothing is restricted', async () => {
    const { http, requests } = scriptedHttp(() => ({ body: hostedJson }))
    await createParallelSource({ http, apiKey: 'k' }).search(sourceRequest(), never)
    expect(jsonBody(requests[0]).advanced_settings).toEqual({ max_results: 15 })
  })

  it('classifies a hosted tool error', async () => {
    const { http } = scriptedHttp(() => ({ body: toolResult('Too many requests', true) }))
    const source = createParallelSource({ http, apiKey: undefined })
    expect((await failure(source.search(sourceRequest(), never))).code).toBe('rate_limited')
  })
})
