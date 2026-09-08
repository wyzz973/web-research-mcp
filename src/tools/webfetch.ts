/** Fetch and paginate immutable snapshots without re-fetching on continuation. */
import { randomUUID } from 'node:crypto'
import type { WebFetchInput } from '../generated/webfetch.input.ts'
import type { WebFetchOutput } from '../generated/webfetch.output.ts'
import type { RuntimeConfiguration } from '../generated/config.ts'
import type { DocumentLoader, DocumentSnapshot, SnapshotStore } from '../shared/types.ts'
import { AppError, throwIfAborted } from '../shared/errors.ts'
import { parseContract } from '../shared/contracts.ts'
import { toolError, withDeadline } from './common.ts'

interface FetchCursor {
  snapshotId: string
  offset: number
}

function readCursor(value: unknown): FetchCursor {
  if (
    !value ||
    typeof value !== 'object' ||
    !('snapshotId' in value) ||
    typeof value.snapshotId !== 'string' ||
    !('offset' in value) ||
    !Number.isSafeInteger(value.offset) ||
    typeof value.offset !== 'number' ||
    value.offset < 0
  ) {
    throw new AppError('CURSOR_MISMATCH', 'Invalid saved fetch cursor.')
  }
  return { snapshotId: value.snapshotId, offset: value.offset }
}

/** Materialize a continuous code-point page, preserving full-snapshot hashes. */
export function snapshotPage(
  snapshot: DocumentSnapshot,
  offset: number,
  maxChars: number,
  store: SnapshotStore,
  requestId: string,
): WebFetchOutput {
  const chars = Array.from(snapshot.content)
  if (offset > chars.length)
    throw new AppError('CURSOR_MISMATCH', 'Cursor offset exceeds the snapshot.')
  const end = Math.min(chars.length, offset + maxChars)
  const content = chars.slice(offset, end).join('')
  const segments = snapshot.segments
    .filter((s) => s.end_char > offset && s.start_char < end)
    .map((s) => {
      const start = Math.max(offset, s.start_char)
      const finish = Math.min(end, s.end_char)
      return {
        id: s.id,
        text: chars.slice(start, finish).join(''),
        start_char: start,
        end_char: finish,
      }
    })
  const more = end < chars.length
  return {
    schema_version: '0.2-draft',
    request_id: requestId,
    status: snapshot.warnings.length ? 'partial' : 'ok',
    error: null,
    source_id: snapshot.sourceId,
    snapshot_id: snapshot.snapshotId,
    url: snapshot.url,
    final_url: snapshot.finalUrl,
    title: snapshot.title,
    fetched_at: snapshot.fetchedAt,
    content_type: snapshot.contentType,
    content,
    content_sha256: snapshot.contentSha256,
    segments,
    warnings: [...snapshot.warnings],
    truncated: more,
    next_cursor: more
      ? store.createCursor(
          'fetch',
          { snapshotId: snapshot.snapshotId, offset: end },
          snapshot.expiresAt,
        )
      : null,
  }
}

export function createWebFetch(
  config: RuntimeConfiguration,
  loader: DocumentLoader,
  store: SnapshotStore,
) {
  return async (raw: unknown, parent: AbortSignal): Promise<WebFetchOutput> => {
    const requestId = randomUUID()
    const deadline = withDeadline(parent, config.fetch.deadline_ms)
    try {
      const args = parseContract<WebFetchInput>('webfetch.input', raw)
      const maxChars = args.max_chars ?? config.fetch.max_chars
      if (maxChars > config.fetch.max_output_chars)
        throw new AppError(
          'INVALID_ARGUMENT',
          'Requested text exceeds the deployment output limit.',
        )
      throwIfAborted(deadline.signal)
      let snapshot: DocumentSnapshot
      let offset = 0
      if (args.cursor) {
        const cursor = readCursor(store.getCursor(args.cursor, 'fetch').payload)
        snapshot = store.getDocument(cursor.snapshotId)
        offset = cursor.offset
        if (args.format && args.format !== snapshot.format)
          throw new AppError('CURSOR_MISMATCH', 'The format differs from this cursor snapshot.')
      } else {
        if (!args.url) throw new AppError('INVALID_ARGUMENT', 'A URL or cursor is required.')
        const document = await loader.load(args.url, { signal: deadline.signal })
        throwIfAborted(deadline.signal)
        snapshot = store.saveDocument(document, args.format ?? 'markdown')
      }
      return snapshotPage(snapshot, offset, maxChars, store, requestId)
    } catch (error) {
      return {
        schema_version: '0.2-draft',
        request_id: requestId,
        status: 'error',
        warnings: [],
        error: toolError(error),
      }
    } finally {
      deadline.dispose()
    }
  }
}
