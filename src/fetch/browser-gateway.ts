import { setTimeout as sleep } from 'node:timers/promises'
import { AppError, throwIfAborted } from '../shared/errors.ts'
import { noOpTraceRecorder, type TraceRecorder } from '../shared/trace.ts'
import type { DomainScope } from '../shared/types.ts'
import { Limiter } from './limiter.ts'
import {
  connectPinned,
  header,
  readBody,
  resolvePublic,
  validateUrl,
  type FetchDependencies,
} from './network.ts'
import { parseRobots } from './robots.ts'

export interface BrowserGatewayOptions {
  readonly initialUrl: string
  readonly tracer?: TraceRecorder
  readonly deadlineMs: number
  readonly maxCompressedBytes: number
  readonly maxDecompressedBytes: number
  readonly maxRedirects: number
  readonly globalConcurrency: number
  readonly perHostConcurrency: number
  readonly userAgent: string
}
export interface BrowserResourceRequest {
  readonly url: string
  readonly resource_type: string
  readonly main_frame: boolean
  readonly redirect_depth: number
}
export interface BrowserResourceResponse {
  readonly status: number
  readonly headers: Record<string, string>
  readonly body_base64: string
}
const REDIRECTS = new Set([301, 302, 303, 307, 308])
const RESOURCE_TYPES = new Set(['script', 'stylesheet', 'xhr', 'fetch'])
const RESPONSE_HEADERS = [
  'content-type',
  'cache-control',
  'expires',
  'last-modified',
  'etag',
  'access-control-allow-origin',
  'access-control-expose-headers',
]
const MAX_REQUESTS = 60
const MAX_TOTAL_BYTES = 8 * 1024 * 1024

/** One render owns this anonymous GET gateway. Browser traffic must be fulfilled through it,
 * never continued onto the browser network. close() aborts and awaits all owned I/O. */
