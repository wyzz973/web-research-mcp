import { createServer, type Server } from 'node:http'
import { gzipSync } from 'node:zlib'
import { once } from 'node:events'
import { Worker } from 'node:worker_threads'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createDocumentLoader,
  type FetchDependencies,
  type FetchOptions,
} from '../src/fetch/index.ts'
import { connectPinned, isPublicAddress, type NetworkResponse } from '../src/fetch/network.ts'
import { extractHtml } from '../src/fetch/extractor.ts'
import type { DocumentLoader } from '../src/shared/types.ts'
import { resolveScope } from '../src/shared/domain-scope.ts'

const options: FetchOptions = {
  deadlineMs: 10_000,
  maxCompressedBytes: 1_000_000,
  maxDecompressedBytes: 2_000_000,
  maxRedirects: 3,
  globalConcurrency: 3,
  perHostConcurrency: 1,
  parserTimeoutMs: 5000,
  parserConcurrency: 2,
  parserMemoryMb: 128,
  userAgent: 'WebResearchMCP/0.1',
}
const article =
  '<!doctype html><html><head><title>Protocol guide</title></head><body><nav>Ignore navigation</nav><article><h1>Reliable evidence</h1><p>' +
  'Public documentation provides reliable source evidence with exact quotations and reproducible snapshots. '.repeat(
    10,
  ) +
  '</p><pre><code class="language-js">const evidence = "原文 😀";\nconsole.log(evidence)</code></pre>' +
  '<table><thead><tr><th>Method</th><th>State</th></tr></thead><tbody><tr><td>fetch</td><td>supported</td></tr></tbody></table>' +
  '<p><a href="javascript:alert(1)">unsafe link</a> <a href="/reference">Reference</a></p>' +
  '<script>globalThis.__FETCH_EXECUTED=true;fetch("http://127.0.0.1/private")</script></article></body></html>'
const loaders: DocumentLoader[] = []
afterEach(async () => {
  await Promise.all(loaders.splice(0).map((loader) => loader.close()))
})

function response(
  body: string | Buffer,
  status = 200,
  headers: Record<string, string> = {},
): NetworkResponse {
  return {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    body: (async function* () {
      yield Buffer.from(body)
    })(),
    close: async () => {},
  }
}
function fixture(
  handler: NonNullable<FetchDependencies['connect']>,
  override: Partial<FetchOptions> = {},
  resolve: FetchDependencies['resolve'] = async () => [{ address: '93.184.216.34', family: 4 }],
) {
  const calls: string[] = []
  const loader = createDocumentLoader(
    { ...options, ...override },
    {
      resolve,
      connect: async (url, ...args) => {
        calls.push(url.href)
        return handler(url, ...args)
      },
    },
  )
  loaders.push(loader)
  return { loader, calls }
}
const signal = () => new AbortController().signal

describe('public-web network policy', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.1.2',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fc00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '2001:db8::1',
  ])('rejects non-public address %s', (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })
  it.each([
    'http://127.0.0.1/x',
    'http://2130706433/x',
    'http://0x7f000001/x',
    'http://[::1]/x',
    'http://user:pass@example.com/',
    'http://example.com:8080/',
    'file:///etc/passwd',
  ])('never connects to prohibited URL %s', async (url) => {
    const { loader, calls } = fixture(async () => response(article))
    await expect(loader.load(url, { signal: signal() })).rejects.toMatchObject({
      code: 'FETCH_BLOCKED',
    })
    expect(calls).toEqual([])
  })
  it('rejects mixed public/private DNS answers before even requesting robots', async () => {
    const { loader, calls } = fixture(
      async () => response(article),
      {},
      async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
      ],
    )
    await expect(loader.load('https://example.com', { signal: signal() })).rejects.toMatchObject({
      code: 'FETCH_BLOCKED',
    })
    expect(calls).toEqual([])
  })
  it('revalidates DNS after robots before connecting to a rebinding page address', async () => {
    let lookups = 0
    const { loader, calls } = fixture(
      async () => response('', 404),
      {},
      async () => {
        lookups++
        return [{ address: lookups > 2 ? '127.0.0.1' : '93.184.216.34', family: 4 }]
      },
    )
    await expect(loader.load('https://example.com/a', { signal: signal() })).rejects.toMatchObject({
      code: 'FETCH_BLOCKED',
    })
    expect(calls).toEqual(['https://example.com/robots.txt'])
  })
  it.each([
    'http://example.com/downgrade',
    'https://evil.example.net/outside',
    'https://127.0.0.1/private',
  ])('rejects redirect %s before connecting to target', async (target) => {
    const { loader, calls } = fixture(async (url) =>
      url.pathname === '/robots.txt' ? response('', 404) : response('', 302, { location: target }),
    )
    await expect(
      loader.load('https://example.com/start', {
        signal: signal(),
        scope: resolveScope({ sites: ['example.com'] }),
      }),
    ).rejects.toMatchObject({ code: 'FETCH_BLOCKED' })
    expect(calls).toEqual(['https://example.com/robots.txt', 'https://example.com/start'])
  })
  it('enforces robots disallow rules without requesting the page', async () => {
    const { loader, calls } = fixture(async () =>
      response('User-agent: *\nDisallow: /secret\n', 200, { 'content-type': 'text/plain' }),
    )
    await expect(
      loader.load('https://example.com/secret', { signal: signal() }),
    ).rejects.toMatchObject({ code: 'ROBOTS_DENIED' })
    expect(calls).toEqual(['https://example.com/robots.txt'])
  })
})

