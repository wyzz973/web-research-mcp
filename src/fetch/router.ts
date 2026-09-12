import type { DocumentLoader, FetchEngine } from '../shared/types.ts'
import { AppError, throwIfAborted } from '../shared/errors.ts'
import { noOpTraceRecorder, type TraceRecorder } from '../shared/trace.ts'

/** Strategy selection never bypasses denied origins, robots, challenges or an expired deadline. */
export function createFetchRouter(
  staticLoader: DocumentLoader,
  browserLoader: DocumentLoader,
  options: { defaultEngine: FetchEngine; allowFallback: boolean; tracer?: TraceRecorder },
): DocumentLoader {
  const trace = options.tracer ?? noOpTraceRecorder
  let closed = false
  return {
    async load(url, spec) {
      if (closed) throw new AppError('CANCELLED', 'Fetch router is closed.')
      const engine = spec.engine ?? options.defaultEngine
      throwIfAborted(spec.signal)
      if (engine === 'crawl4ai') return browserLoader.load(url, spec)
      if (engine === 'auto' && !options.allowFallback)
        throw new AppError(
          'INVALID_ARGUMENT',
          'Automatic browser fallback is disabled by this deployment.',
        )
      try {
        const document = await staticLoader.load(url, spec)
        if (
          engine === 'auto' &&
          ['text/html', 'application/xhtml+xml'].includes(document.contentType) &&
          document.text.replace(/\s/gu, '').length < 80
        )
          throw new AppError(
            'EXTRACTION_FAILED',
            'Static HTML has fewer than 80 visible text characters.',
          )
        return { ...document, fetchBackend: 'static' }
      } catch (error) {
        throwIfAborted(spec.signal)
        if (engine !== 'auto' || !(error instanceof AppError) || error.code !== 'EXTRACTION_FAILED')
          throw error
        return trace.span(
          'crawl4ai.fallback',
          {
            url,
            reason:
              'Static readable-text extraction failed or returned fewer than 80 visible HTML text characters; trying rendered HTML.',
          },
          () => browserLoader.load(url, spec),
          (value) => ({
            backend: value.fetchBackend,
            text_chars: Array.from(value.text).length,
            warnings: value.warnings,
          }),
        )
      }
    },
    async close() {
      closed = true
      const results = await Promise.allSettled([staticLoader.close(), browserLoader.close()])
      const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      if (errors.length)
        throw new AggregateError(
          errors.map((r) => r.reason),
          'Fetch strategies did not close cleanly.',
        )
    },
  }
}
