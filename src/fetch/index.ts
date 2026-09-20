/**
 * web_fetch core: read pages as verbatim Markdown and find evidence in them. A page is fetched
 * once and frozen as a snapshot; every way of reading is a slice of that snapshot.
 */
import type { Config } from '../config.ts'
import type { FetchRequest, FetchResult, PageResult, ResolvedFetch, Store } from '../contract.ts'
import { WebError, toToolError } from '../errors.ts'
import type { NetworkDependencies } from '../net/safe-http.ts'
import { buildResult, failedPage, failedResult, okPage, type PageSource } from './assemble.ts'
import {
  atLeast,
  CALL_OVERHEAD,
  ERROR_PAGE_OVERHEAD,
  MIN_CONTENT,
  minus,
  PAGE_OVERHEAD,
  type Budget,
} from './budget.ts'
import { CURSOR_KIND, parseCursorState, type CursorState } from './cursor.ts'
import { createDocumentCache } from './document.ts'
import { createFoldCache } from './find.ts'
import { createLimiter } from './limiter.ts'
import { asWebError, createPageLoader, type LoadedSnapshot } from './load.ts'
import { normalizeFetch } from './normalize.ts'
import { describeReads, readByMode } from './modes.ts'
import { readFind, readGoal, readOnward, type PageRead, type ReadablePage } from './read.ts'
import { inheritedGoal, resolveTargets, type ResolvedTarget } from './targets.ts'

export type { NetworkDependencies } from '../net/safe-http.ts'

export interface Reader {
  /** Never throws: every failure becomes a page-level or an overall `error`. */
  fetch(request: FetchRequest, signal: AbortSignal): Promise<FetchResult>
  /** Cancels reads in flight and resolves once their sockets and workers are gone. */
  close(): Promise<void>
}

export interface ReaderDependencies {
  config: Config
  store: Store
  /** Test seam for DNS resolution and connecting. Production uses the real network. */
  network?: NetworkDependencies
  now?: () => Date
  /** Pause between request starts to one host, 500 ms by default. Tests set 0. */
  hostIntervalMs?: number
}

const PAGE_CONCURRENCY = 3
/** Cursors stay in a model's context; long enough that an expired one is never issued again. */
const CURSOR_ID_LENGTH = 8

type Outcome = { source: PageSource } | { failed: PageResult }

function scaled(budget: Budget, factor: number): Budget {
  return { tokens: budget.tokens * factor, chars: budget.chars * factor }
}

