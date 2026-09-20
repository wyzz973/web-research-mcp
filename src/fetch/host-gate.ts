import { throwIfAborted } from '../errors.ts'
import { createLimiter, type Limited } from './limiter.ts'

export interface HostGate {
  /** Resolves when the next request to this host may start. */
  pace(host: string, signal: AbortSignal): Promise<void>
  /** Runs the task while holding one of the host's connection slots. */
  withSlot<T>(host: string, signal: AbortSignal, task: () => Promise<T>): Promise<T>
}

const MAX_TRACKED_HOSTS = 256

function delay(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(timer)
      try {
        throwIfAborted(signal)
      } catch (error) {
        reject(error)
      }
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Politeness towards one host: a few connections at a time and a pause between request starts. */
export function createHostGate(perHost: number, minIntervalMs: number): HostGate {
  const nextStart = new Map<string, number>()
  const slots = new Map<string, { limited: Limited; users: number }>()

  function forget(now: number): void {
    if (nextStart.size <= MAX_TRACKED_HOSTS) return
    for (const [host, at] of nextStart) if (at <= now) nextStart.delete(host)
  }

  return {
    async pace(host, signal) {
      throwIfAborted(signal)
      const now = Date.now()
      // The start time is reserved before waiting, so concurrent callers queue up instead of
      // all waking at the same instant.
      const start = Math.max(now, nextStart.get(host) ?? 0)
      nextStart.set(host, start + minIntervalMs)
      forget(now)
      await delay(start - now, signal)
    },
    async withSlot(host, signal, task) {
      const entry = slots.get(host) ?? { limited: createLimiter(perHost), users: 0 }
      slots.set(host, entry)
      entry.users += 1
      try {
        return await entry.limited(signal, task)
      } finally {
        entry.users -= 1
        if (entry.users === 0) slots.delete(host)
      }
    },
  }
}
