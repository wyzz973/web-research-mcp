/**
 * One fresh search: choose sources, call them, fuse what came back. `fast` asks one source,
 * `standard` asks one and adds a second only when the first answer looks weak, `deep` asks up to
 * three at once. Nothing is retried: a failed source cools down and the next search avoids it.
 */
import type { Config } from '../config.ts'
import type { ResolvedSearch, SourceStatus, Store, ToolError } from '../contract.ts'
import type { SourceAdapter } from '../sources/types.ts'
import { recencyStart } from '../sources/shared.ts'
import type { Cooldowns } from './cooldown.ts'
import { runCalls, type CallOutcome, type SourceCall } from './execute.ts'
import { fuse, type FusedHit, type RankedList } from './fuse.ts'
import { queryLanguages } from './language.ts'
import { buildLineup, cooldownKey, walkLineup, type Hold, type LineupCursor } from './select.ts'
import {
  allFailedError,
  realErrors,
  representative,
  sourceStatus,
  type SourceFailure,
} from './status.ts'
import { queryCoverage, type Term } from './terms.ts'

export interface SearchTimeouts {
  softMs: number
  hardMs: number
  /** Ceiling for a whole `standard` search, second source included. */
  standardTotalMs: number
}

export const DEFAULT_TIMEOUTS: SearchTimeouts = {
  softMs: 4000,
  hardMs: 8000,
  standardTotalMs: 12_000,
}

export interface EngineContext {
  config: Config
  store: Store
  sources: readonly SourceAdapter[]
  cooldowns: Cooldowns
  now: () => Date
  timeouts: SearchTimeouts
}

export interface EngineResult {
  pool: FusedHit[]
  sources: SourceStatus[]
  calls: number
  costUsd: number
  /** Keyed sources this search sent a request to. */
  paidSources: string[]
  notes: string[]
  /** Set when no source produced an answer. */
  error: ToolError | undefined
}

const DEEP_SOURCES = 3
/** A failure the vendor answered with is not billed; anything after a request went out may be. */
const UNBILLED = new Set(['rate_limited', 'blocked', 'upstream_error', 'budget_exhausted'])
/** Below this share of the query's words in the top results, the answer is probably off topic. */
const WEAK_COVERAGE = 1 / 3
const COVERAGE_SAMPLE = 5
/** Share of the daily budget after which the model is told that paid sources are about to stop. */
const NEARLY_SPENT = 0.8

const NO_SOURCE =
  'no search source is available; set EXA_API_KEY, TAVILY_API_KEY or PARALLEL_API_KEY, or enable anonymous sources (WEB_RESEARCH_ANONYMOUS_SOURCES=1)'
const CAP_REACHED =
  'the daily cap for anonymous sources is reached; set EXA_API_KEY, TAVILY_API_KEY or PARALLEL_API_KEY, or raise WEB_RESEARCH_ANONYMOUS_DAILY_CAP'
const BUDGET_SPENT =
  'the daily budget for paid sources is spent and no free source is available; raise WEB_RESEARCH_DAILY_BUDGET_USD or enable anonymous sources (WEB_RESEARCH_ANONYMOUS_SOURCES=1)'

function perCallResults(search: ResolvedSearch): number {
  const factor = search.depth === 'deep' ? 2 : 1.5
  return Math.min(Math.max(Math.ceil(search.maxResults * factor), 10), 50)
}

function callCount(adapter: SourceAdapter, search: ResolvedSearch): number {
  return Math.ceil(search.queries.length / Math.max(1, adapter.maxQueriesPerCall ?? 1))
}

function callsFor(adapter: SourceAdapter, search: ResolvedSearch, now: Date): SourceCall[] {
  const size = Math.max(1, adapter.maxQueriesPerCall ?? 1)
  const calls: SourceCall[] = []
  for (let start = 0; start < search.queries.length; start += size) {
    const queries = search.queries.slice(start, start + size)
    calls.push({
      adapter,
      queryIndexes: queries.map((_, offset) => start + offset + 1),
      request: {
        queries,
        goal: search.goal,
        sites: search.sites,
        recency: search.recency,
        maxResults: perCallResults(search),
        now,
      },
    })
  }
  return calls
}

function lineupCursor(context: EngineContext, search: ResolvedSearch): LineupCursor {
  const { config, store, sources, cooldowns } = context
  const lineup = buildLineup({
    sources,
    cooldowns,
    callsToday: (source) => store.usageTodayBySource(source).calls,
    plannedCalls: (adapter) => callCount(adapter, search),
    paidAllowed: store.usageToday().cost_usd < config.limits.dailyBudgetUsd,
    anonymousDailyCap: config.sources.anonymousDailyCap,
    wantsFilters: search.sites.length > 0 || search.recency !== undefined,
  })
  return walkLineup(lineup)
}

type Held = ReadonlyArray<{ id: string; hold: Hold }>