export function createReader(dependencies: ReaderDependencies): Reader {
  const { config, store } = dependencies
  const now = dependencies.now ?? (() => new Date())
  const loader = createPageLoader({ ...dependencies, now })
  const limited = createLimiter(PAGE_CONCURRENCY)
  const analyze = createDocumentCache()
  const fold = createFoldCache()
  const shutdown = new AbortController()
  const active = new Set<Promise<FetchResult>>()

  async function toSource(
    target: ResolvedTarget,
    loaded: LoadedSnapshot,
    signal: AbortSignal,
  ): Promise<PageSource> {
    const source: PageSource = {
      n: target.n,
      snapshot: loaded.snapshot,
      cache: loaded.cache,
      document: await analyze(loaded.snapshot.id, loaded.snapshot.markdown, signal),
    }
    if (target.ref !== undefined) source.ref = target.ref
    if (loaded.cacheAgeS !== undefined) source.cacheAgeS = loaded.cacheAgeS
    return source
  }

  function storedSnapshot(target: Extract<ResolvedTarget, { kind: 'snapshot' }>): LoadedSnapshot {
    const age = Math.round((now().getTime() - Date.parse(target.snapshot.retrieved_at)) / 1000)
    return { snapshot: target.snapshot, cache: 'hit', cacheAgeS: Math.max(0, age) }
  }

  async function loadTarget(
    target: ResolvedTarget,
    fresh: boolean,
    signal: AbortSignal,
  ): Promise<Outcome> {
    if (target.kind === 'error')
      return { failed: failedPage(target.n, target.url, target.ref, target.error) }
    const url = target.kind === 'snapshot' ? target.snapshot.url : target.url
    try {
      const loaded =
        target.kind === 'snapshot' && !fresh
          ? storedSnapshot(target)
          : await limited(signal, () => loader(url, fresh, signal))
      return { source: await toSource(target, loaded, signal) }
    } catch (error) {
      return { failed: failedPage(target.n, url, target.ref, asWebError(error).toToolError()) }
    }
  }

  function overhead(okPages: number, failedPages: number): Budget {
    return {
      tokens:
        CALL_OVERHEAD.tokens +
        okPages * PAGE_OVERHEAD.tokens +
        failedPages * ERROR_PAGE_OVERHEAD.tokens,
      chars:
        CALL_OVERHEAD.chars +
        okPages * PAGE_OVERHEAD.chars +
        failedPages * ERROR_PAGE_OVERHEAD.chars,
    }
  }

  /** Headers, footers, and error lines are paid first; every readable page keeps room for a paragraph. */
  function contentBudget(maxTokens: number, okPages: number, failedPages: number): Budget {
    const total: Budget = { tokens: maxTokens, chars: config.limits.maxOutputChars }
    const room = minus(total, overhead(okPages, failedPages))
    return atLeast(room, scaled(MIN_CONTENT, Math.max(1, okPages)))
  }

  function budgetTooSmall(maxTokens: number, okPages: number, failedPages: number): boolean {
    const room = maxTokens - overhead(okPages, failedPages).tokens
    return okPages > 0 && room < MIN_CONTENT.tokens * okPages
  }

  function saveCursor(state: CursorState | undefined): string | undefined {
    if (!state) return undefined
    return store.insertRecord(CURSOR_KIND, 'c_', state, config.ttl.searchSeconds, CURSOR_ID_LENGTH)
  }

  function finish(source: PageSource, read: PageRead): PageResult {
    if (read.error) return failedPage(source.n, source.snapshot.url, source.ref, read.error)
    return okPage(source, read, saveCursor(read.cursor))
  }

  function readablePages(sources: PageSource[]): ReadablePage[] {
    return sources.map((source) => ({
      n: source.n,
      snapshot: source.snapshot.id,
      document: source.document,
    }))
  }

  async function readTargets(plan: ResolvedFetch, signal: AbortSignal): Promise<FetchResult> {
    const targets = resolveTargets(store, plan.targets)
    const usesGoal = plan.find === undefined && plan.section === undefined
    const wanted = usesGoal ? (plan.goal ?? inheritedGoal(targets)) : undefined
    if (targets.length > 1 && plan.find === undefined && wanted === undefined)
      return failedResult(
        {
          code: 'invalid_input',
          message:
            'goal is required when reading several pages: say what you want to find in them.',
        },
        plan.notes,
      )
    const outcomes = await Promise.all(
      targets.map((target) => loadTarget(target, plan.fresh, signal)),
    )
    const sources = outcomes.flatMap((outcome) => ('source' in outcome ? [outcome.source] : []))
    const failed = outcomes.length - sources.length
    const budget = contentBudget(plan.maxTokens, sources.length, failed)
    const {
      reads,
      goal,
      notes: modeNotes,
    } = await readByMode(readablePages(sources), plan, wanted, budget, { fold, signal })
    const notes = [
      ...modeNotes,
      ...describeReads(
        sources.map((source) => source.n),
        reads,
      ),
    ]
    if (budgetTooSmall(plan.maxTokens, sources.length, failed))
      notes.push(
        `max_tokens is too small for ${sources.length} pages; each page got the minimum, so the response is larger than requested`,
      )
    const pages = outcomes.map((outcome) => {
      if ('failed' in outcome) return outcome.failed
      return finish(outcome.source, reads[sources.indexOf(outcome.source)] ?? emptyRead())
    })
    return buildResult(pages, goal, [...notes, ...plan.notes])
  }

  function emptyRead(): PageRead {
    return { mode: 'full', parts: [], truncated: false }
  }

  async function continueRead(
    source: PageSource,
    state: CursorState,
    maxTokens: number,
    signal: AbortSignal,
  ): Promise<PageRead> {
    const page = { n: 1, snapshot: source.snapshot.id, document: source.document }
    const budget = contentBudget(maxTokens, 1, 0)
    if (state.kind === 'read') return readOnward(page, state, budget)
    if (state.kind === 'find') {
      const folded = await fold(page.snapshot, page.document.markdown, signal)
      return readFind([page], state.find, state.from, budget, [folded])[0] ?? emptyRead()
    }
    const options = { goal: state.goal, budget, maxTokens, shown: state.shown, signal }
    return (await readGoal([page], options))[0] ?? emptyRead()
  }

  /** Cursors only ever read the stored snapshot; they never go back to the site. */
  async function continueCursor(
    plan: ResolvedFetch,
    cursor: string,
    signal: AbortSignal,
  ): Promise<FetchResult> {
    const state = parseCursorState(store.getRecord<unknown>(CURSOR_KIND, cursor.trim())?.value)
    const snapshot = state ? store.getSnapshot(state.snapshot) : undefined
    if (!state || !snapshot)
      return failedResult(
        {
          code: 'expired_ref',
          message: 'This cursor is unknown or has expired; fetch the page again to get a new one.',
        },
        plan.notes,
      )
    const target: ResolvedTarget = { kind: 'snapshot', n: 1, ref: snapshot.id, snapshot }
    const source = await toSource(target, storedSnapshot(target), signal)
    const read = await continueRead(source, state, plan.maxTokens, signal)
    const notes = [...describeReads([source.n], [read]), ...plan.notes]
    if (plan.targets.length > 0 || plan.find !== undefined || plan.section !== undefined)
      notes.push('cursor continues an earlier read; the other arguments were ignored')
    return buildResult(
      [finish(source, read)],
      state.kind === 'goal' ? state.goal : undefined,
      notes,
    )
  }

  async function run(request: FetchRequest, signal: AbortSignal): Promise<FetchResult> {
    try {
      const plan = normalizeFetch(request, config)
      if (plan.cursor !== undefined) return await continueCursor(plan, plan.cursor, signal)
      return await readTargets(plan, signal)
    } catch (error) {
      return failedResult(toToolError(error))
    }
  }

  return {
    fetch(request, signal) {
      const task = run(request, AbortSignal.any([signal, shutdown.signal]))
      active.add(task)
      void task.finally(() => active.delete(task))
      return task
    },
    async close() {
      shutdown.abort(new WebError('cancelled', 'The reader is shutting down.'))
      await Promise.allSettled(active)
    },
  }
}
