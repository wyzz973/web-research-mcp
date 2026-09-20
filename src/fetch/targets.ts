/** Turns `ref` values into something readable: a URL from a stored search, or a stored snapshot. */
import type { FetchTarget, Snapshot, Store, ToolError } from '../contract.ts'
import { isSnapshotId, parseRef } from '../ids.ts'

export type ResolvedTarget =
  | { kind: 'url'; n: number; url: string; ref?: string; goal?: string }
  | { kind: 'snapshot'; n: number; ref: string; snapshot: Snapshot }
  | { kind: 'error'; n: number; url: string; ref?: string; error: ToolError }

interface StoredHitView {
  url: string
  goal: string | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Stored searches come back from disk as JSON, so only the fields used here are trusted after a
 * check. Pools store the full ref ("k7f2:r1"); the bare form ("r1") is accepted as well.
 */
function readStoredHit(value: unknown, fullRef: string, hitRef: string): StoredHitView | undefined {
  if (!isRecord(value) || !Array.isArray(value.hits)) return undefined
  const hit = value.hits.find(
    (item) => isRecord(item) && (item.ref === fullRef || item.ref === hitRef),
  )
  if (!isRecord(hit) || typeof hit.url !== 'string') return undefined
  const firstQuery = Array.isArray(value.queries) ? value.queries[0] : undefined
  const goal = typeof value.goal === 'string' && value.goal.trim() !== '' ? value.goal : firstQuery
  return { url: hit.url, goal: typeof goal === 'string' ? goal : undefined }
}

function expired(n: number, ref: string, what: 'ref' | 'snapshot'): ResolvedTarget {
  const message =
    what === 'ref'
      ? 'This ref is unknown or older than 24 hours; run web_search again and use a ref from its output.'
      : 'This snapshot is unknown or has expired; fetch the page again by its URL.'
  return { kind: 'error', n, url: '', ref, error: { code: 'expired_ref', message } }
}

function resolveRef(store: Store, n: number, raw: string): ResolvedTarget {
  const ref = raw.trim()
  if (isSnapshotId(ref)) {
    const snapshot = store.getSnapshot(ref)
    return snapshot ? { kind: 'snapshot', n, ref, snapshot } : expired(n, ref, 'snapshot')
  }
  const parsed = parseRef(ref)
  // A malformed ref is arbitrary caller text, often copied from a page: it is not echoed back.
  if (!parsed)
    return {
      kind: 'error',
      n,
      url: '',
      error: {
        code: 'invalid_input',
        message: 'use the full ref from web_search, for example "k7f2:r1"',
      },
    }
  const stored = store.getRecord<unknown>('search', parsed.searchId)
  const fullRef = `${parsed.searchId}:${parsed.hit}`
  const hit = stored ? readStoredHit(stored.value, fullRef, parsed.hit) : undefined
  if (!hit) return expired(n, ref, 'ref')
  const target: ResolvedTarget = { kind: 'url', n, url: hit.url, ref }
  if (hit.goal !== undefined) target.goal = hit.goal
  return target
}

export function resolveTargets(store: Store, targets: FetchTarget[]): ResolvedTarget[] {
  return targets.map((target, index) => {
    const n = index + 1
    if (target.ref !== undefined) return resolveRef(store, n, target.ref)
    return { kind: 'url', n, url: target.url ?? '' }
  })
}

/** A goal stored with the search is reused so `refs` alone is enough for evidence mode. */
export function inheritedGoal(targets: ResolvedTarget[]): string | undefined {
  for (const target of targets) if (target.kind === 'url' && target.goal) return target.goal
  return undefined
}
