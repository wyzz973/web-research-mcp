import { noOpTraceRecorder, type TraceRecorder } from '../shared/trace.ts'
import { parseRobots } from './robots.ts'
import { AppError, throwIfAborted } from '../shared/errors.ts'
import type { DocumentLoader, DomainScope, LoadedDocument } from '../shared/types.ts'
import {
  connectPinned,
  header,
  readBody,
  resolvePublic,
  validateUrl,
  type FetchDependencies,
} from './network.ts'
import { extractHtml } from './extractor.ts'
import { Limiter } from './limiter.ts'
import { createSourceMetadata } from '../shared/source-metadata.ts'

export type { FetchDependencies } from './network.ts'
export interface FetchOptions {
  readonly tracer?: TraceRecorder
  readonly deadlineMs: number
  readonly maxCompressedBytes: number
  readonly maxDecompressedBytes: number
  readonly maxRedirects: number
  readonly globalConcurrency: number
  readonly perHostConcurrency: number
  readonly parserTimeoutMs: number
  readonly parserConcurrency: number
  readonly parserMemoryMb: number
  readonly userAgent: string
}
interface RobotsEntry {
  expires: number
  policy: ReturnType<typeof parseRobots>
}
const REDIRECTS = new Set([301, 302, 303, 307, 308])