/** Why nothing can run right now, leading with the reason the caller can do something about. */
function unavailable(held: Held): ToolError {
  const holds = held.map((entry) => entry.hold)
  const cooling = holds.filter((hold) => hold.kind === 'cooling')
  if (cooling.length) {
    const retryAfterS = Math.min(...cooling.map((hold) => hold.retryAfterS))
    const codes = cooling.map((hold) => hold.code)
    const code = codes.includes('rate_limited')
      ? 'rate_limited'
      : codes.every((entry) => entry === 'budget_exhausted')
        ? 'budget_exhausted'
        : 'upstream_error'
    return {
      code,
      message: `every search source is cooling down after a failure; retry after ${retryAfterS}s`,
      retry_after_s: retryAfterS,
    }
  }
  if (holds.some((hold) => hold.kind === 'cap'))
    return { code: 'budget_exhausted', message: CAP_REACHED }
  if (holds.some((hold) => hold.kind === 'budget'))
    return { code: 'budget_exhausted', message: BUDGET_SPENT }
  return { code: 'no_source_available', message: NO_SOURCE }
}

/**
 * Calls are entered in the ledger before they go out, so searches running at the same time see
 * each other and the anonymous cap holds under concurrency. Best effort: a locked state file
 * must not fail a search.
 */
function adjustUsage(context: EngineContext, source: string, calls: number, costUsd: number): void {
  try {
    context.store.addUsage(source, calls, costUsd)
  } catch {
    // The search matters more than the ledger entry.
  }
}

function reserve(context: EngineContext, calls: readonly SourceCall[]): void {
  for (const call of calls) adjustUsage(context, call.adapter.id, 1, 0)
}

/** Gives back what never went out, and prices what did. Returns the estimated cost. */
function settle(context: EngineContext, outcomes: readonly CallOutcome[]): number {
  let cost = 0
  for (const outcome of outcomes) {
    const { adapter } = outcome.call
    if (!outcome.dispatched) {
      adjustUsage(context, adapter.id, -1, 0)
      continue
    }
    const billed = !outcome.error || !UNBILLED.has(outcome.error.code)
    const price = billed && !adapter.free() ? (adapter.unitCostUsd?.() ?? 0) : 0
    if (price > 0) adjustUsage(context, adapter.id, 0, price)
    cost += price
  }
  return cost
}

function updateCooldown(
  context: EngineContext,
  adapter: SourceAdapter,
  own: readonly CallOutcome[],
): void {
  const errors = realErrors(own.filter((outcome) => outcome.dispatched)).filter(
    (error) => error.code !== 'cancelled',
  )
  const failure = representative(errors)
  if (failure) context.cooldowns.fail(cooldownKey(adapter), failure)
  else if (own.some((outcome) => !outcome.error)) context.cooldowns.succeed(cooldownKey(adapter))
}

interface Wave {
  adapters: SourceAdapter[]
  outcomes: CallOutcome[]
}

/** Why a single-source answer should be backed up by a second source, if at all. */
function weakness(
  wave: Wave,
  pool: readonly FusedHit[],
  search: ResolvedSearch,
  terms: readonly Term[],
): string | undefined {
  const failure = representative(realErrors(wave.outcomes))
  if (failure && pool.length === 0) return `failed (${failure.code})`
  if (pool.length === 0) return 'returned nothing'
  // "Few" is judged against what the source could have returned, not against a wish it cannot meet.
  const possible = wave.adapters.reduce(
    (sum, adapter) =>
      sum + (adapter.maxResultsPerCall?.() ?? search.maxResults) * callCount(adapter, search),
    0,
  )
  if (pool.length < Math.min(search.maxResults, possible) / 2) return 'returned few results'
  // One word proves little: semantic sources legitimately answer "js" with "JavaScript".
  if (terms.filter((term) => term.weight >= 2).length < 2) return undefined
  const texts = pool.slice(0, COVERAGE_SAMPLE).flatMap((hit) => [hit.title, ...hit.passages])
  return queryCoverage(terms, texts) < WEAK_COVERAGE ? 'barely matched the query' : undefined
}

function take(cursor: LineupCursor, count: number): SourceAdapter[] {
  const taken: SourceAdapter[] = []
  for (let adapter = cursor.next(); adapter; adapter = cursor.next()) {
    taken.push(adapter)
    if (taken.length >= count) break
  }
  return taken
}

function toLists(waves: readonly Wave[]): RankedList[] {
  return waves.flatMap((wave) =>
    wave.outcomes
      .filter((outcome) => !outcome.error)
      .map((outcome) => ({
        source: outcome.call.adapter.id,
        queries: outcome.call.queryIndexes,
        hits: outcome.hits,
      })),
  )
}

