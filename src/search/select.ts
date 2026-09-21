/**
 * Source order for one search (docs/design/web-search.md, section 5): keyed sources first,
 * anonymous tiers after them, and within a tier whichever was used least today, so load spreads
 * instead of draining one free tier.
 *
 * Whether a source may be used is not decided here by reading the ledger: several processes
 * share the state file, and they would all read "one call left" together. The caller admits a
 * source by reserving its calls atomically (`admit`); a refusal puts the source on hold and the
 * walk moves on to the next one. The ledger is read only to order the sources.
 */
import type { ErrorCode, SourceStatus } from '../contract.ts'
import type { SourceAdapter } from '../sources/types.ts'
import type { Cooldowns } from './cooldown.ts'

export interface LineupInput {
  sources: readonly SourceAdapter[]
  cooldowns: Cooldowns
  /** Upstream calls booked today, per source id. Used for the order only, never as a gate. */
  callsToday(source: string): number
  /** The request restricts sites or dates; sources that filter upstream serve it better. */
  wantsFilters: boolean
}

/** Why a source sits this search out. */
export type Hold =
  | { kind: 'cooling'; code: ErrorCode; retryAfterS: number }
  /** The anonymous tier's self-imposed daily cap would be passed. */
  | { kind: 'cap' }
  /** Today's paid budget would be passed. */
  | { kind: 'budget' }
  /** The ledger could not be written, and money is not spent without a record of it. */
  | { kind: 'ledger' }
  /** A keyed source names a price that is not one, so it cannot be held to the budget. */
  | { kind: 'price' }

/** Books the calls a source would make. Returns the hold when they cannot be booked. */
export type Admit = (adapter: SourceAdapter) => Hold | undefined

interface Entry {
  adapter: SourceAdapter
  cooling: Hold | undefined
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

function coolingHold(adapter: SourceAdapter, cooldowns: Cooldowns): Hold | undefined {
  const cooling = cooldowns.get(cooldownKey(adapter))
  return cooling ? { kind: 'cooling', ...cooling } : undefined
}

/** An optional trait of outside code: anything but a plain `true` counts as "no". */
function filtersNatively(adapter: SourceAdapter): boolean {
  try {
    return adapter.nativeFilters?.() === true
  } catch {
    return false
  }
}

function filterPenalty(adapter: SourceAdapter, wantsFilters: boolean): number {
  return wantsFilters && !filtersNatively(adapter) ? 1 : 0
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
    entries: ranked.map(({ adapter }) => ({
      adapter,
      cooling: coolingHold(adapter, input.cooldowns),
    })),
  }
}

const HOLD_DETAIL: Record<Exclude<Hold['kind'], 'cooling'>, string> = {
  cap: 'daily anonymous cap reached',
  budget: 'daily budget reached',
  ledger: 'usage ledger unavailable',
  price: 'no usable price per call',
}

function skippedStatus(id: string, hold: Hold): SourceStatus {
  if (hold.kind !== 'cooling') return { id, status: 'skipped', detail: HOLD_DETAIL[hold.kind] }
  const detail =
    hold.code === 'budget_exhausted'
      ? 'quota used up; not tried again before local midnight'
      : `cooling down after ${hold.code}`
  return { id, status: 'skipped', retry_after_s: hold.retryAfterS, detail }
}

/** Hands out admitted sources in order and remembers the ones it had to pass over. */
export interface LineupCursor {
  /** The next source whose calls could be booked. Booking happens here, exactly once per source. */
  next(): SourceAdapter | undefined
  skipped(): SourceStatus[]
  /** The sources passed over so far and why. */
  holds(): ReadonlyArray<{ id: string; hold: Hold }>
}

export function walkLineup(lineup: Lineup, admit: Admit): LineupCursor {
  const passed: Array<{ id: string; hold: Hold }> = []
  let position = 0
  return {
    next() {
      for (let entry = lineup.entries[position]; entry; entry = lineup.entries[position]) {
        position += 1
        // A cooling source is not even asked: a reservation for it would only have to be undone.
        const hold = entry.cooling ?? admit(entry.adapter)
        if (!hold) return entry.adapter
        passed.push({ id: entry.adapter.id, hold })
      }
      return undefined
    },
    skipped: () => passed.map(({ id, hold }) => skippedStatus(id, hold)),
    holds: () => [...passed],
  }
}
