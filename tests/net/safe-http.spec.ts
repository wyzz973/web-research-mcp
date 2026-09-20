import { once } from 'node:events'
import { createServer, type Server } from 'node:http'
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import {
  connectPinned,
  isPublicAddress,
  safeGet,
  validateUrl,
  type Address,
  type NetworkDependencies,
  type NetworkResponse,
  type SafeGetOptions,
} from '../../src/net/safe-http.ts'

const PUBLIC: Address = { address: '93.184.216.34', family: 4 }
const options: SafeGetOptions = {
  userAgent: 'test-agent/1.0',
  accept: 'text/markdown, text/html;q=0.9, text/plain;q=0.8',
  timeoutMs: 5000,
  maxBytes: 100_000,
  maxRedirects: 3,
}

function reply(
  body: string | Buffer,
  status = 200,
  headers: Record<string, string> = {},
): NetworkResponse & { closed: number } {
  const response = {
    status,
    headers: { 'content-type': 'text/html; charset=utf-8', ...headers },
    body: (async function* () {
      yield Buffer.from(body)
    })(),
    closed: 0,
    close: async () => {
      response.closed += 1
    },
  }
  return response
}

interface Harness {
  dependencies: NetworkDependencies
  connected: string[]
  resolved: string[]
  headers: Record<string, string>[]
}

function harness(
  handler: (url: URL, signal: AbortSignal) => Promise<NetworkResponse> | NetworkResponse,
  resolve: (hostname: string) => readonly Address[] = () => [PUBLIC],
): Harness {
  const state: Harness = { dependencies: {}, connected: [], resolved: [], headers: [] }
  state.dependencies = {
    resolve: async (hostname) => {
      state.resolved.push(hostname)
      return resolve(hostname)
    },
    connect: async (url, _address, signal, headers) => {
      state.connected.push(url.href)
      state.headers.push({ ...headers })
      return handler(url, signal)
    },
  }
  return state
}

const never = (): AbortSignal => new AbortController().signal

describe('address policy', () => {
  it.each([
    '127.0.0.1',
    '10.0.0.1',
    '172.16.1.2',
    '192.168.1.1',
    '169.254.169.254',
    '169.254.0.7',
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '192.0.2.10',
    '198.18.0.1',
    '::1',
    '::',
    'fc00::1',
    'fd12:3456::1',
    'fe80::1',
    'ff02::1',
    '::ffff:127.0.0.1',
    '::ffff:169.254.169.254',
    '::ffff:8.8.8.8',
    '64:ff9b::7f00:1',
    '2002:7f00:1::',
    '2001:db8::1',
    'not-an-address',
  ])('refuses %s', (address) => {
    expect(isPublicAddress(address)).toBe(false)
  })

  it.each(['93.184.216.34', '8.8.8.8', '1.1.1.1', '2606:2800:220:1:248:1893:25c8:1946'])(
    'accepts public unicast %s',
    (address) => {
      expect(isPublicAddress(address)).toBe(true)
    },
  )
})

describe('URL policy', () => {
  it.each([
    ['decimal', 'http://2130706433/x'],
    ['hex', 'http://0x7f000001/x'],
    ['octal', 'http://0177.0.0.1/x'],
    ['short form', 'http://127.1/x'],
    ['metadata in decimal', 'http://2852039166/latest/meta-data/'],
  ])(
    'the URL parser turns the %s spelling into a dotted address, which is then refused',
    async (_name, url) => {
      expect(validateUrl(url).hostname).toMatch(/^\d+\.\d+\.\d+\.\d+$/u)
      const net = harness(() => reply('secret'))
      await expect(safeGet(url, options, never(), net.dependencies)).rejects.toMatchObject({
        code: 'unsafe_url',
      })
      expect(net.resolved).toEqual([])
      expect(net.connected).toEqual([])
    },
  )

  it.each([
    'http://127.0.0.1/x',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/x',
    'http://[::ffff:127.0.0.1]/x',
    'http://[fe80::1]/x',
    'http://user:pass@example.com/',
    'http://example.com:22/',
    'https://example.com:3000/',
    'http://localhost/x',
    'http://api.localhost/x',
    'file:///etc/passwd',
    'ftp://example.com/file',
    'gopher://example.com/',
    'javascript:alert(1)',
  ])('never connects to %s', async (url) => {
    const net = harness(() => reply('secret'))
    await expect(safeGet(url, options, never(), net.dependencies)).rejects.toMatchObject({
      code: 'unsafe_url',
    })
    expect(net.connected).toEqual([])
  })

  it('allows the alternative web ports and strips the fragment', () => {
    expect(validateUrl('https://example.com:8443/a#frag').href).toBe('https://example.com:8443/a')
    expect(validateUrl('http://example.com:8080/').port).toBe('8080')
  })

  it('reports an unparseable address as invalid input', () => {
    expect(() => validateUrl('https://')).toThrowError(
      expect.objectContaining({ code: 'invalid_input' }),
    )
  })

  it('refuses a query string over the sanity limit', async () => {
    const net = harness(() => reply('ok'))
    const url = `https://example.com/collect?d=${'a'.repeat(2001)}`
    await expect(safeGet(url, options, never(), net.dependencies)).rejects.toMatchObject({
      code: 'unsafe_url',
    })
    expect(net.resolved).toEqual([])
  })
})

