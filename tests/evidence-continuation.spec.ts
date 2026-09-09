import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Evidence, WebFetchOutput } from '../src/generated/webfetch.output.ts'
import type {
  DocumentLoader,
  DocumentSnapshot,
  LoadedDocument,
  Passage,
  SnapshotStore,
} from '../src/shared/types.ts'
import { loadConfiguration } from '../src/shared/config.ts'
import { parseContract } from '../src/shared/contracts.ts'
import { createSourceMetadata } from '../src/shared/source-metadata.ts'
import { createSnapshotStore } from '../src/storage/index.ts'
import { prepareEvidence, readEvidencePage } from '../src/tools/evidence.ts'
import { createWebFetch } from '../src/tools/webfetch.ts'

const directories: string[] = []
const stores: SnapshotStore[] = []

function open(directory: string, ttlSeconds = 60): SnapshotStore {
  const store = createSnapshotStore({ directory, ttlSeconds, maxBytes: 8 * 1024 * 1024 })
  stores.push(store)
  return store
}

function fixture(withMetadata = true, ttlSeconds = 60) {
  const directory = mkdtempSync(join(tmpdir(), 'web-research-evidence-'))
  directories.push(directory)
  const store = open(directory, ttlSeconds)
  const url = 'https://example.org/research'
  const fetchedAt = '2026-09-09T08:00:00.000Z'
  const metadata = createSourceMetadata(url, url, fetchedAt)
  metadata.site_name = 'Retained Research Site'
  metadata.metadata_source = 'html'
  metadata.metadata_url = url
  metadata.provenance.site_name = 'opengraph'
  // Unicode paragraph sizes cause the 4,000-character budget to bind before the three-entry cap.
  const content = Array.from(
    { length: 9 },
    (_, index) =>
      `${index + 1}. ${'Evidence研究🙂 e\u0301 needs context. '.repeat(index < 2 ? 25 : 45)}\n\n`,
  ).join('')
  const document: LoadedDocument = {
    url,
    finalUrl: url,
    title: 'Retained research',
    contentType: 'text/html',
    text: content,
    markdown: content,
    fetchedAt,
    extractorVersion: 'fixture-v2',
    warnings: [],
    ...(withMetadata ? { sourceMetadata: metadata } : {}),
  }
  const snapshot = store.saveDocument(document, 'text')
  const groups = [
    snapshot.segments.slice(0, 2),
    ...snapshot.segments.slice(2).map((segment) => [segment]),
  ]
  const passages: Passage[] = groups.map((group) => {
    const first = group[0]
    const last = group.at(-1)
    if (!first || !last) throw new Error('Expected paragraph group')
    return {
      quote: group.map((segment) => segment.text).join(''),
      start_char: first.start_char,
      end_char: last.end_char,
      segment_id: first.id,
      segment_ids: group.map((segment) => segment.id),
      relevance: {
        score: 1,
        method: 'lexical_coverage_v1',
        version: 'fixture-v2',
        basis: 'quote',
        matched_terms: ['evidence'],
        reasons: ['Fixture matched paragraph.'],
      },
    }
  })
  const load = vi.fn<DocumentLoader['load']>(async () => {
    throw new Error('Continuation must never fetch')
  })
  const loader: DocumentLoader = { load, async close() {} }
  const config = loadConfiguration()
  config.storage.directory = directory
  config.storage.snapshot_ttl_seconds = ttlSeconds
  return { directory, store, snapshot, passages, loader, load, config, metadata }
}

function token(value: string | null | undefined): string {
  if (typeof value !== 'string') throw new Error('Expected evidence continuation cursor')
  return value
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected object')
  return value as Record<string, unknown>
}

function verifyEntries(entries: readonly Evidence[], snapshot: DocumentSnapshot): void {
  const chars = Array.from(snapshot.content)
  for (const entry of entries) {
    expect(chars.slice(entry.start_char, entry.end_char).join('')).toBe(entry.quote)
    expect(entry.content_sha256).toBe(
      createHash('sha256').update(snapshot.content, 'utf8').digest('hex'),
    )
    expect(entry.snapshot_id).toBe(snapshot.snapshotId)
    const segmentIds = snapshot.segments
      .filter(
        (segment) => segment.end_char > entry.start_char && segment.start_char < entry.end_char,
      )
      .map((segment) => segment.id)
    expect(entry.segment_ids).toEqual(segmentIds)
    expect(entry.segment_id).toBe(segmentIds[0])
    expect(entry.verification).toBe('exact_match')
  }
}

function validate(output: WebFetchOutput): WebFetchOutput {
  return parseContract<WebFetchOutput>('webfetch.output', output)
}

