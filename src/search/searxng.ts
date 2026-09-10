import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { AppError, throwIfAborted } from '../shared/errors.ts'
import { canonicalUrl, resolveScope } from '../shared/domain-scope.ts'
import type {
  SearchPage,
  SearchPageRequest,
  SearchProvider,
  SearchSource,
} from '../shared/types.ts'

import {
  EngineHealth,
  classifyEngineFailure,
  type EngineDiagnostic,
  type EngineFailure,
  type EngineSelection,
} from './engine-health.ts'

import { KEYLESS_ENGINES } from '../shared/search-policy.ts'
export { KEYLESS_ENGINES } from '../shared/search-policy.ts'
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** SearXNG parses modifiers before engines=. Reject controls, preserving normal site: and quoted text. */
export function validateSearchQuery(query: string): void {
  if (!query.trim() || query.length > 4000)
    throw new AppError('INVALID_ARGUMENT', 'Invalid search query length.')
  // Python str.isspace includes four C0 separators and NEL in addition to JavaScript whitespace.
  // eslint-disable-next-line no-control-regex -- Match Python's actual query-token boundaries to prevent modifier bypass.
  const separators = /[\s\u001c-\u001f\u0085]+/u
  if (query.split(separators).some((part) => /^[!:]/u.test(part) || /^<\p{N}/u.test(part))) {
    throw new AppError(
      'INVALID_ARGUMENT',
      'SearXNG engine, bang, language, and timeout directives are not allowed in query.',
    )
  }
}

function upstreamFailure(reason: string): AppError {
  const code = classifyEngineFailure(reason)
  return new AppError(
    code,
    code === 'UPSTREAM_BLOCKED'
      ? 'The configured search engines blocked the request.'
      : code === 'TIMEOUT'
        ? 'Search engines timed out.'
        : 'The configured search engines are unavailable.',
    code !== 'UPSTREAM_BLOCKED',
  )
}

export interface SearchDiagnostics {
  status: 'idle' | 'ready' | 'degraded' | 'unavailable' | 'closed'
  endpoint: {
    total_requests: number
    failed_requests: number
    last_elapsed_ms: number | null
    last_error: string | null
    last_observed_at: string | null
  }
  engines: readonly EngineDiagnostic[]
}
export interface SearxngProvider extends SearchProvider {
  /** Read provider-local observations without issuing a probe or exposing queries. */
  inspect(): SearchDiagnostics
}

function parsePage(
  payload: unknown,
  allowed: ReadonlySet<string>,
  observe: (
    failures: readonly EngineFailure[],
    successful: ReadonlySet<string>,
    diagnosticsComplete: boolean,
  ) => void,
): SearchPage {
  if (!record(payload) || !Array.isArray(payload.results)) {
    throw new AppError(
      'UPSTREAM_UNAVAILABLE',
      'Search endpoint returned an invalid response.',
      true,
    )
  }
  const errors: string[] = []
  const failures: EngineFailure[] = []
  if (payload.unresponsive_engines !== undefined) {
    if (!Array.isArray(payload.unresponsive_engines)) {
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        'Search endpoint returned invalid engine diagnostics.',
        true,
      )
    }
    for (const entry of payload.unresponsive_engines) {
      if (
        !Array.isArray(entry) ||
        entry.length < 2 ||
        entry.length > 3 ||
        typeof entry[0] !== 'string' ||
        typeof entry[1] !== 'string' ||
        (entry[2] !== undefined && typeof entry[2] !== 'boolean')
      ) {
        throw new AppError(
          'UPSTREAM_UNAVAILABLE',
          'Search endpoint returned invalid engine diagnostics.',
          true,
        )
      }
      if (allowed.has(entry[0]))
        failures.push({
          engine: entry[0],
          code: classifyEngineFailure(entry[1]),
          suspended: typeof entry[2] === 'boolean' ? entry[2] : null,
        })
      const failure = upstreamFailure(entry[1])
      errors.push(`${failure.code}: ${allowed.has(entry[0]) ? entry[0] : 'unconfigured_engine'}`)
    }
  }
  const sources: SearchSource[] = []
  for (const row of payload.results.slice(0, 200)) {
    if (!record(row) || typeof row.url !== 'string' || typeof row.title !== 'string') {
      errors.push('UPSTREAM_UNAVAILABLE: invalid_result')
      continue
    }
    const engines: unknown = row.engines ?? (typeof row.engine === 'string' ? [row.engine] : [])
    if (
      !Array.isArray(engines) ||
      engines.length === 0 ||
      engines.some((engine) => typeof engine !== 'string' || !allowed.has(engine))
    ) {
      throw new AppError(
        'UPSTREAM_UNAVAILABLE',
        'Search endpoint returned a result from an unconfigured engine.',
      )
    }
    let url: string
    try {
      url = canonicalUrl(row.url)
    } catch {
      errors.push('UPSTREAM_UNAVAILABLE: invalid_result_url')
      continue
    }
    const date = typeof row.publishedDate === 'string' ? Date.parse(row.publishedDate) : NaN
    sources.push({
      url,
      title: Array.from(row.title).slice(0, 500).join(''),
      snippet:
        typeof row.content === 'string' ? Array.from(row.content).slice(0, 3000).join('') : '',
      publishedAt: Number.isFinite(date) ? new Date(date).toISOString() : null,
      engines: engines.filter((engine): engine is string => typeof engine === 'string'),
    })
  }
  if (payload.results.length > 200) errors.push('UPSTREAM_UNAVAILABLE: response_candidate_limit')
  const successful = new Set(sources.flatMap((source) => source.engines))
  observe(failures, successful, Array.isArray(payload.unresponsive_engines))
  if (sources.length === 0 && errors.length > 0) throw upstreamFailure(errors.join(' '))
  return { sources, errors, exhausted: payload.results.length === 0 || payload.paging === false }
}

