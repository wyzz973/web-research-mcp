import { describe, expect, it } from 'vitest'
import { createExaSource, parseExaJson, parseExaText } from '../../src/sources/exa.ts'
import {
  failure,
  fixture,
  jsonBody,
  never,
  scriptedHttp,
  sourceRequest,
  toolResult,
} from './helpers.ts'

const hostedText = fixture('exa-mcp-abortcontroller.txt')

describe('parseExaText', () => {
  const hits = parseExaText(hostedText)

  it('reads every block of the recorded hosted-MCP answer', () => {
    expect(hits.map((hit) => hit.url)).toEqual([
      'https://realcoding.blog/en/2026/02/02/nodejs-abortcontroller-fetch-timeout/',
      'https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static',
      'https://older-posts.simonplend.com/how-to-cancel-an-http-request-in-node-js/',
      'https://stitchapi.dev/blog/fetch-timeout-typescript',
      'https://blog.appsignal.com/2025/02/12/managing-asynchronous-operations-in-nodejs-with-abortcontroller.html',
    ])
    expect(hits.map((hit) => hit.published)).toEqual([
      '2026-02-02',
      '2026-09-01',
      '2021-10-20',
      '2026-06-29',
      '2025-02-12',
    ])
  })

  it('keeps titles on one line, even after an author field that spans lines', () => {
    expect(hits[1]?.title).toBe('AbortSignal: timeout() static method - Web APIs | MDN')
    expect(hits[2]?.title).toBe('How to cancel an HTTP request in Node.js - Simon Plenderleith')
    expect(hits[2]?.passages[0]).toMatch(/^Fortunately there’s a JavaScript API/u)
  })

  it('splits highlights into verbatim passages at the "..." lines', () => {
    const mdn = hits[1]?.passages ?? []
    expect(mdn[0]).toBe(
      'The `AbortSignal.timeout()` static method returns an `AbortSignal` that will automatically abort after a specified time.',
    )
    expect(mdn[1]).toBe('The signal aborts with a `TimeoutError` `DOMException` on timeout.')
    expect(mdn.every((passage) => !/^\.\.\.$/mu.test(passage))).toBe(true)
    expect(mdn.at(-1)).toContain(
      'const res = await fetch(url, { signal: AbortSignal.timeout(5000) });',
    )
    for (const passage of mdn) expect(hostedText).toContain(passage)
  })

  it('reads "Text:" bodies and placeholder fields', () => {
    const [hit] = parseExaText(
      'Title: N/A\nURL: https://example.com/a\nPublished: N/A\nAuthor: N/A\nText: Body text.',
    )
    expect(hit).toEqual({ url: 'https://example.com/a', title: '', passages: ['Body text.'] })
  })

  it('does not split a block at a horizontal rule inside the highlights', () => {
    const text =
      'Title: One\nURL: https://example.com/1\nHighlights:\nbefore\n\n---\n\nafter\n\n---\n\nTitle: Two\nURL: https://example.com/2\nHighlights:\nsecond'
    const parsed = parseExaText(text)
    expect(parsed.map((hit) => hit.url)).toEqual(['https://example.com/1', 'https://example.com/2'])
    expect(parsed[0]?.passages[0]).toContain('after')
  })

  it('treats a "no results" sentence as a confirmed empty answer', () => {
    expect(parseExaText('No search results found. Please try a different query.')).toEqual([])
    expect(parseExaText('')).toEqual([])
  })

  it('refuses an unknown format instead of reporting zero results', () => {
    expect(() => parseExaText('<html><body>Service unavailable</body></html>')).toThrowError(
      expect.objectContaining({ code: 'parse_failed' }),
    )
  })
})

