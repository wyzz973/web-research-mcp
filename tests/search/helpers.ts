import { loadConfig, type Config } from '../../src/config.ts'
import type { WebError } from '../../src/errors.ts'
import type { SourceAdapter, SourceHit, SourceRequest } from '../../src/sources/types.ts'

export const never = new AbortController().signal

export function testConfig(env: Record<string, string> = {}): Config {
  return loadConfig({ WEB_RESEARCH_DATA_DIR: '/nonexistent/web-research-test', ...env })
}

export function hit(url: string, text = 'Some text about the page.', title = `Title of ${url}`) {
  return { url, title, passages: [text] } satisfies SourceHit
}

export function hits(prefix: string, count: number): SourceHit[] {
  return Array.from({ length: count }, (_, index) =>
    hit(`https://${prefix}.example.com/page-${index + 1}`, `Text ${index + 1} about fetch abort.`),
  )
}

type Answer =
  SourceHit[] | WebError | ((request: SourceRequest, signal: AbortSignal) => Promise<SourceHit[]>)

export interface FakeSource extends SourceAdapter {
  requests: SourceRequest[]
  /** Replace to change what the next calls return. */
  answer: Answer
}

/** An offline adapter: answers from memory and records what it was asked. */
export function fakeSource(
  id: string,
  answer: Answer,
  traits: {
    paid?: number
    maxQueriesPerCall?: number
    maxResultsPerCall?: number
    nativeFilters?: boolean
  } = {},
): FakeSource {
  const source: FakeSource = {
    id,
    requests: [],
    answer,
    ...(traits.maxQueriesPerCall ? { maxQueriesPerCall: traits.maxQueriesPerCall } : {}),
    ...(traits.maxResultsPerCall ? { maxResultsPerCall: () => traits.maxResultsPerCall ?? 0 } : {}),
    free: () => traits.paid === undefined,
    nativeFilters: () => traits.nativeFilters === true,
    unitCostUsd: () => traits.paid ?? 0,
    search(request, signal) {
      source.requests.push(request)
      const current = source.answer
      if (typeof current === 'function') return current(request, signal)
      return Array.isArray(current) ? Promise.resolve(current) : Promise.reject(current)
    },
  }
  return source
}

/** Resolves after `ms`, or rejects with the abort reason as soon as the signal fires. */
export function delayed(ms: number, result: SourceHit[]) {
  return (_request: SourceRequest, signal: AbortSignal) =>
    new Promise<SourceHit[]>((resolve, reject) => {
      const timer = setTimeout(() => resolve(result), ms)
      signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer)
          reject(signal.reason as Error)
        },
        { once: true },
      )
    })
}
