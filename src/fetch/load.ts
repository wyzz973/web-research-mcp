/** Fetch one URL, convert it, classify failures, and freeze the result as a snapshot. */
import { createHash } from 'node:crypto'
import type { Config } from '../config.ts'
import type { Snapshot, Store } from '../contract.ts'
import { WebError } from '../errors.ts'
import { extractFromText, extractHtml } from '../extract/index.ts'
import {
  assertPlausibleQuery,
  safeGet,
  validateUrl,
  type NetworkDependencies,
  type SafeResponse,
} from '../net/safe-http.ts'
import { createHostGate } from './host-gate.ts'
import { createRobotsCheck } from './robots.ts'
import {
  classifyContent,
  classifyStatus,
  contentKind,
  mediaType,
  unreadable,
  unsupportedType,
} from './classify.ts'

export interface LoadedSnapshot {
  snapshot: Snapshot
  cache: 'miss' | 'hit'
  cacheAgeS?: number
}

export interface LoaderDependencies {
  config: Config
  store: Store
  network?: NetworkDependencies
  now: () => Date
  /** Pause between request starts to one host. Tests set 0. */
  hostIntervalMs?: number
}

export type PageLoader = (
  url: string,
  fresh: boolean,
  signal: AbortSignal,
) => Promise<LoadedSnapshot>

const ACCEPT = 'text/markdown, text/html;q=0.9, text/plain;q=0.8'
/** A stored snapshot answers repeat reads of the same URL for a day; `fresh` overrides it. */
const REUSE_SECONDS = 24 * 3600
const MIN_EXTRACT_MS = 1000
const HOST_CONNECTIONS = 2
const HOST_INTERVAL_MS = 500

interface Converted {
  title: string
  markdown: string
  hiddenRemoved: number
}

function ageSeconds(snapshot: Snapshot, now: Date): number {
  return Math.max(0, Math.round((now.getTime() - Date.parse(snapshot.retrieved_at)) / 1000))
}

function looksBinary(body: Buffer): boolean {
  return body.subarray(0, 1024).includes(0)
}

export function createPageLoader(dependencies: LoaderDependencies): PageLoader {
  const { config, store, now } = dependencies
  const gate = createHostGate(HOST_CONNECTIONS, dependencies.hostIntervalMs ?? HOST_INTERVAL_MS)
  const pace = (url: URL, signal: AbortSignal): Promise<void> => gate.pace(url.host, signal)
  const robots = createRobotsCheck({
    config,
    store,
    beforeRequest: pace,
    ...(dependencies.network ? { network: dependencies.network } : {}),
  })

  /**
   * Every hop must be allowed by robots rules; the check is a cache lookup after the first hop
   * on a host. Waiting is only paid when the host changes, and not at all when robots.txt was
   * downloaded a moment ago, because that request already took this fetch's turn.
   */
  function hopGuard(): (url: URL, signal: AbortSignal) => Promise<void> {
    let previousHost: string | undefined
    return async (url, signal) => {
      const newHost = url.host !== previousHost
      previousHost = url.host
      const downloaded = await robots(url, signal, newHost)
      if (newHost && !downloaded) await pace(url, signal)
    }
  }

  function reusable(url: string): LoadedSnapshot | undefined {
    const snapshot = store.latestSnapshotForUrl(url)
    if (!snapshot) return undefined
    const cacheAgeS = ageSeconds(snapshot, now())
    return cacheAgeS < REUSE_SECONDS ? { snapshot, cache: 'hit', cacheAgeS } : undefined
  }

  async function convertHtml(
    response: SafeResponse,
    requested: URL,
    budgetMs: number,
    signal: AbortSignal,
  ): Promise<Converted> {
    const reply = await extractHtml(
      { html: response.body, url: response.url.href, contentType: response.contentType },
      { timeoutMs: budgetMs, memoryMb: config.fetch.extractMemoryMb },
      signal,
    )
    const signals = reply.ok ? reply.value.signals : reply.signals
    const failure = signals && classifyContent(signals, { requested, final: response.url })
    if (failure) throw failure
    if (!reply.ok) throw unreadable()
    return reply.value
  }

  async function convert(
    response: SafeResponse,
    requested: URL,
    startedAt: number,
    signal: AbortSignal,
  ): Promise<Converted> {
    const kind = contentKind(response.contentType)
    const untyped = mediaType(response.contentType) === ''
    if (kind === 'unsupported' || response.bodySkipped || (untyped && looksBinary(response.body)))
      // A skipped body has no measured size; saying "0 bytes" would be a guess.
      throw unsupportedType(
        response.contentType,
        response.declaredBytes ?? (response.bodySkipped ? undefined : response.body.length),
      )
    if (response.body.length === 0) throw unreadable()
    if (kind === 'text') return extractFromText(response.body, response.contentType)
    // One deadline covers the whole page: conversion only gets what the download left over.
    const left = config.fetch.timeoutMs - (Date.now() - startedAt)
    const budgetMs = Math.min(config.fetch.extractTimeoutMs, Math.max(MIN_EXTRACT_MS, left))
    return convertHtml(response, requested, budgetMs, signal)
  }

  function freeze(requested: URL, response: SafeResponse, converted: Converted): Snapshot {
    return store.insertSnapshot(
      {
        url: requested.href,
        final_url: response.url.href,
        http_status: response.status,
        content_type: mediaType(response.contentType) || 'text/html',
        title: converted.title,
        markdown: converted.markdown,
        sha256: createHash('sha256').update(converted.markdown, 'utf8').digest('hex'),
        retrieved_at: now().toISOString(),
        hidden_removed: converted.hiddenRemoved,
      },
      config.ttl.snapshotSeconds,
    )
  }

  return async (rawUrl, fresh, signal) => {
    const requested = validateUrl(rawUrl)
    assertPlausibleQuery(requested)
    const cached = fresh ? undefined : reusable(requested.href)
    if (cached) return cached
    // Time spent queueing for a host slot is not the page's fault and is not charged to it.
    let startedAt = Date.now()
    const response = await gate.withSlot(requested.host, signal, () => {
      startedAt = Date.now()
      return safeGet(
        requested.href,
        {
          userAgent: config.userAgent,
          accept: ACCEPT,
          timeoutMs: config.fetch.timeoutMs,
          maxBytes: config.fetch.maxBytes,
          maxRedirects: config.fetch.maxRedirects,
          wantsBody: (contentType) => contentKind(contentType) !== 'unsupported',
          beforeHop: hopGuard(),
        },
        signal,
        dependencies.network,
      )
    })
    const failure = classifyStatus(response, now())
    if (failure) throw failure
    const converted = await convert(response, requested, startedAt, signal)
    if (converted.markdown.trim() === '') throw unreadable()
    return { snapshot: freeze(requested, response, converted), cache: 'miss' }
  }
}

/** Anything that is not already a WebError must not leak its text into a tool result. */
export function asWebError(error: unknown): WebError {
  if (error instanceof WebError) return error
  if (error instanceof Error && error.name === 'AbortError')
    return new WebError('cancelled', 'The request was cancelled.')
  return new WebError('internal', 'An unexpected internal error occurred while reading the page.')
}
