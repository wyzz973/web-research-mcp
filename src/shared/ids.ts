import { createHash, randomBytes } from 'node:crypto'
import { AppError } from './errors.ts'

declare const identity: unique symbol

/** Domain identities remain plain strings at JSON and MCP boundaries. */
export type SourceId = string & { readonly [identity]: 'SourceId' }
export type SnapshotId = string & { readonly [identity]: 'SnapshotId' }
export type CursorToken = string & { readonly [identity]: 'CursorToken' }

export function parseSourceId(value: string): SourceId {
  if (!/^source_[a-f0-9]{64}$/u.test(value)) {
    throw new AppError('STORAGE_UNAVAILABLE', 'Invalid stored source identity.')
  }
  // The persisted identity grammar is validated above; this assertion adds no runtime conversion.
  return value as SourceId
}

/** Preserve query encoding/order and remove only the fragment; search canonicalizes tracking first. */
export function makeSourceId(value: string): SourceId {
  const url = new URL(value)
  url.hash = ''
  return parseSourceId(`source_${createHash('sha256').update(url.href, 'utf8').digest('hex')}`)
}

export function parseSnapshotId(value: string): SnapshotId {
  if (
    !/^snapshot_[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}_(?:text|markdown)$/u.test(
      value,
    )
  ) {
    throw new AppError('STORAGE_UNAVAILABLE', 'Invalid stored snapshot identity.')
  }
  // Validation preserves the existing schema-v1 UUID-plus-format string representation.
  return value as SnapshotId
}

export function makeSnapshotId(observationId: string, format: 'text' | 'markdown'): SnapshotId {
  return parseSnapshotId(`snapshot_${observationId}_${format}`)
}

/** Format validation only; authenticity, tool kind and retention still require a store lookup. */
export function parseCursorToken(value: string): CursorToken {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(value)) {
    throw new AppError('CURSOR_EXPIRED', 'Unknown cursor.')
  }
  return value as CursorToken
}

export function makeCursorToken(): CursorToken {
  return parseCursorToken(randomBytes(32).toString('base64url'))
}