afterEach(() => {
  vi.useRealTimers()
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('immutable evidence continuation', () => {
  it('reads complete bounded paragraphs across repeated SQLite restarts with stable metadata and no fetch', async () => {
    const f = fixture()
    const initial = prepareEvidence(f.snapshot, f.passages, f.store, { perPage: 3, maxChars: 4000 })
    expect(f.passages.length).toBeGreaterThan(4)
    expect(initial.evidence[0]?.segment_ids).toHaveLength(2)
    expect(initial.evidence_chars).toBeLessThanOrEqual(4000)
    expect(initial.evidence).toHaveLength(2)
    verifyEntries(initial.evidence, f.snapshot)
    const collected = [...initial.evidence]
    let continuation = initial.next_evidence_cursor
    let active = f.store
    let pageCount = 0
    while (continuation !== null) {
      active.close()
      active = open(f.directory)
      const fetch = createWebFetch(f.config, f.loader, active)
      const request = { cursor: continuation }
      const page = validate(await fetch(request, new AbortController().signal))
      const replay = validate(await fetch(request, new AbortController().signal))
      expect(page.status).toBe('ok')
      expect(page.schema_version).toBe('0.3-draft')
      expect(page.view).toBe('evidence')
      expect(page.source_metadata).toEqual(f.metadata)
      expect(page.evidence).toEqual(replay.evidence)
      expect(page.content).toBe(replay.content)
      expect(page.evidence_chars).toBe(replay.evidence_chars)
      expect(page.evidence_chars).toBeLessThanOrEqual(4000)
      expect(Array.from(page.content ?? '').length).toBeLessThanOrEqual(4000)
      const entries = page.evidence ?? []
      expect(entries.length).toBeGreaterThan(0)
      expect(entries.length).toBeLessThanOrEqual(3)
      expect(page.evidence_chars).toBe(
        entries.reduce((sum, entry) => sum + Array.from(entry.quote).length, 0),
      )
      verifyEntries(entries, f.snapshot)
      collected.push(...entries)
      expect(page.has_more_evidence).toBe(page.next_evidence_cursor !== null)
      expect(page.next_cursor).toBe(page.next_evidence_cursor)
      continuation = page.next_evidence_cursor ?? null
      pageCount++
      if (pageCount > 10) throw new Error('Continuation failed to make bounded progress')
    }
    expect(collected.map((entry) => entry.quote)).toEqual(
      f.passages.map((passage) => passage.quote),
    )
    expect(collected.map((entry) => entry.quote).join('')).toBe(f.snapshot.content)
    expect(new Set(collected.map((entry) => entry.id)).size).toBe(f.passages.length)
    expect(pageCount).toBeGreaterThan(1)
    expect(f.load).not.toHaveBeenCalled()
  })

  it('rejects a too-small page budget and markdown while preserving a readable evidence cursor', async () => {
    const f = fixture()
    const initial = prepareEvidence(f.snapshot, f.passages, f.store, { perPage: 3, maxChars: 4000 })
    const cursor = token(initial.next_evidence_cursor)
    const fetch = createWebFetch(f.config, f.loader, f.store)
    const tooSmall = validate(await fetch({ cursor, max_chars: 100 }, new AbortController().signal))
    expect(tooSmall.error?.code).toBe('INVALID_ARGUMENT')
    const markdown = validate(
      await fetch({ cursor, format: 'markdown' }, new AbortController().signal),
    )
    expect(markdown.error?.code).toBe('CURSOR_MISMATCH')
    const readable = validate(
      await fetch({ cursor, format: 'text', max_chars: 1500 }, new AbortController().signal),
    )
    expect(readable.status).toBe('ok')
    expect(readable.evidence).toHaveLength(1)
    expect(readable.evidence_chars).toBeLessThanOrEqual(1500)
    expect(readable.has_more_evidence).toBe(true)
    expect(f.load).not.toHaveBeenCalled()
  })

  it('counts paragraph separators against an explicit output budget without cutting a quote', async () => {
    const f = fixture()
    const initial = prepareEvidence(f.snapshot, f.passages, f.store, { perPage: 3, maxChars: 4000 })
    const next = f.passages.slice(initial.evidence.length, initial.evidence.length + 2)
    const budget = next.reduce((sum, passage) => sum + Array.from(passage.quote).length, 0)
    const output = validate(
      await createWebFetch(
        f.config,
        f.loader,
        f.store,
      )(
        { cursor: token(initial.next_evidence_cursor), max_chars: budget },
        new AbortController().signal,
      ),
    )
    expect(output.status).toBe('ok')
    expect(output.evidence).toHaveLength(1)
    expect(Array.from(output.content ?? '').length).toBeLessThanOrEqual(budget)
    expect(output.evidence?.[0]?.quote).toBe(next[0]?.quote)
    expect(output.evidence_chars).toBe(Array.from(next[0]?.quote ?? '').length)
  })

  it('honors a reduced deployment default and maximum when resuming a larger retained plan', async () => {
    const f = fixture()
    const initial = prepareEvidence(f.snapshot, f.passages, f.store, { perPage: 3, maxChars: 4000 })
    f.config.fetch.max_chars = 1000
    f.config.fetch.max_output_chars = 1000
    const output = validate(
      await createWebFetch(
        f.config,
        f.loader,
        f.store,
      )({ cursor: token(initial.next_evidence_cursor) }, new AbortController().signal),
    )
    expect(output.status).toBe('error')
    expect(output.error?.code).toBe('INVALID_ARGUMENT')
    expect(output.content ?? '').toBe('')
    expect(f.load).not.toHaveBeenCalled()
  })

  it('keeps legacy full-document cursors readable with an explicit metadata fallback', async () => {
    const f = fixture(false)
    const cursor = f.store.createCursor(
      'fetch',
      { snapshotId: f.snapshot.snapshotId, offset: 0 },
      f.snapshot.expiresAt,
    )
    f.store.close()
    const reopened = open(f.directory)
    const output = validate(
      await createWebFetch(
        f.config,
        f.loader,
        reopened,
      )({ cursor, max_chars: 50000 }, new AbortController().signal),
    )
    expect(output.view).toBe('document')
    expect(output.content).toBe(f.snapshot.content)
    expect(output.source_metadata).toMatchObject({
      metadata_source: 'url_only',
      hostname: 'example.org',
      assets_verified: false,
      retrieved_at: f.snapshot.fetchedAt,
    })
    expect(output.evidence).toEqual([])
    expect(output.has_more_evidence).toBe(false)
    expect(output.next_evidence_cursor).toBeNull()
    expect(output.evidence_chars).toBe(0)
    expect(output.next_cursor).toBeNull()
    expect(f.load).not.toHaveBeenCalled()
  })

  it('expires the plan and both evidence/full-snapshot cursor kinds without refetching', async () => {
    vi.useFakeTimers()
    const f = fixture(true, 1)
    const initial = prepareEvidence(f.snapshot, f.passages, f.store, { perPage: 3, maxChars: 4000 })
    const continuation = token(initial.next_evidence_cursor)
    const fullCursor = initial.evidence[0]?.snapshot_cursor
    await vi.advanceTimersByTimeAsync(1001)
    const fetch = createWebFetch(f.config, f.loader, f.store)
    for (const cursor of [continuation, token(fullCursor)]) {
      const output = validate(await fetch({ cursor }, new AbortController().signal))
      expect(output.error?.code).toBe('CURSOR_EXPIRED')
    }
    expect(f.load).not.toHaveBeenCalled()
  })

  it.each(['version', 'quote', 'offset', 'segment_ids', 'hash', 'plan_shape'])(
    'rejects persisted evidence plan tampering: %s',
    async (field) => {
      const f = fixture()
      const initial = prepareEvidence(f.snapshot, f.passages, f.store, {
        perPage: 3,
        maxChars: 4000,
      })
      const cursor = token(initial.next_evidence_cursor)
      const payload = record(f.store.getCursor(cursor, 'fetch').payload)
      if (typeof payload.planId !== 'string') throw new Error('Expected persisted evidence plan id')
      const plan = record(f.store.getEvidence(payload.planId))
      if (!Array.isArray(plan.evidence)) throw new Error('Expected evidence array')
      const entry = record(plan.evidence[0])
      switch (field) {
        case 'version':
          plan.version = 999
          break
        case 'quote':
          entry.quote = 'Forged statement.'
          break
        case 'offset':
          entry.start_char = 1
          break
        case 'segment_ids':
          entry.segment_ids = ['forged-segment']
          break
        case 'hash':
          entry.content_sha256 = 'a'.repeat(64)
          break
        case 'plan_shape':
          delete plan.snapshotId
          break
      }
      const database = new Database(join(f.directory, 'snapshots.sqlite'))
      database
        .prepare('UPDATE records SET payload = ? WHERE kind = ? AND id = ?')
        .run(JSON.stringify(plan), 'evidence', payload.planId)
      database.close()
      const output = validate(
        await createWebFetch(f.config, f.loader, f.store)({ cursor }, new AbortController().signal),
      )
      expect(output.error?.code).toBe('STORAGE_UNAVAILABLE')
      expect(output.evidence ?? []).toEqual([])
      expect(f.load).not.toHaveBeenCalled()
    },
  )

  it.each([-1, 0.5, 1000])(
    'rejects malformed or out-of-range evidence cursor offset %s',
    async (offset) => {
      const f = fixture()
      const initial = prepareEvidence(f.snapshot, f.passages, f.store, {
        perPage: 3,
        maxChars: 4000,
      })
      const payload = record(
        f.store.getCursor(token(initial.next_evidence_cursor), 'fetch').payload,
      )
      const cursor = f.store.createCursor('fetch', { ...payload, offset }, f.snapshot.expiresAt)
      const output = validate(
        await createWebFetch(f.config, f.loader, f.store)({ cursor }, new AbortController().signal),
      )
      expect(output.error?.code).toBe('CURSOR_MISMATCH')
      expect(f.load).not.toHaveBeenCalled()
    },
  )

  it('resolves the evidence page directly to the identical retained snapshot', () => {
    const f = fixture()
    const first = prepareEvidence(f.snapshot, f.passages, f.store, { perPage: 3, maxChars: 4000 })
    const payload = f.store.getCursor(token(first.next_evidence_cursor), 'fetch').payload
    const resolved = readEvidencePage(payload, f.store)
    expect(resolved.snapshot).toEqual(f.snapshot)
    verifyEntries(resolved.page.evidence, resolved.snapshot)
    expect(resolved.page.evidence_chars).toBeLessThanOrEqual(4000)
  })
})
