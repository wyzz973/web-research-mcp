import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createBrowserGateway,
  type BrowserGatewayOptions,
  type BrowserResourceRequest,
} from '../src/fetch/browser-gateway.ts'
import type { FetchDependencies, NetworkResponse } from '../src/fetch/network.ts'
import { resolveScope } from '../src/shared/domain-scope.ts'
import { AppError } from '../src/shared/errors.ts'

const options: BrowserGatewayOptions = {
  initialUrl: 'https://example.com/article',
  deadlineMs: 5000,
  maxCompressedBytes: 6 * 1024 * 1024,
  maxDecompressedBytes: 6 * 1024 * 1024,
  maxRedirects: 5,
  globalConcurrency: 2,
  perHostConcurrency: 1,
  userAgent: 'WebResearchMCP/0.4',
}
const gateways: ReturnType<typeof createBrowserGateway>[] = []
afterEach(async () => {
  await Promise.all(gateways.splice(0).map((g) => g.close()))
})
function response(
  body: string | Buffer = '',
  status = 200,
  headers: Record<string, string> = {},
): NetworkResponse {
  return {
    status,
    headers: { 'content-type': 'text/html', ...headers },
    body: (async function* () {
      yield Buffer.from(body)
    })(),
    close: async () => {},
  }
}
function resource(url = options.initialUrl, type = 'document'): BrowserResourceRequest {
  return { url, resource_type: type, main_frame: true, redirect_depth: 0 }
}
function fixture(
  handler: NonNullable<FetchDependencies['connect']> = async (url) =>
    response(url.pathname === '/robots.txt' ? '' : 'public document'),
  overrides: Partial<BrowserGatewayOptions> = {},
  resolve: FetchDependencies['resolve'] = async () => [{ address: '93.184.216.34', family: 4 }],
  signal = new AbortController().signal,
) {
  const calls: string[] = []
  const gateway = createBrowserGateway(
    { ...options, ...overrides },
    {
      resolve,
      connect: async (url, ...args) => {
        calls.push(url.href)
        return handler(url, ...args)
      },
    },
    resolveScope({ sites: ['example.com'] }),
    signal,
  )
  gateways.push(gateway)
  return { gateway, calls }
}

