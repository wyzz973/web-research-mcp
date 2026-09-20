import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Snapshot, Store } from '../contract.ts'
import { WebError } from '../errors.ts'
import { randomId } from '../ids.ts'

const SCHEMA_VERSION = 1
const SWEEP_BATCH = 200

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
  // Extended result codes (261 BUSY_RECOVERY, 517 BUSY_SNAPSHOT, ...) keep the primary code in the low byte.
  const primary = Number((error as { errcode?: number }).errcode ?? 0) & 0xff
  return primary === 5 || primary === 6 || /database (table )?is locked/iu.test(error.message)
}

/**
 * busy_timeout does not cover every lock (switching the journal mode fails at once), and several
 * agent processes routinely open the same file at the same moment. Waiting yields to the event
 * loop so stdin, timers, and cancellation keep working.
 */
async function withBusyRetry<T>(operation: () => T): Promise<T> {
  const deadline = Date.now() + 10_000
  for (let attempt = 0; ; attempt += 1) {
    try {
      return operation()
    } catch (error) {
      if (!isBusy(error) || Date.now() > deadline) throw error
      await sleep(Math.min(20 + attempt * 15, 200))
    }
  }
}

function readVersion(db: DatabaseSync): number {
  const row = db.prepare('PRAGMA user_version').get() as { user_version?: number } | undefined
  return row?.user_version ?? 0
}

function createSchema(db: DatabaseSync): void {
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

function migrate(db: DatabaseSync): void {
  if (readVersion(db) === SCHEMA_VERSION) return
  // IMMEDIATE serializes concurrent first runs; the version is re-read once the lock is held.
  // A failed BEGIN must surface as the busy error it is, so the caller's retry can see it.
  db.exec('BEGIN IMMEDIATE')
  try {
    const version = readVersion(db)
    if (version > SCHEMA_VERSION)
      throw new WebError(
        'internal',
        `The state database was written by a newer version (schema ${version}).`,
      )
    if (version < SCHEMA_VERSION) createSchema(db)
    db.exec('COMMIT')
  } catch (error) {
    try {
      db.exec('ROLLBACK')
    } catch {
      // The original failure is the one worth reporting.
    }
    throw error
  }
}

/** WAL is unavailable on some network and sync-folder file systems; the rollback journal still works there. */
function chooseJournalMode(db: DatabaseSync): string {
  const current = db.prepare('PRAGMA journal_mode').get() as { journal_mode?: string } | undefined
  if (current?.journal_mode?.toLowerCase() === 'wal') return 'wal'
  try {
    const row = db.prepare('PRAGMA journal_mode = WAL').get() as
      { journal_mode?: string } | undefined
    return row?.journal_mode?.toLowerCase() ?? 'unknown'
  } catch (error) {
    if (isBusy(error)) throw error
    return current?.journal_mode?.toLowerCase() ?? 'delete'
  }
}

/** Local calendar day, the same day the tools echo to the model. */
function today(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${String(now.getDate()).padStart(2, '0')}`
}

function isConstraint(error: unknown): boolean {
  return error instanceof Error && /UNIQUE|constraint/iu.test(error.message)
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
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

/**
 * One SQLite file holds every piece of shared state, so several agent processes on one machine
 * see the same cache, snapshots, and usage ledger without a daemon.
 */
export async function createSqliteStore(location: string): Promise<Store> {
  const { DatabaseSync } = await loadSqlite()
  if (location !== ':memory:') mkdirSync(path.dirname(location), { recursive: true })
  const db = new DatabaseSync(location)
  let journalMode: string
  try {
    db.exec('PRAGMA busy_timeout = 5000')
    journalMode =
      location === ':memory:' ? 'memory' : await withBusyRetry(() => chooseJournalMode(db))
    db.exec('PRAGMA synchronous = NORMAL')
    await withBusyRetry(() => migrate(db))
  } catch (error) {
    // A refused database must not stay open: Windows keeps an open file locked against deletion.
    db.close()
    throw error
  }

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
  // The condition lives inside the statement: a read followed by a write would let two processes
  // both see room for the last call. The first call of the day has no row to conflict with.
  const reserveUsage = db.prepare(
    `INSERT INTO usage (day, source, calls, cost_usd) SELECT ?1, ?2, ?3, 0 WHERE ?3 <= ?4
     ON CONFLICT (day, source) DO UPDATE SET calls = calls + excluded.calls
       WHERE usage.calls + excluded.calls <= ?4`,
  )
  // The budget spans every source, so the guard sums the day inside the same statement.
  const reservePaid = db.prepare(
    `INSERT INTO usage (day, source, calls, cost_usd) SELECT ?1, ?2, ?3, ?4
       WHERE (SELECT COALESCE(SUM(cost_usd), 0) FROM usage WHERE day = ?1) + ?4 <= ?5
     ON CONFLICT (day, source) DO UPDATE SET calls = calls + excluded.calls,
       cost_usd = cost_usd + excluded.cost_usd`,
  )
  const selectUsage = db.prepare(
    'SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(cost_usd), 0) AS cost FROM usage WHERE day = ?',
  )
  const selectUsageBySource = db.prepare(
    'SELECT COALESCE(SUM(calls), 0) AS calls, COALESCE(SUM(cost_usd), 0) AS cost FROM usage WHERE day = ? AND source = ?',
  )
  // Bounded batches keep the write lock short even when large page snapshots expire together.
  const sweepRecords = db.prepare(
    `DELETE FROM records WHERE rowid IN (SELECT rowid FROM records WHERE expires_at <= ? LIMIT ${SWEEP_BATCH})`,
  )
  const sweepSnapshots = db.prepare(
    `DELETE FROM snapshots WHERE rowid IN (SELECT rowid FROM snapshots WHERE expires_at <= ? LIMIT ${SWEEP_BATCH})`,
  )

  let writes = 0
  function maybeSweep(now: number): void {
    writes += 1
    if (writes % 50 !== 1) return
    sweepRecords.run(now)
    sweepSnapshots.run(now)
  }

  function usageRow(row: unknown): { calls: number; cost_usd: number } {
    const value = (row ?? {}) as { calls?: number; cost?: number }
    return { calls: Number(value.calls ?? 0), cost_usd: Number(value.cost ?? 0) }
  }

  return {
    journalMode,
    insertRecord(kind, prefix, value, ttlSeconds, idLength = 4) {
      const now = Date.now()
      const json = JSON.stringify(value)
      for (let attempt = 0; attempt < 8; attempt += 1) {
        // Ids grow by one character after repeated collisions so allocation always terminates.
        const id = `${prefix}${randomId(idLength + Math.floor(attempt / 2))}`
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
      // A corrupt row is treated as missing; callers already handle an expired or unknown id.
      const value = parseJson(row.value)
      if (value === undefined) return undefined
      return { value: value as T, created_at: Number(row.created_at) }
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
    reserveUsage(source, calls, cap) {
      return Number(reserveUsage.run(today(), source, calls, cap).changes) > 0
    },
    reservePaid(source, calls, estimatedCostUsd, budgetUsd) {
      const result = reservePaid.run(today(), source, calls, estimatedCostUsd, budgetUsd)
      return Number(result.changes) > 0
    },
    usageToday() {
      return usageRow(selectUsage.get(today()))
    },
    usageTodayBySource(source) {
      return usageRow(selectUsageBySource.get(today(), source))
    },
    close() {
      db.close()
    },
  }
}
