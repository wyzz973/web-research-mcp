/**
 * Guarded HTTP GET for addresses chosen by a model or by a web page. Every hop is validated,
 * resolved, checked to be public unicast, and then connected to that exact address, so a DNS
 * answer cannot change between the check and the connection.
 */
import { Resolver } from 'node:dns/promises'
import { isIP } from 'node:net'
import { Readable, type Transform } from 'node:stream'
import { finished } from 'node:stream/promises'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import ipaddr from 'ipaddr.js'
import { Agent, request } from 'undici'
import { WebError, throwIfAborted } from '../errors.ts'

export interface Address {
  address: string
  family: 4 | 6
}

export interface NetworkResponse {
  status: number
  headers: Record<string, string | string[] | undefined>
  body: AsyncIterable<Uint8Array>
  close(): Promise<void>
}

export type RequestHeaders = Readonly<Record<string, string>>

/** Test seam. `connect` always receives an address that has already been verified and pinned. */
export interface NetworkDependencies {
  resolve?: (hostname: string, signal: AbortSignal) => Promise<readonly Address[]>
  connect?: (
    url: URL,
    address: Address,
    signal: AbortSignal,
    headers: RequestHeaders,
  ) => Promise<NetworkResponse>
}

export interface SafeGetOptions {
  userAgent: string
  accept: string
  timeoutMs: number
  maxBytes: number
  maxRedirects: number
  /** Return false to skip downloading a body that could not be used anyway. */
  wantsBody?: (contentType: string) => boolean
  /** Runs before every request, redirects included. Throw to refuse the hop (robots rules, pacing). */
  beforeHop?: (url: URL, signal: AbortSignal) => Promise<void>
}

export interface SafeResponse {
  status: number
  /** Address of the response that was finally read, after redirects. */
  url: URL
  redirects: number
  headers: NetworkResponse['headers']
  contentType: string
  /** Size announced by the server, when it announced one. */
  declaredBytes: number | undefined
  /** Decoded body. Empty when the body was skipped; a bounded sample for non-2xx responses. */
  body: Buffer
  bodySkipped: boolean
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
/** `URL.port` is empty for the scheme default, so '' covers 80 and 443. */
const ALLOWED_PORTS = new Set(['', '80', '443', '8080', '8443'])
const MAX_QUERY_CHARS = 2000
const ERROR_SAMPLE_BYTES = 256 * 1024
const DNS_TIMEOUT_MS = 5000

function unsafe(message: string): WebError {
  return new WebError('unsafe_url', message)
}

function isLocalName(hostname: string): boolean {
  const name = hostname.replace(/\.$/u, '').toLowerCase()
  return name === 'localhost' || name.endsWith('.localhost')
}

/** Syntax-level policy. Address-level policy is enforced by `resolvePublic` on every hop. */
export function validateUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new WebError(
      'invalid_input',
      'The URL could not be parsed; pass a full https:// address.',
    )
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:')
    throw unsafe('Only http:// and https:// addresses can be read.')
  if (url.username || url.password)
    throw unsafe('Addresses with embedded credentials are refused; use the plain public address.')
  if (!ALLOWED_PORTS.has(url.port))
    throw unsafe('Only ports 80, 443, 8080, and 8443 can be read; this port is refused.')
  if (!url.hostname || url.hostname.includes('%') || isLocalName(url.hostname))
    throw unsafe(
      'The address does not name a public host; this is refused and must not be retried.',
    )
  url.hash = ''
  return url
}

/**
 * A sanity limit on addresses a model wrote, nothing more. It does not keep data from leaving
 * through a URL: a short query, a path, or a host name carries data just as well.
 */
export function assertPlausibleQuery(url: URL): void {
  if (url.search.length > MAX_QUERY_CHARS)
    throw unsafe(
      `The query string is longer than ${MAX_QUERY_CHARS} characters, which this reader refuses; request the page with a shorter address.`,
    )
}

/** Only globally routable unicast passes; mapped, NAT64, 6to4, and Teredo forms are all refused. */
export function isPublicAddress(address: string): boolean {
  try {
    return ipaddr.parse(address).range() === 'unicast'
  } catch {
    return false
  }
}

async function resolveDns(hostname: string, signal: AbortSignal): Promise<readonly Address[]> {
  const resolver = new Resolver({ timeout: DNS_TIMEOUT_MS, tries: 2 })
  const cancel = (): void => resolver.cancel()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    throwIfAborted(signal)
    const [v4, v6] = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ])
    throwIfAborted(signal)
    const addresses: Address[] = []
    if (v4.status === 'fulfilled')
      for (const address of v4.value) addresses.push({ address, family: 4 })
    if (v6.status === 'fulfilled')
      for (const address of v6.value) addresses.push({ address, family: 6 })
    return addresses
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