describe('Crawl4AI anonymous browser resource gateway', () => {
  it.each([
    'http://127.0.0.1/',
    'https://169.254.169.254/',
    'https://[::1]/',
    'file:///etc/passwd',
    'https://user:secret@example.com/',
    'https://example.com:8000/',
    'http://example.com/',
  ])('rejects private, credentialed, non-default and downgrade resources: %s', async (url) => {
    const { gateway, calls } = fixture()
    await expect(gateway.request(resource(url, 'fetch'))).rejects.toMatchObject({
      code: 'FETCH_BLOCKED',
    })
    expect(calls).toEqual([])
  })
  it('applies domain scope to main documents but allows public CDN scripts with their own robots', async () => {
    const { gateway, calls } = fixture()
    await expect(gateway.request(resource('https://cdn.test/page'))).rejects.toMatchObject({
      code: 'FETCH_BLOCKED',
    })
    await expect(
      gateway.request(resource('https://cdn.test/script.js', 'script')),
    ).resolves.toMatchObject({ status: 200 })
    expect(calls).toEqual(['https://cdn.test/robots.txt', 'https://cdn.test/script.js'])
  })
  it.each(['image', 'font', 'media', 'websocket', 'eventsource', 'other'])(
    'does not send unwanted %s requests',
    async (type) => {
      const { gateway, calls } = fixture()
      await expect(
        gateway.request(resource('https://example.com/asset', type)),
      ).rejects.toMatchObject({ code: 'FETCH_BLOCKED' })
      expect(calls).toEqual([])
    },
  )
  it('blocks iframe documents before DNS or robots', async () => {
    const { gateway, calls } = fixture()
    await expect(gateway.request({ ...resource(), main_frame: false })).rejects.toMatchObject({
      code: 'FETCH_BLOCKED',
    })
    expect(calls).toEqual([])
  })
  it('rejects mixed DNS and rechecks after robots to prevent rebinding', async () => {
    let lookups = 0
    const { gateway, calls } = fixture(
      async () => response('', 404),
      {},
      async () => {
        lookups++
        return lookups < 3
          ? [{ address: '93.184.216.34', family: 4 }]
          : [
              { address: '127.0.0.1', family: 4 },
              { address: '93.184.216.34', family: 4 },
            ]
      },
    )
    await expect(gateway.request(resource())).rejects.toMatchObject({ code: 'FETCH_BLOCKED' })
    expect(calls).toEqual(['https://example.com/robots.txt'])
  })
  it('passes the checked address and anonymous user agent to every connection', async () => {
    const seen: string[] = []
    const { gateway } = fixture(async (url, address, _signal, userAgent) => {
      seen.push(`${address.address} ${userAgent}`)
      return response(url.pathname === '/robots.txt' ? '' : 'document')
    })
    await gateway.request(resource())
    expect(seen).toEqual(['93.184.216.34 WebResearchMCP/0.4', '93.184.216.34 WebResearchMCP/0.4'])
  })
  it('keeps MIME and safe CORS headers but removes cookies, encoding and arbitrary headers', async () => {
    const html = Buffer.from('<p>decoded 😀</p>')
    const { gateway } = fixture(async (url) =>
      url.pathname === '/robots.txt'
        ? response('')
        : response(gzipSync(html), 200, {
            'set-cookie': 'private=secret',
            authorization: 'secret',
            'content-encoding': 'gzip',
            'content-length': '999',
            'access-control-allow-origin': '*',
            'content-type': 'text/html; charset=utf-8',
          }),
    )
    const result = await gateway.request(resource())
    expect(Buffer.from(result.body_base64, 'base64')).toEqual(html)
    expect(result.headers).toEqual({
      'content-type': 'text/html; charset=utf-8',
      'access-control-allow-origin': '*',
    })
  })
  it('deduplicates concurrent robots fetches and enforces disallow for XHR', async () => {
    const { gateway, calls } = fixture(async (url) =>
      response(url.pathname === '/robots.txt' ? 'User-agent: *\nDisallow: /private' : 'ok'),
    )
    const results = await Promise.allSettled([
      gateway.request(resource('https://example.com/private', 'xhr')),
      gateway.request(resource('https://example.com/public', 'fetch')),
    ])
    expect(results[0]).toMatchObject({ status: 'rejected', reason: { code: 'ROBOTS_DENIED' } })
    expect(results[1]).toMatchObject({ status: 'fulfilled' })
    expect(calls.filter((url) => url.endsWith('/robots.txt'))).toHaveLength(1)
    expect(calls).not.toContain('https://example.com/private')
  })
  it.each([403, 503])('fails closed when robots returns HTTP %i', async (status) => {
    const { gateway, calls } = fixture(async () => response('', status))
    await expect(gateway.request(resource())).rejects.toMatchObject({ code: 'ROBOTS_DENIED' })
    expect(calls).toHaveLength(1)
  })
  it('does not accept a robots challenge as a permissive policy', async () => {
    const { gateway } = fixture(async () => response('<!doctype html><html>captcha</html>'))
    await expect(gateway.request(resource())).rejects.toMatchObject({ code: 'ROBOTS_DENIED' })
  })
  it('validates robots redirects and never connects to their private target', async () => {
    const { gateway, calls } = fixture(async () =>
      response('', 302, { location: 'https://127.0.0.1/private' }),
    )
    await expect(gateway.request(resource())).rejects.toMatchObject({ code: 'FETCH_BLOCKED' })
    expect(calls).toHaveLength(1)
  })
  it('checks main redirect scope and depth before returning Location to the browser', async () => {
    const { gateway } = fixture(async (url) =>
      url.pathname === '/robots.txt'
        ? response('')
        : response('', 302, { location: 'https://elsewhere.test/' }),
    )
    await expect(gateway.request(resource())).rejects.toMatchObject({ code: 'FETCH_BLOCKED' })
    const within = fixture(async (url) =>
      url.pathname === '/robots.txt' ? response('') : response('', 302, { location: '/next' }),
    )
    await expect(within.gateway.request(resource())).resolves.toMatchObject({
      status: 302,
      headers: { location: 'https://example.com/next' },
      body_base64: '',
    })
    await expect(
      within.gateway.request({ ...resource(), redirect_depth: 5 }),
    ).rejects.toMatchObject({ code: 'FETCH_BLOCKED' })
  })
  it('blocks a public-to-private subresource redirect before fulfilling it', async () => {
    const { gateway, calls } = fixture(async (url) =>
      url.pathname === '/robots.txt'
        ? response('')
        : response('', 302, { location: 'https://127.0.0.1/' }),
    )
    await expect(
      gateway.request(resource('https://cdn.test/script.js', 'script')),
    ).rejects.toMatchObject({ code: 'FETCH_BLOCKED' })
    expect(calls).toHaveLength(2)
  })
  it('records a failed script as blocked instead of a successful empty response', async () => {
    const { gateway } = fixture(async (url) =>
      url.pathname === '/robots.txt' ? response('') : response('', 403),
    )
    await expect(
      gateway.request(resource('https://example.com/script.js', 'script')),
    ).rejects.toMatchObject({ code: 'UPSTREAM_BLOCKED' })
    expect(gateway.inspect()).toMatchObject({ blocked: 1, completed: 0 })
  })
  it('rejects a crawl delay that exceeds the total render deadline', async () => {
    const { gateway, calls } = fixture(async () => response('User-agent: *\nCrawl-delay: 60'))
    await expect(gateway.request(resource())).rejects.toMatchObject({ code: 'ROBOTS_DENIED' })
    expect(calls).toEqual(['https://example.com/robots.txt'])
  })
  it('aborts actual connection waits at the shared render deadline', async () => {
    let closed = false
    const { gateway } = fixture(
      async (_url, _address, signal) => {
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener(
            'abort',
            () => {
              closed = true
              reject(new Error('network aborted'))
            },
            { once: true },
          ),
        )
        return response('')
      },
      { deadlineMs: 20 },
    )
    await expect(gateway.request(resource())).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(closed).toBe(true)
  })
  it('limits decompressed resources even when their compressed payload is tiny', async () => {
    const { gateway } = fixture(async (url) =>
      url.pathname === '/robots.txt'
        ? response('')
        : response(gzipSync(Buffer.alloc(2 * 1024 * 1024 + 1)), 200, {
            'content-encoding': 'gzip',
          }),
    )
    await expect(
      gateway.request(resource('https://example.com/script.js', 'script')),
    ).rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' })
  })
  it('enforces the 8 MiB cumulative decoded limit across requests', async () => {
    const { gateway } = fixture(async (url) =>
      response(url.pathname === '/robots.txt' ? '' : Buffer.alloc(2 * 1024 * 1024)),
    )
    for (let i = 0; i < 4; i++) await gateway.request(resource(`https://example.com/${i}`, 'fetch'))
    await expect(gateway.request(resource('https://example.com/5', 'fetch'))).rejects.toMatchObject(
      { code: 'RESPONSE_TOO_LARGE' },
    )
    expect(gateway.inspect().decodedBytes).toBe(8 * 1024 * 1024)
  })
  it('counts robots and resources against the 60-request ceiling', async () => {
    const { gateway, calls } = fixture()
    for (let i = 0; i < 59; i++)
      await gateway.request(resource(`https://example.com/${i}`, 'fetch'))
    await expect(
      gateway.request(resource('https://example.com/last', 'fetch')),
    ).rejects.toMatchObject({ code: 'FETCH_BLOCKED' })
    expect(calls).toHaveLength(60)
  })
  it('enforces global and per-host network concurrency', async () => {
    let active = 0
    let maximum = 0
    const { gateway } = fixture(async () => {
      active++
      maximum = Math.max(maximum, active)
      await new Promise((resolve) => setTimeout(resolve, 5))
      return {
        ...response(''),
        close: async () => {
          active--
        },
      }
    })
    await Promise.all(
      Array.from({ length: 6 }, (_, i) =>
        gateway.request(resource(`https://cdn${i % 3}.test/${i}`, 'script')),
      ),
    )
    expect(maximum).toBe(2)
    expect(active).toBe(0)
  })
  it('propagates cancellation into a body read and close awaits socket cleanup', async () => {
    let started: (() => void) | undefined
    const waiting = new Promise<void>((resolve) => {
      started = resolve
    })
    let closed = false
    const { gateway } = fixture(async (url, _address, signal) => {
      if (url.pathname === '/robots.txt') return response('')
      return {
        status: 200,
        headers: {},
        body: (async function* () {
          yield Buffer.from('first')
          started?.()
          await new Promise<void>((_resolve, reject) =>
            signal.addEventListener('abort', () => reject(new AppError('CANCELLED', 'cancelled')), {
              once: true,
            }),
          )
        })(),
        close: async () => {
          await new Promise((resolve) => setTimeout(resolve, 5))
          closed = true
        },
      }
    })
    const task = gateway.request(resource())
    const assertion = expect(task).rejects.toMatchObject({ code: 'CANCELLED' })
    await waiting
    await gateway.close()
    await assertion
    expect(closed).toBe(true)
    await expect(gateway.request(resource())).rejects.toMatchObject({ code: 'CANCELLED' })
  })
})
