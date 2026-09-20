import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WebError } from '../../src/errors.ts'
import { runCalls, type SourceCall } from '../../src/search/execute.ts'
import type { SourceAdapter } from '../../src/sources/types.ts'
import { delayed, fakeSource, hits, never } from './helpers.ts'

const timeouts = { softMs: 4000, hardMs: 8000 }

function callTo(adapter: SourceAdapter, query = 'q', index = 1): SourceCall {
  return {
    adapter,
    queryIndexes: [index],
    request: {
      queries: [query],
      goal: undefined,
      sites: [],
      recency: undefined,
      maxResults: 10,
      now: new Date(),
    },
  }
}

beforeEach(() => {
  vi.useFakeTimers({
    toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'],
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('runCalls', () => {
  it('sends every call at once and returns the outcomes in call order', async () => {
    const slow = fakeSource('slow', delayed(900, hits('slow', 2)))
    const fast = fakeSource('fast', delayed(100, hits('fast', 3)))
    const pending = runCalls([callTo(slow), callTo(fast)], timeouts, never)
    await vi.advanceTimersByTimeAsync(100)
    expect([slow.requests.length, fast.requests.length]).toEqual([1, 1])
    await vi.advanceTimersByTimeAsync(800)

    const outcomes = await pending
    expect(
      outcomes.map((outcome) => [outcome.call.adapter.id, outcome.hits.length, outcome.ms]),
    ).toEqual([
      ['slow', 2, 900],
      ['fast', 3, 100],
    ])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops waiting at the soft deadline once another source has answered, and aborts the straggler', async () => {
    let stragglerSignal: AbortSignal | undefined
    const straggler = fakeSource('straggler', (request, signal) => {
      stragglerSignal = signal
      return delayed(7000, hits('late', 1))(request, signal)
    })
    const quick = fakeSource('quick', delayed(1000, hits('quick', 2)))
    const pending = runCalls([callTo(straggler), callTo(quick)], timeouts, never)
    await vi.advanceTimersByTimeAsync(3999)
    expect(stragglerSignal?.aborted).toBe(false)
    await vi.advanceTimersByTimeAsync(1)

    const [late, answered] = await pending
    expect(answered?.hits).toHaveLength(2)
    expect(late).toMatchObject({ notAwaited: true, dispatched: true, hits: [], ms: 4000 })
    expect(stragglerSignal?.aborted).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('gives up on stragglers at once when the first answer arrives after the soft deadline', async () => {
    const straggler = fakeSource('straggler', delayed(7500, hits('late', 1)))
    const slow = fakeSource('slow', delayed(5000, hits('slow', 1)))
    const pending = runCalls([callTo(straggler), callTo(slow)], timeouts, never)
    await vi.advanceTimersByTimeAsync(5000)
    const [late, answered] = await pending
    expect(answered?.error).toBeUndefined()
    expect(late).toMatchObject({ notAwaited: true, ms: 5000 })
  })

  it('keeps waiting up to the hard limit while nobody has produced results', async () => {
    const empty = fakeSource('empty', delayed(500, []))
    const slow = fakeSource('slow', delayed(6000, hits('slow', 1)))
    const dead = fakeSource('dead', delayed(60_000, hits('dead', 1)))
    const pending = runCalls([callTo(empty), callTo(slow), callTo(dead)], timeouts, never)
    await vi.advanceTimersByTimeAsync(6000)

    const [none, late, hung] = await pending
    expect(none).toMatchObject({ hits: [], error: undefined })
    expect(late?.hits).toHaveLength(1)
    // Dropped the moment "slow" answered: the soft deadline had already passed.
    expect(hung).toMatchObject({ notAwaited: true, ms: 6000 })
  })

  it('enforces the hard limit on a call that is alone', async () => {
    const dead = fakeSource('dead', delayed(60_000, hits('dead', 1)))
    const pending = runCalls([callTo(dead)], timeouts, never)
    await vi.advanceTimersByTimeAsync(8000)
    const [outcome] = await pending
    expect(outcome?.error).toMatchObject({
      code: 'timeout',
      message: 'dead did not answer within 8000 ms.',
    })
    // Its own deadline passed: that is a failure of the source, unlike not being awaited.
    expect(outcome?.notAwaited).toBe(false)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('does not let an adapter that ignores its signal hold the search hostage', async () => {
    const deaf = fakeSource(
      'deaf',
      () => new Promise((resolve) => setTimeout(() => resolve(hits('deaf', 1)), 600_000)),
    )
    const pending = runCalls([callTo(deaf)], timeouts, never)
    await vi.advanceTimersByTimeAsync(8000 + 250)
    const [outcome] = await pending
    expect(outcome?.error?.code).toBe('timeout')
    expect(outcome?.ms).toBe(8250)
  })

  it('passes a caller abort to every call and reports cancelled', async () => {
    const controller = new AbortController()
    const signals: AbortSignal[] = []
    const watch = (id: string) =>
      fakeSource(id, (request, signal) => {
        signals.push(signal)
        return delayed(5000, hits(id, 1))(request, signal)
      })
    const pending = runCalls([callTo(watch('a')), callTo(watch('b'))], timeouts, controller.signal)
    await vi.advanceTimersByTimeAsync(200)
    controller.abort()
    await vi.advanceTimersByTimeAsync(0)

    const outcomes = await pending
    expect(outcomes.map((outcome) => outcome.error?.code)).toEqual(['cancelled', 'cancelled'])
    expect(outcomes.map((outcome) => outcome.notAwaited)).toEqual([false, false])
    expect(signals.map((signal) => signal.aborted)).toEqual([true, true])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('sends nothing when the caller had already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    const source = fakeSource('exa', hits('exa', 1))
    const [outcome] = await runCalls([callTo(source)], timeouts, controller.signal)
    expect(outcome).toMatchObject({ dispatched: false, error: { code: 'cancelled' } })
    expect(source.requests).toHaveLength(0)
  })

  it('keeps failures apart from results and never throws', async () => {
    const limited = fakeSource('limited', new WebError('rate_limited', 'slow down', 60))
    const broken = fakeSource('broken', () => {
      throw new TypeError('bug in adapter')
    })
    const fine = fakeSource('fine', hits('fine', 2))
    const pending = runCalls([callTo(limited), callTo(broken), callTo(fine)], timeouts, never)
    await vi.advanceTimersByTimeAsync(0)
    const outcomes = await pending

    expect(outcomes.map((outcome) => outcome.error?.code)).toEqual([
      'rate_limited',
      'internal',
      undefined,
    ])
    expect(outcomes[0]?.error?.retryAfterSeconds).toBe(60)
    expect(outcomes[1]?.error?.message).toBe('The broken adapter failed unexpectedly.')
  })

  it('runs at most three calls to one source at a time', async () => {
    let active = 0
    let peak = 0
    const busy = fakeSource('busy', async (request, signal) => {
      active += 1
      peak = Math.max(peak, active)
      const result = await delayed(300, hits(request.queries[0] ?? 'x', 1))(request, signal)
      active -= 1
      return result
    })
    const other = fakeSource('other', delayed(300, []))
    const calls = ['q1', 'q2', 'q3', 'q4', 'q5'].map((query, index) =>
      callTo(busy, query, index + 1),
    )
    const pending = runCalls([...calls, callTo(other)], timeouts, never)
    await vi.advanceTimersByTimeAsync(0)
    expect(busy.requests).toHaveLength(3)
    expect(other.requests).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(600)

    const outcomes = await pending
    expect(peak).toBe(3)
    expect(outcomes.filter((outcome) => outcome.hits.length === 1)).toHaveLength(5)
  })

  it('does not blame a source for an error it throws because we stopped waiting for it', async () => {
    const touchy = fakeSource(
      'touchy',
      (_request, signal) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener('abort', () =>
            reject(new WebError('upstream_error', 'socket closed')),
          )
        }),
    )
    const quick = fakeSource('quick', delayed(100, hits('quick', 1)))
    const pending = runCalls([callTo(touchy), callTo(quick)], timeouts, never)
    await vi.advanceTimersByTimeAsync(4000)
    const [dropped] = await pending
    expect(dropped).toMatchObject({ notAwaited: true, error: { code: 'upstream_error' } })
  })

  it('never sends the calls that were still queued when we stopped waiting', async () => {
    const busy = fakeSource('busy', delayed(5000, []))
    const quick = fakeSource('quick', delayed(100, hits('quick', 1)))
    const calls = ['q1', 'q2', 'q3', 'q4', 'q5'].map((query, index) =>
      callTo(busy, query, index + 1),
    )
    const pending = runCalls([...calls, callTo(quick)], timeouts, never)
    await vi.advanceTimersByTimeAsync(4000)

    const outcomes = await pending
    expect(busy.requests).toHaveLength(3)
    expect(outcomes.slice(3, 5)).toMatchObject([
      { dispatched: false, notAwaited: true },
      { dispatched: false, notAwaited: true },
    ])
  })

  it('marks queued calls that never started as not dispatched', async () => {
    const busy = fakeSource('busy', delayed(3900, []))
    const quick = fakeSource('quick', delayed(100, hits('quick', 1)))
    const calls = ['q1', 'q2', 'q3', 'q4'].map((query, index) => callTo(busy, query, index + 1))
    const pending = runCalls([...calls, callTo(quick)], timeouts, never)
    await vi.advanceTimersByTimeAsync(4000)

    const outcomes = await pending
    // q4 started at 3900 ms and was dropped at the soft deadline.
    expect(outcomes.slice(0, 3).map((outcome) => outcome.error)).toEqual([
      undefined,
      undefined,
      undefined,
    ])
    expect(outcomes[3]).toMatchObject({ dispatched: true, notAwaited: true })
    expect(busy.requests).toHaveLength(4)
  })
})
