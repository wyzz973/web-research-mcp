import { describe, expect, it } from 'vitest'
import type { SourceStatus } from '../../src/contract.ts'
import { WebError } from '../../src/errors.ts'
import type { CallOutcome } from '../../src/search/execute.ts'
import {
  allFailedError,
  cacheable,
  overallStatus,
  representative,
  sourceStatus,
} from '../../src/search/status.ts'
import { fakeSource, hits } from './helpers.ts'

const source = (id: string, status: SourceStatus['status']): SourceStatus => ({ id, status })

function outcome(result: number | WebError, ms = 100, notAwaited = false): CallOutcome {
  const adapter = fakeSource('exa', [])
  const call = { adapter, queryIndexes: [1], request: adapter.requests[0] as never }
  return typeof result === 'number'
    ? { call, hits: hits('x', result), error: undefined, notAwaited, dispatched: true, ms }
    : { call, hits: [], error: result, notAwaited, dispatched: true, ms }
}

const notAwaited = () => outcome(new WebError('timeout', 'Not awaited.'), 4000, true)

describe('overallStatus', () => {
  it('is ok when there are results and every source answered', () => {
    expect(overallStatus(5, [source('exa', 'ok'), source('parallel', 'empty')])).toBe('ok')
  })

  it('is partial when there are results but a source failed', () => {
    for (const failed of ['rate_limited', 'blocked', 'timeout', 'error'] as const)
      expect(overallStatus(5, [source('exa', 'ok'), source('parallel', failed)])).toBe('partial')
  })

  it('does not count a source that was skipped while cooling down as a failure', () => {
    expect(overallStatus(5, [source('parallel', 'ok'), source('exa', 'skipped')])).toBe('ok')
  })

  it('is empty only when a source confirmed that there is nothing', () => {
    expect(overallStatus(0, [source('exa', 'empty')])).toBe('empty')
    expect(overallStatus(0, [source('exa', 'timeout'), source('parallel', 'empty')])).toBe('empty')
    // Results that the site filter removed: the source answered, nothing is left.
    expect(overallStatus(0, [source('exa', 'ok')])).toBe('empty')
  })

  it('is an error, never empty, when no source answered', () => {
    expect(overallStatus(0, [source('exa', 'rate_limited'), source('parallel', 'timeout')])).toBe(
      'error',
    )
    expect(overallStatus(0, [source('exa', 'skipped')])).toBe('error')
    expect(overallStatus(0, [])).toBe('error')
  })
})

describe('sourceStatus', () => {
  it('reports ok or empty for clean calls, with the slowest call as the duration', () => {
    expect(sourceStatus('exa', [outcome(3, 120), outcome(0, 480)])).toEqual({
      id: 'exa',
      status: 'ok',
      ms: 480,
    })
    expect(sourceStatus('exa', [outcome(0)])).toEqual({ id: 'exa', status: 'empty', ms: 100 })
  })

  it('reports the failure even when other calls of the same source succeeded', () => {
    const status = sourceStatus('exa', [
      outcome(4),
      outcome(new WebError('rate_limited', 'exa rate limited the request (HTTP 429).', 30)),
      outcome(2),
    ])
    expect(status).toEqual({
      id: 'exa',
      status: 'rate_limited',
      ms: 100,
      retry_after_s: 30,
      detail: '1 of 3 calls failed: exa rate limited the request (HTTP 429).',
    })
  })

  it('reports a source we stopped waiting for as skipped, not as a failure', () => {
    expect(sourceStatus('tavily', [notAwaited()])).toEqual({
      id: 'tavily',
      status: 'skipped',
      ms: 4000,
      detail: 'not awaited',
    })
    // Answers that did arrive still count; a real failure still shows.
    expect(sourceStatus('exa', [outcome(3), notAwaited()]).status).toBe('ok')
    expect(sourceStatus('exa', [notAwaited(), outcome(new WebError('blocked', 'x'))]).status).toBe(
      'blocked',
    )
  })

  it('keeps one bounded line of whatever a custom adapter put into its error', () => {
    const message = `upstream said:\n${'very long text '.repeat(40)}`
    const { detail } = sourceStatus('custom', [outcome(new WebError('upstream_error', message))])
    expect(detail?.startsWith('upstream said: very long text')).toBe(true)
    expect(detail).not.toContain('\n')
    expect(detail?.length).toBeLessThanOrEqual(160)
  })

  it('maps error codes to source outcomes', () => {
    const statusOf = (code: ConstructorParameters<typeof WebError>[0]) =>
      sourceStatus('exa', [outcome(new WebError(code, 'm'))]).status
    expect(statusOf('blocked')).toBe('blocked')
    expect(statusOf('timeout')).toBe('timeout')
    expect(statusOf('upstream_error')).toBe('error')
    expect(statusOf('parse_failed')).toBe('error')
    expect(statusOf('too_large')).toBe('error')
    expect(statusOf('budget_exhausted')).toBe('error')
  })
})

describe('representative and allFailedError', () => {
  const error = (code: ConstructorParameters<typeof WebError>[0], retryAfterSeconds?: number) =>
    new WebError(code, code, retryAfterSeconds)

  it('prefers rate_limited, then the most frequent code, then a fixed order', () => {
    expect(representative([error('timeout'), error('rate_limited'), error('timeout')])?.code).toBe(
      'rate_limited',
    )
    expect(representative([error('blocked'), error('timeout'), error('blocked')])?.code).toBe(
      'blocked',
    )
    expect(representative([error('upstream_error'), error('timeout')])?.code).toBe('timeout')
    expect(representative([])).toBeUndefined()
  })

  it('names every source and says when to retry, using only our own words', () => {
    // Different reasons: no one of them is the answer's, and the wait is the longer of the two,
    // because the shorter one would promise a retry that cannot succeed (ninth audit round).
    const mixed = [
      { source: 'tavily', error: error('budget_exhausted', 79_241) },
      { source: 'exa', error: error('parse_failed') },
    ]
    expect(allFailedError(mixed)).toEqual({
      code: 'upstream_error',
      message:
        'All search sources failed (tavily: budget_exhausted, retry after 79241s; exa: parse_failed).',
      retry_after_s: 79_241,
    })
    const agreeing = [
      { source: 'exa', error: error('rate_limited', 30) },
      { source: 'parallel', error: error('rate_limited', 300) },
    ]
    expect(allFailedError(agreeing)).toMatchObject({ code: 'rate_limited', retry_after_s: 300 })
    expect(allFailedError([{ source: 'exa', error: error('blocked') }])).toEqual({
      code: 'blocked',
      message: 'All search sources failed (exa: blocked).',
    })
  })
})

describe('cacheable', () => {
  it('accepts a pool when some source answered and none failed', () => {
    expect(cacheable([source('exa', 'ok'), source('parallel', 'empty')])).toBe(true)
    expect(cacheable([source('exa', 'ok'), source('parallel', 'timeout')])).toBe(false)
    expect(cacheable([source('exa', 'error'), source('parallel', 'ok')])).toBe(false)
    expect(cacheable([])).toBe(false)
  })

  it('is not blocked by a source that was skipped: deep searches must be able to cache', () => {
    expect(cacheable([source('exa', 'ok'), source('tavily', 'skipped')])).toBe(true)
    expect(cacheable([source('tavily', 'skipped')])).toBe(false)
  })
})