/** Every answer must be public: one private record among public ones is a rebinding setup. */
export async function resolvePublic(
  url: URL,
  signal: AbortSignal,
  resolve: NonNullable<NetworkDependencies['resolve']> = resolveDns,
): Promise<Address> {
  throwIfAborted(signal)
  const hostname = url.hostname.replace(/^\[|\]$/gu, '')
  const family = isIP(hostname)
  const addresses: readonly Address[] =
    family === 4 || family === 6 ? [{ address: hostname, family }] : await resolve(hostname, signal)
  throwIfAborted(signal)
  const first = addresses[0]
  if (!first)
    throw new WebError(
      'upstream_error',
      'The host name did not resolve; check the address or try another source.',
    )
  if (addresses.some(({ address }) => !isPublicAddress(address)))
    throw unsafe(
      'The host resolves to a private, loopback, link-local, or metadata address; this is refused and must not be retried.',
    )
  return first
}

/** A fresh dispatcher owns exactly one connection, and its lookup never consults DNS again. */
export async function connectPinned(
  url: URL,
  address: Address,
  signal: AbortSignal,
  headers: RequestHeaders,
): Promise<NetworkResponse> {
  const dispatcher = new Agent({
    connect: {
      lookup: (_hostname, options, callback) => {
        if (options.all) callback(null, [address])
        else callback(null, address.address, address.family)
      },
    },
    headersTimeout: 0,
    bodyTimeout: 0,
  })
  try {
    const response = await request(url, { dispatcher, signal, method: 'GET', headers })
    return {
      status: response.statusCode,
      headers: response.headers,
      body: response.body,
      close: async () => {
        // Destroying an unread undici body emits UND_ERR_ABORTED; observe the terminal event
        // first so it never surfaces as an unhandled error.
        const drained = finished(response.body, { cleanup: true }).catch(() => undefined)
        response.body.destroy()
        await dispatcher.destroy()
        await drained
      },
    }
  } catch (error) {
    await dispatcher.destroy()
    throw error
  }
}

export function header(response: Pick<NetworkResponse, 'headers'>, name: string): string {
  const value = response.headers[name]
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

function readableLimit(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

function tooLarge(limit: number): WebError {
  return new WebError(
    'too_large',
    `The response is larger than the ${readableLimit(limit)} limit; look for a smaller page or a text version.`,
  )
}

async function readRaw(
  response: NetworkResponse,
  signal: AbortSignal,
  limit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of response.body) {
    throwIfAborted(signal)
    bytes += chunk.byteLength
    if (bytes > limit) throw tooLarge(limit)
    chunks.push(Buffer.from(chunk))
  }
  throwIfAborted(signal)
  return Buffer.concat(chunks)
}

function inflaterFor(encoding: string): Transform | undefined {
  if (encoding === 'gzip' || encoding === 'x-gzip') return createGunzip()
  if (encoding === 'br') return createBrotliDecompress()
  if (encoding === 'deflate') return createInflate()
  return undefined
}

async function inflate(
  raw: Buffer,
  inflater: Transform,
  signal: AbortSignal,
  limit: number,
): Promise<Buffer> {
  const source = Readable.from([raw])
  const stream = source.pipe(inflater)
  const cancel = (): void => void stream.destroy()
  signal.addEventListener('abort', cancel, { once: true })
  const decoded: Buffer[] = []
  let total = 0
  try {
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
      total += buffer.length
      // The limit applies to the decoded size too, otherwise a small bomb expands without bound.
      if (total > limit) throw tooLarge(limit)
      decoded.push(buffer)
    }
    return Buffer.concat(decoded)
  } catch (error) {
    throwIfAborted(signal)
    if (error instanceof WebError) throw error
    throw new WebError('upstream_error', 'The response body could not be decompressed.')
  } finally {
    signal.removeEventListener('abort', cancel)
    source.destroy()
    stream.destroy()
  }
}

/** Reads the whole body under one limit that applies before and after decompression. */
export async function readBody(
  response: NetworkResponse,
  signal: AbortSignal,
  limit: number,
): Promise<Buffer> {
  const raw = await readRaw(response, signal, limit)
  const encoding = header(response, 'content-encoding').trim().toLowerCase()
  if (!encoding || encoding === 'identity') return raw
  const inflater = inflaterFor(encoding)
  if (!inflater)
    throw new WebError('upstream_error', 'The response uses an unsupported content encoding.')
  return inflate(raw, inflater, signal, limit)
}

