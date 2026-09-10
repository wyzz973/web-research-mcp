/** Loopback-only HTTP adapter. Browser requests use the same tool contracts and cancellation. */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { AppError } from '../shared/errors.ts'
import { parseContract } from '../shared/contracts.ts'
import { toolError } from '../tools/common.ts'
import type { WebSearchOutput } from '../generated/websearch.output.ts'
import type { WebFetchOutput } from '../generated/webfetch.output.ts'

interface WorkbenchOptions {
  port: number
  uiDirectory: URL
  websearch(input: unknown, signal: AbortSignal): Promise<WebSearchOutput>
  webfetch(input: unknown, signal: AbortSignal): Promise<WebFetchOutput>
  status(): unknown
  evaluation(): Promise<unknown>
}
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
])

async function readJson(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  if (!/^application\/json(?:;|$)/iu.test(request.headers['content-type'] ?? ''))
    throw new AppError('INVALID_ARGUMENT', 'Send application/json.')
  const chunks: Buffer[] = []
  let bytes = 0
  const timeout = setTimeout(() => request.destroy(), 5000)
  const cancel = () => request.destroy()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    if (signal.aborted) throw new AppError('CANCELLED', 'Request cancelled.')
    for await (const chunk of request) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      bytes += buffer.length
      if (bytes > 64 * 1024) throw new AppError('INVALID_ARGUMENT', 'Request body exceeds 64 KiB.')
      chunks.push(buffer)
    }
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
    } catch {
      throw new AppError('INVALID_ARGUMENT', 'Request body must be valid JSON.')
    }
  } finally {
    clearTimeout(timeout)
    signal.removeEventListener('abort', cancel)
  }
}

/** Owns HTTP requests; close cancels and waits before the caller releases runtime resources. */
export async function startWorkbench(options: WorkbenchOptions) {
  const token = randomBytes(32).toString('hex')
  const lifetime = new AbortController()
  const active = new Set<Promise<void>>()
  let origin = ''
  let inFlight = 0
  function json(response: ServerResponse, code: number, body: unknown) {
    if (response.destroyed) return
    response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
    response.end(JSON.stringify(body))
  }
  async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store')
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin')
    response.setHeader(
      'Content-Security-Policy',
      "default-src 'none'; script-src 'self'; style-src 'self'; img-src https: data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    )
    if (
      request.headers.host !== new URL(origin).host ||
      (request.headers.origin !== undefined && request.headers.origin !== origin) ||
      request.headers['sec-fetch-site'] === 'cross-site'
    ) {
      json(response, 403, {
        error: { code: 'FORBIDDEN', message: 'Only this local workbench origin is allowed.' },
      })
      return
    }
    const route = request.url ?? '/'
    const asset = assets.get(route)
    if (request.method === 'GET' && asset) {
      const [filename, contentType] = asset
      if (!filename || !contentType) throw new Error('Invalid static asset definition')
      let content = await readFile(new URL(filename, options.uiDirectory), 'utf8')
      if (filename === 'index.html') {
        content = content.replace(
          '</head>',
          `<meta name="workbench-token" content="${token}"></head>`,
        )
      }
      response.writeHead(200, { 'Content-Type': contentType })
      response.end(content)
      return
    }
    if (!route.startsWith('/api/')) {
      json(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found.' } })
      return
    }
    const supplied = request.headers['x-workbench-token']
    if (
      typeof supplied !== 'string' ||
      !/^[a-f0-9]{64}$/u.test(supplied) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(token))
    ) {
      json(response, 403, {
        error: {
          code: 'FORBIDDEN',
          message: 'Reload the workbench to obtain its current local session.',
        },
      })
      return
    }
    if (request.method === 'GET' && route === '/api/status') {
      json(response, 200, options.status())
      return
    }
    if (request.method === 'GET' && route === '/api/evaluation') {
      json(response, 200, await options.evaluation())
      return
    }
    if (request.method !== 'POST' || !['/api/search', '/api/fetch'].includes(route)) {
      json(response, 404, { error: { code: 'NOT_FOUND', message: 'Route not found.' } })
      return
    }
    if (inFlight >= 4 || lifetime.signal.aborted) {
      json(response, 429, {
        error: {
          code: 'RATE_LIMITED',
          message: 'Four local requests are active. Wait or cancel one.',
        },
      })
      return
    }
    inFlight++
    const disconnected = new AbortController()
    const onClose = () => {
      if (!response.writableEnded)
        disconnected.abort(new AppError('CANCELLED', 'Browser disconnected.'))
    }
    response.once('close', onClose)
    const signal = AbortSignal.any([lifetime.signal, disconnected.signal])
    try {
      const input = await readJson(request, signal)
      const name = route === '/api/search' ? 'websearch' : 'webfetch'
      const output =
        name === 'websearch'
          ? await options.websearch(input, signal)
          : await options.webfetch(input, signal)
      parseContract(`${name}.output`, output)
      json(response, 200, output)
    } catch (error) {
      json(response, 400, { error: toolError(error) })
    } finally {
      inFlight--
      response.removeListener('close', onClose)
    }
  }
  const server = createServer((request, response) => {
    const task = handle(request, response)
      .catch(() => {
        json(response, 500, { error: { code: 'INTERNAL_ERROR', message: 'Local request failed.' } })
      })
      .finally(() => {
        active.delete(task)
      })
    active.add(task)
  })
  server.requestTimeout = 10_000
  server.headersTimeout = 5000
  server.maxConnections = 32
  server.keepAliveTimeout = 1000
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected loopback TCP address')
  origin = `http://127.0.0.1:${address.port}`
  let closing: Promise<void> | undefined
  return {
    url: origin,
    close(): Promise<void> {
      closing ??= (async () => {
        lifetime.abort(new AppError('CANCELLED', 'Workbench shutting down.'))
        const closed = new Promise<void>((resolve, reject) =>
          server.close((error) => (error ? reject(error) : resolve())),
        )
        server.closeAllConnections()
        await Promise.allSettled(active)
        await closed
      })()
      return closing
    },
  }
}
