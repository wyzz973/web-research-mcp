import { AsyncLocalStorage } from 'node:async_hooks'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createResilientProvider, type ResilientOptions } from '../src/search/resilient.ts'
import { AppError } from '../src/shared/errors.ts'
import type { SearchPage, SearchPageRequest, SearchProvider } from '../src/shared/types.ts'

const input: SearchPageRequest = { query: 'MCP tools', language: 'en', timeRange: 'any', page: 1 }
const page: SearchPage = {
  sources: [
    {
      url: 'https://example.com',
      title: 'MCP tools',
      snippet: 'Tools',
      engines: ['brave'],
      publishedAt: null,
    },
  ],
  errors: [],
  exhausted: false,
}
const signal = () => new AbortController().signal
const closers: (() => Promise<void>)[] = []
afterEach(async () => {
  for (const close of closers.splice(0).reverse()) await close()
  vi.useRealTimers()
})

function controlled(options: ResilientOptions = {}) {
  const calls: {
    input: SearchPageRequest
    signal: AbortSignal
    finish: (page: SearchPage) => void
    fail: (error: unknown) => void
    startedAt: number
  }[] = []
  let closed = 0
  const upstream: SearchProvider = {
    searchPage(request, abortSignal) {
      return new Promise<SearchPage>((resolve, reject) => {
        calls.push({
          input: request,
          signal: abortSignal,
          finish: resolve,
          fail: reject,
          startedAt: performance.now(),
        })
      })
    },
    close() {
      closed += 1
      for (const call of calls) call.fail(new AppError('CANCELLED', 'Closed fixture'))
      return Promise.resolve()
    },
  }
  const provider = createResilientProvider(upstream, { minIntervalMs: 0, ...options })
  closers.push(() => provider.close())
  return { provider, calls, closed: () => closed }
}

async function successful(fixture: ReturnType<typeof controlled>, request = input, value = page) {
  const result = fixture.provider.searchPage(request, signal())
  const call = fixture.calls.at(-1)
  if (!call) throw new Error('Expected upstream call')
  call.finish(value)
  return result
}

