import { AppError } from '../shared/errors.ts'
import type { DocumentSnapshot, Segment } from '../shared/types.ts'
import { createHash } from 'node:crypto'
import { makeSourceId, parseSnapshotId, parseSourceId } from '../shared/ids.ts'
import { parseContract } from '../shared/contracts.ts'
import type { SourceMetadata } from '../generated/source-metadata.ts'

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

/** Paragraph boundaries include their whitespace; offsets count Unicode code points. */
export function segmentContent(content: string): Segment[] {
  const segments: Segment[] = []
  let offset = 0
  for (const match of content.matchAll(/[^\n]*(?:\n(?!\n)[^\n]*)*(?:\n+|$)/gu)) {
    const text = match[0]
    if (text.length === 0) continue
    const end = offset + Array.from(text).length
    segments.push({ id: `segment_${segments.length + 1}`, text, start_char: offset, end_char: end })
    offset = end
  }
  return segments
}

function isJson(value: unknown, parents = new Set<object>()): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object' || parents.has(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) return false
  parents.add(value)
  const valid = Array.isArray(value)
    ? Array.from(value).every((item) => isJson(item, parents))
    : Reflect.ownKeys(value).every((key) => {
        if (typeof key !== 'string') return false
        const descriptor = Object.getOwnPropertyDescriptor(value, key)
        return (
          descriptor !== undefined && 'value' in descriptor && isJson(descriptor.value, parents)
        )
      })
  parents.delete(value)
  return valid
}

export function encodeJson(value: unknown): string {
  if (!isJson(value)) throw new AppError('STORAGE_UNAVAILABLE', 'Storage accepts only JSON values.')
  return JSON.stringify(value)
}

export function decodeJson(value: string): unknown {
  const parsed: unknown = JSON.parse(value)
  return parsed
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeSourceMetadata(value: unknown): SourceMetadata {
  try {
    return parseContract<SourceMetadata>('source-metadata', value)
  } catch {
    throw new AppError('STORAGE_UNAVAILABLE', 'Stored source metadata failed schema validation.')
  }
}

export function decodeSnapshot(value: unknown): DocumentSnapshot {
  if (!isRecord(value)) throw new AppError('STORAGE_UNAVAILABLE', 'Invalid stored snapshot.')
  function stringField(key: string): string {
    const field = isRecord(value) ? value[key] : undefined
    if (typeof field !== 'string')
      throw new AppError('STORAGE_UNAVAILABLE', 'Invalid stored snapshot field.')
    return field
  }
  if (
    (value.format !== 'text' && value.format !== 'markdown') ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every((item) => typeof item === 'string') ||
    !Array.isArray(value.segments)
  )
    throw new AppError('STORAGE_UNAVAILABLE', 'Invalid stored snapshot.')
  const segments = value.segments.map((item: unknown): Segment => {
    if (
      !isRecord(item) ||
      typeof item.id !== 'string' ||
      typeof item.text !== 'string' ||
      typeof item.start_char !== 'number' ||
      typeof item.end_char !== 'number'
    ) {
      throw new AppError('STORAGE_UNAVAILABLE', 'Invalid stored segment.')
    }
    return { id: item.id, text: item.text, start_char: item.start_char, end_char: item.end_char }
  })
  if (
    value.fetchBackend !== undefined &&
    value.fetchBackend !== 'static' &&
    value.fetchBackend !== 'crawl4ai'
  )
    throw new AppError('STORAGE_UNAVAILABLE', 'Invalid stored fetch backend.')
  const snapshot: DocumentSnapshot = {
    ...(value.fetchBackend !== undefined ? { fetchBackend: value.fetchBackend } : {}),
    sourceId: parseSourceId(stringField('sourceId')),
    snapshotId: parseSnapshotId(stringField('snapshotId')),
    url: stringField('url'),
    finalUrl: stringField('finalUrl'),
    title: stringField('title'),
    fetchedAt: stringField('fetchedAt'),
    expiresAt: stringField('expiresAt'),
    contentType: stringField('contentType'),
    format: value.format,
    content: stringField('content'),
    contentSha256: stringField('contentSha256'),
    extractorVersion: stringField('extractorVersion'),
    segments,
    warnings: value.warnings,
    ...(Object.hasOwn(value, 'sourceMetadata')
      ? { sourceMetadata: decodeSourceMetadata(value.sourceMetadata) }
      : {}),
  }
  const metadata = snapshot.sourceMetadata
  if (
    metadata !== undefined &&
    (metadata.source_url !== snapshot.url ||
      metadata.final_url !== snapshot.finalUrl ||
      metadata.retrieved_at !== snapshot.fetchedAt ||
      metadata.metadata_url !== snapshot.finalUrl)
  ) {
    throw new AppError(
      'STORAGE_UNAVAILABLE',
      'Stored source metadata does not match its snapshot observation.',
    )
  }
  if (
    !Number.isFinite(Date.parse(snapshot.fetchedAt)) ||
    !Number.isFinite(Date.parse(snapshot.expiresAt)) ||
    snapshot.sourceId !== makeSourceId(snapshot.url) ||
    !snapshot.snapshotId.endsWith(`_${snapshot.format}`) ||
    snapshot.contentSha256 !== sha256(snapshot.content) ||
    JSON.stringify(snapshot.segments) !== JSON.stringify(segmentContent(snapshot.content))
  )
    throw new AppError('STORAGE_UNAVAILABLE', 'Stored snapshot integrity check failed.')
  return snapshot
}