describe('parseExaJson', () => {
  it('reads highlights and dates from the REST response', () => {
    const body = JSON.stringify({
      requestId: 'r',
      results: [
        {
          title: ' A  title ',
          url: 'https://example.com/a',
          publishedDate: '2023-11-16T01:36:32.547Z',
          author: 'x',
          highlights: ['first', '', 'second'],
        },
        { title: 'text only', url: 'https://example.com/b', text: 'page text' },
        { title: 'no url' },
      ],
      costDollars: { total: 0.007 },
    })
    expect(parseExaJson(body)).toEqual([
      {
        url: 'https://example.com/a',
        title: 'A title',
        passages: ['first', 'second'],
        published: '2023-11-16',
      },
      { url: 'https://example.com/b', title: 'text only', passages: ['page text'] },
    ])
  })

  it('refuses a body without a results list', () => {
    expect(() => parseExaJson('{"error":"nope"}')).toThrowError(
      expect.objectContaining({ code: 'parse_failed' }),
    )
    expect(() => parseExaJson('not json')).toThrowError(
      expect.objectContaining({ code: 'parse_failed' }),
    )
  })
})

describe('createExaSource', () => {
  it('without a key calls the hosted MCP tool with the query as the objective', async () => {
    const { http, requests } = scriptedHttp(() => ({ body: toolResult(hostedText) }))
    const source = createExaSource({ http, apiKey: undefined })
    const hits = await source.search(sourceRequest({ maxResults: 40 }), never)

    expect(hits).toHaveLength(5)
    expect(source.free()).toBe(true)
    expect(source.nativeFilters?.()).toBe(false)
    expect(source.unitCostUsd?.()).toBe(0)
    expect(requests[0]?.url).toBe('https://mcp.exa.ai/mcp')
    expect(jsonBody(requests[0]).params).toEqual({
      name: 'web_search_exa',
      arguments: {
        query: 'abort fetch timeout',
        objective: 'abort fetch timeout',
        numResults: 25,
      },
    })
  })

  it('states the goal, sites and recency in the objective of the anonymous tier', async () => {
    const { http, requests } = scriptedHttp(() => ({ body: toolResult(hostedText) }))
    const source = createExaSource({ http, apiKey: undefined })
    await source.search(
      sourceRequest({ goal: 'official docs', sites: ['nodejs.org'], recency: 'week' }),
      never,
    )
    const params = jsonBody(requests[0]).params as { arguments: { objective: string } }
    expect(params.arguments.objective).toBe(
      'official docs Only include results from: nodejs.org. Only include content published or updated since 2026-09-14.',
    )
  })

  it('with a key calls the REST API with native filters and highlights only', async () => {
    const { http, requests } = scriptedHttp(() => ({ body: '{"results":[]}' }))
    const source = createExaSource({ http, apiKey: 'exa-key' })
    const hits = await source.search(
      sourceRequest({ goal: 'official docs', sites: ['nodejs.org'], recency: 'month' }),
      never,
    )

    expect(hits).toEqual([])
    expect(source.free()).toBe(false)
    expect(source.nativeFilters?.()).toBe(true)
    expect(source.unitCostUsd?.()).toBe(0.007)
    expect(requests[0]).toMatchObject({
      url: 'https://api.exa.ai/search',
      method: 'POST',
      headers: { 'x-api-key': 'exa-key' },
      quotaStatuses: [402],
    })
    expect(jsonBody(requests[0])).toEqual({
      query: 'abort fetch timeout',
      type: 'auto',
      numResults: 15,
      contents: { highlights: { maxCharacters: 2000, query: 'official docs' } },
      includeDomains: ['nodejs.org'],
      startPublishedDate: '2026-08-21T12:00:00.000Z',
    })
  })

  it('lets transport failures through unchanged', async () => {
    const { WebError } = await import('../../src/errors.ts')
    const { http } = scriptedHttp(() => new WebError('rate_limited', 'slow down', 17))
    const error = await failure(
      createExaSource({ http, apiKey: undefined }).search(sourceRequest(), never),
    )
    expect(error.code).toBe('rate_limited')
    expect(error.retryAfterSeconds).toBe(17)
  })
})