describe('DNS answers', () => {
  it('refuses a host when any answer is private, even next to public ones', async () => {
    const net = harness(
      () => reply('secret'),
      () => [PUBLIC, { address: '10.0.0.5', family: 4 }],
    )
    await expect(
      safeGet('https://rebind.example.com/', options, never(), net.dependencies),
    ).rejects.toMatchObject({ code: 'unsafe_url' })
    expect(net.connected).toEqual([])
  })

  it('reports an empty answer as an upstream failure, not as a safe empty page', async () => {
    const net = harness(
      () => reply('x'),
      () => [],
    )
    await expect(
      safeGet('https://nowhere.example.com/', options, never(), net.dependencies),
    ).rejects.toMatchObject({ code: 'upstream_error' })
  })

  it('pins the verified address for the connection', async () => {
    const seen: Address[] = []
    const dependencies: NetworkDependencies = {
      resolve: async () => [PUBLIC, { address: '8.8.8.8', family: 4 }],
      connect: async (_url, address) => {
        seen.push(address)
        return reply('ok')
      },
    }
    await safeGet('https://example.com/', options, never(), dependencies)
    expect(seen).toEqual([PUBLIC])
  })
})

describe('redirects', () => {
  it('follows relative redirects, re-resolving and re-checking every hop', async () => {
    const net = harness((url) =>
      url.pathname === '/start'
        ? reply('', 302, { location: '/article' })
        : url.pathname === '/article'
          ? reply('', 301, { location: 'https://cdn.example.net/final' })
          : reply('done'),
    )
    const response = await safeGet('https://example.com/start', options, never(), net.dependencies)
    expect(response.url.href).toBe('https://cdn.example.net/final')
    expect(response.redirects).toBe(2)
    expect(response.body.toString()).toBe('done')
    expect(net.resolved).toEqual(['example.com', 'example.com', 'cdn.example.net'])
  })

  it('checks the address of a redirect target before connecting to it', async () => {
    const net = harness(
      () => reply('', 302, { location: 'https://internal.example.com/admin' }),
      (hostname) =>
        hostname === 'internal.example.com' ? [{ address: '10.1.2.3', family: 4 }] : [PUBLIC],
    )
    await expect(
      safeGet('https://example.com/start', options, never(), net.dependencies),
    ).rejects.toMatchObject({ code: 'unsafe_url' })
    expect(net.connected).toEqual(['https://example.com/start'])
  })

  it.each([
    ['an HTTPS to HTTP downgrade', 'http://example.com/plain'],
    ['a literal loopback address', 'https://127.0.0.1/private'],
    ['the metadata address', 'http://169.254.169.254/latest/'],
    ['a non-web scheme', 'file:///etc/passwd'],
    ['a refused port', 'https://example.com:6379/'],
  ])('refuses a redirect to %s', async (_name, location) => {
    const net = harness(() => reply('', 302, { location }))
    await expect(
      safeGet('https://example.com/start', options, never(), net.dependencies),
    ).rejects.toMatchObject({ code: 'unsafe_url' })
    expect(net.connected).toEqual(['https://example.com/start'])
  })

  it('allows an HTTP to HTTPS upgrade', async () => {
    const net = harness((url) =>
      url.protocol === 'http:' ? reply('', 301, { location: 'https://example.com/' }) : reply('ok'),
    )
    const response = await safeGet('http://example.com/', options, never(), net.dependencies)
    expect(response.url.protocol).toBe('https:')
  })

  it('stops after the configured number of redirects and closes every response', async () => {
    const replies: (NetworkResponse & { closed: number })[] = []
    const net = harness((url) => {
      const next = reply('', 302, { location: `/hop${Number(url.pathname.slice(4) || 0) + 1}` })
      replies.push(next)
      return next
    })
    await expect(
      safeGet('https://example.com/hop0', options, never(), net.dependencies),
    ).rejects.toMatchObject({ code: 'upstream_error' })
    expect(net.connected).toHaveLength(options.maxRedirects + 1)
    expect(replies.every((item) => item.closed === 1)).toBe(true)
  })

  it('reports a redirect without a target', async () => {
    const net = harness(() => reply('', 302))
    await expect(
      safeGet('https://example.com/', options, never(), net.dependencies),
    ).rejects.toMatchObject({ code: 'upstream_error' })
  })
})

