import { createHash } from 'node:crypto'
import { mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest'
import { createSnapshotStore } from '../src/storage/index.ts'
import type { LoadedDocument, SnapshotStore } from '../src/shared/types.ts'
import { makeSourceId, parseSnapshotId } from '../src/shared/ids.ts'
import type { CursorToken, SnapshotId, SourceId } from '../src/shared/ids.ts'
import type { SourceMetadata } from '../src/generated/source-metadata.ts'

const directories: string[] = []
const stores: SnapshotStore[] = []

function tempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'web-research-storage-'))
  directories.push(directory)
  return directory
}

function open(directory = tempDirectory(), maxBytes = 2 ** 20, ttlSeconds = 60): SnapshotStore {
  const store = createSnapshotStore({ directory, ttlSeconds, maxBytes })
  stores.push(store)
  return store
}

function loaded(text = '\n你好🙂 e\u0301\n\n第二段\n最后一行\n\n'): LoadedDocument {
  return {
    url: 'https://example.org/article#fragment',
    finalUrl: 'https://example.org/article',
    title: 'Unicode article',
    contentType: 'text/html',
    text,
    markdown: `# 标题\n\n${text}`,
    fetchedAt: '2026-09-08T08:00:00.000Z',
    extractorVersion: 'test-v1',
    warnings: [],
  }
}

function deadline(): string {
  return new Date(Date.now() + 60_000).toISOString()
}

function metadata(): SourceMetadata {
  return {
    source_url: 'https://example.org/article#fragment',
    final_url: 'https://example.org/article',
    canonical_url: 'https://example.org/canonical',
    hostname: 'example.org',
    domain: 'example.org',
    origin: 'https://example.org',
    display_url: 'example.org/article',
    site_name: '示例研究站',
    description: '研究与证据🙂',
    language: 'zh-CN',
    favicon_url: 'https://example.org/favicon.svg',
    logo_url: 'https://example.org/logo.png',
    image_url: 'https://example.org/preview.png',
    published_at: '2026-09-01T00:00:00.000Z',
    modified_at: null,
    retrieved_at: '2026-09-08T08:00:00.000Z',
    metadata_source: 'html',
    metadata_url: 'https://example.org/article',
    assets_verified: false,
    provenance: {
      site_name: 'opengraph',
      favicon_url: 'html_link',
      logo_url: 'json_ld',
      image_url: 'opengraph',
      canonical_url: 'html_link',
    },
  }
}

