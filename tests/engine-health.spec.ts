import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import { createSearxngProvider } from '../src/search/searxng.ts'
import type { SearchPageRequest } from '../src/shared/types.ts'

const disposers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const dispose of disposers.reverse()) await dispose()
  disposers.length = 0
})
const input: SearchPageRequest = { query: 'MCP tools', language: 'en', timeRange: 'any', page: 1 }
const signal = () => new AbortController().signal
const row = {
  title: 'Tools',
  url: 'https://example.com/tools',
  content: 'MCP tools',
  engines: ['google'],
}
function send(response: ServerResponse, payload: unknown) {
  response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload))
}
async function fixture(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
  engines = ['google', 'brave'],
) {
  let time = Date.parse('2026-09-10T00:00:00.000Z')
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('No server address')
  disposers.push(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    )
  })
  const provider = createSearxngProvider({
    baseUrl: `http://127.0.0.1:${address.port}`,
    engines,
    timeoutMs: 1000,
    now: () => time,
  })
  disposers.push(() => provider.close())
  return {
    provider,
    advance: (ms: number) => {
      time += ms
    },
  }
}

describe('engine health and recovery', () => {
  it('keeps useful results and skips only the engine reporting CAPTCHA on later requests', async () => {
    const requested: string[] = []
    const { provider } = await fixture((request, response) => {
      requested.push(new URL(request.url ?? '/', 'http://local').searchParams.get('engines') ?? '')
      send(response, {
        results: [row],
        unresponsive_engines: requested.length === 1 ? [['brave', 'CAPTCHA', true]] : [],
      })
    })
    expect(provider.inspect().status).toBe('idle')
    const first = await provider.searchPage(input, signal())
    expect(first.sources).toHaveLength(1)
    expect(first.errors).toEqual(['UPSTREAM_BLOCKED: brave'])
    expect(provider.inspect()).toMatchObject({
      status: 'degraded',
      engines: [
        { engine: 'google', status: 'healthy', observation: 'results', elapsed_ms: null },
        {
          engine: 'brave',
          status: 'cooling_down',
          last_error: 'UPSTREAM_BLOCKED',
          suspended: true,
          retry_after_ms: 300000,
          failed_responses: 1,
        },
      ],
    })
    const next = await provider.searchPage(input, signal())
    expect(requested).toEqual(['google,brave', 'google'])
    expect(next.errors).toEqual(['UPSTREAM_UNAVAILABLE: brave (cooling_down_or_probe_in_flight)'])
    expect(provider.inspect().endpoint.last_elapsed_ms).toBeTypeOf('number')
  })

  it('never returns an empty success when all engines are blocked and does not issue requests during cooldown', async () => {
    let calls = 0
    const { provider } = await fixture((_request, response) => {
      calls += 1
      send(response, {
        results: [],
        unresponsive_engines: [
          ['google', 'CAPTCHA'],
          ['brave', '429'],
        ],
      })
    })
    await expect(provider.searchPage(input, signal())).rejects.toMatchObject({
      code: 'UPSTREAM_BLOCKED',
    })
    await expect(provider.searchPage(input, signal())).rejects.toMatchObject({
      code: 'UPSTREAM_BLOCKED',
    })
    expect(calls).toBe(1)
    expect(provider.inspect().status).toBe('unavailable')
  })

  it('admits only one half-open probe and closes the circuit on an explicit no-error response', async () => {
    let calls = 0
    let pending: ServerResponse | undefined
    let entered: (() => void) | undefined
    const probeEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const { provider, advance } = await fixture(
      (_request, response) => {
        calls += 1
        if (calls === 1)
          send(response, { results: [], unresponsive_engines: [['google', 'timeout', false]] })
        else {
          pending = response
          entered?.()
        }
      },
      ['google'],
    )
    await expect(provider.searchPage(input, signal())).rejects.toMatchObject({ code: 'TIMEOUT' })
    advance(30000)
    expect(provider.inspect().engines[0]?.status).toBe('half_open')
    const probe = provider.searchPage(input, signal())
    await probeEntered
    await expect(provider.searchPage(input, signal())).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
    })
    expect(provider.inspect().engines[0]?.probe_in_flight).toBe(true)
    if (!pending) throw new Error('Missing probe')
    send(pending, { results: [], unresponsive_engines: [] })
    expect(await probe).toEqual({ sources: [], errors: [], exhausted: true })
    expect(provider.inspect().engines[0]).toMatchObject({
      status: 'healthy',
      observation: 'no_error_reported',
      consecutive_failures: 0,
      probe_in_flight: false,
    })
    expect(calls).toBe(2)
  })

  it('uses bounded exponential cooldown and continues respecting upstream suspension', async () => {
    const { provider, advance } = await fixture(
      (_request, response) =>
        send(response, { results: [], unresponsive_engines: [['google', 'CAPTCHA', true]] }),
      ['google'],
    )
    for (const expected of [300000, 600000, 1200000, 1800000, 1800000]) {
      await expect(provider.searchPage(input, signal())).rejects.toMatchObject({
        code: 'UPSTREAM_BLOCKED',
      })
      expect(provider.inspect().engines[0]?.retry_after_ms).toBe(expected)
      advance(expected)
    }
    expect(provider.inspect().engines[0]?.failed_responses).toBe(5)
  })

  it('does not attribute endpoint denial to individual engines', async () => {
    const { provider } = await fixture((_request, response) =>
      response.writeHead(403).end('denied'),
    )
    await expect(provider.searchPage(input, signal())).rejects.toMatchObject({
      code: 'UPSTREAM_BLOCKED',
    })
    const diagnostics = provider.inspect()
    expect(diagnostics).toMatchObject({
      status: 'unavailable',
      endpoint: { failed_requests: 1, last_error: 'UPSTREAM_BLOCKED' },
    })
    expect(
      diagnostics.engines.every(
        (engine) =>
          engine.status === 'unknown' &&
          engine.failed_responses === 0 &&
          engine.elapsed_ms === null,
      ),
    ).toBe(true)
  })

  it('keeps empty responses without engine diagnostics unknown', async () => {
    const { provider } = await fixture((_request, response) => send(response, { results: [] }))
    expect((await provider.searchPage(input, signal())).exhausted).toBe(true)
    expect(provider.inspect().engines.every((engine) => engine.status === 'unknown')).toBe(true)
  })

  it.each([
    [['google', 'timeout', 'yes']],
    [['google', 'timeout', false, 'extra']],
    [['google', 42]],
  ])(
    'rejects malformed suspension tuples without poisoning circuit state: %j',
    async (diagnostics) => {
      const { provider } = await fixture((_request, response) =>
        send(response, { results: [], unresponsive_engines: diagnostics }),
      )
      await expect(provider.searchPage(input, signal())).rejects.toMatchObject({
        code: 'UPSTREAM_UNAVAILABLE',
      })
      expect(provider.inspect().engines.every((engine) => engine.failed_responses === 0)).toBe(true)
    },
  )

  it('does not clear a newer blocked observation when an older request finishes successfully', async () => {
    let first: ServerResponse | undefined
    let entered: (() => void) | undefined
    const firstEntered = new Promise<void>((resolve) => {
      entered = resolve
    })
    const { provider } = await fixture(
      (_request, response) => {
        if (!first) {
          first = response
          entered?.()
        } else send(response, { results: [], unresponsive_engines: [['google', 'CAPTCHA']] })
      },
      ['google'],
    )
    const old = provider.searchPage(input, signal())
    await firstEntered
    await expect(provider.searchPage(input, signal())).rejects.toMatchObject({
      code: 'UPSTREAM_BLOCKED',
    })
    if (!first) throw new Error('Missing response')
    send(first, { results: [row], unresponsive_engines: [] })
    await old
    expect(provider.inspect().engines[0]?.status).toBe('cooling_down')
  })

  it('does not expose mutable state or retain queries in diagnostics', async () => {
    const { provider } = await fixture((_request, response) =>
      send(response, { results: [row], unresponsive_engines: [] }),
    )
    await provider.searchPage(input, signal())
    const diagnostic = provider.inspect()
    if (diagnostic.engines[0]) diagnostic.engines[0].submitted_requests = 999
    diagnostic.endpoint.total_requests = 999
    expect(provider.inspect().endpoint.total_requests).toBe(1)
    expect(provider.inspect().engines[0]?.submitted_requests).toBe(1)
    expect(JSON.stringify(provider.inspect())).not.toContain(input.query)
    await provider.close()
    expect(provider.inspect().status).toBe('closed')
  })

  it('releases a cancelled recovery probe without blaming the engine', async () => {
    let count = 0
    let entered: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => {
      entered = resolve
    })
    const { provider, advance } = await fixture(
      (_request, response) => {
        count += 1
        if (count === 1)
          send(response, { results: [], unresponsive_engines: [['google', 'timeout']] })
        else entered?.()
      },
      ['google'],
    )
    await expect(provider.searchPage(input, signal())).rejects.toMatchObject({ code: 'TIMEOUT' })
    advance(30000)
    const controller = new AbortController()
    const pending = provider.searchPage(input, controller.signal)
    const rejected = expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
    await waiting
    controller.abort()
    await rejected
    expect(provider.inspect().engines[0]).toMatchObject({
      probe_in_flight: false,
      consecutive_failures: 1,
      status: 'half_open',
    })
  })
})