/** Owns all requests to one operator-configured infrastructure endpoint; never follows redirects. */
export function createSearxngProvider(options: {
  baseUrl: string
  engines: readonly string[]
  timeoutMs: number
  now?: () => number
}): SearxngProvider {
  let endpoint: URL
  try {
    const base = new URL(options.baseUrl)
    if (
      !['https:', 'http:'].includes(base.protocol) ||
      base.username ||
      base.password ||
      base.search ||
      base.hash
    )
      throw new Error('invalid endpoint')
    endpoint = new URL(
      base.pathname.endsWith('/search') ? base.href : `${base.href.replace(/\/$/u, '')}/search`,
    )
  } catch {
    throw new AppError(
      'INVALID_ARGUMENT',
      'SearXNG URL must be an HTTP(S) base URL without credentials, query, or fragment.',
    )
  }
  const allowed = new Set(options.engines)
  if (
    allowed.size === 0 ||
    [...allowed].some((engine) => !(KEYLESS_ENGINES as readonly string[]).includes(engine))
  ) {
    throw new AppError(
      'INVALID_ARGUMENT',
      'Only the fixed keyless web engine allowlist is supported.',
    )
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0)
    throw new AppError('INVALID_ARGUMENT', 'Search timeout must be positive.')
  let closed = false
  const now = options.now ?? Date.now
  const health = new EngineHealth([...allowed], now)
  const endpointDiagnostic: SearchDiagnostics['endpoint'] = {
    total_requests: 0,
    failed_requests: 0,
    last_elapsed_ms: null,
    last_error: null,
    last_observed_at: null,
  }
  const active = new Map<AbortController, Promise<SearchPage>>()

  function requestPage(
    input: SearchPageRequest,
    callerSignal: AbortSignal,
    controller: AbortController,
    selection: EngineSelection,
  ): Promise<SearchPage> {
    const signal = AbortSignal.any([callerSignal, controller.signal])
    throwIfAborted(signal)
    validateSearchQuery(input.query)
    const url = new URL(endpoint)
    const site =
      input.site === undefined ? undefined : resolveScope({ sites: [input.site] }).sites[0]
    url.searchParams.set('q', site ? `${input.query} site:${site}` : input.query)
    url.searchParams.set('format', 'json')
    url.searchParams.set('engines', selection.engines.join(','))
    // SearXNG unions explicit categories with engines; omitting categories preserves the exact allowlist.
    url.searchParams.set('language', input.language)
    url.searchParams.set('pageno', String(input.page))
    if (input.timeRange !== 'any') url.searchParams.set('time_range', input.timeRange)
    return new Promise<SearchPage>((resolve, reject) => {
      let settled = false
      const finish = (error?: Error, value?: SearchPage) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else if (value) resolve(value)
      }
      const timer = setTimeout(
        () => controller.abort(new AppError('TIMEOUT', 'Search endpoint timed out.', true)),
        options.timeoutMs,
      )
      const transport = url.protocol === 'https:' ? httpsRequest : httpRequest
      const request = transport(
        url,
        {
          method: 'GET',
          signal,
          agent: false,
          headers: {
            accept: 'application/json',
            'accept-encoding': 'identity',
            'user-agent': 'web-research-mcp/0.1',
          },
        },
        (response) => {
          const status = response.statusCode ?? 0
          const fail = (error: AppError) => {
            response.destroy()
            finish(error)
          }
          if (status === 403 || status === 429)
            return fail(
              new AppError(
                'UPSTREAM_BLOCKED',
                'Search endpoint denied the request or disabled JSON.',
                false,
                status,
              ),
            )
          if (status < 200 || status >= 300)
            return fail(
              new AppError(
                'UPSTREAM_UNAVAILABLE',
                'Search endpoint returned an HTTP error; redirects are disabled.',
                status >= 500,
                status,
              ),
            )
          if (
            !/\bapplication\/(?:[a-z0-9.+-]+\+)?json\b/iu.test(
              response.headers['content-type'] ?? '',
            )
          ) {
            return fail(
              new AppError(
                'UPSTREAM_BLOCKED',
                'Search endpoint returned a non-JSON page, possibly an access challenge.',
              ),
            )
          }
          const chunks: Buffer[] = []
          let size = 0
          response.on('data', (chunk: Buffer) => {
            size += chunk.length
            if (size > MAX_RESPONSE_BYTES)
              return fail(
                new AppError('UPSTREAM_UNAVAILABLE', 'Search response exceeded its byte limit.'),
              )
            chunks.push(chunk)
          })
          response.on('error', () => {
            if (signal.aborted) {
              try {
                throwIfAborted(signal)
              } catch (error) {
                finish(
                  error instanceof Error ? error : new AppError('CANCELLED', 'Search cancelled.'),
                )
              }
            } else
              finish(new AppError('UPSTREAM_UNAVAILABLE', 'Search response was interrupted.', true))
          })
          response.on('end', () => {
            if (settled) return
            try {
              throwIfAborted(signal)
              const payload: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              const page = parsePage(
                payload,
                new Set(selection.engines),
                (failures, successful, diagnosticsComplete) =>
                  health.observe(selection, failures, successful, diagnosticsComplete),
              )
              const skippedErrors = selection.skipped.map(
                (engine) => `UPSTREAM_UNAVAILABLE: ${engine} (cooling_down_or_probe_in_flight)`,
              )
              if (page.sources.length === 0 && skippedErrors.length > 0)
                throw upstreamFailure(skippedErrors.join(' '))
              finish(undefined, { ...page, errors: [...page.errors, ...skippedErrors] })
            } catch (error) {
              finish(
                error instanceof AppError
                  ? error
                  : new AppError(
                      'UPSTREAM_UNAVAILABLE',
                      'Search endpoint returned invalid JSON.',
                      true,
                    ),
              )
            }
          })
        },
      )
      request.on('error', () => {
        if (signal.aborted) {
          try {
            throwIfAborted(signal)
          } catch (error) {
            finish(error instanceof Error ? error : new AppError('CANCELLED', 'Search cancelled.'))
          }
        } else
          finish(
            new AppError(
              'UPSTREAM_UNAVAILABLE',
              'Unable to connect to the configured search endpoint.',
              true,
            ),
          )
      })
      request.end()
    })
  }

  return {
    async searchPage(input, signal) {
      if (closed) throw new AppError('UPSTREAM_UNAVAILABLE', 'Search provider is closed.')
      throwIfAborted(signal)
      validateSearchQuery(input.query)
      if (input.site !== undefined) resolveScope({ sites: [input.site] })
      const selection = health.select()
      const controller = new AbortController()
      const startedAt = performance.now()
      endpointDiagnostic.total_requests += 1
      const promise = requestPage(input, signal, controller, selection)
      active.set(controller, promise)
      try {
        const page = await promise
        endpointDiagnostic.last_error = null
        return page
      } catch (error) {
        endpointDiagnostic.failed_requests += 1
        endpointDiagnostic.last_error =
          error instanceof AppError ? error.code : 'UPSTREAM_UNAVAILABLE'
        throw error
      } finally {
        endpointDiagnostic.last_elapsed_ms = Math.round(performance.now() - startedAt)
        endpointDiagnostic.last_observed_at = new Date(now()).toISOString()
        health.release(selection)
        active.delete(controller)
      }
    },
    inspect() {
      const engines = health.inspect()
      const failed = engines.filter(
        (engine) => engine.status === 'cooling_down' || engine.status === 'half_open',
      ).length
      const status = closed
        ? 'closed'
        : failed === engines.length
          ? 'unavailable'
          : failed > 0
            ? 'degraded'
            : endpointDiagnostic.last_error
              ? 'unavailable'
              : endpointDiagnostic.total_requests > 0
                ? 'ready'
                : 'idle'
      return { status, endpoint: { ...endpointDiagnostic }, engines }
    },
    async close() {
      closed = true
      const pending = [...active]
      for (const [controller] of pending)
        controller.abort(new AppError('CANCELLED', 'Search provider closed.'))
      await Promise.allSettled(pending.map(([, promise]) => promise))
    },
  }
}
