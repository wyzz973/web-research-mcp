import { describe, expect, it } from 'vitest'
import { WebError } from '../../src/errors.ts'
import { createApiHttp, parseRetryAfter, type FetchFunction } from '../../src/net/api-http.ts'

const never = new AbortController().signal
const request = { url: 'https://api.example.test/search', method: 'POST', json: { q: 1 } } as const

function respond(status: number, body = '', headers: Record<string, string> = {}): FetchFunction {
  return () => Promise.resolve(new Response(status === 204 ? null : body, { status, headers }))
}

/** A body that reports when the consumer gives up on it. */
function trackedStream(chunks: string[], keepOpen = false) {
  const state = { cancelled: false }
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk))
      if (!keepOpen) controller.close()
    },
    cancel() {
      state.cancelled = true
    },
  })
  return { state, body }
}

async function failure(promise: Promise<unknown>): Promise<WebError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  if (!(error instanceof WebError)) throw new Error('expected a WebError')
  return error
}

describe('createApiHttp', () => {
  it('sends JSON without following redirects and returns the body of a 2xx response', async () => {
    const seen: Array<{ url: string; init: Parameters<FetchFunction>[1] }> = []
    const http = createApiHttp({
      userAgent: 'test-agent/1.0',
      fetch: (url, init) => {
        seen.push({ url, init })
        return Promise.resolve(
          new Response('{"ok":true}', {
            headers: { 'content-type': 'Application/JSON; charset=utf-8' },
          }),
        )
      },
    })
    const response = await http.request({ ...request, headers: { 'x-api-key': 'secret' } }, never)

    expect(response).toEqual({ status: 200, contentType: 'application/json', body: '{"ok":true}' })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.url).toBe(request.url)
    expect(seen[0]?.init.redirect).toBe('manual')
    expect(seen[0]?.init.body).toBe('{"q":1}')
    expect(seen[0]?.init.headers).toEqual({
      'user-agent': 'test-agent/1.0',
      'x-api-key': 'secret',
      'content-type': 'application/json',
    })
  })

  it('maps HTTP 429 to rate_limited and reads retry-after', async () => {
    const http = createApiHttp({
      userAgent: 'ua',
      fetch: respond(429, '', { 'retry-after': '42' }),
    })
    const error = await failure(http.request(request, never))
    expect(error.code).toBe('rate_limited')
    expect(error.retryAfterSeconds).toBe(42)
  })

  it.each([401, 403])('maps HTTP %i to blocked', async (status) => {
    const http = createApiHttp({ userAgent: 'ua', fetch: respond(status) })
    expect((await failure(http.request(request, never))).code).toBe('blocked')
  })

  it.each([400, 404, 500, 503])('maps HTTP %i to upstream_error', async (status) => {
    const http = createApiHttp({ userAgent: 'ua', fetch: respond(status) })
    const error = await failure(http.request(request, never))
    expect(error.code).toBe('upstream_error')
    expect(error.message).toContain(String(status))
  })

  it('treats a redirect as a failure instead of following it', async () => {
    const fetch = respond(302, '', { location: 'https://elsewhere.test/' })
    const error = await failure(createApiHttp({ userAgent: 'ua', fetch }).request(request, never))
    expect(error.code).toBe('upstream_error')
    expect(error.message).toContain('redirect')
  })

  it('maps a used-up vendor quota to budget_exhausted, not to a rate limit', async () => {
    const http = createApiHttp({ userAgent: 'ua', fetch: respond(432, '', { 'retry-after': '5' }) })
    const error = await failure(http.request({ ...request, quotaStatuses: [432, 433] }, never))
    expect(error.code).toBe('budget_exhausted')
    expect(error.retryAfterSeconds).toBeUndefined()
    // The same status from a vendor that does not use it this way stays an upstream error.
    expect((await failure(http.request(request, never))).code).toBe('upstream_error')
  })

  it('rejects a body that announces more than the cap', async () => {
    const fetch = respond(200, 'x', { 'content-length': String(3 * 1024 * 1024) })
    const error = await failure(createApiHttp({ userAgent: 'ua', fetch }).request(request, never))
    expect(error.code).toBe('too_large')
  })

  it('releases the connection when the announced length is already over the cap', async () => {
    const { state, body } = trackedStream(['x'], true)
    const http = createApiHttp({
      userAgent: 'ua',
      maxBytes: 1000,
      fetch: () => Promise.resolve(new Response(body, { headers: { 'content-length': '5000' } })),
    })
    expect((await failure(http.request(request, never))).code).toBe('too_large')
    expect(state.cancelled).toBe(true)
  })

  it('turns a malformed request URL into a WebError instead of a TypeError', async () => {
    const http = createApiHttp({ userAgent: 'ua', fetch: respond(200, 'never used') })
    const error = await failure(http.request({ url: 'not a url', method: 'GET' }, never))
    expect(error.code).toBe('internal')
  })

  it('stops reading once the cap is exceeded and releases the stream', async () => {
    const { state, body } = trackedStream(['a'.repeat(600), 'b'.repeat(600)], true)
    const http = createApiHttp({
      userAgent: 'ua',
      maxBytes: 1000,
      fetch: () => Promise.resolve(new Response(body)),
    })
    expect((await failure(http.request(request, never))).code).toBe('too_large')
    expect(state.cancelled).toBe(true)
  })

  it('returns an event stream as soon as the caller has what it needs', async () => {
    const { state, body } = trackedStream(['data: one\n\n', 'data: two\n\n'], true)
    const http = createApiHttp({
      userAgent: 'ua',
      fetch: () =>
        Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } })),
    })
    const response = await http.request(
      { ...request, streamComplete: (text) => text.includes('two') },
      never,
    )
    expect(response.body).toBe('data: one\n\ndata: two\n\n')
    expect(state.cancelled).toBe(true)
  })

  it('shows every event block exactly once, even when a separator straddles two chunks', async () => {
    const { body } = trackedStream(['data: one\n', '\ndata: tw', 'o\r\n', '\r\ndata: three\n\n'])
    const blocks: string[] = []
    const http = createApiHttp({
      userAgent: 'ua',
      fetch: () =>
        Promise.resolve(new Response(body, { headers: { 'content-type': 'text/event-stream' } })),
    })
    await http.request({ ...request, streamComplete: (block) => blocks.push(block) < 0 }, never)
    expect(blocks).toEqual(['data: one', 'data: two', 'data: three'])
  })

  it('ignores streamComplete for bodies that are not event streams', async () => {
    const http = createApiHttp({ userAgent: 'ua', fetch: respond(200, 'abcdef') })
    const response = await http.request({ ...request, streamComplete: () => true }, never)
    expect(response.body).toBe('abcdef')
  })

  it('aborts the real request when its own deadline passes', async () => {
    let signal: AbortSignal | undefined
    const http = createApiHttp({
      userAgent: 'ua',
      timeoutMs: 20,
      fetch: (_url, init) => {
        signal = init.signal
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () => reject(init.signal.reason as Error))
        })
      },
    })
    const error = await failure(http.request(request, never))
    expect(error.code).toBe('timeout')
    expect(signal?.aborted).toBe(true)
  })

  it('passes a caller abort through to the request and reports cancelled', async () => {
    const controller = new AbortController()
    const http = createApiHttp({
      userAgent: 'ua',
      fetch: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
          controller.abort()
        }),
    })
    expect((await failure(http.request(request, controller.signal))).code).toBe('cancelled')
  })

  it('keeps the reason when the caller aborts with a WebError', async () => {
    const controller = new AbortController()
    controller.abort(new WebError('timeout', 'search deadline'))
    const http = createApiHttp({ userAgent: 'ua', fetch: respond(200, 'never used') })
    const error = await failure(http.request(request, controller.signal))
    expect(error.message).toBe('search deadline')
  })

  it('reports a network failure with its system code and nothing else', async () => {
    const http = createApiHttp({
      userAgent: 'ua',
      fetch: () =>
        Promise.reject(
          new TypeError('fetch failed', { cause: { code: 'ECONNRESET', secret: 'x' } }),
        ),
    })
    const error = await failure(http.request(request, never))
    expect(error.code).toBe('upstream_error')
    expect(error.message).toBe('Could not reach api.example.test (ECONNRESET).')
  })
})

describe('parseRetryAfter', () => {
  const now = new Date('2026-09-21T00:00:00Z')

  it('reads delta seconds and HTTP dates', () => {
    expect(parseRetryAfter('30', now)).toBe(30)
    expect(parseRetryAfter('Mon, 21 Sep 2026 00:02:00 GMT', now)).toBe(120)
  })

  it('bounds the value and ignores garbage', () => {
    expect(parseRetryAfter('0', now)).toBe(1)
    expect(parseRetryAfter('999999999', now)).toBe(24 * 3600)
    expect(parseRetryAfter('Mon, 21 Sep 2020 00:00:00 GMT', now)).toBe(1)
    expect(parseRetryAfter('soon', now)).toBeUndefined()
    expect(parseRetryAfter(null, now)).toBeUndefined()
  })
})
