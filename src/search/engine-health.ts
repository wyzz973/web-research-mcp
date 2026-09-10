import { AppError } from '../shared/errors.ts'

export type EngineFailureCode = 'UPSTREAM_BLOCKED' | 'TIMEOUT' | 'UPSTREAM_UNAVAILABLE'
export interface EngineFailure {
  engine: string
  code: EngineFailureCode
  /** SearXNG explicitly skipped this engine due to its own suspension. */
  suspended: boolean | null
}
export interface EngineDiagnostic {
  engine: string
  status: 'unknown' | 'healthy' | 'cooling_down' | 'half_open'
  last_error: EngineFailureCode | null
  observation: 'results' | 'no_error_reported' | 'failure' | null
  suspended: boolean | null
  consecutive_failures: number
  failed_responses: number
  submitted_requests: number
  last_observed_at: string | null
  cooldown_until: string | null
  retry_after_ms: number
  probe_in_flight: boolean
  /** The aggregate JSON endpoint does not expose per-engine elapsed times. */
  elapsed_ms: null
}
interface State {
  diagnostic: EngineDiagnostic
  cooldownUntil: number
  observation: number
  probe: number | null
}
export interface EngineSelection {
  id: number
  engines: readonly string[]
  skipped: readonly string[]
}

export function classifyEngineFailure(reason: string): EngineFailureCode {
  if (/captcha|blocked|forbidden|access.denied|too.many.requests|429/iu.test(reason))
    return 'UPSTREAM_BLOCKED'
  if (/timeout|timed.out/iu.test(reason)) return 'TIMEOUT'
  return 'UPSTREAM_UNAVAILABLE'
}

/** Provider-local circuit state; no timers, background probes, queries or response bodies retained. */
export class EngineHealth {
  private readonly states: Map<string, State>
  private sequence = 0
  constructor(
    engines: readonly string[],
    private readonly now: () => number,
  ) {
    this.states = new Map(
      engines.map((engine) => [
        engine,
        {
          diagnostic: {
            engine,
            status: 'unknown',
            last_error: null,
            observation: null,
            suspended: null,
            consecutive_failures: 0,
            failed_responses: 0,
            submitted_requests: 0,
            last_observed_at: null,
            cooldown_until: null,
            retry_after_ms: 0,
            probe_in_flight: false,
            elapsed_ms: null,
          },
          cooldownUntil: 0,
          observation: 0,
          probe: null,
        },
      ]),
    )
  }

  select(): EngineSelection {
    const id = ++this.sequence
    const engines: string[] = []
    const skipped: string[] = []
    const now = this.now()
    for (const [engine, state] of this.states) {
      if (state.cooldownUntil > now || state.probe !== null) skipped.push(engine)
      else {
        engines.push(engine)
        if (state.cooldownUntil > 0) state.probe = id
      }
    }
    if (engines.length === 0) {
      const retryMs = Math.min(
        ...[...this.states.values()].map((state) => Math.max(0, state.cooldownUntil - now)),
      )
      const blocked = [...this.states.values()].some(
        (state) => state.diagnostic.last_error === 'UPSTREAM_BLOCKED',
      )
      throw new AppError(
        blocked ? 'UPSTREAM_BLOCKED' : 'UPSTREAM_UNAVAILABLE',
        `All configured search engines are cooling down or awaiting a recovery probe. Retry after ${retryMs} ms; inspect engine diagnostics.`,
        !blocked,
      )
    }
    for (const engine of engines) {
      const state = this.states.get(engine)
      if (state) state.diagnostic.submitted_requests += 1
    }
    return { id, engines, skipped }
  }

  observe(
    selection: EngineSelection,
    failures: readonly EngineFailure[],
    successful: ReadonlySet<string>,
    diagnosticsComplete: boolean,
  ): void {
    const now = this.now()
    for (const engine of selection.engines) {
      const state = this.states.get(engine)
      if (!state || state.observation > selection.id) continue
      const failure = failures.find((entry) => entry.engine === engine)
      if (!failure && !successful.has(engine) && !diagnosticsComplete) continue
      state.observation = selection.id
      state.diagnostic.last_observed_at = new Date(now).toISOString()
      if (failure) {
        state.diagnostic.observation = 'failure'
        state.diagnostic.failed_responses += 1
        state.diagnostic.consecutive_failures += 1
        state.diagnostic.last_error = failure.code
        state.diagnostic.suspended = failure.suspended
        // SearXNG's tuple exposes a suspension flag, not its remaining duration. Our bounded
        // delay is additional backoff; a recovery call still respects SearXNG's own suspension.
        const base = failure.code === 'UPSTREAM_BLOCKED' || failure.suspended ? 300_000 : 30_000
        const duration = Math.min(
          1_800_000,
          base * 2 ** Math.min(10, state.diagnostic.consecutive_failures - 1),
        )
        state.cooldownUntil = now + duration
        state.diagnostic.status = 'cooling_down'
      } else {
        state.cooldownUntil = 0
        state.diagnostic.status = 'healthy'
        state.diagnostic.observation = successful.has(engine) ? 'results' : 'no_error_reported'
        state.diagnostic.consecutive_failures = 0
        state.diagnostic.last_error = null
        state.diagnostic.suspended = false
      }
    }
  }

  release(selection: EngineSelection): void {
    for (const engine of selection.engines) {
      const state = this.states.get(engine)
      if (state?.probe === selection.id) state.probe = null
    }
  }

  inspect(): EngineDiagnostic[] {
    const now = this.now()
    return [...this.states.values()].map((state) => ({
      ...state.diagnostic,
      status:
        state.cooldownUntil > 0
          ? state.cooldownUntil > now
            ? 'cooling_down'
            : 'half_open'
          : state.diagnostic.status,
      cooldown_until: state.cooldownUntil > 0 ? new Date(state.cooldownUntil).toISOString() : null,
      retry_after_ms: Math.max(0, state.cooldownUntil - now),
      probe_in_flight: state.probe !== null,
    }))
  }
}