describe('request and body handling', () => {
  it('sends the configured identity and asks for Markdown first', async () => {
    const net = harness(() => reply('ok'))
    await safeGet('https://example.com/', options, never(), net.dependencies)
    expect(net.headers[0]).toMatchObject({
      'user-agent': 'test-agent/1.0',
      accept: 'text/markdown, text/html;q=0.9, text/plain;q=0.8',
    })
    expect(Object.keys(net.headers[0] ?? {})).not.toContain('cookie')
  })

  it('decodes gzip within the limit', async () => {
    const net = harness(() =>
      reply(gzipSync('hello '.repeat(100)), 200, { 'content-encoding': 'gzip' }),
    )
    const response = await safeGet('https://example.com/', options, never(), net.dependencies)
    expect(response.body.toString()).toBe('hello '.repeat(100))
  })

  it('stops a decompression bomb at the limit', async () => {
    const bomb = gzipSync(Buffer.alloc(5_000_000))
    expect(bomb.length).toBeLessThan(options.maxBytes)
    const net = harness(() => reply(bomb, 200, { 'content-encoding': 'gzip' }))
    await expect(
      safeGet('https://example.com/', options, never(), net.dependencies),
    ).rejects.toMatchObject({ code: 'too_large' })
  })

  it('stops an oversized body while streaming and closes the response', async () => {
    const big = reply(Buffer.alloc(options.maxBytes + 1))
    const net = harness(() => big)
    await expect(
      safeGet('https://example.com/', options, never(), net.dependencies),
    ).rejects.toMatchObject({ code: 'too_large' })
    expect(big.closed).toBe(1)
  })

  it('refuses a declared size over the limit without reading the body', async () => {
    let read = false
    const net = harness(() => ({
      status: 200,
      headers: { 'content-type': 'text/html', 'content-length': String(options.maxBytes + 1) },
      body: (async function* () {
        read = true
        yield Buffer.from('x')
      })(),
      close: async () => {},
    }))
    await expect(
      safeGet('https://example.com/', options, never(), net.dependencies),
    ).rejects.toMatchObject({ code: 'too_large' })
    expect(read).toBe(false)
  })

  it('skips a body the caller cannot use and reports its declared size', async () => {
    const net = harness(() =>
      reply('PK...', 200, { 'content-type': 'application/zip', 'content-length': '12582912' }),
    )
    const response = await safeGet(
      'https://example.com/a.zip',
      { ...options, wantsBody: (type) => type.startsWith('text/') },
      never(),
      net.dependencies,
    )
    expect(response).toMatchObject({ bodySkipped: true, declaredBytes: 12_582_912 })
    expect(response.body).toHaveLength(0)
  })

  it('keeps only a bounded sample of an error body', async () => {
    const net = harness(() => reply('x'.repeat(400_000), 503))
    const response = await safeGet('https://example.com/', options, never(), net.dependencies)
    expect(response.status).toBe(503)
    expect(response.body).toHaveLength(0)
  })

  it('maps a transport failure without echoing remote text', async () => {
    const net = harness(() => {
      throw Object.assign(new Error('connect ECONNREFUSED 93.184.216.34:443 <script>'), {
        code: 'ECONNREFUSED',
      })
    })
    const failure = await safeGet('https://example.com/', options, never(), net.dependencies).catch(
      (error: unknown) => error,
    )
    expect(failure).toMatchObject({ code: 'upstream_error' })
    expect(String((failure as Error).message)).toContain('ECONNREFUSED')
    expect(String((failure as Error).message)).not.toContain('script')
  })
})