describe('bounded search availability wrapper', () => {
  it('coalesces identical in-flight calls, preserving separate immutable result ownership', async () => {
    const { provider, calls } = controlled()
    const first = provider.searchPage(input, signal())
    const second = provider.searchPage(input, signal())
    expect(calls).toHaveLength(1)
    calls[0]?.finish(page)
    const [a, b] = await Promise.all([first, second])
    expect(a).toEqual(page)
    expect(b).toEqual(page)
    expect(a).not.toBe(b)
    expect(a.sources).not.toBe(b.sources)
    expect(provider.inspect()).toMatchObject({ coalesced: 1, active: 0, queued: 0 })
  })

  it('does not cancel the shared upstream when one subscriber deadline expires', async () => {
    const { provider, calls } = controlled()
    const firstSignal = new AbortController()
    const first = provider.searchPage(input, firstSignal.signal)
    const failure = expect(first).rejects.toMatchObject({ code: 'TIMEOUT' })
    const second = provider.searchPage(input, signal())
    firstSignal.abort(new AppError('TIMEOUT', 'Deadline expired'))
    await failure
    expect(calls[0]?.signal.aborted).toBe(false)
    calls[0]?.finish(page)
    await expect(second).resolves.toEqual(page)
  })

  it('aborts actual I/O after the last subscriber leaves and never caches its late success', async () => {
    const { provider, calls } = controlled()
    const controller = new AbortController()
    const request = provider.searchPage(input, controller.signal)
    const failure = expect(request).rejects.toMatchObject({ code: 'CANCELLED' })
    controller.abort()
    await failure
    expect(calls[0]?.signal.aborted).toBe(true)
    const next = provider.searchPage(input, signal())
    expect(calls).toHaveLength(2)
    calls[0]?.finish(page)
    calls[1]?.finish(page)
    await next
    expect(provider.inspect().active).toBe(0)
  })

  it('honors queued cancellation without ever starting that upstream request', async () => {
    const { provider, calls } = controlled({ maxConcurrent: 1 })
    const first = provider.searchPage(input, signal())
    const controller = new AbortController()
    const second = provider.searchPage({ ...input, page: 2 }, controller.signal)
    const failure = expect(second).rejects.toMatchObject({ code: 'TIMEOUT' })
    expect(provider.inspect().queued).toBe(1)
    controller.abort(new AppError('TIMEOUT', 'Queue consumed deadline'))
    await failure
    calls[0]?.finish(page)
    await first
    expect(calls).toHaveLength(1)
    expect(provider.inspect().queued).toBe(0)
  })

  it('paces starts globally and never exceeds two actual in-flight requests', async () => {
    vi.useFakeTimers()
    const { provider, calls } = controlled({ minIntervalMs: 1000, maxConcurrent: 2 })
    const requests = [1, 2, 3].map((number) =>
      provider.searchPage({ ...input, page: number }, signal()),
    )
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(calls).toHaveLength(2)
    await vi.advanceTimersByTimeAsync(5000)
    expect(calls).toHaveLength(2)
    expect(provider.inspect().active).toBe(2)
    calls[0]?.finish(page)
    await requests[0]
    expect(calls).toHaveLength(3)
    expect((calls[1]?.startedAt ?? 0) - (calls[0]?.startedAt ?? 0)).toBeGreaterThanOrEqual(1000)
    expect((calls[2]?.startedAt ?? 0) - (calls[1]?.startedAt ?? 0)).toBeGreaterThanOrEqual(1000)
    calls[1]?.finish(page)
    calls[2]?.finish(page)
    await Promise.all(requests)
  })

  it('serves complete pages within TTL then performs a new request after expiry', async () => {
    vi.useFakeTimers()
    const fixture = controlled({ cacheTtlMs: 1000 })
    await successful(fixture)
    await vi.advanceTimersByTimeAsync(900)
    await expect(fixture.provider.searchPage(input, signal())).resolves.toEqual(page)
    expect(fixture.calls).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(100)
    await successful(fixture)
    expect(fixture.calls).toHaveLength(2)
    expect(fixture.provider.inspect().cache_hits).toBe(1)
  })

  it('never caches partial pages, thrown failures, or disabled-cache results', async () => {
    const fixture = controlled()
    const partial = { ...page, errors: ['UPSTREAM_BLOCKED: duckduckgo'] }
    await successful(fixture, input, partial)
    await successful(fixture, input, partial)
    expect(fixture.calls).toHaveLength(2)
    const failed = fixture.provider.searchPage(input, signal())
    const failure = expect(failed).rejects.toMatchObject({ code: 'UPSTREAM_BLOCKED' })
    fixture.calls[2]?.fail(new AppError('UPSTREAM_BLOCKED', 'CAPTCHA'))
    await failure
    expect(fixture.provider.inspect().cache_entries).toBe(0)
    const noCache = controlled({ cacheTtlMs: 0 })
    await successful(noCache)
    await successful(noCache)
    expect(noCache.calls).toHaveLength(2)
  })

  it('bounds cached entries with LRU eviction and rejects oversized cache entries', async () => {
    const fixture = controlled({ maxCacheEntries: 2 })
    await successful(fixture, { ...input, page: 1 })
    await successful(fixture, { ...input, page: 2 })
    await fixture.provider.searchPage({ ...input, page: 1 }, signal())
    await successful(fixture, { ...input, page: 3 })
    await successful(fixture, { ...input, page: 2 })
    expect(fixture.calls).toHaveLength(4)
    expect(fixture.provider.inspect().cache_entries).toBe(2)
    const tiny = controlled({ maxCacheBytes: 100 })
    await successful(tiny)
    expect(tiny.provider.inspect()).toMatchObject({ cache_entries: 0, cache_bytes: 0 })
  })

  it('keeps query, page, site, language, and time range distinct', async () => {
    const fixture = controlled()
    const variants: SearchPageRequest[] = [
      input,
      { ...input, query: 'MCP Tools' },
      { ...input, page: 2 },
      { ...input, site: 'example.com' },
      { ...input, language: 'zh' },
      { ...input, timeRange: 'day' },
    ]
    for (const variant of variants) await successful(fixture, variant)
    expect(fixture.calls.map((call) => call.input)).toEqual(variants)
  })

  it('bounds pending subscribers including duplicate calls, releasing capacity after cancellation', async () => {
    const { provider, calls } = controlled({ maxPending: 2 })
    const controller = new AbortController()
    const first = provider.searchPage(input, controller.signal)
    const failure = expect(first).rejects.toMatchObject({ code: 'CANCELLED' })
    const second = provider.searchPage(input, signal())
    await expect(provider.searchPage(input, signal())).rejects.toMatchObject({
      code: 'UPSTREAM_UNAVAILABLE',
      retryable: true,
    })
    controller.abort()
    await failure
    const third = provider.searchPage(input, signal())
    calls[0]?.finish(page)
    await Promise.all([second, third])
    expect(calls).toHaveLength(1)
  })

  it('rejects subscribers on close, aborts active I/O, and waits for provider cleanup', async () => {
    let release: (() => void) | undefined
    let actualSignal: AbortSignal | undefined
    const pending = Promise.withResolvers<SearchPage>()
    const provider = createResilientProvider(
      {
        searchPage(_request, abortSignal) {
          actualSignal = abortSignal
          return pending.promise
        },
        close() {
          return new Promise<void>((resolve) => {
            release = () => {
              pending.reject(new AppError('CANCELLED', 'Closed'))
              resolve()
            }
          })
        },
      },
      { minIntervalMs: 0 },
    )
    const request = provider.searchPage(input, signal())
    const failure = expect(request).rejects.toMatchObject({ code: 'CANCELLED' })
    const close = provider.close()
    expect(provider.close()).toBe(close)
    await failure
    expect(actualSignal?.aborted).toBe(true)
    let completed = false
    const tracked = close.then(() => {
      completed = true
    })
    await Promise.resolve()
    expect(completed).toBe(false)
    release?.()
    await tracked
    expect(provider.inspect()).toMatchObject({
      closed: true,
      active: 0,
      queued: 0,
      cache_entries: 0,
    })
    await expect(provider.searchPage(input, signal())).rejects.toMatchObject({ code: 'CANCELLED' })
  })

  it('binds trace events to each coalesced caller async context and reports cache age', async () => {
    const context = new AsyncLocalStorage<string>()
    const observed: { caller: string | undefined; type: string; age?: number }[] = []
    const fixture = controlled({
      onEvent(event) {
        observed.push({
          caller: context.getStore(),
          type: event.type,
          ...(event.cache_age_ms === undefined ? {} : { age: event.cache_age_ms }),
        })
      },
    })
    const a = context.run('a', () => fixture.provider.searchPage(input, signal()))
    const b = context.run('b', () => fixture.provider.searchPage(input, signal()))
    fixture.calls[0]?.finish(page)
    await Promise.all([a, b])
    await context.run('c', () => fixture.provider.searchPage(input, signal()))
    expect(observed).toContainEqual({ caller: 'b', type: 'coalesced' })
    expect(observed).toContainEqual({ caller: 'a', type: 'upstream_end' })
    expect(observed).toContainEqual({ caller: 'b', type: 'upstream_end' })
    expect(observed.find((event) => event.caller === 'c')).toMatchObject({
      type: 'cache_hit',
      age: expect.any(Number),
    })
  })

  it('evicts by aggregate serialized byte budget and caches legitimate zero results', async () => {
    const fixture = controlled({ maxCacheBytes: 300, maxCacheEntries: 10 })
    await successful(fixture, { ...input, page: 1 })
    await successful(fixture, { ...input, page: 2 })
    expect(fixture.provider.inspect().cache_entries).toBe(1)
    expect(fixture.provider.inspect().cache_bytes).toBeLessThanOrEqual(300)
    await successful(fixture, { ...input, page: 1 })
    expect(fixture.calls).toHaveLength(3)
    const empty = { sources: [], errors: [], exhausted: true }
    await successful(fixture, { ...input, page: 3 }, empty)
    await expect(fixture.provider.searchPage({ ...input, page: 3 }, signal())).resolves.toEqual(
      empty,
    )
    expect(fixture.calls).toHaveLength(4)
  })

  it('close clears delayed starts and rejects queued subscriptions without another upstream call', async () => {
    vi.useFakeTimers()
    const { provider, calls, closed } = controlled({ minIntervalMs: 1000 })
    const first = provider.searchPage(input, signal())
    const second = provider.searchPage({ ...input, page: 2 }, signal())
    const failures = [
      expect(first).rejects.toMatchObject({ code: 'CANCELLED' }),
      expect(second).rejects.toMatchObject({ code: 'CANCELLED' }),
    ]
    await provider.close()
    await Promise.all(failures)
    await vi.advanceTimersByTimeAsync(2000)
    expect(calls).toHaveLength(1)
    expect(closed()).toBe(1)
    expect(provider.inspect()).toMatchObject({ active: 0, queued: 0 })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('isolates observer failures and rejects invalid construction limits', async () => {
    const fixture = controlled({
      onEvent() {
        throw new Error('Observer failed')
      },
    })
    await expect(successful(fixture)).resolves.toEqual(page)
    expect(fixture.provider.inspect().observer_errors).toBeGreaterThan(0)
    expect(() => createResilientProvider(fixture.provider, { maxConcurrent: 0 })).toThrow(
      'maxConcurrent',
    )
  })
})