describe('bounded extraction', () => {
  it('returns HTML metadata after redirects without requesting icon, logo or preview assets', async () => {
    const html = article.replace(
      '</head>',
      `
      <meta property="og:site_name" content="Public protocol docs">
      <meta property="og:image" content="https://cdn.example.net/preview.jpg">
      <link rel="icon" href="/site.svg">
      <script type="application/ld+json">{"@type":"Organization","logo":"https://cdn.example.net/logo.png"}</script>
      </head>`,
    )
    const { loader, calls } = fixture(async (url) => {
      if (url.pathname === '/robots.txt') return response('', 404)
      if (url.pathname === '/start') return response('', 302, { location: '/article' })
      return response(html)
    })
    const result = await loader.load('https://example.com/start', { signal: signal() })
    expect(result.sourceMetadata).toMatchObject({
      source_url: 'https://example.com/start',
      final_url: 'https://example.com/article',
      metadata_url: 'https://example.com/article',
      retrieved_at: result.fetchedAt,
      site_name: 'Public protocol docs',
      favicon_url: 'https://example.com/site.svg',
      image_url: 'https://cdn.example.net/preview.jpg',
      logo_url: 'https://cdn.example.net/logo.png',
      assets_verified: false,
      metadata_source: 'html',
    })
    expect(calls).toEqual([
      'https://example.com/robots.txt',
      'https://example.com/start',
      'https://example.com/article',
    ])
  })

  it('labels plain text metadata as a URL fallback while recording its actual retrieval time', async () => {
    const { loader } = fixture(async (url) =>
      url.pathname === '/robots.txt'
        ? response('', 404)
        : response('Plain public article.', 200, { 'content-type': 'text/plain' }),
    )
    const result = await loader.load('https://example.com/readme.txt', { signal: signal() })
    expect(result.sourceMetadata).toMatchObject({
      metadata_source: 'url_only',
      metadata_url: 'https://example.com/readme.txt',
      retrieved_at: result.fetchedAt,
      favicon_url: 'https://example.com/favicon.ico',
      provenance: { favicon_url: 'origin_fallback' },
    })
  })

  it('extracts malformed-CSS pages without emitting DOM noise to worker stdout or stderr', async () => {
    const html = article.replace('</head>', '<style>@layer x { broken</style></head>')
    const worker = new Worker(new URL('../src/fetch/extract-worker.ts', import.meta.url), {
      workerData: {
        html: Buffer.from(html),
        url: 'https://example.com/',
        contentType: 'text/html',
      },
      resourceLimits: { maxOldGenerationSizeMb: 128 },
      execArgv: [],
      stdout: true,
      stderr: true,
    })
    let stdout = ''
    let stderr = ''
    worker.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    worker.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    const exited = once(worker, 'exit')
    try {
      const [result] = await once(worker, 'message')
      await exited
      expect(result).toMatchObject({ ok: true, value: { title: 'Protocol guide', warnings: [] } })
      expect(stdout).toBe('')
      expect(stderr).toBe('')
    } finally {
      await worker.terminate()
    }
  })
  it('caps actual live parser workers independently of the network load concurrency', async () => {
    let current = 0
    let peak = 0
    const observed = (worker: Worker) => {
      current++
      peak = Math.max(peak, current)
      worker.once('exit', () => {
        current--
      })
    }
    process.on('worker', observed)
    try {
      const { loader } = fixture(
        async (url) => (url.pathname === '/robots.txt' ? response('', 404) : response(article)),
        { globalConcurrency: 4, parserConcurrency: 1 },
      )
      const results = await Promise.all(
        ['a', 'b', 'c', 'd'].map((host) =>
          loader.load(`https://${host}.example.com/`, { signal: signal() }),
        ),
      )
      expect(results.every((result) => result.text.includes('原文 😀'))).toBe(true)
      expect(peak).toBe(1)
      expect(current).toBe(0)
    } finally {
      process.removeListener('worker', observed)
    }
  })
  it('bounds simultaneous network requests per host and across all loads', async () => {
    let inFlight = 0
    let peak = 0
    const byHost = new Map<string, number>()
    const peaks = new Map<string, number>()
    const { loader } = fixture(async (url) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      const current = (byHost.get(url.hostname) ?? 0) + 1
      byHost.set(url.hostname, current)
      peaks.set(url.hostname, Math.max(peaks.get(url.hostname) ?? 0, current))
      await new Promise((resolve) => setTimeout(resolve, 5))
      return {
        ...response(
          url.pathname === '/robots.txt' ? '' : 'A plain public document.',
          url.pathname === '/robots.txt' ? 404 : 200,
          { 'content-type': 'text/plain' },
        ),
        close: async () => {
          inFlight--
          byHost.set(url.hostname, (byHost.get(url.hostname) ?? 1) - 1)
        },
      }
    })
    await Promise.all(
      ['a', 'a', 'b', 'c', 'c', 'd'].map((host, index) =>
        loader.load(`https://${host}.example.com/${index}`, { signal: signal() }),
      ),
    )
    expect(peak).toBeLessThanOrEqual(3)
    expect([...peaks.values()].every((value) => value === 1)).toBe(true)
    expect(inFlight).toBe(0)
  })
  it('honors a long Retry-After instead of silently capping it and reconnecting', async () => {
    const { loader, calls } = fixture(async (url) =>
      url.pathname === '/robots.txt'
        ? response('', 404)
        : response('', 429, { 'retry-after': '3600' }),
    )
    await expect(loader.load('https://example.com/a', { signal: signal() })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    })
    const before = calls.length
    await expect(loader.load('https://example.com/b', { signal: signal() })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    })
    expect(calls.length).toBe(before)
  })
  it('extracts actual article text and GFM code/table in an isolated worker', async () => {
    let closed = 0
    const { loader } = fixture(async (url) => ({
      ...response(
        url.pathname === '/robots.txt' ? '' : article,
        url.pathname === '/robots.txt' ? 404 : 200,
      ),
      close: async () => {
        closed++
      },
    }))
    const result = await loader.load('https://example.com/article', { signal: signal() })
    expect(result.title).toBe('Protocol guide')
    expect(result.text).toContain('原文 😀')
    expect(result.markdown).toContain('```')
    expect(result.markdown).toContain('| Method | State |')
    expect(result.markdown).toContain('https://example.com/reference')
    expect(result.markdown).not.toMatch(/javascript:|<script|__FETCH_EXECUTED/)
    expect(closed).toBe(2)
  })
  it('decodes bounded gzip but rejects decompression bombs', async () => {
    const { loader } = fixture(
      async (url) =>
        url.pathname === '/robots.txt'
          ? response('', 404)
          : response(gzipSync('word '.repeat(100_000)), 200, {
              'content-encoding': 'gzip',
              'content-type': 'text/plain',
            }),
      { maxDecompressedBytes: 2000 },
    )
    await expect(loader.load('https://example.com/a', { signal: signal() })).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
    })
  })
  it('rejects oversized compressed input and closes the response', async () => {
    let closed = 0
    const { loader } = fixture(
      async (url) =>
        url.pathname === '/robots.txt'
          ? response('', 404)
          : {
              ...response(Buffer.alloc(10_000)),
              close: async () => {
                closed++
              },
            },
      { maxCompressedBytes: 1000 },
    )
    await expect(loader.load('https://example.com/a', { signal: signal() })).rejects.toMatchObject({
      code: 'RESPONSE_TOO_LARGE',
    })
    expect(closed).toBe(1)
  })
  it.each([
    [429, 'RATE_LIMITED'],
    [500, 'HTTP_ERROR'],
    [403, 'UPSTREAM_BLOCKED'],
  ] as const)('maps HTTP %i without extracting an error page', async (status, code) => {
    const { loader } = fixture(async (url) =>
      url.pathname === '/robots.txt' ? response('', 404) : response(article, status),
    )
    await expect(loader.load('https://example.com/a', { signal: signal() })).rejects.toMatchObject({
      code,
      httpStatus: status,
    })
  })
  it('reports empty/unreadable HTML extraction failure without returning raw markup', async () => {
    const { loader } = fixture(async (url) =>
      url.pathname === '/robots.txt'
        ? response('', 404)
        : response('<html><body><script>alert(1)</script></body></html>'),
    )
    await expect(loader.load('https://example.com/a', { signal: signal() })).rejects.toMatchObject({
      code: 'EXTRACTION_FAILED',
    })
  })
  it('terminates a parser whose budget expires and can subsequently parse normally', async () => {
    await expect(
      extractHtml(Buffer.from(article), 'https://example.com/', 'text/html', signal(), 1, 128),
    ).rejects.toMatchObject({ code: 'TIMEOUT' })
    const result = await extractHtml(
      Buffer.from(article),
      'https://example.com/',
      'text/html',
      signal(),
      5000,
      128,
    )
    expect(result.text).toContain('reproducible snapshots')
  })
  it('contains worker heap exhaustion inside the worker', async () => {
    await expect(
      extractHtml(Buffer.from(article), 'https://example.com/', 'text/html', signal(), 5000, 8),
    ).rejects.toMatchObject({ code: 'EXTRACTION_FAILED' })
  })
  it('cancels parser work with a distinct cancellation outcome', async () => {
    const abort = new AbortController()
    const pending = extractHtml(
      Buffer.from(article),
      'https://example.com/',
      'text/html',
      abort.signal,
      5000,
      128,
    )
    abort.abort()
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' })
  })
  it('close cancels active and queued requests, waits for responses to close, and refuses new work', async () => {
    let started = 0
    let closed = 0
    let ready: (() => void) | undefined
    const startedPromise = new Promise<void>((resolve) => {
      ready = resolve
    })
    const { loader } = fixture(
      async (url, _address, requestSignal) => {
        if (url.pathname === '/robots.txt') return response('', 404)
        started++
        ready?.()
        return {
          status: 200,
          headers: { 'content-type': 'text/plain' },
          body: (async function* () {
            yield Buffer.from('first')
            await new Promise<void>((_resolve, reject) =>
              requestSignal.addEventListener('abort', () => reject(requestSignal.reason), {
                once: true,
              }),
            )
          })(),
          close: async () => {
            closed++
          },
        }
      },
      { globalConcurrency: 1 },
    )
    const first = loader.load('https://example.com/a', { signal: signal() })
    const second = loader.load('https://example.com/b', { signal: signal() })
    const result = Promise.allSettled([first, second])
    await startedPromise
    await loader.close()
    expect((await result).map((entry) => entry.status)).toEqual(['rejected', 'rejected'])
    expect(started).toBe(1)
    expect(closed).toBe(1)
    await expect(loader.load('https://example.com/c', { signal: signal() })).rejects.toMatchObject({
      code: 'CANCELLED',
    })
  })
})

