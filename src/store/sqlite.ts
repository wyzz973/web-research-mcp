import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Snapshot, Store } from '../contract.ts'
import { WebError } from '../errors.ts'
import { randomId } from '../ids.ts'

const SCHEMA_VERSION = 1

/** Node 22 prints an ExperimentalWarning for node:sqlite. Keep CLI stderr clean; drop only that one. */
async function loadSqlite(): Promise<typeof import('node:sqlite')> {
  const original = process.emitWarning
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const text = typeof warning === 'string' ? warning : warning.message
    if (text.includes('SQLite is an experimental feature')) return
    ;(original as (...args: unknown[]) => void).call(process, warning, ...rest)
  }) as typeof process.emitWarning
  try {
    return await import('node:sqlite')
  } finally {
    process.emitWarning = original
  }
}

function isBusy(error: unknown): boolean {
  if (!(error instanceof Error)) return false
  const code = (error as { errcode?: number }).errcode
  return (
    code === 5 || code === 6 || /database is locked|database table is locked/iu.test(error.message)
  )
}

function pause(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)
}

/**
 * busy_timeout does not cover every lock (switching the journal mode fails immediately), and
 * several agent processes routinely open the same file at the same moment.
 */
function withBusyRetry<T>(operation: () => T): T {
  const deadline = Date.now() + 10_000
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation()
    } catch (error) {
      if (!isBusy(error) || Date.now() > deadline) throw error
      pause(Math.min(20 + attempt * 15, 200))
    }
  }
}

function readVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  return row?.user_version ?? 0
}

