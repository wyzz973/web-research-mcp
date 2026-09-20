/**
 * The real undici transport against a loopback server: what the offline fakes cannot show is that
 * an abort reaches the socket, that a redirect is not followed, and that `close()` lets go.
 */
import { readFileSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebError } from '../../src/errors.ts'
import { createApiHttp, type ApiHttpClient } from '../../src/net/api-http.ts'
import { parseExaText } from '../../src/sources/exa.ts'
import { callHostedTool } from '../../src/sources/hosted-mcp.ts'

const never = new AbortController().signal
const seen: string[] = []
let closedEarly = 0
let server: Server
let origin = ''
let client: ApiHttpClient | undefined

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = ''
    request.on('data', (chunk: Buffer) => (body += chunk.toString('utf8')))
    request.on('end', () => resolve(body))
  })
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  seen.push(`${request.method} ${request.url}`)
  response.on('close', () => {
    if (!response.writableFinished) closedEarly += 1
  })
  if (request.url === '/echo') {
    const body = await readBody(request)
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ headers: request.headers, body }))
  } else if (request.url === '/redirect') {
    response.writeHead(302, { location: '/echo' }).end()
  } else if (request.url === '/big') {
    response.writeHead(200, { 'content-type': 'text/plain' })
    const chunk = 'x'.repeat(64 * 1024)
    for (let sent = 0; sent < 48 && !response.destroyed; sent += 1) response.write(chunk)
    response.end()
  } else if (request.url === '/recorded-exa') {
    // The recorded Exa answer, cut at awkward places, on a stream that is never closed.
    const recorded = readFileSync(
      new URL('../fixtures/sources/exa-mcp-http-body.sse.txt', import.meta.url),
    )
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const cuts = [0, 7, 30_001, recorded.length - 1, recorded.length]
    for (let index = 1; index < cuts.length; index += 1)
      response.write(recorded.subarray(cuts[index - 1], cuts[index]))
  } else if (request.url === '/sse') {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    response.write('data: {"done":true}\n\n')
    // Left open on purpose, as a streaming server may do.
  }
  // '/slow' never answers.
}

beforeAll(async () => {
  // A proxy configured on the developer's machine must not sit between the test and loopback.
  for (const name of ['HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy'])
    vi.stubEnv(name, '')
  server = createServer((request, response) => void handle(request, response))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterEach(async () => {
  await client?.close()
  client = undefined
  seen.length = 0
  closedEarly = 0
})

afterAll(async () => {
  vi.unstubAllEnvs()
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

async function failure(promise: Promise<unknown>): Promise<WebError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  if (!(error instanceof WebError)) throw new Error('expected a WebError')
  return error
}

async function eventually(condition: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 100 && !condition(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10))
  expect(condition()).toBe(true)
}

describe('createApiHttp over a real connection', () => {
  it('posts JSON with our user agent and the caller headers', async () => {
    client = createApiHttp({ userAgent: 'web-research-test/1.0' })
    const response = await client.request(
      { url: `${origin}/echo`, method: 'POST', headers: { 'x-api-key': 'k' }, json: { q: 'é' } },
      never,
    )
    const echoed = JSON.parse(response.body) as { headers: Record<string, string>; body: string }
    expect(response.contentType).toBe('application/json')
    expect(echoed.body).toBe('{"q":"é"}')
    expect(echoed.headers).toMatchObject({
      'user-agent': 'web-research-test/1.0',
      'content-type': 'application/json',
      'x-api-key': 'k',
    })
  })

  it('does not follow a redirect', async () => {
    client = createApiHttp({ userAgent: 'ua' })
    const error = await failure(client.request({ url: `${origin}/redirect`, method: 'GET' }, never))
    expect(error.code).toBe('upstream_error')
    expect(seen).toEqual(['GET /redirect'])
  })

  it('closes the connection when its deadline passes', async () => {
    client = createApiHttp({ userAgent: 'ua', timeoutMs: 100 })
    const error = await failure(client.request({ url: `${origin}/slow`, method: 'GET' }, never))
    expect(error.code).toBe('timeout')
    await eventually(() => closedEarly === 1)
  })

  it('closes the connection when the caller aborts', async () => {
    client = createApiHttp({ userAgent: 'ua' })
    const controller = new AbortController()
    const pending = failure(
      client.request({ url: `${origin}/slow`, method: 'GET' }, controller.signal),
    )
    await eventually(() => seen.length === 1)
    controller.abort()
    expect((await pending).code).toBe('cancelled')
    await eventually(() => closedEarly === 1)
  })

  it('stops downloading a body that exceeds the cap', async () => {
    client = createApiHttp({ userAgent: 'ua', maxBytes: 256 * 1024 })
    const error = await failure(client.request({ url: `${origin}/big`, method: 'GET' }, never))
    expect(error.code).toBe('too_large')
  })

  it('returns from an event stream that the server keeps open', async () => {
    client = createApiHttp({ userAgent: 'ua', timeoutMs: 2000 })
    const response = await client.request(
      { url: `${origin}/sse`, method: 'GET', streamComplete: (block) => block.includes('done') },
      never,
    )
    expect(response.body).toBe('data: {"done":true}\n\n')
    await eventually(() => closedEarly === 1)
  })

  it('reads a recorded hosted-MCP answer off a chunked stream that stays open', async () => {
    client = createApiHttp({ userAgent: 'ua', timeoutMs: 3000 })
    const started = performance.now()
    const text = await callHostedTool(
      client.request,
      {
        source: 'exa',
        url: `${origin}/recorded-exa`,
        tool: 'web_search_exa',
        args: { query: 'q' },
      },
      never,
    )
    expect(parseExaText(text)).toHaveLength(15)
    // It returned because the answer was complete, not because the deadline cut the stream.
    expect(performance.now() - started).toBeLessThan(2000)
  })

  it('reports an unreachable host as upstream_error with the system code', async () => {
    // A port that was just released: nothing listens there.
    const spare = createServer()
    await new Promise<void>((resolve) => spare.listen(0, '127.0.0.1', resolve))
    const { port } = spare.address() as AddressInfo
    await new Promise<void>((resolve) => spare.close(() => resolve()))

    client = createApiHttp({ userAgent: 'ua' })
    const url = `http://127.0.0.1:${port}/`
    const error = await failure(client.request({ url, method: 'GET' }, never))
    expect(error).toMatchObject({
      code: 'upstream_error',
      message: `Could not reach 127.0.0.1:${port} (ECONNREFUSED).`,
    })
  })
})
