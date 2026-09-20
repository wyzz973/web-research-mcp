/**
 * Runs the upstream calls of one search in parallel. This module owns every timer and abort
 * signal it creates: when `runCalls` resolves, no timer is pending and every call has either
 * settled or been aborted and given a short grace period to unwind.
 */
import { WebError } from '../errors.ts'
import type { SourceAdapter, SourceHit, SourceRequest } from '../sources/types.ts'

export interface SourceCall {
  adapter: SourceAdapter
  request: SourceRequest
  /** 1-based indexes (into the search's queries) of the queries this call carries. */
  queryIndexes: number[]
}

export interface CallOutcome {
  call: SourceCall
  hits: SourceHit[]
  error: WebError | undefined
  /**
   * True when we stopped waiting because another source had already answered. The source did
   * nothing wrong, so this is neither a failure nor a reason to cool it down.
   */
  notAwaited: boolean
  /** False when the call never left the queue: nothing was sent and nothing was spent. */
  dispatched: boolean
  ms: number
}

export interface Timeouts {
  /** Once some call has produced results, the rest are awaited only until this long after the start. */
  softMs: number
  /** Ceiling for any single call. */
  hardMs: number
}

/** Anonymous tiers document limits of a few requests per second. */
const MAX_PARALLEL_PER_SOURCE = 3
/** How long an aborted call may take to unwind before we stop waiting for it. */
const ABORT_GRACE_MS = 250

function abortReason(signal: AbortSignal): WebError {
  const reason: unknown = signal.reason
  if (reason instanceof WebError) return reason
  if (reason instanceof Error && reason.name === 'TimeoutError')
    return new WebError('timeout', 'The request timed out.')
  return new WebError('cancelled', 'The request was cancelled.')
}

function toWebError(error: unknown, signal: AbortSignal, source: string): WebError {
  if (error instanceof WebError) return error
  if (signal.aborted) return abortReason(signal)
  return new WebError('internal', `The ${source} adapter failed unexpectedly.`)
}

/**
 * Resolves or rejects with `work`. After `signal` aborts, `work` gets a grace period to settle
 * on its own; an adapter that ignores its signal must not be able to hold the search hostage.
 */
function settleOrAbandon<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let grace: NodeJS.Timeout | undefined
    const onAbort = () => {
      grace = setTimeout(() => reject(abortReason(signal)), ABORT_GRACE_MS)
    }
    const cleanup = () => {
      clearTimeout(grace)
      signal.removeEventListener('abort', onAbort)
    }
    if (signal.aborted) onAbort()
    else signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        cleanup()
        resolve(value)
      },
      (error: unknown) => {
        cleanup()
        reject(error)
      },
    )
  })
}

/** `cancel` is the caller giving up; `soft` is us no longer needing the answer. */
interface StopSignals {
  cancel: AbortSignal
  soft: AbortSignal
}

function unsent(call: SourceCall, stop: StopSignals): CallOutcome | undefined {
  const signal = stop.cancel.aborted ? stop.cancel : stop.soft.aborted ? stop.soft : undefined
  if (!signal) return undefined
  const notAwaited = signal === stop.soft
  return { call, hits: [], error: abortReason(signal), notAwaited, dispatched: false, ms: 0 }
}

async function runOne(call: SourceCall, hardMs: number, stop: StopSignals): Promise<CallOutcome> {
  const skipped = unsent(call, stop)
  if (skipped) return skipped
  const began = performance.now()
  const elapsed = () => Math.round(performance.now() - began)
  const controller = new AbortController()
  const onCancel = () => controller.abort(stop.cancel.reason)
  const onSoft = () => controller.abort(stop.soft.reason)
  stop.cancel.addEventListener('abort', onCancel, { once: true })
  stop.soft.addEventListener('abort', onSoft, { once: true })
  const source = call.adapter.id
  const timer = setTimeout(
    () =>
      controller.abort(new WebError('timeout', `${source} did not answer within ${hardMs} ms.`)),
    hardMs,
  )
  try {
    const work = Promise.resolve().then(() => call.adapter.search(call.request, controller.signal))
    const hits = await settleOrAbandon(work, controller.signal)
    if (!Array.isArray(hits))
      throw new WebError('internal', `The ${source} adapter returned no list.`)
    return { call, hits, error: undefined, notAwaited: false, dispatched: true, ms: elapsed() }
  } catch (error) {
    // Whatever the adapter threw, a call we aborted for this reason did not fail on its own.
    const notAwaited = stop.soft.aborted && controller.signal.reason === stop.soft.reason
    const failure = toWebError(error, controller.signal, source)
    return { call, hits: [], error: failure, notAwaited, dispatched: true, ms: elapsed() }
  } finally {
    clearTimeout(timer)
    stop.cancel.removeEventListener('abort', onCancel)
    stop.soft.removeEventListener('abort', onSoft)
  }
}

function groupBySource(calls: readonly SourceCall[]): SourceCall[][] {
  const groups = new Map<string, SourceCall[]>()
  for (const call of calls)
    groups.set(call.adapter.id, [...(groups.get(call.adapter.id) ?? []), call])
  return [...groups.values()]
}

export async function runCalls(
  calls: readonly SourceCall[],
  timeouts: Timeouts,
  signal: AbortSignal,
): Promise<CallOutcome[]> {
  const began = performance.now()
  const cancel = new AbortController()
  const soft = new AbortController()
  const onCancel = () => cancel.abort(abortReason(signal))
  if (signal.aborted) onCancel()
  else signal.addEventListener('abort', onCancel, { once: true })

  let softTimer: NodeJS.Timeout | undefined
  let armed = false
  const stopWaiting = () =>
    soft.abort(new WebError('timeout', 'Not awaited: another source had already answered.'))
  const armSoftDeadline = () => {
    if (armed) return
    armed = true
    const wait = timeouts.softMs - (performance.now() - began)
    if (wait <= 0) stopWaiting()
    else softTimer = setTimeout(stopWaiting, wait)
  }

  const stop = { cancel: cancel.signal, soft: soft.signal }
  const outcomes = new Map<SourceCall, CallOutcome>()
  async function drain(queue: SourceCall[]): Promise<void> {
    for (let call = queue.shift(); call !== undefined; call = queue.shift()) {
      const outcome = await runOne(call, timeouts.hardMs, stop)
      outcomes.set(call, outcome)
      if (outcome.hits.length > 0) armSoftDeadline()
    }
  }

  try {
    const workers = groupBySource(calls).flatMap((group) => {
      const queue = [...group]
      const width = Math.min(MAX_PARALLEL_PER_SOURCE, queue.length)
      return Array.from({ length: width }, () => drain(queue))
    })
    await Promise.all(workers)
  } finally {
    clearTimeout(softTimer)
    signal.removeEventListener('abort', onCancel)
  }
  return calls.flatMap((call) => outcomes.get(call) ?? [])
}