describe('real pinned transport', () => {
  let server: Server | undefined
  afterEach(async () => {
    if (server) {
      server.closeAllConnections()
      await new Promise<void>((resolve) => server?.close(() => resolve()))
      server = undefined
    }
  })
  it('uses the verified address for the actual socket and does not follow redirects or send credentials', async () => {
    const observed: string[] = []
    server = createServer((request, response) => {
      observed.push(request.url ?? '')
      expect(request.headers.host).toContain('nonexistent-host.invalid:')
      expect(request.headers.cookie).toBeUndefined()
      expect(request.headers.authorization).toBeUndefined()
      response.writeHead(302, { location: 'http://127.0.0.1/private' })
      response.end()
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected listening TCP address')
    // Direct transport test only: the production resolvePublic layer rejects this address.
    const response = await connectPinned(
      new URL(`http://nonexistent-host.invalid:${address.port}/start`),
      { address: '127.0.0.1', family: 4 },
      signal(),
      options.userAgent,
    )
    expect(response.status).toBe(302)
    await response.close()
    expect(observed).toEqual(['/start'])
  })
  it('aborting a streamed request closes the real origin socket', async () => {
    let disconnected: (() => void) | undefined
    const closed = new Promise<void>((resolve) => {
      disconnected = resolve
    })
    server = createServer((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('stream started')
      response.once('close', () => disconnected?.())
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('Expected listening TCP address')
    const abort = new AbortController()
    const response = await connectPinned(
      new URL(`http://nonexistent-host.invalid:${address.port}/`),
      { address: '127.0.0.1', family: 4 },
      abort.signal,
      options.userAgent,
    )
    const reading = (async () => {
      for await (const _chunk of response.body) {
        abort.abort()
      }
    })()
    await expect(reading).rejects.toBeDefined()
    await response.close()
    await closed
  })
})
