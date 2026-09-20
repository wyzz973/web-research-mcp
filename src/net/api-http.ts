/**
 * HTTP client for vendor search APIs. Hosts are fixed by our own adapters, so this client is
 * deliberately simpler than the page fetcher: no redirects, a small body cap, typed failures.
 */
import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'
import { WebError, throwIfAborted } from '../errors.ts'

export interface ApiRequest {
  url: string
  method: 'GET' | 'POST'
  headers?: Record<string, string>
  /** Sent as a JSON body. */
  json?: unknown
  /**
   * Vendor-specific statuses that mean "the account's quota is used up" (Exa 402, Tavily
   * 432/433). Reported as budget_exhausted: unlike a rate limit, waiting a minute does not help.
   */
  quotaStatuses?: readonly number[]
  /**
   * For `text/event-stream` responses: called once with each completed event block; return true
   * when that event is all the caller needs. Servers may keep such a stream open after the answer.
   */
  streamComplete?: (eventBlock: string) => boolean
}

export interface ApiResponse {
  status: number
  /** Lower-cased media type without parameters, e.g. "text/event-stream". */
  contentType: string
  body: string
}

/** Resolves for 2xx only. Every failure is a WebError: rate_limited, blocked, timeout, ... */
export type ApiHttp = (request: ApiRequest, signal: AbortSignal) => Promise<ApiResponse>

/** Structural, so both undici's and the platform's `Response` fit without a cast. */
interface BodyStream {
  getReader(): {
    read(): Promise<{ done: boolean; value?: Uint8Array | undefined }>
    cancel(): Promise<void>
  }
  cancel(): Promise<void>
}

interface FetchResponse {
  status: number
  headers: { get(name: string): string | null }
  body: BodyStream | null
}

interface FetchInit {
  method: string
  headers: Record<string, string>
  body?: string
  redirect: 'manual'
  signal: AbortSignal
}

/** The subset of `fetch` this client needs; tests substitute it to stay offline. */
export type FetchFunction = (url: string, init: FetchInit) => Promise<FetchResponse>

export interface ApiHttpOptions {
  userAgent: string
  /** Upper bound for one request, connection through last byte. */
  timeoutMs?: number
  maxBytes?: number
  fetch?: FetchFunction
}

export interface ApiHttpClient {
  request: ApiHttp
  close(): Promise<void>
}

const DEFAULT_TIMEOUT_MS = 10_000
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024
const MAX_RETRY_AFTER_S = 24 * 3600

/**
 * Users behind a proxy configure it the way curl expects (HTTPS_PROXY, NO_PROXY); this agent
 * honours those variables and behaves like a plain keep-alive agent when none is set.
 */
function createDispatcher(): Dispatcher {
  return new EnvHttpProxyAgent({ keepAliveTimeout: 30_000, connections: 8 })
}

function transport(options: ApiHttpOptions): { send: FetchFunction; close(): Promise<void> } {
  if (options.fetch) return { send: options.fetch, close: () => Promise.resolve() }
  const dispatcher = createDispatcher()
  return {
    send: (url, init) => undiciFetch(url, { ...init, dispatcher }),
    close: () => dispatcher.close(),
  }
}

/** `Retry-After` is either delta-seconds or an HTTP date. */
export function parseRetryAfter(value: string | null, now: Date): number | undefined {
  if (!value) return undefined
  const trimmed = value.trim()
  const seconds = /^\d+$/u.test(trimmed)
    ? Number(trimmed)
    : Math.ceil((Date.parse(trimmed) - now.getTime()) / 1000)
  if (!Number.isFinite(seconds)) return undefined
  return Math.min(Math.max(Math.ceil(seconds), 1), MAX_RETRY_AFTER_S)
}

function failureFor(response: FetchResponse, request: ApiRequest, host: string): WebError {
  const { status } = response
  const retryAfter = parseRetryAfter(response.headers.get('retry-after'), new Date())
  if (status === 429)
    return new WebError('rate_limited', `${host} rate limited the request (HTTP 429).`, retryAfter)
  if (request.quotaStatuses?.includes(status))
    return new WebError('budget_exhausted', `${host} quota is used up (HTTP ${status}).`)
  if (status === 401 || status === 403)
    return new WebError('blocked', `${host} refused the request (HTTP ${status}).`)
  if (status >= 300 && status < 400)
    return new WebError('upstream_error', `${host} answered with a redirect (HTTP ${status}).`)
  return new WebError('upstream_error', `${host} answered HTTP ${status}.`, retryAfter)
}

