import { Resolver } from 'node:dns/promises'
import { isIP } from 'node:net'
import { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import { createBrotliDecompress, createGunzip, createInflate } from 'node:zlib'
import ipaddr from 'ipaddr.js'
import { Agent, request } from 'undici'
import { AppError, throwIfAborted } from '../shared/errors.ts'
import { matchesScope } from '../shared/domain-scope.ts'
import type { DomainScope } from '../shared/types.ts'

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
/** Test-only assembly seam. Each connection receives an already verified, pinned address. */
export interface FetchDependencies {
  resolve?: (hostname: string, signal: AbortSignal) => Promise<readonly Address[]>
  connect?: (
    url: URL,
    address: Address,
    signal: AbortSignal,
    userAgent: string,
  ) => Promise<NetworkResponse>
}

export function validateUrl(raw: string, scope?: DomainScope): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new AppError('INVALID_ARGUMENT', 'Invalid HTTP URL.')
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.port ||
    url.hostname.includes('%')
  ) {
    throw new AppError('FETCH_BLOCKED', 'Only anonymous HTTP(S) on its default port is permitted.')
  }
  if (scope && !matchesScope(url.href, scope))
    throw new AppError('FETCH_BLOCKED', 'The URL is outside the requested domain scope.')
  url.hash = ''
  return url
}

export function isPublicAddress(address: string): boolean {
  try {
    const parsed = ipaddr.parse(address)
    return parsed.range() === 'unicast'
  } catch {
    return false
  }
}

export async function resolvePublic(
  url: URL,
  signal: AbortSignal,
  resolve = resolveDns,
): Promise<Address> {
  throwIfAborted(signal)
  const hostname = url.hostname.replace(/^\[|\]$/g, '')
  const family = isIP(hostname)
  const addresses: readonly Address[] =
    family === 4 || family === 6 ? [{ address: hostname, family }] : await resolve(hostname, signal)
  throwIfAborted(signal)
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new AppError('FETCH_BLOCKED', 'DNS must resolve exclusively to public unicast addresses.')
  }
  const selected = addresses[0]
  if (!selected) throw new AppError('UPSTREAM_UNAVAILABLE', 'DNS returned no addresses.', true)
  return selected
}

async function resolveDns(hostname: string, signal: AbortSignal): Promise<readonly Address[]> {
  const resolver = new Resolver()
  const cancel = () => resolver.cancel()
  signal.addEventListener('abort', cancel, { once: true })
  try {
    throwIfAborted(signal)
    const answers = await Promise.allSettled([
      resolver.resolve4(hostname),
      resolver.resolve6(hostname),
    ])
    throwIfAborted(signal)
    const addresses: Address[] = []
    for (const [index, result] of answers.entries()) {
      if (result.status === 'fulfilled')
        for (const address of result.value) addresses.push({ address, family: index === 0 ? 4 : 6 })
    }
    if (!addresses.length)
      throw new AppError('UPSTREAM_UNAVAILABLE', 'DNS resolution failed.', true)
    return addresses
  } finally {
    signal.removeEventListener('abort', cancel)
  }
}

export async function connectPinned(
  url: URL,
  address: Address,
  signal: AbortSignal,
  userAgent: string,
): Promise<NetworkResponse> {
  // A fresh dispatcher owns exactly this connection. The lookup never re-resolves DNS.
  const dispatcher = new Agent({
    connect: {
      lookup: (_host, options, callback) => {
        if (options.all) callback(null, [address])
        else callback(null, address.address, address.family)
      },
    },
    headersTimeout: 0,
    bodyTimeout: 0,
  })
  try {
    const response = await request(url, {
      dispatcher,
      signal,
      method: 'GET',
      headers: {
        'user-agent': userAgent,
        accept: 'text/html,application/xhtml+xml,text/plain,text/markdown;q=0.9',
        'accept-encoding': 'gzip, deflate, br',
      },
    })
    return {
      status: response.statusCode,
      headers: response.headers,
      body: response.body,
      close: async () => {
        // Destroying an unread Undici body emits UND_ERR_ABORTED. Observe the
        // terminal event before destroying it, including redirect/error bodies.
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

export function header(response: NetworkResponse, name: string): string {
  const value = response.headers[name]
  return Array.isArray(value) ? (value[0] ?? '') : (value ?? '')
}

export async function readBody(
  response: NetworkResponse,
  signal: AbortSignal,
  compressedLimit: number,
  decompressedLimit: number,
): Promise<Buffer> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of response.body) {
    throwIfAborted(signal)
    bytes += chunk.byteLength
    if (bytes > compressedLimit)
      throw new AppError(
        'RESPONSE_TOO_LARGE',
        'Compressed response exceeds the configured byte limit.',
      )
    chunks.push(Buffer.from(chunk))
  }
  throwIfAborted(signal)
  const raw = Buffer.concat(chunks)
  const encoding = header(response, 'content-encoding').trim().toLowerCase()
  if (!encoding || encoding === 'identity') {
    if (raw.length > decompressedLimit)
      throw new AppError('RESPONSE_TOO_LARGE', 'Response exceeds the configured byte limit.')
    return raw
  }
  const inflater =
    encoding === 'gzip'
      ? createGunzip()
      : encoding === 'br'
        ? createBrotliDecompress()
        : encoding === 'deflate'
          ? createInflate()
          : null
  if (!inflater)
    throw new AppError('UNSUPPORTED_CONTENT_TYPE', 'Unsupported response content encoding.')
  const cancel = () => inflater.destroy(new AppError('CANCELLED', 'Decompression was cancelled.'))
  signal.addEventListener('abort', cancel, { once: true })
  const decoded: Buffer[] = []
  let total = 0
  const source = Readable.from([raw])
  try {
    throwIfAborted(signal)
    source.pipe(inflater)
    for await (const chunk of inflater) {
      throwIfAborted(signal)
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      total += buffer.length
      if (total > decompressedLimit)
        throw new AppError(
          'RESPONSE_TOO_LARGE',
          'Decompressed response exceeds the configured byte limit.',
        )
      decoded.push(buffer)
    }
    return Buffer.concat(decoded)
  } finally {
    signal.removeEventListener('abort', cancel)
    source.destroy()
    inflater.destroy()
  }
}
