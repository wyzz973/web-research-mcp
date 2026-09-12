import { AsyncResource } from 'node:async_hooks'
import { AppError, throwIfAborted } from '../shared/errors.ts'
import type { SearchPage, SearchPageRequest, SearchProvider } from '../shared/types.ts'

export interface SearchAvailabilityEvent {
  type: 'cache_hit' | 'cache_miss' | 'coalesced' | 'queued' | 'upstream_start' | 'upstream_end'
  page: number
  wait_ms?: number
  cache_age_ms?: number
  outcome?: 'ok' | 'partial' | 'error' | 'cancelled'
}

export interface ResilientOptions {
  cacheTtlMs?: number
  maxCacheEntries?: number
  maxCacheBytes?: number
  minIntervalMs?: number
  maxConcurrent?: number
  maxPending?: number
  /** Receives no query or URL. Bound to each caller's async context; observer errors are isolated. */
  onEvent?: (event: SearchAvailabilityEvent) => void
}

export interface ResilientDiagnostics {
  scope: 'process'
  closed: boolean
  requests: number
  cache_hits: number
  cache_misses: number
  coalesced: number
  provider_calls: number
  cache_entries: number
  cache_bytes: number
  active: number
  queued: number
  observer_errors: number
}

export interface ResilientProvider extends SearchProvider {
  inspect(): ResilientDiagnostics
}

interface Subscriber {
  resolve: (page: SearchPage) => void
  reject: (error: unknown) => void
  notify: (event: SearchAvailabilityEvent) => void
  signal: AbortSignal
  abort: () => void
}
interface Job {
  key: string
  request: SearchPageRequest
  controller: AbortController
  subscribers: Set<Subscriber>
  queuedAt: number
  started: boolean
}
interface CacheEntry {
  page: SearchPage
  createdAt: number
  bytes: number
}

function limit(value: number, name: string, allowZero = false): number {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new AppError('INVALID_ARGUMENT', `Invalid search availability option: ${name}.`)
  }
  return value
}

