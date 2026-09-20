/**
 * Source order for one search (docs/design/web-search.md, section 5): keyed sources that are
 * within the daily budget first, anonymous tiers after them, and within a tier whichever was
 * used least today, so load spreads instead of draining one free tier. A source that cannot be
 * used right now keeps its place in the order and is reported as skipped when it is passed over.
 */
import type { ErrorCode, SourceStatus } from '../contract.ts'
import type { SourceAdapter } from '../sources/types.ts'
import type { Cooldowns } from './cooldown.ts'

export interface LineupInput {
  sources: readonly SourceAdapter[]
  cooldowns: Cooldowns
  /** Upstream calls already made or reserved today, per source id. */
  callsToday(source: string): number
  /** Upstream calls this search would make to the source. */
  plannedCalls(source: SourceAdapter): number
  /** False once today's estimated spend reached the budget. */
  paidAllowed: boolean
  anonymousDailyCap: number
  /** The request restricts sites or dates; sources that filter upstream serve it better. */
  wantsFilters: boolean
}

/** Why a source sits this search out. */
export type Hold =
  { kind: 'cooling'; code: ErrorCode; retryAfterS: number } | { kind: 'cap' } | { kind: 'budget' }

interface Entry {
  adapter: SourceAdapter
  hold: Hold | undefined
}

export interface Lineup {
  entries: Entry[]
}

/**
 * The anonymous tier and the keyed API of one vendor fail for different reasons (a shared rate
 * limit, an empty account), so each has its own breaker.
 */
export function cooldownKey(adapter: SourceAdapter): string {
  return adapter.free() ? adapter.id : `${adapter.id}:keyed`
}

function holdFor(adapter: SourceAdapter, calls: number, input: LineupInput): Hold | undefined {
  if (!adapter.free() && !input.paidAllowed) return { kind: 'budget' }
  if (adapter.free() && calls + input.plannedCalls(adapter) > input.anonymousDailyCap)
    return { kind: 'cap' }
  const cooling = input.cooldowns.get(cooldownKey(adapter))
  return cooling ? { kind: 'cooling', ...cooling } : undefined
}

function filterPenalty(adapter: SourceAdapter, wantsFilters: boolean): number {
  return wantsFilters && adapter.nativeFilters?.() !== true ? 1 : 0
}

export function buildLineup(input: LineupInput): Lineup {
  const ranked = input.sources
    .map((adapter, index) => ({ adapter, index, calls: input.callsToday(adapter.id) }))
    .toSorted(
      (a, b) =>
        filterPenalty(a.adapter, input.wantsFilters) -
          filterPenalty(b.adapter, input.wantsFilters) ||
        Number(a.adapter.free()) - Number(b.adapter.free()) ||
        a.calls - b.calls ||
        a.index - b.index,
    )
  return {
    entries: ranked.map(({ adapter, calls }) => ({
      adapter,
      hold: holdFor(adapter, calls, input),
    })),
  }
}

function skippedStatus(id: string, hold: Hold): SourceStatus {
  if (hold.kind === 'cap') return { id, status: 'skipped', detail: 'daily anonymous cap reached' }
  if (hold.kind === 'budget') return { id, status: 'skipped', detail: 'daily budget reached' }
  const detail =
    hold.code === 'budget_exhausted'
      ? 'quota used up; not tried again before local midnight'
      : `cooling down after ${hold.code}`
  return { id, status: 'skipped', retry_after_s: hold.retryAfterS, detail }
}

/** Hands out usable sources in order and remembers the held ones it had to pass over. */
export interface LineupCursor {
  next(): SourceAdapter | undefined
  /**
   * Status lines for the sources that sat this search out: those passed over, plus every source
   * that is over its cap or budget. Rotation ranks a capped source last, so it is rarely passed
   * over, yet the caller should still see that it is unavailable today.
   */
  skipped(): SourceStatus[]
  /** The sources passed over so far and why: these holds changed what this search could use. */
  holds(): ReadonlyArray<{ id: string; hold: Hold }>
}

export function walkLineup(lineup: Lineup): LineupCursor {
  const passed: Array<{ id: string; hold: Hold }> = []
  let position = 0
  return {
    next() {
      for (let entry = lineup.entries[position]; entry; entry = lineup.entries[position]) {
        position += 1
        if (!entry.hold) return entry.adapter
        passed.push({ id: entry.adapter.id, hold: entry.hold })
      }
      return undefined
    },
    skipped() {
      const unreached = lineup.entries
        .slice(position)
        .flatMap(({ adapter, hold }) =>
          hold && hold.kind !== 'cooling' ? [{ id: adapter.id, hold }] : [],
        )
      return [...passed, ...unreached].map(({ id, hold }) => skippedStatus(id, hold))
    },
    holds: () => [...passed],
  }
}
