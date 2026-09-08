/** Expected operational failures, mapped once at the tool boundary. */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly retryable = false,
    public readonly httpStatus?: number,
  ) {
    super(message)
    this.name = 'AppError'
  }
}

/** Preserve cancellation independently from provider failure. */
export function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) {
    if (signal.reason instanceof AppError) throw signal.reason
    throw new AppError('CANCELLED', 'The request was cancelled.')
  }
}