function migrate(db: DatabaseSync): void {
  if (readVersion(db) === SCHEMA_VERSION) return
  // IMMEDIATE serializes concurrent first runs; the version is re-read once the lock is held.
  db.exec('BEGIN IMMEDIATE')
  try {
    const version = readVersion(db)
    if (version > SCHEMA_VERSION)
      throw new WebError(
        'internal',
        `The state database was written by a newer version (schema ${version}).`,
      )
    if (version < SCHEMA_VERSION) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS records (
          kind TEXT NOT NULL, id TEXT NOT NULL, value TEXT NOT NULL,
          created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
          PRIMARY KEY (kind, id)
        );
        CREATE INDEX IF NOT EXISTS records_expiry ON records (expires_at);
        CREATE TABLE IF NOT EXISTS snapshots (
          id TEXT PRIMARY KEY, url TEXT NOT NULL, final_url TEXT NOT NULL,
          http_status INTEGER NOT NULL, content_type TEXT NOT NULL, title TEXT NOT NULL,
          markdown TEXT NOT NULL, sha256 TEXT NOT NULL, retrieved_at TEXT NOT NULL,
          hidden_removed INTEGER NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS snapshots_url ON snapshots (url, created_at);
        CREATE INDEX IF NOT EXISTS snapshots_expiry ON snapshots (expires_at);
        CREATE TABLE IF NOT EXISTS usage (
          day TEXT NOT NULL, source TEXT NOT NULL, calls INTEGER NOT NULL, cost_usd REAL NOT NULL,
          PRIMARY KEY (day, source)
        );
        PRAGMA user_version = ${SCHEMA_VERSION};
      `)
    }
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
}

function enableWal(db: DatabaseSync): void {
  const row = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined
  if (row?.journal_mode?.toLowerCase() === 'wal') return
  db.exec('PRAGMA journal_mode = WAL')
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * One SQLite file holds every piece of shared state, so several agent processes on one machine
 * see the same cache, snapshots, and usage ledger without a daemon.
 */
export async function createSqliteStore(location: string): Promise<Store> {
  const { DatabaseSync } = await loadSqlite()
  if (location !== ':memory:') mkdirSync(path.dirname(location), { recursive: true })
  const db = new DatabaseSync(location)
  db.exec('PRAGMA busy_timeout = 5000')
  if (location !== ':memory:') withBusyRetry(() => enableWal(db))
  db.exec('PRAGMA synchronous = NORMAL')
  withBusyRetry(() => migrate(db))

  const insertRecord = db.prepare(
    'INSERT INTO records (kind, id, value, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
  )
  const upsertRecord = db.prepare(
    `INSERT INTO records (kind, id, value, created_at, expires_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (kind, id) DO UPDATE SET value = excluded.value,
       created_at = excluded.created_at, expires_at = excluded.expires_at`,
  )
  const selectRecord = db.prepare(
    'SELECT value, created_at FROM records WHERE kind = ? AND id = ? AND expires_at > ?',
  )
  const insertSnapshot = db.prepare(
    `INSERT INTO snapshots (id, url, final_url, http_status, content_type, title, markdown, sha256,
       retrieved_at, hidden_removed, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  const selectSnapshot = db.prepare('SELECT * FROM snapshots WHERE id = ? AND expires_at > ?')
  const selectSnapshotByUrl = db.prepare(
    'SELECT * FROM snapshots WHERE url = ? AND expires_at > ? ORDER BY created_at DESC LIMIT 1',
  )
  const upsertUsage = db.prepare(
    `INSERT INTO usage (day, source, calls, cost_usd) VALUES (?, ?, ?, ?)
     ON CONFLICT (day, source) DO UPDATE SET calls = calls + excluded.calls,
       cost_usd = cost_usd + excluded.cost_usd`,
  )
  const selectUsage = db.prepare(
    'SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(cost_usd), 0) AS cost FROM usage WHERE day = ?',
  )
  const selectUsageBySource = db.prepare(
    'SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(cost_usd), 0) AS cost FROM usage WHERE day = ? AND source = ?',
  )
  const sweepRecords = db.prepare('DELETE FROM records WHERE expires_at <= ?')
  const sweepSnapshots = db.prepare('DELETE FROM snapshots WHERE expires_at <= ?')

  let writes = 0
  function maybeSweep(now: number): void {
    writes += 1
    if (writes % 50 !== 1) return
    sweepRecords.run(now)
    sweepSnapshots.run(now)
  }

  function isConstraint(error: unknown): boolean {
    return error instanceof Error && /UNIQUE|constraint/iu.test(error.message)
  }

  function toSnapshot(row: unknown): Snapshot | undefined {
    if (typeof row !== 'object' || row === null) return undefined
    const r = row as Record<string, unknown>
    return {
      id: String(r.id),
      url: String(r.url),
      final_url: String(r.final_url),
      http_status: Number(r.http_status),
      content_type: String(r.content_type),
      title: String(r.title),
      markdown: String(r.markdown),
      sha256: String(r.sha256),
      retrieved_at: String(r.retrieved_at),
      hidden_removed: Number(r.hidden_removed),
    }
  }

  return {
    insertRecord(kind, prefix, value, ttlSeconds) {
      const now = Date.now()
      const json = JSON.stringify(value)
      for (let attempt = 0; attempt < 8; attempt += 1) {
        // Ids grow by one character after repeated collisions so allocation always terminates.
        const id = `${prefix}${randomId(4 + Math.floor(attempt / 2))}`
        try {
          insertRecord.run(kind, id, json, now, now + ttlSeconds * 1000)
          maybeSweep(now)
          return id
        } catch (error) {
          if (!isConstraint(error)) throw error
        }
      }
      throw new WebError('internal', 'Could not allocate a unique id.')
    },
    putRecord(kind, id, value, ttlSeconds) {
      const now = Date.now()
      upsertRecord.run(kind, id, JSON.stringify(value), now, now + ttlSeconds * 1000)
      maybeSweep(now)
    },
    getRecord<T>(kind: string, id: string) {
      const row = selectRecord.get(kind, id, Date.now()) as
        { value: string; created_at: number } | undefined
      if (!row) return undefined
      return { value: JSON.parse(row.value) as T, created_at: Number(row.created_at) }
    },
    insertSnapshot(snapshot, ttlSeconds) {
      const now = Date.now()
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const id = `s_${randomId(6 + Math.floor(attempt / 2))}`
        try {
          insertSnapshot.run(
            id,
            snapshot.url,
            snapshot.final_url,
            snapshot.http_status,
            snapshot.content_type,
            snapshot.title,
            snapshot.markdown,
            snapshot.sha256,
            snapshot.retrieved_at,
            snapshot.hidden_removed,
            now,
            now + ttlSeconds * 1000,
          )
          maybeSweep(now)
          return { id, ...snapshot }
        } catch (error) {
          if (!isConstraint(error)) throw error
        }
      }
      throw new WebError('internal', 'Could not allocate a unique snapshot id.')
    },
    getSnapshot(id) {
      return toSnapshot(selectSnapshot.get(id, Date.now()))
    },
    latestSnapshotForUrl(url) {
      return toSnapshot(selectSnapshotByUrl.get(url, Date.now()))
    },
    addUsage(source, calls, costUsd) {
      upsertUsage.run(today(), source, calls, costUsd)
    },
    usageToday() {
      const row = selectUsage.get(today()) as { calls: number; cost: number } | undefined
      return { calls: Number(row?.calls ?? 0), cost_usd: Number(row?.cost ?? 0) }
    },
    usageTodayBySource(source) {
      const row = selectUsageBySource.get(today(), source) as
        { calls: number; cost: number } | undefined
      return { calls: Number(row?.calls ?? 0), cost_usd: Number(row?.cost ?? 0) }
    },
    close() {
      db.close()
    },
  }
}