export function createBrowserGateway(
  options: BrowserGatewayOptions,
  dependencies: FetchDependencies = {},
  scope?: DomainScope,
  signal: AbortSignal = new AbortController().signal,
) {
  const initial = validateUrl(options.initialUrl, scope)
  const trace = options.tracer ?? noOpTraceRecorder
  const shutdown = new AbortController()
  const deadline = new AbortController()
  const timer = setTimeout(
    () =>
      deadline.abort(
        new AppError('TIMEOUT', 'Browser resources exceeded the render deadline.', true),
      ),
    options.deadlineMs,
  )
  const combined = AbortSignal.any([signal, shutdown.signal, deadline.signal])
  const global = new Limiter(options.globalConcurrency)
  const hosts = new Map<string, Limiter>()
  const policies = new Map<string, Promise<ReturnType<typeof parseRobots>>>()
  const intervals = new Map<string, number>()
  const nextStart = new Map<string, number>()
  const active = new Set<Promise<BrowserResourceResponse>>()
  const counts = { requests: 0, completed: 0, blocked: 0, decodedBytes: 0 }
  let remainingBytes = MAX_TOTAL_BYTES
  const connect = dependencies.connect ?? connectPinned

  function safeUrl(raw: string, main: boolean): URL {
    const url = validateUrl(raw, main ? scope : undefined)
    if (initial.protocol === 'https:' && url.protocol !== 'https:')
      throw new AppError('FETCH_BLOCKED', 'HTTPS render resources cannot downgrade to HTTP.')
    return url
  }
  function redirect(url: URL, location: string, depth: number, main: boolean): URL {
    if (depth >= Math.min(5, options.maxRedirects))
      throw new AppError('FETCH_BLOCKED', 'Browser redirect limit exceeded.')
    if (!location) throw new AppError('HTTP_ERROR', 'Redirect has no Location header.')
    let target: URL
    try {
      target = safeUrl(new URL(location, url).href, main)
    } catch (error) {
      if (error instanceof AppError) throw error
      throw new AppError('FETCH_BLOCKED', 'Invalid browser redirect URL.')
    }
    if (url.protocol === 'https:' && target.protocol !== 'https:')
      throw new AppError('FETCH_BLOCKED', 'HTTPS redirects cannot downgrade to HTTP.')
    return target
  }
  async function io(url: URL, byteLimit: number) {
    throwIfAborted(combined)
    if (counts.requests >= MAX_REQUESTS)
      throw new AppError('FETCH_BLOCKED', 'Browser network request budget exceeded.')
    counts.requests++
    let host = hosts.get(url.hostname)
    if (!host) {
      host = new Limiter(options.perHostConcurrency)
      hosts.set(url.hostname, host)
    }
    const releaseHost = await host.acquire(combined)
    let releaseGlobal: (() => void) | undefined
    try {
      const now = Date.now()
      const start = Math.max(now, nextStart.get(url.hostname) ?? 0)
      nextStart.set(url.hostname, start + (intervals.get(url.hostname) ?? 0))
      if (start > now) await sleep(start - now, undefined, { signal: combined })
      releaseGlobal = await global.acquire(combined)
      const address = await resolvePublic(url, combined, dependencies.resolve)
      const response = await connect(url, address, combined, options.userAgent)
      try {
        throwIfAborted(combined)
        const headers: Record<string, string> = {}
        for (const key of RESPONSE_HEADERS) {
          const value = header(response, key)
          if (value && value.length <= 8192 && !/[\r\n\0]/.test(value)) headers[key] = value
        }
        // Redirect and error payloads are intentionally not loaded into Chromium.
        let body: Buffer = Buffer.alloc(0)
        if (response.status >= 200 && response.status < 300) {
          // Reserve before awaiting a read so simultaneous responses cannot each
          // spend the same remaining quota. A failed/oversize read consumes its
          // reservation conservatively because readBody does not expose partial bytes.
          const reserved = Math.min(options.maxDecompressedBytes, byteLimit, remainingBytes)
          if (reserved <= 0)
            throw new AppError('RESPONSE_TOO_LARGE', 'Browser total decoded byte budget exceeded.')
          remainingBytes -= reserved
          body = await readBody(
            response,
            combined,
            Math.min(options.maxCompressedBytes, byteLimit, reserved),
            reserved,
          )
          remainingBytes += reserved - body.length
          counts.decodedBytes += body.length
        }
        if (response.status === 429) nextStart.set(url.hostname, Date.now() + options.deadlineMs)
        return { status: response.status, headers, body, location: header(response, 'location') }
      } finally {
        await response.close()
      }
    } finally {
      releaseGlobal?.()
      releaseHost()
    }
  }
  async function robots(url: URL, main: boolean): Promise<void> {
    let pending = policies.get(url.origin)
    const cached = pending !== undefined
    if (!pending) {
      pending = (async () => {
        const original = new URL('/robots.txt', url)
        let target = safeUrl(original.href, main)
        let body = ''
        for (let depth = 0; ; depth++) {
          const result = await io(target, 512_000)
          if (REDIRECTS.has(result.status)) {
            target = redirect(target, result.location, depth, main)
            continue
          }
          if (result.status === 404 || result.status === 410) break
          if (result.status === 429)
            throw new AppError('RATE_LIMITED', 'Robots request was rate limited.', true, 429)
          if (result.status < 200 || result.status >= 300)
            throw new AppError(
              'ROBOTS_DENIED',
              'Robots policy could not be established.',
              false,
              result.status,
            )
          body = result.body.toString('utf8')
          if (/^\s*(?:<!doctype\s+html|<html)/i.test(body))
            throw new AppError('ROBOTS_DENIED', 'HTML challenge is not a robots policy.')
          break
        }
        return parseRobots(original.href, body)
      })()
      policies.set(url.origin, pending)
    }
    await trace.span(
      'crawl4ai.robots',
      { url: url.href, cached },
      async () => {
        const policy = await pending
        if (policy.isAllowed(url.href, options.userAgent) === false)
          throw new AppError('ROBOTS_DENIED', 'Robots rules disallow this browser resource.')
        const seconds = policy.getCrawlDelay(options.userAgent)
        if (seconds !== undefined && Number.isFinite(seconds) && seconds > 0) {
          const interval = seconds * 1000
          if (interval > options.deadlineMs)
            throw new AppError('ROBOTS_DENIED', 'Crawl delay exceeds the render budget.')
          if (!intervals.has(url.hostname)) nextStart.set(url.hostname, Date.now() + interval)
          intervals.set(url.hostname, interval)
        }
      },
      () => ({ allowed: true }),
    )
  }
  async function execute(request: BrowserResourceRequest): Promise<BrowserResourceResponse> {
    throwIfAborted(combined)
    const main = request.resource_type === 'document' && request.main_frame
    if (!main && !RESOURCE_TYPES.has(request.resource_type))
      throw new AppError(
        'FETCH_BLOCKED',
        'Only main documents, scripts, stylesheets and read-only fetch/XHR are loaded.',
      )
    if (
      !Number.isInteger(request.redirect_depth) ||
      request.redirect_depth < 0 ||
      request.redirect_depth > Math.min(5, options.maxRedirects)
    )
      throw new AppError('FETCH_BLOCKED', 'Invalid browser redirect depth.')
    const url = safeUrl(request.url, main)
    // Preflight the actual resource before requesting even its robots URL; re-resolve
    // and pin again for the actual connection, preventing robots-time DNS rebinding.
    await resolvePublic(url, combined, dependencies.resolve)
    await robots(url, main)
    const result = await io(url, (main ? 5 : 2) * 1024 * 1024)
    if (REDIRECTS.has(result.status)) {
      const target = redirect(url, result.location, request.redirect_depth, main)
      await resolvePublic(target, combined, dependencies.resolve)
      result.headers.location = target.href
    }
    if (!REDIRECTS.has(result.status) && (result.status < 200 || result.status >= 300)) {
      const code =
        result.status === 429
          ? 'RATE_LIMITED'
          : result.status === 403
            ? 'UPSTREAM_BLOCKED'
            : 'HTTP_ERROR'
      throw new AppError(
        code,
        'The browser origin returned an unsuccessful HTTP status.',
        result.status >= 500 || result.status === 429,
        result.status,
      )
    }
    counts.completed++
    return {
      status: result.status,
      headers: result.headers,
      body_base64: result.body.toString('base64'),
    }
  }
  return {
    request(request: BrowserResourceRequest): Promise<BrowserResourceResponse> {
      const task = trace
        .span(
          'crawl4ai.resource',
          request,
          () => execute(request),
          (result) => ({
            http_status: result.status,
            bytes: Buffer.byteLength(result.body_base64, 'base64'),
          }),
        )
        .catch((error: unknown) => {
          counts.blocked++
          trace.event('crawl4ai.blocked', 'partial', {
            url: request.url,
            resource_type: request.resource_type,
            code: error instanceof AppError ? error.code : 'UPSTREAM_UNAVAILABLE',
          })
          throwIfAborted(combined)
          if (error instanceof AppError) throw error
          throw new AppError('UPSTREAM_UNAVAILABLE', 'Browser resource could not be fetched.', true)
        })
        .finally(() => active.delete(task))
      active.add(task)
      return task
    },
    inspect() {
      return { ...counts }
    },
    async close(): Promise<void> {
      clearTimeout(timer)
      shutdown.abort(new AppError('CANCELLED', 'Browser gateway is closing.'))
      await Promise.allSettled(active)
      policies.clear()
      hosts.clear()
      intervals.clear()
      nextStart.clear()
    },
  }
}
