/** Shared tool-boundary results and deadline ownership. */
import type { WebSearchOutput } from '../generated/websearch.output.ts'
import type { Relevance } from '../shared/types.ts'
import { AppError } from '../shared/errors.ts'

export type ToolError = NonNullable<WebSearchOutput['error']>
export type SearchResult = WebSearchOutput['results'][number]

/** Retain operational error codes while withholding unanticipated implementation details. */
export function toolError(error: unknown): ToolError {
  if (!(error instanceof AppError))
    return {
      code: 'INTERNAL_ERROR',
      message: 'An internal operation failed. See stderr diagnostics.',
      retryable: false,
    }
  // Codes are validated against the output schema before leaving the MCP boundary.
  return {
    code: error.code as ToolError['code'],
    message: error.message,
    retryable: error.retryable,
    ...(error.httpStatus === undefined ? {} : { http_status: error.httpStatus }),
  }
}

/** A deadline owns its timer and linked abort listener. */
export function withDeadline(
  parent: AbortSignal,
  ms: number,
): { signal: AbortSignal; dispose(): void } {
  const controller = new AbortController()
  const abort = () =>
    controller.abort(parent.reason ?? new AppError('CANCELLED', 'The request was cancelled.'))
  if (parent.aborted) abort()
  else parent.addEventListener('abort', abort, { once: true })
  const timer = setTimeout(
    () =>
      controller.abort(new AppError('TIMEOUT', 'The total request deadline was reached.', true)),
    ms,
  )
  timer.unref()
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      parent.removeEventListener('abort', abort)
    },
  }
}

/** Adapt the domain score to generated nonempty-reason wire types. */
export function wireRelevance<B extends 'title_snippet' | 'quote'>(value: Relevance, basis: B) {
  return {
    ...value,
    basis,
    reasons: [value.reasons[0] ?? 'No relevance assessment.', ...value.reasons.slice(1)] as [
      string,
      ...string[],
    ],
  }
}