function fuseWaves(
  context: EngineContext,
  search: ResolvedSearch,
  waves: readonly Wave[],
): FusedHit[] {
  const since = search.recency
    ? recencyStart(search.recency, context.now()).toISOString().slice(0, 10)
    : undefined
  return fuse(toLists(waves), {
    sites: search.sites,
    since,
    languages: queryLanguages(search.queries),
  })
}

async function runWave(
  context: EngineContext,
  search: ResolvedSearch,
  adapters: SourceAdapter[],
  hardMs: number,
  signal: AbortSignal,
): Promise<Wave> {
  const calls = adapters.flatMap((adapter) => callsFor(adapter, search, context.now()))
  reserve(context, calls)
  const outcomes = await runCalls(calls, { softMs: context.timeouts.softMs, hardMs }, signal)
  return { adapters, outcomes }
}

function heldNotes(held: Held): string[] {
  const named = (kind: Hold['kind']) =>
    held.filter((entry) => entry.hold.kind === kind).map((entry) => entry.id)
  const overBudget = named('budget')
  const overCap = named('cap')
  return [
    ...(overBudget.length
      ? [`The daily budget is spent, so paid sources (${overBudget.join(', ')}) were not used.`]
      : []),
    ...(overCap.length
      ? [`The daily cap for anonymous calls is reached for ${overCap.join(', ')}.`]
      : []),
  ]
}

/** Spend stays out of the model's view until it matters: shortly before paid sources stop. */
function budgetNote(context: EngineContext): string[] {
  const budget = context.config.limits.dailyBudgetUsd
  try {
    const spent = context.store.usageToday().cost_usd
    return spent >= budget * NEARLY_SPENT
      ? [
          `Today's paid search budget is nearly spent ($${spent.toFixed(2)} of $${budget.toFixed(2)}).`,
        ]
      : []
  } catch {
    return []
  }
}

function summarize(
  context: EngineContext,
  waves: readonly Wave[],
  pool: FusedHit[],
  cursor: LineupCursor,
  notes: string[],
): EngineResult {
  const outcomes = waves.flatMap((wave) => wave.outcomes)
  const costUsd = settle(context, outcomes)
  const failures: SourceFailure[] = []
  const sources: SourceStatus[] = []
  const paid: string[] = []
  const waits: number[] = []
  for (const adapter of waves.flatMap((wave) => wave.adapters)) {
    const own = outcomes.filter((outcome) => outcome.call.adapter === adapter)
    updateCooldown(context, adapter, own)
    sources.push(sourceStatus(adapter.id, own))
    const failure = representative(realErrors(own))
    if (failure) failures.push({ source: adapter.id, error: failure })
    if (failure) waits.push(context.cooldowns.get(cooldownKey(adapter))?.retryAfterS ?? 0)
    if (!adapter.free() && own.some((outcome) => outcome.dispatched)) paid.push(adapter.id)
  }
  const answered = sources.some((source) => source.status === 'ok' || source.status === 'empty')
  return {
    pool,
    sources: [...sources, ...cursor.skipped()],
    calls: outcomes.filter((outcome) => outcome.dispatched).length,
    costUsd,
    paidSources: paid,
    notes: [...notes, ...heldNotes(cursor.holds()), ...(paid.length ? budgetNote(context) : [])],
    error: answered
      ? undefined
      : allFailedError(
          failures,
          waits.some(Boolean) ? Math.min(...waits.filter(Boolean)) : undefined,
        ),
  }
}

export async function runEngine(
  context: EngineContext,
  search: ResolvedSearch,
  terms: readonly Term[],
  signal: AbortSignal,
): Promise<EngineResult> {
  const began = performance.now()
  const cursor = lineupCursor(context, search)
  const first = take(cursor, search.depth === 'deep' ? DEEP_SOURCES : 1)
  const primary = first[0]
  if (!primary)
    return {
      pool: [],
      sources: cursor.skipped(),
      calls: 0,
      costUsd: 0,
      paidSources: [],
      notes: heldNotes(cursor.holds()),
      error: unavailable(cursor.holds()),
    }

  const waves = [await runWave(context, search, first, context.timeouts.hardMs, signal)]
  let pool = fuseWaves(context, search, waves)
  const notes: string[] = []
  const opening = waves[0]
  const weak =
    search.depth === 'standard' && opening ? weakness(opening, pool, search, terms) : undefined
  const remainingMs = context.timeouts.standardTotalMs - (performance.now() - began)
  const backup = weak && !signal.aborted && remainingMs > 0 ? cursor.next() : undefined
  if (backup) {
    const hardMs = Math.min(context.timeouts.hardMs, remainingMs)
    waves.push(await runWave(context, search, [backup], hardMs, signal))
    pool = fuseWaves(context, search, waves)
    notes.push(`${primary.id} ${weak}, so ${backup.id} was searched as well.`)
  } else if (weak && !signal.aborted) {
    notes.push(`${primary.id} ${weak}, and no other source was available to add.`)
  }
  return summarize(context, waves, pool, cursor, notes)
}
