/**
 * Honest outcomes. A source that failed is never reported as "no results", and a search in which
 * every source failed is an error, not an empty list.
 */
import type { ErrorCode, SourceOutcome, SourceStatus, Status, ToolError } from '../contract.ts'
import type { WebError } from '../errors.ts'
import type { CallOutcome } from './execute.ts'

export interface SourceFailure {
  source: string
  error: WebError
}

/** rate_limited first: it is the one failure the caller can wait out. */
const CODE_PRIORITY: readonly ErrorCode[] = [
  'rate_limited',
  'budget_exhausted',
  'timeout',
  'blocked',
  'upstream_error',
  'parse_failed',
  'too_large',
  'internal',
]

function outcomeOf(code: ErrorCode): SourceOutcome {
  if (code === 'rate_limited' || code === 'blocked' || code === 'timeout') return code
  return 'error'
}

function priority(code: ErrorCode): number {
  const index = CODE_PRIORITY.indexOf(code)
  return index < 0 ? CODE_PRIORITY.length : index
}

/** The failure that best explains a group: rate limits first, then the most frequent code. */
export function representative(errors: readonly WebError[]): WebError | undefined {
  const limited = errors.find((error) => error.code === 'rate_limited')
  if (limited) return limited
  const count = (code: ErrorCode) => errors.filter((error) => error.code === code).length
  return errors.toSorted(
    (a, b) => count(b.code) - count(a.code) || priority(a.code) - priority(b.code),
  )[0]
}

/** Errors that say something about the source; a call we chose not to wait for does not. */
export function realErrors(outcomes: readonly CallOutcome[]): WebError[] {
  return outcomes.flatMap((outcome) =>
    outcome.error && !outcome.notAwaited ? [outcome.error] : [],
  )
}

const MAX_DETAIL_CHARS = 160

/**
 * The built-in adapters word their own failures, but an adapter supplied by the embedding
 * application may pass on what an upstream said. One bounded line is all that is kept of it.
 */
function boundedDetail(message: string): string {
  return message.replace(/\s+/gu, ' ').trim().slice(0, MAX_DETAIL_CHARS)
}

/** One status line per source, however many calls the search made to it. */
export function sourceStatus(source: string, outcomes: readonly CallOutcome[]): SourceStatus {
  const ms = Math.max(0, ...outcomes.map((outcome) => outcome.ms))
  const errors = realErrors(outcomes)
  const failure = representative(errors)
  if (failure) {
    const partial =
      errors.length < outcomes.length ? `${errors.length} of ${outcomes.length} calls failed: ` : ''
    return {
      id: source,
      status: outcomeOf(failure.code),
      ms,
      ...(failure.retryAfterSeconds === undefined
        ? {}
        : { retry_after_s: failure.retryAfterSeconds }),
      detail: `${partial}${boundedDetail(failure.message)}`,
    }
  }
  const answered = outcomes.filter((outcome) => !outcome.error)
  if (answered.length === 0) return { id: source, status: 'skipped', ms, detail: 'not awaited' }
  const found = answered.some((outcome) => outcome.hits.length > 0)
  return { id: source, status: found ? 'ok' : 'empty', ms }
}

function failed(status: SourceStatus): boolean {
  return status.status !== 'ok' && status.status !== 'empty' && status.status !== 'skipped'
}

export function overallStatus(available: number, sources: readonly SourceStatus[]): Status {
  if (available > 0) return sources.some(failed) ? 'partial' : 'ok'
  const confirmed = sources.some((source) => source.status === 'ok' || source.status === 'empty')
  return confirmed ? 'empty' : 'error'
}

/**
 * A pool may be cached when some source answered and none failed. A skipped source (cooling
 * down, over its cap, or simply not awaited) took nothing away from the answer we did get; a
 * failed one did, and its gap must not outlive the failure.
 */
export function cacheable(sources: readonly SourceStatus[]): boolean {
  const answered = sources.some((source) => source.status === 'ok' || source.status === 'empty')
  return answered && !sources.some(failed)
}

/** The error of a search in which no source produced an answer. */
export function allFailedError(
  failures: readonly SourceFailure[],
  retryAfterS: number | undefined,
): ToolError {
  const main = representative(failures.map((failure) => failure.error))
  const code = main?.code ?? 'upstream_error'
  const listed = failures.map((failure) => `${failure.source}: ${failure.error.code}`).join(', ')
  const retry = retryAfterS === undefined ? '' : `; retry after ${retryAfterS}s`
  return {
    code,
    message: `All search sources failed (${listed})${retry}.`,
    ...(retryAfterS === undefined ? {} : { retry_after_s: retryAfterS }),
  }
}
