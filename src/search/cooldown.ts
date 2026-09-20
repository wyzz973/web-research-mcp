/**
 * Circuit breaker. A source that failed is left alone for a while instead of being retried:
 * anonymous tiers are shared, and hammering a limited endpoint only extends the limit.
 *
 * The state lives in the store, not in the process: a CLI run is a new process every time, and
 * several agents share one machine. The in-memory map only covers a store that cannot be used.
 */
import type { ErrorCode, Store } from '../contract.ts'
import type { WebError } from '../errors.ts'

export interface Cooling {
  code: ErrorCode
  /** Whole seconds until the source may be tried again; at least 1. */
  retryAfterS: number
}

export interface Cooldowns {
  get(source: string): Cooling | undefined
  fail(source: string, error: WebError): void
  succeed(source: string): void
}

const KIND = 'cooldown'
/** The vendor said no: waiting is the only fix. Anything else may be a passing fault. */
const REFUSED_S = 300
const FAULT_S = 30
const MAX_S = 3600
/** How long the failure count outlives the cooldown, so that a relapse still escalates. */
const STRIKE_MEMORY_S = 3600

interface Entry {
  until: number
  reason: ErrorCode
  strikes: number
}

function isEntry(value: unknown): value is Entry {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return (
    typeof entry.until === 'number' &&
    typeof entry.reason === 'string' &&
    typeof entry.strikes === 'number'
  )
}

/** A used-up quota comes back with the vendor's next day; local midnight is the closest we know. */
function secondsToLocalMidnight(now: Date): number {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)
  return Math.max(1, Math.ceil((midnight.getTime() - now.getTime()) / 1000))
}

function durationOf(error: WebError, strikes: number, now: Date): number {
  if (error.code === 'budget_exhausted') return secondsToLocalMidnight(now)
  const refused = error.code === 'rate_limited' || error.code === 'blocked'
  // Doubles with every consecutive failure, so a source that stays down is probed ever less.
  const backoff = Math.min((refused ? REFUSED_S : FAULT_S) * 2 ** (strikes - 1), MAX_S)
  return Math.max(backoff, Math.min(error.retryAfterSeconds ?? 0, MAX_S))
}

export function createCooldowns(now: () => Date, store: Store): Cooldowns {
  const memory = new Map<string, Entry>()

  function read(source: string): Entry | undefined {
    try {
      const stored = store.getRecord<unknown>(KIND, source)?.value
      if (isEntry(stored)) return stored
    } catch {
      // Fall through to what this process remembers.
    }
    return memory.get(source)
  }

  function write(source: string, entry: Entry, ttlSeconds: number): void {
    if (ttlSeconds > 0) memory.set(source, entry)
    else memory.delete(source)
    try {
      store.putRecord(KIND, source, entry, ttlSeconds)
    } catch {
      // The breaker still works for this process.
    }
  }

  return {
    get(source) {
      const entry = read(source)
      if (!entry) return undefined
      const remaining = Math.ceil((entry.until - now().getTime()) / 1000)
      return remaining > 0 ? { code: entry.reason, retryAfterS: remaining } : undefined
    },
    fail(source, error) {
      const strikes = (read(source)?.strikes ?? 0) + 1
      const seconds = durationOf(error, strikes, now())
      const entry = { until: now().getTime() + seconds * 1000, reason: error.code, strikes }
      write(source, entry, seconds + STRIKE_MEMORY_S)
    },
    succeed(source) {
      // Nothing to clear in the common case; a zero lifetime removes the record.
      if (read(source)) write(source, { until: 0, reason: 'internal', strikes: 0 }, 0)
    },
  }
}
