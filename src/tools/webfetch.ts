/** Fetch and paginate immutable snapshots without re-fetching on continuation. */
import { noOpTraceRecorder, type TraceRecorder } from '../shared/trace.ts'
import { randomUUID } from 'node:crypto'
import type { WebFetchInput } from '../generated/webfetch.input.ts'
import type { WebFetchOutput } from '../generated/webfetch.output.ts'
import type { RuntimeConfiguration } from '../generated/config.ts'
import type { DocumentLoader, DocumentSnapshot, SnapshotStore } from '../shared/types.ts'
import { AppError, throwIfAborted } from '../shared/errors.ts'
import { parseContract } from '../shared/contracts.ts'
import { toolError, withDeadline } from './common.ts'
import { createSourceMetadata } from '../shared/source-metadata.ts'
import { readEvidencePage } from './evidence.ts'

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
    schema_version: '0.3-draft',
    request_id: requestId,
    status: snapshot.warnings.length ? 'partial' : 'ok',
    error: null,
    view: 'document',
    source_metadata:
      snapshot.sourceMetadata ??
      createSourceMetadata(snapshot.url, snapshot.finalUrl, snapshot.fetchedAt),
    evidence: [],
    has_more_evidence: false,
    next_evidence_cursor: null,
    evidence_chars: 0,
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
  trace: TraceRecorder = noOpTraceRecorder,
) {
  return async (raw: unknown, parent: AbortSignal): Promise<WebFetchOutput> => {
    const requestId = randomUUID()
    const deadline = withDeadline(parent, config.fetch.deadline_ms)
    try {
      const args = await trace.span('fetch.resolve', raw, async () =>
        parseContract<WebFetchInput>('webfetch.input', raw),
      )
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
        const payload = store.getCursor(args.cursor, 'fetch').payload
        if (
          payload &&
          typeof payload === 'object' &&
          'view' in payload &&
          payload.view === 'evidence'
        ) {
          if (args.format && args.format !== 'text')
            throw new AppError(
              'CURSOR_MISMATCH',
              'Evidence cursors read original text; use the snapshot cursor for another document view.',
            )
          const { snapshot: evidenceSnapshot, page } = await trace.span(
            'fetch.read_evidence',
            { max_chars: maxChars, view: 'evidence' },
            async () => readEvidencePage(payload, store, maxChars),
            (value) => ({
              snapshot_id: value.snapshot.snapshotId,
              returned_passages: value.page.evidence.length,
              has_more: value.page.has_more_evidence,
              network_requested: false,
            }),
          )
          return {
            schema_version: '0.3-draft',
            request_id: requestId,
            status: evidenceSnapshot.warnings.length ? 'partial' : 'ok',
            error: null,
            source_id: evidenceSnapshot.sourceId,
            snapshot_id: evidenceSnapshot.snapshotId,
            url: evidenceSnapshot.url,
            final_url: evidenceSnapshot.finalUrl,
            title: evidenceSnapshot.title,
            fetched_at: evidenceSnapshot.fetchedAt,
            content_type: evidenceSnapshot.contentType,
            content: page.evidence.map((e) => e.quote).join('\n\n'),
            content_sha256: evidenceSnapshot.contentSha256,
            segments: page.evidence.map((e) => ({
              id: e.id,
              text: e.quote,
              start_char: e.start_char,
              end_char: e.end_char,
            })),
            warnings: [...evidenceSnapshot.warnings],
            truncated: page.has_more_evidence,
            next_cursor: page.next_evidence_cursor,
            view: 'evidence',
            source_metadata:
              evidenceSnapshot.sourceMetadata ??
              createSourceMetadata(
                evidenceSnapshot.url,
                evidenceSnapshot.finalUrl,
                evidenceSnapshot.fetchedAt,
              ),
            ...page,
          }
        }
        const cursor = readCursor(payload)
        snapshot = await trace.span(
          'fetch.read_snapshot',
          { snapshot_id: cursor.snapshotId, offset: cursor.offset },
          async () => store.getDocument(cursor.snapshotId),
          (value) => ({
            snapshot_id: value.snapshotId,
            text_chars: Array.from(value.content).length,
            network_requested: false,
          }),
        )
        offset = cursor.offset
        if (args.format && args.format !== snapshot.format)
          throw new AppError('CURSOR_MISMATCH', 'The format differs from this cursor snapshot.')
      } else {
        if (!args.url) throw new AppError('INVALID_ARGUMENT', 'A URL or cursor is required.')
        const url = args.url
        const document = await trace.span(
          'fetch.load',
          { url },
          () => loader.load(url, { signal: deadline.signal }),
          (value) => ({
            title: value.title,
            text_chars: Array.from(value.text).length,
            warnings: value.warnings,
          }),
        )
        throwIfAborted(deadline.signal)
        snapshot = await trace.span(
          'fetch.snapshot',
          { url: document.finalUrl, format: args.format ?? 'markdown' },
          async () => store.saveDocument(document, args.format ?? 'markdown'),
          (value) => ({
            snapshot_id: value.snapshotId,
            content_sha256: value.contentSha256,
            expires_at: value.expiresAt,
          }),
        )
      }
      const documentSnapshot = snapshot
      return await trace.span(
        'fetch.present',
        { snapshot_id: snapshot.snapshotId, offset, max_chars: maxChars },
        async () => snapshotPage(documentSnapshot, offset, maxChars, store, requestId),
        (value) => ({
          status: value.status,
          content_chars: Array.from(value.content ?? '').length,
          content_preview: value.content?.slice(0, 1800),
          has_more: Boolean(value.next_cursor),
        }),
      )
    } catch (error) {
      return {
        schema_version: '0.3-draft',
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