describe('deadline and cancellation', () => {
  function hanging(signal: AbortSignal): NetworkResponse & { closed: number } {
    const response = {
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: (async function* () {
        yield Buffer.from('first chunk')
        await new Promise<void>((_resolve, reject) =>
          signal.addEventListener('abort', () => reject(signal.reason as Error), { once: true }),
        )
      })(),
      closed: 0,
      close: async () => {
        response.closed += 1
      },
    }
    return response
  }

  it('turns the total deadline into a timeout that reaches the body stream', async () => {
    let response: (NetworkResponse & { closed: number }) | undefined
    const net = harness((_url, signal) => (response = hanging(signal)))
    const started = Date.now()
    await expect(
      safeGet('https://example.com/', { ...options, timeoutMs: 60 }, never(), net.dependencies),
    ).rejects.toMatchObject({ code: 'timeout' })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(response?.closed).toBe(1)
  })

  it('reports caller cancellation as cancelled and closes the response', async () => {
    let response: (NetworkResponse & { closed: number }) | undefined
    const net = harness((_url, signal) => (response = hanging(signal)))
    const abort = new AbortController()
    const pending = safeGet('https://example.com/', options, abort.signal, net.dependencies)
    setTimeout(() => abort.abort(), 20)
    await expect(pending).rejects.toMatchObject({ code: 'cancelled' })
    expect(response?.closed).toBe(1)
  })

  it('does not start when the caller has already cancelled', async () => {
    const net = harness(() => reply('ok'))
    const abort = new AbortController()
    abort.abort()
    await expect(
      safeGet('https://example.com/', options, abort.signal, net.dependencies),
    ).rejects.toMatchObject({ code: 'cancelled' })
    expect(net.connected).toEqual([])
  })
})

describe('real pinned transport', () => {
  let server: Server | undefined
  afterEach(async () => {
    server?.closeAllConnections()
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
    server = undefined
  })

  async function listen(handler: Parameters<typeof createServer>[1]): Promise<number> {
    server = createServer(handler)
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('expected a TCP address')
    return address.port
  }

  // Transport-only: resolvePublic would refuse this address; here it stands in for a verified one.
  it('connects to the pinned address, not to the host name, and does not follow redirects', async () => {
    const seen: string[] = []
    const port = await listen((request, response) => {
      seen.push(`${request.headers.host ?? ''} ${request.url ?? ''}`)
      expect(request.headers.cookie).toBeUndefined()
      expect(request.headers.authorization).toBeUndefined()
      response.writeHead(302, { location: 'http://127.0.0.1/private' })
      response.end()
    })
    const response = await connectPinned(
      new URL(`http://does-not-exist.invalid:${port}/start`),
      { address: '127.0.0.1', family: 4 },
      never(),
      { 'user-agent': 'test-agent/1.0' },
    )
    expect(response.status).toBe(302)
    await response.close()
    expect(seen).toEqual([`does-not-exist.invalid:${port} /start`])
  })

  it('closes the real socket when a streamed request is aborted', async () => {
    let disconnected: (() => void) | undefined
    const closed = new Promise<void>((resolve) => (disconnected = resolve))
    const port = await listen((_request, response) => {
      response.writeHead(200, { 'content-type': 'text/plain' })
      response.write('stream started')
      response.once('close', () => disconnected?.())
    })
    const abort = new AbortController()
    const response = await connectPinned(
      new URL(`http://does-not-exist.invalid:${port}/`),
      { address: '127.0.0.1', family: 4 },
      abort.signal,
      {},
    )
    const reading = (async () => {
      for await (const _chunk of response.body) abort.abort()
    })()
    await expect(reading).rejects.toBeDefined()
    await response.close()
    await closed
  })
})