afterEach(() => {
  vi.useRealTimers()
  for (const store of stores.splice(0)) store.close()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('durable snapshots', () => {
  it('persists an immutable evidence plan across restart independently from a same-ID search pool', () => {
    const directory = tempDirectory()
    const store = open(directory)
    const plan = {
      snapshotId: 'fixture-snapshot',
      passages: [{ start_char: 0, end_char: 3 }],
      version: 1,
    }
    const search = { results: ['https://example.org/'] }
    store.putEvidence('same-id', plan, deadline())
    store.putSearch('same-id', search, deadline())
    expect(store.getEvidence('same-id')).toEqual(plan)
    expect(store.getSearch('same-id')).toEqual(search)
    expect(() => store.putEvidence('same-id', { changed: true }, deadline())).toThrow(
      expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }),
    )
    store.close()
    const reopened = open(directory)
    expect(reopened.getEvidence('same-id')).toEqual(plan)
    expect(reopened.getSearch('same-id')).toEqual(search)
    expect(() => reopened.getEvidence('unknown')).toThrow(
      expect.objectContaining({ code: 'CURSOR_EXPIRED' }),
    )
  })

  it('applies retention and JSON validation to evidence plans', () => {
    vi.useFakeTimers()
    const store = open()
    expect(() => store.putEvidence('invalid', { value: undefined }, deadline())).toThrow(
      expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }),
    )
    store.putEvidence('short', { passages: [] }, new Date(Date.now() + 1000).toISOString())
    vi.advanceTimersByTime(1001)
    expect(() => store.getEvidence('short')).toThrow(
      expect.objectContaining({ code: 'CURSOR_EXPIRED' }),
    )
  })

  it('retains all source metadata across serialization and restart without aliasing caller objects', () => {
    const directory = tempDirectory()
    const store = open(directory)
    const original = metadata()
    const snapshot = store.saveDocument({ ...loaded(), sourceMetadata: original }, 'text')
    expect(snapshot.sourceMetadata).toEqual(metadata())
    original.site_name = 'Caller changed its object'
    original.provenance.site_name = 'hostname'
    expect(snapshot.sourceMetadata).toEqual(metadata())
    store.close()
    const reopened = open(directory)
    expect(reopened.getDocument(snapshot.snapshotId)).toEqual(snapshot)
    expect(reopened.getDocument(snapshot.snapshotId).sourceMetadata).toEqual(metadata())
    const database = new Database(join(directory, 'snapshots.sqlite'))
    expect(database.pragma('user_version', { simple: true })).toBe(1)
    database.close()
  })

  it.each([
    null,
    { assets_verified: true },
    { ...metadata(), favicon_url: 'javascript:alert(1)' },
    { ...metadata(), assets_verified: true },
    { ...metadata(), provenance: { ...metadata().provenance, logo_url: 'certified' } },
    { ...metadata(), published_at: 'not-a-date' },
    { ...metadata(), injected_field: 'discard-me?' },
  ])(
    'rejects invalid persisted source metadata rather than silently dropping it: %j',
    (sourceMetadata) => {
      const directory = tempDirectory()
      const store = open(directory)
      const snapshot = store.saveDocument(loaded(), 'text')
      const database = new Database(join(directory, 'snapshots.sqlite'))
      database
        .prepare('UPDATE records SET payload = ? WHERE kind = ? AND id = ?')
        .run(JSON.stringify({ ...snapshot, sourceMetadata }), 'snapshot', snapshot.snapshotId)
      database.close()
      expect(() => store.getDocument(snapshot.snapshotId)).toThrow(
        expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }),
      )
    },
  )

  it.each([
    { source_url: 'https://other.example.org/article' },
    { final_url: 'https://other.example.org/article' },
    { final_url: null },
    { retrieved_at: '2026-09-08T09:00:00.000Z' },
    { retrieved_at: null },
    { metadata_url: 'https://other.example.org/article' },
    { metadata_url: null },
  ])(
    'rejects schema-valid metadata attributed to a different snapshot observation: %j',
    (patch) => {
      const directory = tempDirectory()
      const store = open(directory)
      const snapshot = store.saveDocument({ ...loaded(), sourceMetadata: metadata() }, 'text')
      const database = new Database(join(directory, 'snapshots.sqlite'))
      database
        .prepare('UPDATE records SET payload = ? WHERE kind = ? AND id = ?')
        .run(
          JSON.stringify({ ...snapshot, sourceMetadata: { ...metadata(), ...patch } }),
          'snapshot',
          snapshot.snapshotId,
        )
      database.close()
      expect(() => store.getDocument(snapshot.snapshotId)).toThrow(
        expect.objectContaining({
          code: 'STORAGE_UNAVAILABLE',
          message: 'Stored source metadata does not match its snapshot observation.',
        }),
      )
    },
  )

  it('continues reading a schema-v1 snapshot that predates optional source metadata', () => {
    const directory = tempDirectory()
    const store = open(directory)
    const snapshot = store.saveDocument(loaded(), 'text')
    expect(snapshot).not.toHaveProperty('sourceMetadata')
    store.close()
    const reopened = open(directory)
    const restored = reopened.getDocument(snapshot.snapshotId)
    expect(restored).toEqual(snapshot)
    expect(restored).not.toHaveProperty('sourceMetadata')
    expect(restored.contentSha256).toBe(
      createHash('sha256').update(loaded().text, 'utf8').digest('hex'),
    )
  })

  it('keeps domain identities distinct while preserving the stored schema-v1 strings', () => {
    expectTypeOf<SourceId>().not.toEqualTypeOf<SnapshotId>()
    expectTypeOf<CursorToken>().not.toEqualTypeOf<SnapshotId>()
    expectTypeOf<string>().not.toMatchTypeOf<SourceId>()
    const store = open()
    const snapshot = store.saveDocument(loaded(), 'text')
    expectTypeOf(snapshot.sourceId).toEqualTypeOf<SourceId>()
    expectTypeOf(snapshot.snapshotId).toEqualTypeOf<SnapshotId>()
    expectTypeOf(store.createCursor('fetch', {}, snapshot.expiresAt)).toEqualTypeOf<CursorToken>()
    const expected = `source_${createHash('sha256').update('https://example.org/article').digest('hex')}`
    expect(snapshot.sourceId).toBe(expected)
    expect(makeSourceId('https://example.org/article#another')).toBe(snapshot.sourceId)
    expect(makeSourceId('https://example.org/article?q=%2f&a=1&a=2')).not.toBe(
      makeSourceId('https://example.org/article?a=1&a=2&q=%2F'),
    )
    expect(parseSnapshotId(snapshot.snapshotId)).toBe(snapshot.snapshotId)
    expect(JSON.parse(JSON.stringify(snapshot)).sourceId).toBe(expected)
  })

  it('retains exact UTF-8 content, code-point offsets, format identity and original observation time', () => {
    const store = open()
    const document = loaded()
    const snapshot = store.saveDocument(document, 'text')
    expect(snapshot.content).toBe(document.text)
    expect(snapshot.contentSha256).toBe(
      createHash('sha256').update(document.text, 'utf8').digest('hex'),
    )
    expect(snapshot.segments.map((segment) => segment.text).join('')).toBe(document.text)
    for (const segment of snapshot.segments) {
      expect(Array.from(document.text).slice(segment.start_char, segment.end_char).join('')).toBe(
        segment.text,
      )
    }
    expect(snapshot.segments.at(-1)?.end_char).toBe(Array.from(document.text).length)
    const markdown = store.saveDocument(document, 'markdown')
    expect(markdown.snapshotId).not.toBe(snapshot.snapshotId)
    expect(markdown.sourceId).toBe(snapshot.sourceId)
    expect(markdown.fetchedAt).toBe(document.fetchedAt)
    expect(store.saveDocument({ ...document }, 'text').snapshotId).not.toBe(snapshot.snapshotId)
    expect(store.saveDocument(document, 'text')).toEqual(snapshot)
  })

  it('reads the exact snapshot, cursor and frozen search pool after closing and reopening', () => {
    const directory = tempDirectory()
    let store = open(directory)
    const snapshot = store.saveDocument(loaded(), 'text')
    const token = store.createCursor(
      'fetch',
      { snapshotId: snapshot.snapshotId, offset: 3 },
      snapshot.expiresAt,
    )
    const pool = { results: [{ url: 'https://example.org/', rank: 1 }], scope: null }
    store.putSearch('search-1', pool, deadline())
    store.close()
    store = open(directory)
    expect(store.getDocument(snapshot.snapshotId)).toEqual(snapshot)
    expect(store.getCursor(token, 'fetch').payload).toEqual({
      snapshotId: snapshot.snapshotId,
      offset: 3,
    })
    expect(store.getSearch('search-1')).toEqual(pool)
    expect(() => store.putSearch('search-1', { mutated: true }, deadline())).toThrow(
      expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }),
    )
    expect(store.getSearch('search-1')).toEqual(pool)
  })

  it('rejects random, modified and cross-tool cursor tokens without exposing stored payload', () => {
    const store = open()
    const token = store.createCursor('fetch', { secret: 'local payload' }, deadline())
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/u)
    expect(() => store.getCursor('random', 'fetch')).toThrow(
      expect.objectContaining({ code: 'CURSOR_EXPIRED' }),
    )
    const modified = `${token[0] === 'A' ? 'B' : 'A'}${token.slice(1)}`
    expect(() => store.getCursor(modified, 'fetch')).toThrow(
      expect.objectContaining({ code: 'CURSOR_EXPIRED' }),
    )
    expect(() => store.getCursor(token, 'search')).toThrow(
      expect.objectContaining({ code: 'CURSOR_MISMATCH' }),
    )
  })

  it('returns an explicit expiry error for expired cursor, search pool and snapshot', () => {
    vi.useFakeTimers()
    const store = open(undefined, undefined, 1)
    const snapshot = store.saveDocument(loaded(), 'text')
    const token = store.createCursor('fetch', {}, snapshot.expiresAt)
    store.putSearch('search-1', [], snapshot.expiresAt)
    vi.advanceTimersByTime(1001)
    for (const read of [
      () => store.getDocument(snapshot.snapshotId),
      () => store.getCursor(token, 'fetch'),
      () => store.getSearch('search-1'),
    ]) {
      expect(read).toThrow(expect.objectContaining({ code: 'CURSOR_EXPIRED' }))
    }
  })

  it('rejects unknown schema versions and preserves the existing database', () => {
    const directory = tempDirectory()
    const database = new Database(join(directory, 'snapshots.sqlite'))
    database.exec("CREATE TABLE precious (value TEXT); INSERT INTO precious VALUES ('keep')")
    database.pragma('user_version = 999')
    database.close()
    expect(() => open(directory)).toThrow(expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }))
    const inspect = new Database(join(directory, 'snapshots.sqlite'))
    expect(inspect.pragma('user_version', { simple: true })).toBe(999)
    expect(inspect.prepare('SELECT value FROM precious').get()).toEqual({ value: 'keep' })
    inspect.close()
  })

  it('detects durable snapshot corruption independently of the stored hash', () => {
    const directory = tempDirectory()
    const store = open(directory)
    const snapshot = store.saveDocument(loaded(), 'text')
    const database = new Database(join(directory, 'snapshots.sqlite'))
    database
      .prepare('UPDATE records SET payload = ? WHERE kind = ? AND id = ?')
      .run(JSON.stringify({ ...snapshot, content: 'tampered' }), 'snapshot', snapshot.snapshotId)
    database.close()
    expect(() => store.getDocument(snapshot.snapshotId)).toThrow(
      expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }),
    )
  })

  it('rejects a stored source identity bound to a different URL before returning a snapshot', () => {
    const directory = tempDirectory()
    const store = open(directory)
    const snapshot = store.saveDocument(loaded(), 'text')
    const database = new Database(join(directory, 'snapshots.sqlite'))
    database
      .prepare('UPDATE records SET payload = ? WHERE kind = ? AND id = ?')
      .run(
        JSON.stringify({ ...snapshot, sourceId: makeSourceId('https://elsewhere.org/') }),
        'snapshot',
        snapshot.snapshotId,
      )
    database.close()
    expect(() => store.getDocument(snapshot.snapshotId)).toThrow(
      expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }),
    )
  })

  it('refuses capacity overflow atomically and retains all still-valid records', () => {
    const directory = tempDirectory()
    const budget = 256 * 1024
    const store = open(directory, budget)
    const snapshot = store.saveDocument(loaded(), 'text')
    const token = store.createCursor(
      'fetch',
      { snapshotId: snapshot.snapshotId },
      snapshot.expiresAt,
    )
    expect(() => store.createCursor('search', { huge: 'z'.repeat(budget) }, deadline())).toThrow(
      expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }),
    )
    expect(store.getDocument(snapshot.snapshotId)).toEqual(snapshot)
    expect(store.getCursor(token, 'fetch').payload).toEqual({ snapshotId: snapshot.snapshotId })
    const database = new Database(join(directory, 'snapshots.sqlite'))
    expect(
      database.prepare("SELECT count(*) AS count FROM records WHERE kind = 'cursor:search'").get(),
    ).toEqual({ count: 0 })
    database.close()
    expect(
      readdirSync(directory).reduce((sum, file) => sum + statSync(join(directory, file)).size, 0),
    ).toBeLessThanOrEqual(budget)
    expect(statSync(directory).mode & 0o777).toBe(0o700)
    expect(statSync(join(directory, 'snapshots.sqlite')).mode & 0o777).toBe(0o600)
  })

  it('reclaims only expired records to admit later data', () => {
    vi.useFakeTimers()
    const store = open(undefined, 256 * 1024, 1)
    store.putSearch('old', { text: 'a'.repeat(30_000) }, new Date(Date.now() + 1000).toISOString())
    vi.advanceTimersByTime(1001)
    store.putSearch('new', { text: 'b'.repeat(30_000) }, deadline())
    expect(store.getSearch('new')).toEqual({ text: 'b'.repeat(30_000) })
    expect(() => store.getSearch('old')).toThrow(
      expect.objectContaining({ code: 'CURSOR_EXPIRED' }),
    )
  })

  it('rolls back SQLITE_FULL inside the actual insert transaction without a phantom record', () => {
    const directory = tempDirectory()
    const store = open(directory, 256 * 1024)
    const retained: string[] = []
    let failedId: string | undefined
    for (let index = 0; index < 20; index++) {
      const id = `pool-${index}`
      try {
        store.putSearch(id, { text: 'x'.repeat(8000) }, deadline())
        retained.push(id)
      } catch (error) {
        expect(error).toMatchObject({ code: 'STORAGE_UNAVAILABLE' })
        failedId = id
        break
      }
    }
    expect(retained.length).toBeGreaterThan(0)
    expect(failedId).toBeDefined()
    for (const id of retained) expect(store.getSearch(id)).toEqual({ text: 'x'.repeat(8000) })
    if (failedId !== undefined)
      expect(() => store.getSearch(failedId)).toThrow(
        expect.objectContaining({ code: 'CURSOR_EXPIRED' }),
      )
    const database = new Database(join(directory, 'snapshots.sqlite'))
    expect(database.prepare('SELECT count(*) AS count FROM records').get()).toEqual({
      count: retained.length,
    })
    database.close()
  })

  it('rejects non-JSON payloads and malformed persisted JSON at the boundary', () => {
    const directory = tempDirectory()
    const store = open(directory)
    expect(() => store.createCursor('fetch', { undefined }, deadline())).toThrow(
      expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }),
    )
    expect(() => store.putSearch('nan', Number.NaN, deadline())).toThrow(
      expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }),
    )
    store.putSearch('valid', {}, deadline())
    const database = new Database(join(directory, 'snapshots.sqlite'))
    database.prepare('UPDATE records SET payload = ? WHERE id = ?').run('{invalid', 'valid')
    database.close()
    expect(() => store.getSearch('valid')).toThrow(
      expect.objectContaining({ code: 'STORAGE_UNAVAILABLE' }),
    )
  })
})