/** Creates an anonymous public-web loader. close() cancels and awaits every owned load. */
export function createDocumentLoader(
  options: FetchOptions,
  dependencies: FetchDependencies = {},
): DocumentLoader {
  const trace = options.tracer ?? noOpTraceRecorder
  const global = new Limiter(options.globalConcurrency)
  const parsers = new Limiter(options.parserConcurrency)
  const hostLimits = new Map<string, { limiter: Limiter; users: number }>()
  const robots = new Map<string, RobotsEntry>()
  const cooldowns = new Map<string, number>()
  const crawlIntervals = new Map<string, number>()
  const shutdown = new AbortController()
  const active = new Set<Promise<LoadedDocument>>()
  const connect = dependencies.connect ?? connectPinned

  async function requestUrl(url: URL, signal: AbortSignal, bodyLimit?: number) {
    return trace.span(
      'fetch.http',
      { url: url.href, purpose: url.pathname === '/robots.txt' ? 'robots' : 'document' },
      async () => {
        const response = await requestUrlInner(url, signal, bodyLimit)
        if (
          response.status >= 400 &&
          !(url.pathname === '/robots.txt' && [404, 410].includes(response.status))
        )
          trace.annotate({ http_status: response.status }, 'error')
        return response
      },
      (result) => ({
        http_status: result.status,
        bytes: result.body.length,
        content_type: result.contentType,
      }),
    )
  }
  async function requestUrlInner(url: URL, signal: AbortSignal, bodyLimit?: number) {
    let host = hostLimits.get(url.hostname)
    if (!host) {
      host = { limiter: new Limiter(options.perHostConcurrency), users: 0 }
      hostLimits.set(url.hostname, host)
    }
    host.users++
    let release: (() => void) | undefined
    try {
      release = await host.limiter.acquire(signal)
      const now = Date.now()
      const until = Math.max(now, cooldowns.get(url.hostname) ?? 0)
      if (until - now > options.deadlineMs)
        throw new AppError('RATE_LIMITED', 'The origin cooldown exceeds this request budget.', true)
      const interval = crawlIntervals.get(url.hostname) ?? 0
      // Reserve start times synchronously before awaiting; concurrent requests
      // must not all wake at the same crawl-delay deadline.
      if (interval) boundedSet(cooldowns, url.hostname, until + interval)
      else if (until <= now) cooldowns.delete(url.hostname)
      if (until > now) await delay(until - now, signal)
      const address = await trace.span(
        'fetch.dns',
        { hostname: url.hostname },
        () => resolvePublic(url, signal, dependencies.resolve),
        () => ({ public_address_verified: true, connection_pinned: true }),
      )
      const response = await connect(url, address, signal, options.userAgent)
      try {
        throwIfAborted(signal)
        const status = response.status
        if (status === 429) {
          const retry = header(response, 'retry-after')
          const seconds = Number(retry)
          const wait = retry
            ? Number.isFinite(seconds)
              ? seconds * 1000
              : Date.parse(retry) - Date.now()
            : 1000
          if (Number.isFinite(wait) && wait > 0)
            boundedSet(
              cooldowns,
              url.hostname,
              Math.max(cooldowns.get(url.hostname) ?? 0, Date.now() + wait),
            )
        }
        // Error and redirect bodies are never parsed or retained.
        const body =
          status >= 200 && status < 300
            ? await readBody(
                response,
                signal,
                Math.min(options.maxCompressedBytes, bodyLimit ?? Infinity),
                Math.min(options.maxDecompressedBytes, bodyLimit ?? Infinity),
              )
            : Buffer.alloc(0)
        return {
          status,
          body,
          contentType: header(response, 'content-type'),
          location: header(response, 'location'),
        }
      } finally {
        await response.close()
      }
    } finally {
      release?.()
      host.users--
      if (!host.users) hostLimits.delete(url.hostname)
    }
  }

  async function checkRobots(url: URL, signal: AbortSignal, scope?: DomainScope): Promise<void> {
    let entry = robots.get(url.origin)
    if (!entry || entry.expires <= Date.now()) {
      const robotsUrl = new URL('/robots.txt', url)
      let target = validateUrl(robotsUrl.href, scope)
      let body = ''
      for (let redirects = 0; ; redirects++) {
        const response = await requestUrl(target, signal, 512_000)
        if (REDIRECTS.has(response.status)) {
          target = redirect(target, response.location, redirects, scope)
          trace.event('fetch.redirect', 'ok', { url: target.href, redirect_number: redirects + 1 })
          continue
        }
        if (response.status === 404 || response.status === 410) break
        if (response.status === 429)
          throw new AppError('RATE_LIMITED', 'The origin rate limited robots access.', true, 429)
        if (response.status < 200 || response.status >= 300)
          throw new AppError(
            'ROBOTS_DENIED',
            'Robots policy could not be safely established.',
            false,
            response.status,
          )
        body = response.body.toString('utf8')
        if (/^\s*(?:<!doctype\s+html|<html)/i.test(body))
          throw new AppError('ROBOTS_DENIED', 'The origin returned HTML instead of robots rules.')
        break
      }
      entry = { expires: Date.now() + 300_000, policy: parseRobots(robotsUrl.href, body) }
      boundedSet(robots, url.origin, entry)
    }
    if (entry.policy.isAllowed(url.href, options.userAgent) === false)
      throw new AppError('ROBOTS_DENIED', 'The origin robots rules disallow this URL.')
    const seconds = entry.policy.getCrawlDelay(options.userAgent)
    if (seconds !== undefined && Number.isFinite(seconds) && seconds > 0) {
      const delayMs = seconds * 1000
      if (delayMs > options.deadlineMs)
        throw new AppError('ROBOTS_DENIED', 'The origin crawl delay exceeds this request budget.')
      boundedSet(crawlIntervals, url.hostname, delayMs)
      if (!cooldowns.has(url.hostname)) boundedSet(cooldowns, url.hostname, Date.now() + delayMs)
    }
  }

  function redirect(current: URL, location: string, count: number, scope?: DomainScope): URL {
    if (count >= options.maxRedirects)
      throw new AppError('FETCH_BLOCKED', 'The redirect limit was exceeded.')
    if (!location) throw new AppError('HTTP_ERROR', 'Redirect response has no Location header.')
    let raw: string
    try {
      raw = new URL(location, current).href
    } catch {
      throw new AppError('FETCH_BLOCKED', 'Invalid redirect URL.')
    }
    const target = validateUrl(raw, scope)
    if (current.protocol === 'https:' && target.protocol !== 'https:')
      throw new AppError('FETCH_BLOCKED', 'HTTPS downgrade redirects are prohibited.')
    return target
  }

  async function execute(
    raw: string,
    signal: AbortSignal,
    scope?: DomainScope,
  ): Promise<LoadedDocument> {
    const initial = await trace.span(
      'fetch.validate',
      { url: raw, scope },
      async () => validateUrl(raw, scope),
      () => ({ url_policy_passed: true }),
    )
    let target = initial
    const release = await global.acquire(signal)
    try {
      for (let redirects = 0; ; redirects++) {
        // Validate the page address before even making the robots request.
        await trace.span(
          'fetch.dns',
          { hostname: target.hostname, purpose: 'before_robots' },
          () => resolvePublic(target, signal, dependencies.resolve),
          () => ({ public_address_verified: true }),
        )
        await trace.span(
          'fetch.robots',
          {
            url: target.href,
            cached:
              robots.has(target.origin) && (robots.get(target.origin)?.expires ?? 0) > Date.now(),
          },
          () => checkRobots(target, signal, scope),
          () => ({ allowed: true }),
        )
        const response = await requestUrl(target, signal)
        if (REDIRECTS.has(response.status)) {
          target = redirect(target, response.location, redirects, scope)
          trace.event('fetch.redirect', 'ok', { url: target.href, redirect_number: redirects + 1 })
          continue
        }
        const contentType = await trace.span(
          'fetch.content_check',
          { http_status: response.status, content_type: response.contentType },
          async () => {
            if (response.status === 429)
              throw new AppError(
                'RATE_LIMITED',
                'The origin rate limited this request.',
                true,
                response.status,
              )
            if (response.status === 403)
              throw new AppError(
                'UPSTREAM_BLOCKED',
                'The origin refused anonymous access.',
                false,
                response.status,
              )
            if (response.status < 200 || response.status >= 300)
              throw new AppError(
                'HTTP_ERROR',
                'The origin returned an unsuccessful HTTP status.',
                response.status >= 500,
                response.status,
              )
            const contentType = response.contentType.split(';')[0]?.trim().toLowerCase() ?? ''
            if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
              const sample = response.body.subarray(0, 30_000).toString('utf8')
              if (
                /<title[^>]*>\s*(?:just a moment|attention required|access denied|verify (?:you|your)|captcha)/i.test(
                  sample,
                ) ||
                /cf-chl-|challenge-platform|id=["']captcha/i.test(sample)
              ) {
                throw new AppError(
                  'UPSTREAM_BLOCKED',
                  'The origin returned an anti-bot challenge page.',
                )
              }
            }
            return contentType
          },
          (value) => ({ content_type: value, challenge_detected: false }),
        )
        const fetchedAt = new Date().toISOString()
        let extracted
        if (contentType === 'text/html' || contentType === 'application/xhtml+xml') {
          const releaseParser = await parsers.acquire(signal)
          try {
            extracted = await trace.span(
              'fetch.parse',
              {
                url: target.href,
                bytes: response.body.length,
                technology: 'JSDOM + Readability + Turndown',
                parser_timeout_ms: options.parserTimeoutMs,
              },
              () =>
                extractHtml(
                  response.body,
                  target.href,
                  response.contentType,
                  signal,
                  options.parserTimeoutMs,
                  options.parserMemoryMb,
                ),
              (value) => ({
                title: value.title,
                text_chars: Array.from(value.text).length,
                text_preview: value.text.slice(0, 1800),
                warnings: value.warnings,
              }),
            )
          } finally {
            releaseParser()
          }
        } else if (contentType === 'text/plain' || contentType === 'text/markdown') {
          const charset =
            /charset\s*=\s*["']?([^;"'\s]+)/i.exec(response.contentType)?.[1] ?? 'utf-8'
          let text: string
          try {
            text = new TextDecoder(charset, { fatal: true }).decode(response.body).trim()
          } catch {
            throw new AppError(
              'EXTRACTION_FAILED',
              'The text response uses an unsupported or invalid encoding.',
            )
          }
          if (!text || /^\s*(?:<!doctype\s+html|<html)/i.test(text))
            throw new AppError('EXTRACTION_FAILED', 'No plain text content was extracted.')
          trace.event('fetch.parse', 'ok', {
            technology: 'TextDecoder',
            content_type: contentType,
            text_chars: Array.from(text).length,
            text_preview: text.slice(0, 1800),
          })
          // Text/Markdown input is rendered literally: no raw HTML or reference
          // links can sneak executable URL schemes into the rendered output.
          const markdown = text.replace(/[\\`*_{}[\]()<>#+.!|~-]/g, '\\$&')
          extracted = {
            title: '',
            text,
            markdown,
            warnings: [],
            sourceMetadata: createSourceMetadata(initial.href, target.href, fetchedAt),
          }
        } else
          throw new AppError(
            'UNSUPPORTED_CONTENT_TYPE',
            'Only HTML, XHTML, plain text and Markdown are supported.',
          )
        throwIfAborted(signal)
        return {
          url: initial.href,
          finalUrl: target.href,
          contentType,
          fetchedAt,
          extractorVersion: 'readability-0.6.0+gfm-v1',
          ...extracted,
          sourceMetadata: {
            ...extracted.sourceMetadata,
            source_url: initial.href,
            retrieved_at: fetchedAt,
          },
        }
      }
    } finally {
      release()
    }
  }

  return {
    load(raw, { signal, scope }) {
      const timeout = new AbortController()
      const timer = setTimeout(
        () =>
          timeout.abort(
            new AppError('TIMEOUT', 'Fetching exceeded the total request deadline.', true),
          ),
        options.deadlineMs,
      )
      const combined = AbortSignal.any([signal, shutdown.signal, timeout.signal])
      const task = execute(raw, combined, scope)
        .catch((error: unknown) => {
          throwIfAborted(combined)
          if (error instanceof AppError) throw error
          throw new AppError(
            'UPSTREAM_UNAVAILABLE',
            'The public origin could not be fetched.',
            true,
          )
        })
        .finally(() => {
          clearTimeout(timer)
          active.delete(task)
        })
      active.add(task)
      return task
    },
    async close() {
      shutdown.abort(new AppError('CANCELLED', 'The document loader is shutting down.'))
      await Promise.allSettled(active)
      robots.clear()
      cooldowns.clear()
      crawlIntervals.clear()
      hostLimits.clear()
    },
  }
}

function boundedSet<T>(map: Map<string, T>, key: string, value: T): void {
  map.delete(key)
  if (map.size >= 256) {
    const oldest = map.keys().next().value
    if (oldest !== undefined) map.delete(oldest)
  }
  map.set(key, value)
}

async function delay(ms: number, signal: AbortSignal): Promise<void> {
  throwIfAborted(signal)
  await new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      try {
        throwIfAborted(signal)
      } catch (error) {
        reject(error)
      }
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, ms)
    signal.addEventListener('abort', abort, { once: true })
  })
}
