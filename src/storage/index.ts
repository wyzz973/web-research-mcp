import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { AppError } from '../shared/errors.ts'
import { makeCursorToken, makeSnapshotId, makeSourceId, parseCursorToken } from '../shared/ids.ts'
import type {
  CursorRecord,
  DocumentSnapshot,
  LoadedDocument,
  SnapshotStore,
} from '../shared/types.ts'
import { decodeJson, decodeSnapshot, encodeJson, segmentContent, sha256 } from './serialization.ts'

const SCHEMA_VERSION = 1
const PAGE_SIZE = 4096
const WAL_RESERVE = 32768 + 8192

interface StoredRow {
  payload: string
  expires_at: number
}

function readRow(value: unknown): StoredRow | undefined {
  if (value === undefined) return undefined
  if (
    typeof value !== 'object' ||
    value === null ||
    !('payload' in value) ||
    typeof value.payload !== 'string' ||
    !('expires_at' in value) ||
    typeof value.expires_at !== 'number' ||
    !Number.isFinite(value.expires_at)
  ) {
    throw new AppError('STORAGE_UNAVAILABLE', 'Invalid stored record.')
  }
  return { payload: value.payload, expires_at: value.expires_at }
}

/** Owns one SQLite connection. Valid records are never evicted to admit new writes. */
export function createSnapshotStore(options: {
  directory: string
  ttlSeconds: number
  maxBytes: number
}): SnapshotStore {
  const maxPages = Math.floor((options.maxBytes - WAL_RESERVE) / (3 * PAGE_SIZE))
  if (
    !Number.isSafeInteger(options.maxBytes) ||
    maxPages < 5 ||
    !Number.isFinite(options.ttlSeconds) ||
    options.ttlSeconds <= 0
  ) {
    throw new AppError(
      'STORAGE_UNAVAILABLE',
      'Invalid storage lifetime or insufficient disk budget.',
    )
  }
  let database: Database.Database | undefined
  try {
    const directory = resolve(options.directory)
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) {
      throw new AppError('STORAGE_UNAVAILABLE', 'Storage directory must be a private directory.')
    }
    chmodSync(directory, 0o700)
    const path = join(directory, 'snapshots.sqlite')
    if (existsSync(path) && (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink())) {
      throw new AppError('STORAGE_UNAVAILABLE', 'Storage database must be a regular file.')
    }
    database = new Database(path)
    chmodSync(path, 0o600)
    const db = database
    const version: unknown = db.pragma('user_version', { simple: true })
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
    if (version !== SCHEMA_VERSION && (version !== 0 || tables.length > 0)) {
      throw new AppError(
        'STORAGE_UNAVAILABLE',
        'Unsupported database schema version; database was preserved.',
      )
    }
    db.pragma('busy_timeout = 1000')
    db.pragma('page_size = 4096')
    if (db.pragma('page_size', { simple: true }) !== PAGE_SIZE) {
      throw new AppError('STORAGE_UNAVAILABLE', 'Unsupported database page size.')
    }
    const pages: unknown = db.pragma('page_count', { simple: true })
    if (typeof pages !== 'number' || pages > maxPages) {
      throw new AppError(
        'STORAGE_UNAVAILABLE',
        'Existing database exceeds the configured disk budget.',
      )
    }
    // Bound main DB plus worst-case transaction WAL and shared-memory overhead conservatively.
    db.pragma(`max_page_count = ${maxPages}`)
    db.pragma('journal_mode = WAL')
    db.pragma('synchronous = FULL')
    db.pragma('wal_autocheckpoint = 1')
    db.pragma('journal_size_limit = 0')
    if (version === 0) {
      db.transaction(() => {
        db.exec(
          'CREATE TABLE records (kind TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (kind, id)); CREATE INDEX records_expiry ON records(expires_at)',
        )
        db.pragma(`user_version = ${SCHEMA_VERSION}`)
      })()
    }
    db.pragma('wal_checkpoint(TRUNCATE)')
    const find = db.prepare('SELECT payload, expires_at FROM records WHERE kind = ? AND id = ?')
    const insert = db.prepare(
      'INSERT INTO records (kind, id, payload, expires_at) VALUES (?, ?, ?, ?)',
    )
    const expire = db.prepare('DELETE FROM records WHERE expires_at <= ?')
    const observations = new WeakMap<LoadedDocument, string>()

    function guard<T>(operation: () => T): T {
      try {
        if (!db.open) throw new AppError('STORAGE_UNAVAILABLE', 'Snapshot storage is closed.')
        return operation()
      } catch (error) {
        if (error instanceof AppError) throw error
        throw new AppError('STORAGE_UNAVAILABLE', 'Snapshot storage could not read or commit data.')
      }
    }

    function expiry(expiresAt: string): number {
      const milliseconds = Date.parse(expiresAt)
      if (!Number.isFinite(milliseconds))
        throw new AppError('STORAGE_UNAVAILABLE', 'Invalid retention deadline.')
      if (milliseconds <= Date.now())
        throw new AppError('CURSOR_EXPIRED', 'The snapshot or cursor has expired.')
      return milliseconds
    }

    function write(kind: string, id: string, payload: unknown, expiresAt: string): void {
      const deadline = expiry(expiresAt)
      const json = encodeJson(payload)
      if (Buffer.byteLength(json, 'utf8') > maxPages * PAGE_SIZE) {
        throw new AppError('STORAGE_UNAVAILABLE', 'Snapshot storage capacity has been reached.')
      }
      const checkpoint: unknown = db.pragma('wal_checkpoint(TRUNCATE)')
      const first: unknown = Array.isArray(checkpoint) ? checkpoint[0] : undefined
      if (typeof first !== 'object' || first === null || !('busy' in first) || first.busy !== 0) {
        throw new AppError(
          'STORAGE_UNAVAILABLE',
          'Snapshot storage is busy; WAL budget cannot be reclaimed.',
        )
      }
      db.transaction(() => {
        expire.run(Date.now())
        insert.run(kind, id, json, deadline)
      })()
      db.pragma('wal_checkpoint(TRUNCATE)')
    }

    function read(kind: string, id: string): StoredRow {
      const row = readRow(find.get(kind, id))
      if (!row || row.expires_at <= Date.now()) {
        throw new AppError('CURSOR_EXPIRED', 'The snapshot or cursor has expired or is unknown.')
      }
      return row
    }

    return {
      saveDocument(document, format) {
        return guard(() => {
          let observation = observations.get(document)
          if (observation === undefined) {
            observation = randomUUID()
            observations.set(document, observation)
          }
          let snapshotId = makeSnapshotId(observation, format)
          const existing = readRow(find.get('snapshot', snapshotId))
          if (existing && existing.expires_at > Date.now())
            return decodeSnapshot(decodeJson(existing.payload))
          if (existing) {
            observation = randomUUID()
            observations.set(document, observation)
            snapshotId = makeSnapshotId(observation, format)
          }
          const content = format === 'text' ? document.text : document.markdown
          const snapshot: DocumentSnapshot = {
            sourceId: makeSourceId(document.url),
            snapshotId,
            url: document.url,
            finalUrl: document.finalUrl,
            title: document.title,
            fetchedAt: document.fetchedAt,
            expiresAt: new Date(Date.now() + options.ttlSeconds * 1000).toISOString(),
            contentType: document.contentType,
            format,
            content,
            contentSha256: sha256(content),
            extractorVersion: document.extractorVersion,
            segments: segmentContent(content),
            warnings: [...document.warnings],
          }
          write('snapshot', snapshotId, snapshot, snapshot.expiresAt)
          return snapshot
        })
      },
      getDocument(snapshotId) {
        return guard(() => {
          const row = read('snapshot', snapshotId)
          const snapshot = decodeSnapshot(decodeJson(row.payload))
          if (
            snapshot.snapshotId !== snapshotId ||
            Date.parse(snapshot.expiresAt) !== row.expires_at
          ) {
            throw new AppError('STORAGE_UNAVAILABLE', 'Stored snapshot identity check failed.')
          }
          return snapshot
        })
      },
      createCursor(kind, payload, expiresAt) {
        return guard(() => {
          const token = makeCursorToken()
          write(`cursor:${kind}`, sha256(token), payload, expiresAt)
          return token
        })
      },
      getCursor(token, kind): CursorRecord {
        return guard(() => {
          const id = sha256(parseCursorToken(token))
          const other = readRow(find.get(`cursor:${kind === 'fetch' ? 'search' : 'fetch'}`, id))
          if (other && other.expires_at > Date.now())
            throw new AppError('CURSOR_MISMATCH', 'Cursor belongs to a different tool.')
          const row = read(`cursor:${kind}`, id)
          return {
            kind,
            payload: decodeJson(row.payload),
            expiresAt: new Date(row.expires_at).toISOString(),
          }
        })
      },
      putSearch(id, payload, expiresAt) {
        guard(() => write('search', id, payload, expiresAt))
      },
      getSearch(id) {
        return guard(() => decodeJson(read('search', id).payload))
      },
      close() {
        if (db.open) db.close()
      },
    }
  } catch (error) {
    database?.close()
    if (error instanceof AppError) throw error
    throw new AppError('STORAGE_UNAVAILABLE', 'Unable to open snapshot storage.')
  }
}