function networkFailure(error: unknown, host: string): WebError {
  if (error instanceof WebError) return error
  const cause: unknown = error instanceof Error ? error.cause : undefined
  const code =
    typeof cause === 'object' && cause !== null && 'code' in cause ? String(cause.code) : ''
  const suffix = /^[A-Z0-9_]{3,40}$/u.test(code) ? ` (${code})` : ''
  return new WebError('upstream_error', `Could not reach ${host}${suffix}.`)
}

interface ReadOptions {
  maxBytes: number
  host: string
  complete: ((eventBlock: string) => boolean) | undefined
}

/** Shows `complete` every event block exactly once, however the stream was chunked. */
function eventScanner(complete: (eventBlock: string) => boolean) {
  const eventBreak = /\r\n\r\n|\n\n|\r\r/gu
  let blockStart = 0
  let searched = 0
  return (text: string): boolean => {
    // A separator may straddle two chunks, so the search resumes a little before the old end.
    eventBreak.lastIndex = Math.max(blockStart, searched - 3)
    for (let match = eventBreak.exec(text); match; match = eventBreak.exec(text)) {
      const block = text.slice(blockStart, match.index)
      blockStart = match.index + match[0].length
      if (complete(block)) return true
    }
    searched = text.length
    return false
  }
}

async function readBody(response: FetchResponse, options: ReadOptions): Promise<string> {
  const { maxBytes, host } = options
  const tooLarge = () => new WebError('too_large', `${host} sent more than ${maxBytes} bytes.`)
  if (Number(response.headers.get('content-length') ?? 0) > maxBytes) {
    // Without this the unread body pins the socket until the keep-alive timeout.
    await response.body?.cancel().catch(() => undefined)
    throw tooLarge()
  }
  if (!response.body) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const complete = options.complete ? eventScanner(options.complete) : undefined
  let text = ''
  let bytes = 0
  let drained = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done || value === undefined) {
        drained = true
        return text + decoder.decode()
      }
      bytes += value.byteLength
      if (bytes > maxBytes) throw tooLarge()
      text += decoder.decode(value, { stream: true })
      if (complete?.(text)) return text
    }
  } finally {
    // Stopping early (answer complete, oversize, abort) must still release the socket.
    if (!drained) await reader.cancel().catch(() => undefined)
  }
}

/** Adapters build their URLs from constants, but a custom one may not: fail as a WebError. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    throw new WebError('internal', 'A search source was given a request URL that is not valid.')
  }
}

function mediaType(response: FetchResponse): string {
  return (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? ''
}

function buildInit(request: ApiRequest, userAgent: string, signal: AbortSignal): FetchInit {
  const headers: Record<string, string> = { 'user-agent': userAgent, ...request.headers }
  const init: FetchInit = { method: request.method, headers, redirect: 'manual', signal }
  if (request.json === undefined) return init
  headers['content-type'] = 'application/json'
  return { ...init, body: JSON.stringify(request.json) }
}

/** Aborts when the caller aborts or the deadline passes; `dispose` removes both hooks. */
function deadline(parent: AbortSignal, timeoutMs: number, host: string) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(parent.reason)
  const timer = setTimeout(
    () => controller.abort(new WebError('timeout', `${host} did not answer in ${timeoutMs} ms.`)),
    timeoutMs,
  )
  if (parent.aborted) onAbort()
  else parent.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      parent.removeEventListener('abort', onAbort)
    },
  }
}

export function createApiHttp(options: ApiHttpOptions): ApiHttpClient {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const { send, close } = transport(options)

  async function request(apiRequest: ApiRequest, signal: AbortSignal): Promise<ApiResponse> {
    throwIfAborted(signal)
    const host = hostOf(apiRequest.url)
    const limit = deadline(signal, timeoutMs, host)
    try {
      const init = buildInit(apiRequest, options.userAgent, limit.signal)
      const response = await send(apiRequest.url, init)
      if (response.status < 200 || response.status >= 300) {
        await response.body?.cancel().catch(() => undefined)
        throw failureFor(response, apiRequest, host)
      }
      const contentType = mediaType(response)
      const complete = contentType === 'text/event-stream' ? apiRequest.streamComplete : undefined
      const body = await readBody(response, { maxBytes, host, complete })
      return { status: response.status, contentType, body }
    } catch (error) {
      // An aborted fetch rejects with the abort reason or a DOMException; the signal knows which.
      throwIfAborted(limit.signal)
      throw networkFailure(error, host)
    } finally {
      limit.dispose()
    }
  }

  return { request, close }
}