function nextHop(current: URL, location: string, hop: number, maxRedirects: number): URL {
  if (hop >= maxRedirects)
    throw new WebError(
      'upstream_error',
      `The site redirected more than ${maxRedirects} times; request the final address directly.`,
    )
  if (!location)
    throw new WebError('upstream_error', 'The site sent a redirect without a target address.')
  let raw: string
  try {
    raw = new URL(location, current).href
  } catch {
    throw new WebError('upstream_error', 'The site sent a redirect to an unparseable address.')
  }
  const target = validateUrl(raw)
  if (current.protocol === 'https:' && target.protocol !== 'https:')
    throw unsafe('The site redirected from HTTPS to plain HTTP; the downgrade was refused.')
  return target
}

function declaredBytes(response: NetworkResponse): number | undefined {
  const value = Number(header(response, 'content-length'))
  return Number.isSafeInteger(value) && value >= 0 && header(response, 'content-length') !== ''
    ? value
    : undefined
}

async function errorSample(response: NetworkResponse, signal: AbortSignal): Promise<Buffer> {
  try {
    return await readBody(response, signal, ERROR_SAMPLE_BYTES)
  } catch {
    throwIfAborted(signal)
    return Buffer.alloc(0)
  }
}

async function readResponse(
  response: NetworkResponse,
  url: URL,
  redirects: number,
  options: SafeGetOptions,
  signal: AbortSignal,
): Promise<SafeResponse> {
  const contentType = header(response, 'content-type')
  const base = {
    status: response.status,
    url,
    redirects,
    headers: response.headers,
    contentType,
    declaredBytes: declaredBytes(response),
  }
  if (response.status < 200 || response.status >= 300)
    return { ...base, body: await errorSample(response, signal), bodySkipped: false }
  if (options.wantsBody && !options.wantsBody(contentType))
    return { ...base, body: Buffer.alloc(0), bodySkipped: true }
  if (base.declaredBytes !== undefined && base.declaredBytes > options.maxBytes)
    throw tooLarge(options.maxBytes)
  return { ...base, body: await readBody(response, signal, options.maxBytes), bodySkipped: false }
}

function requestHeaders(options: SafeGetOptions): RequestHeaders {
  return {
    'user-agent': options.userAgent,
    accept: options.accept,
    'accept-encoding': 'gzip, deflate, br',
  }
}

async function followRedirects(
  start: URL,
  options: SafeGetOptions,
  signal: AbortSignal,
  dependencies: NetworkDependencies,
): Promise<SafeResponse> {
  const connect = dependencies.connect ?? connectPinned
  const headers = requestHeaders(options)
  let current = start
  for (let hop = 0; ; hop += 1) {
    await options.beforeHop?.(current, signal)
    const address = await resolvePublic(current, signal, dependencies.resolve)
    const response = await connect(current, address, signal, headers)
    try {
      throwIfAborted(signal)
      if (!REDIRECT_STATUSES.has(response.status))
        return await readResponse(response, current, hop, options, signal)
      current = nextHop(current, header(response, 'location'), hop, options.maxRedirects)
    } finally {
      await response.close()
    }
  }
}

function transportError(error: unknown): WebError {
  const code =
    typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  if (code === 'UND_ERR_CONNECT_TIMEOUT')
    return new WebError('timeout', 'The site did not accept a connection in time; retry later.')
  // Only a fixed-format system error code is echoed, never text supplied by the remote side.
  const detail = /^[A-Z][A-Z0-9_]{2,40}$/u.test(code) ? ` (${code})` : ''
  return new WebError(
    'upstream_error',
    `The site could not be reached${detail}; retry later or try another source.`,
  )
}

/**
 * GET one public page. Redirects are followed by hand so each hop is re-validated; the deadline
 * covers DNS, every hop, and the body, and cancellation reaches the socket.
 */
export async function safeGet(
  rawUrl: string,
  options: SafeGetOptions,
  signal: AbortSignal,
  dependencies: NetworkDependencies = {},
): Promise<SafeResponse> {
  const start = validateUrl(rawUrl)
  assertPlausibleQuery(start)
  const deadline = new AbortController()
  const seconds = Math.round(options.timeoutMs / 100) / 10
  const timer = setTimeout(
    () =>
      deadline.abort(
        new WebError(
          'timeout',
          `The page did not finish loading within ${seconds}s; retry later or try another source.`,
        ),
      ),
    options.timeoutMs,
  )
  const combined = AbortSignal.any([signal, deadline.signal])
  try {
    return await followRedirects(start, options, combined, dependencies)
  } catch (error) {
    throwIfAborted(combined)
    throw error instanceof WebError ? error : transportError(error)
  } finally {
    clearTimeout(timer)
  }
}
