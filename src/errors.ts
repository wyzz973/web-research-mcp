import type { ErrorCode, ToolError } from './contract.ts'

/** The only error type that crosses module boundaries. */
export class WebError extends Error {
  readonly code: ErrorCode
  readonly retryAfterSeconds: number | undefined

  constructor(code: ErrorCode, message: string, retryAfterSeconds?: number) {
    super(message)
    this.name = 'WebError'
    this.code = code
    this.retryAfterSeconds = retryAfterSeconds
  }

  toToolError(): ToolError {
    return this.retryAfterSeconds === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, retry_after_s: this.retryAfterSeconds }
  }
}

/** Map anything thrown to a ToolError without leaking stack traces or page-controlled text. */
export function toToolError(error: unknown): ToolError {
  if (error instanceof WebError) return error.toToolError()
  if (error instanceof Error && error.name === 'AbortError')
    return { code: 'cancelled', message: 'The request was cancelled.' }
  if (error instanceof Error && error.name === 'TimeoutError')
    return { code: 'timeout', message: 'The request timed out.' }
  return { code: 'internal', message: 'An unexpected internal error occurred.' }
}

export function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return
  const reason: unknown = signal.reason
  if (reason instanceof WebError) throw reason
  if (reason instanceof Error && reason.name === 'TimeoutError')
    throw new WebError('timeout', 'The request timed out.')
  throw new WebError('cancelled', 'The request was cancelled.')
}
