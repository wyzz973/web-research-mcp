import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createSearxngProvider } from '../src/search/searxng.ts'
import type { SearchPageRequest } from '../src/shared/types.ts'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanup.reverse()) await close()
  cleanup.length = 0
})

async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  timeoutMs = 1000,
) {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (typeof address !== 'object' || address === null) throw new Error('Missing server address')
  cleanup.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  })
  const provider = createSearxngProvider({
    baseUrl: `http://127.0.0.1:${address.port}`,
    engines: ['duckduckgo', 'bing'],
    timeoutMs,
  })
  cleanup.push(() => provider.close())
  return provider
}

const input: SearchPageRequest = { query: 'MCP tools', language: 'en', timeRange: 'any', page: 1 }
const row = {
  title: 'MCP tools',
  url: 'https://example.com/?q=one&utm_source=ad#main',
  content: 'Search summary',
  engines: ['duckduckgo'],
}

describe('SearXNG provider', () => {
  it('uses the fixed engines and site branch without changing query text', async () => {
    let seen: URL | undefined
    const provider = await fixture((request, response) => {
      seen = new URL(request.url ?? '/', 'http://localhost')
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ results: [row], unresponsive_engines: [] }))
    })
    const page = await provider.searchPage(
      {
        ...input,
        query: 'exact "MCP tools" site:other.com',
        site: 'example.com',
        page: 2,
        timeRange: 'year',
      },
      new AbortController().signal,
    )
    expect(seen?.pathname).toBe('/search')
    expect(seen?.searchParams.get('q')).toBe('exact "MCP tools" site:other.com site:example.com')
    expect(seen?.searchParams.get('engines')).toBe('duckduckgo,bing')
    expect(seen?.searchParams.has('categories')).toBe(false)
    expect(seen?.searchParams.get('pageno')).toBe('2')
    expect(seen?.searchParams.get('time_range')).toBe('year')
    expect(page.sources[0]?.url).toBe('https://example.com/?q=one')
    expect(page.sources[0]?.snippet).toBe('Search summary')
    expect(page.exhausted).toBe(false)
  })
  it.each([
    '',
    'query !google',
    'query !!g',
    '!! query',
    'query :fr',
    'query <9000',
    'query\u001c!images',
    'query\u0085!images',
  ])('rejects control query %j before HTTP', async (query) => {
    let requests = 0
    const provider = await fixture((_request, response) => {
      requests += 1
      response.end()
    })
    await expect(
      provider.searchPage({ ...input, query }, new AbortController().signal),
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
    expect(requests).toBe(0)
  })
  it('returns genuine empty pages and preserves partial engine errors', async () => {
    let count = 0
    const provider = await fixture((_request, response) => {
      count += 1
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(
          JSON.stringify(
            count === 1
              ? { results: [], unresponsive_engines: [] }
              : { results: [row], unresponsive_engines: [['bing', 'CAPTCHA']] },
          ),
        )
    })
    expect(await provider.searchPage(input, new AbortController().signal)).toEqual({
      sources: [],
      errors: [],
      exhausted: true,
    })
    expect((await provider.searchPage(input, new AbortController().signal)).errors).toEqual([
      'UPSTREAM_BLOCKED: bing',
    ])
  })
  it.each([
    [{ results: [], unresponsive_engines: [['bing', 'CAPTCHA']] }, 'UPSTREAM_BLOCKED'],
    [{ results: [], unresponsive_engines: [['bing', 'timeout']] }, 'TIMEOUT'],
    [
      { results: [], unresponsive_engines: [['bing', 'connection failure']] },
      'UPSTREAM_UNAVAILABLE',
    ],
    [{ results: [{ ...row, engines: ['paid-api'] }] }, 'UPSTREAM_UNAVAILABLE'],
    [{ nope: [] }, 'UPSTREAM_UNAVAILABLE'],
  ])('does not disguise upstream failure as empty', async (payload, code) => {
    const provider = await fixture((_request, response) =>
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload)),
    )
    await expect(provider.searchPage(input, new AbortController().signal)).rejects.toMatchObject({
      code,
    })
  })
  it.each([
    [403, 'application/json', '{}', 'UPSTREAM_BLOCKED'],
    [429, 'text/html', '<h1>Limit</h1>', 'UPSTREAM_BLOCKED'],
    [200, 'text/html', '<h1>Challenge</h1>', 'UPSTREAM_BLOCKED'],
    [200, 'application/json', 'broken json', 'UPSTREAM_UNAVAILABLE'],
    [503, 'application/json', '{}', 'UPSTREAM_UNAVAILABLE'],
  ])('classifies HTTP/content failure %s %s', async (status, contentType, body, code) => {
    const provider = await fixture((_request, response) =>
      response.writeHead(status, { 'content-type': contentType }).end(body),
    )
    await expect(provider.searchPage(input, new AbortController().signal)).rejects.toMatchObject({
      code,
    })
  })
  it('never follows a redirect and enforces response bytes', async () => {
    let requests = 0
    const provider = await fixture((_request, response) => {
      requests += 1
      if (requests === 1) response.writeHead(302, { location: '/secret' }).end()
      else
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end(' '.repeat(2 * 1024 * 1024 + 1))
    })
    await expect(provider.searchPage(input, new AbortController().signal)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    })
    expect(requests).toBe(1)
    await expect(provider.searchPage(input, new AbortController().signal)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    })
    expect(requests).toBe(2)
  })
  it('cancels timed-out I/O and distinguishes caller cancellation', async () => {
    const provider = await fixture(() => {}, 30)
    await expect(provider.searchPage(input, new AbortController().signal)).rejects.toMatchObject({
      code: 'TIMEOUT',
    })
    const controller = new AbortController()
    const pending = provider.searchPage(input, controller.signal)
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
  })
  it('close aborts active I/O and rejects new requests', async () => {
    const provider = await fixture(() => {})
    const pending = provider.searchPage(input, new AbortController().signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    await provider.close()
    await rejected
    await expect(provider.searchPage(input, new AbortController().signal)).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    })
  })
  it('rejects arbitrary engines and credentials at configuration time', () => {
    for (const engines of [[], ['tavily'], ['braveapi']]) {
      expect(() =>
        createSearxngProvider({ baseUrl: 'http://127.0.0.1:8080', engines, timeoutMs: 1000 }),
      ).toThrow()
    }
    expect(() =>
      createSearxngProvider({
        baseUrl: 'https://user:key@example.com',
        engines: ['bing'],
        timeoutMs: 1000,
      }),
    ).toThrow()
  })
})