/** Owns the wrapped provider. Only complete successful pages are cached, without extending their TTL. */
export function createResilientProvider(
  provider: SearchProvider,
  options: ResilientOptions = {},
): ResilientProvider {
  const ttl = limit(options.cacheTtlMs ?? 60_000, 'cacheTtlMs', true)
  const maxEntries = limit(options.maxCacheEntries ?? 128, 'maxCacheEntries')
  const maxBytes = limit(options.maxCacheBytes ?? 8 * 1024 * 1024, 'maxCacheBytes')
  const interval = limit(options.minIntervalMs ?? 1000, 'minIntervalMs', true)
  const concurrency = limit(options.maxConcurrent ?? 2, 'maxConcurrent')
  const maxPending = limit(options.maxPending ?? 128, 'maxPending')
  const cache = new Map<string, CacheEntry>()
  const jobs = new Map<string, Job>()
  const queue: Job[] = []
  const running = new Set<Promise<void>>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let closePromise: Promise<void> | undefined
  let closed = false
  let nextStart = 0
  let cacheBytes = 0
  let active = 0
  let subscribersPending = 0
  const counters = {
    requests: 0,
    cache_hits: 0,
    cache_misses: 0,
    coalesced: 0,
    provider_calls: 0,
    observer_errors: 0,
  }

  function removeCache(key: string): void {
    const previous = cache.get(key)
    if (previous) cacheBytes -= previous.bytes
    cache.delete(key)
  }
  function prune(): void {
    const now = performance.now()
    for (const [key, entry] of cache) if (now - entry.createdAt >= ttl) removeCache(key)
  }
  function remember(key: string, page: SearchPage): void {
    if (ttl === 0 || page.errors.length > 0) return
    const bytes = Buffer.byteLength(JSON.stringify(page)) + Buffer.byteLength(key)
    if (bytes > maxBytes) return
    prune()
    removeCache(key)
    cache.set(key, { page: structuredClone(page), bytes, createdAt: performance.now() })
    cacheBytes += bytes
    while (cache.size > maxEntries || cacheBytes > maxBytes) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      removeCache(oldest)
    }
  }
  function detach(job: Job, subscriber: Subscriber): void {
    subscriber.signal.removeEventListener('abort', subscriber.abort)
    if (job.subscribers.delete(subscriber)) subscribersPending -= 1
  }
  function removeJob(job: Job): void {
    if (jobs.get(job.key) === job) jobs.delete(job.key)
    const index = queue.indexOf(job)
    if (index >= 0) queue.splice(index, 1)
  }
  function emit(job: Job, event: Omit<SearchAvailabilityEvent, 'page'>): void {
    for (const subscriber of job.subscribers)
      subscriber.notify({ ...event, page: job.request.page })
  }
  async function run(job: Job): Promise<void> {
    try {
      const page = await provider.searchPage(job.request, job.controller.signal)
      throwIfAborted(job.controller.signal)
      if (!closed) remember(job.key, page)
      emit(job, { type: 'upstream_end', outcome: page.errors.length ? 'partial' : 'ok' })
      for (const subscriber of job.subscribers) {
        detach(job, subscriber)
        subscriber.resolve(structuredClone(page))
      }
    } catch (error) {
      emit(job, {
        type: 'upstream_end',
        outcome: error instanceof AppError && error.code === 'CANCELLED' ? 'cancelled' : 'error',
      })
      for (const subscriber of job.subscribers) {
        detach(job, subscriber)
        subscriber.reject(error)
      }
    } finally {
      active -= 1
      removeJob(job)
      schedule()
    }
  }
  function schedule(): void {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    if (closed || active >= concurrency || queue.length === 0) return
    const delay = nextStart - performance.now()
    if (delay > 0) {
      timer = setTimeout(schedule, Math.ceil(delay))
      return
    }
    const job = queue.shift()
    if (!job) return
    job.started = true
    active += 1
    counters.provider_calls += 1
    nextStart = performance.now() + interval
    emit(job, { type: 'upstream_start', wait_ms: Math.round(performance.now() - job.queuedAt) })
    const task = run(job)
    running.add(task)
    // run handles upstream errors and settles every subscriber before this cleanup.
    task.then(
      () => running.delete(task),
      () => running.delete(task),
    )
    schedule()
  }

  async function searchPage(request: SearchPageRequest, signal: AbortSignal): Promise<SearchPage> {
    throwIfAborted(signal)
    if (closed) throw new AppError('CANCELLED', 'Search provider is closed.')
    counters.requests += 1
    const boundObserver = options.onEvent ? AsyncResource.bind(options.onEvent) : undefined
    const notify = (event: SearchAvailabilityEvent): void => {
      try {
        boundObserver?.(event)
      } catch {
        // Instrumentation must never strand subscribers or alter the returned search page.
        counters.observer_errors += 1
      }
    }
    // Every upstream query-shaping field participates, without lossy query normalization.
    const key = JSON.stringify([
      request.query,
      request.language,
      request.timeRange,
      request.site ?? null,
      request.page,
    ])
    prune()
    const cached = cache.get(key)
    if (cached) {
      cache.delete(key)
      cache.set(key, cached)
      counters.cache_hits += 1
      notify({
        type: 'cache_hit',
        page: request.page,
        cache_age_ms: Math.round(performance.now() - cached.createdAt),
      })
      return structuredClone(cached.page)
    }
    counters.cache_misses += 1
    notify({ type: 'cache_miss', page: request.page })
    if (subscribersPending >= maxPending) {
      throw new AppError('UPSTREAM_UNAVAILABLE', 'Search request queue is full; retry later.', true)
    }
    let job = jobs.get(key)
    if (job) {
      counters.coalesced += 1
      notify({ type: 'coalesced', page: request.page })
    } else {
      if (jobs.size >= maxPending)
        throw new AppError(
          'UPSTREAM_UNAVAILABLE',
          'Search request queue is full; retry later.',
          true,
        )
      job = {
        key,
        request: { ...request },
        controller: new AbortController(),
        subscribers: new Set(),
        queuedAt: performance.now(),
        started: false,
      }
      jobs.set(key, job)
      queue.push(job)
      notify({ type: 'queued', page: request.page })
    }
    const ownedJob = job
    return new Promise<SearchPage>((resolve, reject) => {
      const subscriber: Subscriber = {
        resolve,
        reject,
        notify,
        signal,
        abort() {
          detach(ownedJob, subscriber)
          try {
            throwIfAborted(signal)
          } catch (error) {
            reject(error)
          }
          if (ownedJob.subscribers.size === 0) {
            removeJob(ownedJob)
            ownedJob.controller.abort(
              new AppError('CANCELLED', 'All search subscribers cancelled.'),
            )
            schedule()
          }
        },
      }
      ownedJob.subscribers.add(subscriber)
      subscribersPending += 1
      signal.addEventListener('abort', subscriber.abort, { once: true })
      if (signal.aborted) subscriber.abort()
      else schedule()
    })
  }

  function close(): Promise<void> {
    if (closePromise) return closePromise
    closed = true
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    const error = new AppError('CANCELLED', 'Search provider is closing.')
    for (const job of jobs.values()) {
      for (const subscriber of job.subscribers) {
        detach(job, subscriber)
        subscriber.reject(error)
      }
      job.controller.abort(error)
    }
    queue.length = 0
    jobs.clear()
    cache.clear()
    cacheBytes = 0
    closePromise = (async () => {
      const results = await Promise.allSettled([
        Promise.resolve().then(() => provider.close()),
        ...running,
      ])
      const failed = results.find((result) => result.status === 'rejected')
      if (failed?.status === 'rejected') throw failed.reason
    })()
    return closePromise
  }

  return {
    searchPage,
    close,
    inspect() {
      prune()
      return {
        scope: 'process',
        closed,
        ...counters,
        cache_entries: cache.size,
        cache_bytes: cacheBytes,
        active,
        queued: queue.length,
      }
    },
  }
}
