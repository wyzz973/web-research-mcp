import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import Database from 'better-sqlite3'
import { TRACE_MAX_BYTES } from '../shared/trace.ts'
import type { TraceJson, TraceRun, TraceSpan, TraceStatus, TraceStore } from '../shared/trace.ts'

const RETENTION_MS = 24 * 60 * 60 * 1000
const statuses: readonly string[] = [
  'running',
  'ok',
  'error',
  'partial',
  'cancelled',
  'skipped',
  'interrupted',
]
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function json(value: unknown, depth = 0): value is TraceJson {
  if (depth > 10) return false
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value))
    return value.length <= 200 && value.every((item: unknown) => json(item, depth + 1))
  return (
    record(value) &&
    Object.keys(value).length <= 200 &&
    Object.values(value).every((item) => json(item, depth + 1))
  )
}
function date(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value))
}
function status(value: unknown): value is TraceStatus {
  return typeof value === 'string' && statuses.includes(value)
}
function span(value: unknown): value is TraceSpan {
  return (
    record(value) &&
    typeof value.id === 'string' &&
    typeof value.name === 'string' &&
    (value.parent_id === null || typeof value.parent_id === 'string') &&
    status(value.status) &&
    date(value.started_at) &&
    (value.ended_at === undefined || date(value.ended_at)) &&
    (value.duration_ms === undefined ||
      (typeof value.duration_ms === 'number' &&
        value.duration_ms >= 0 &&
        Number.isFinite(value.duration_ms))) &&
    json(value.input) &&
    (value.output === undefined || json(value.output))
  )
}
function decode(value: unknown): TraceRun | undefined {
  if (
    !record(value) ||
    typeof value.payload !== 'string' ||
    Buffer.byteLength(value.payload) > TRACE_MAX_BYTES
  )
    return undefined
  try {
    const run: unknown = JSON.parse(value.payload)
    if (
      !record(run) ||
      typeof run.id !== 'string' ||
      typeof run.tool !== 'string' ||
      !date(run.started_at) ||
      !status(run.status) ||
      typeof run.owner_pid !== 'number' ||
      !Number.isSafeInteger(run.owner_pid) ||
      run.owner_pid <= 0 ||
      typeof run.capture_content !== 'boolean' ||
      typeof run.truncated !== 'boolean' ||
      !json(run.input) ||
      (run.output !== undefined && !json(run.output)) ||
      !Array.isArray(run.spans) ||
      run.spans.length > 200 ||
      !run.spans.every(span) ||
      (run.request_id !== undefined && typeof run.request_id !== 'string') ||
      (run.client_request_id !== undefined && typeof run.client_request_id !== 'string') ||
      (run.ended_at !== undefined && !date(run.ended_at)) ||
      (run.duration_ms !== undefined &&
        (typeof run.duration_ms !== 'number' ||
          !Number.isFinite(run.duration_ms) ||
          run.duration_ms < 0))
    )
      return undefined
    return {
      id: run.id,
      tool: run.tool,
      started_at: run.started_at,
      status: run.status,
      owner_pid: run.owner_pid,
      capture_content: run.capture_content,
      truncated: run.truncated,
      input: run.input,
      spans: run.spans,
      ...(run.output !== undefined ? { output: run.output } : {}),
      ...(run.request_id !== undefined ? { request_id: run.request_id } : {}),
      ...(run.client_request_id !== undefined ? { client_request_id: run.client_request_id } : {}),
      ...(run.ended_at !== undefined ? { ended_at: run.ended_at } : {}),
      ...(run.duration_ms !== undefined ? { duration_ms: run.duration_ms } : {}),
    }
  } catch {
    return undefined
  }
}
function observed(run: TraceRun): TraceRun {
  if (run.status !== 'running') return run
  try {
    process.kill(run.owner_pid, 0)
  } catch (error) {
    if (record(error) && error.code === 'ESRCH') {
      run.status = 'interrupted'
      for (const child of run.spans) if (child.status === 'running') child.status = 'interrupted'
    }
  }
  // A live or inaccessible PID remains running: do not guess that another MCP process died.
  return run
}

/** Optional local telemetry, separate from evidence retention. Owner must close this connection. */
export function createTraceStore(options: { directory: string; readOnly?: boolean }): TraceStore {
  const directory = resolve(options.directory)
  const file = join(directory, 'traces.sqlite')
  if (!options.readOnly) mkdirSync(directory, { recursive: true, mode: 0o700 })
  if (
    !existsSync(directory) ||
    !lstatSync(directory).isDirectory() ||
    lstatSync(directory).isSymbolicLink()
  )
    throw new Error('Trace directory must be a regular directory.')
  if (existsSync(file) && (!lstatSync(file).isFile() || lstatSync(file).isSymbolicLink()))
    throw new Error('Trace database must be a regular file.')
  const db = new Database(file, {
    readonly: options.readOnly ?? false,
    fileMustExist: options.readOnly ?? false,
  })
  try {
    db.pragma('busy_timeout = 100')
    const version: unknown = db.pragma('user_version', { simple: true })
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()
    if (version !== 1 && (version !== 0 || tables.length > 0 || options.readOnly))
      throw new Error('Unsupported trace database schema; preserved existing data.')
    if (!options.readOnly) {
      chmodSync(directory, 0o700)
      chmodSync(file, 0o600)
      db.pragma('journal_mode = WAL')
      db.pragma('synchronous = NORMAL')
      db.pragma('max_page_count = 16384')
      db.pragma('wal_autocheckpoint = 1')
      db.pragma('journal_size_limit = 0')
      if (version === 0)
        db.transaction(() => {
          db.exec(
            'CREATE TABLE traces(id TEXT PRIMARY KEY, started_at INTEGER NOT NULL, payload TEXT NOT NULL); CREATE INDEX traces_started ON traces(started_at DESC)',
          )
          db.pragma('user_version = 1')
        })()
    }
    const find = db.prepare('SELECT payload FROM traces WHERE id = ? AND started_at > ?')
    const list = db.prepare(
      'SELECT payload FROM traces WHERE started_at > ? ORDER BY started_at DESC, rowid DESC LIMIT 100',
    )
    const insert = options.readOnly
      ? undefined
      : db.prepare(
          'INSERT INTO traces(id, started_at, payload) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload = excluded.payload',
        )
    const prune = options.readOnly
      ? undefined
      : db.prepare(
          'DELETE FROM traces WHERE started_at <= ? OR id NOT IN (SELECT id FROM traces ORDER BY started_at DESC, rowid DESC LIMIT 100)',
        )
    return {
      put(run) {
        if (!insert || !prune) throw new Error('Trace store is read only.')
        const payload = JSON.stringify(run)
        if (Buffer.byteLength(payload) > TRACE_MAX_BYTES || !decode({ payload }))
          throw new Error('Trace record is invalid or too large.')
        db.transaction(() => {
          insert.run(run.id, Date.parse(run.started_at), payload)
          prune.run(Date.now() - RETENTION_MS)
        })()
        db.pragma('wal_checkpoint(PASSIVE)')
      },
      list() {
        return list.all(Date.now() - RETENTION_MS).flatMap((row) => {
          const run = decode(row)
          if (!run) return []
          const summary = observed(run)
          return [{ ...summary, span_count: summary.spans.length, spans: [] }]
        })
      },
      get(id) {
        const run = decode(find.get(id, Date.now() - RETENTION_MS))
        return run ? observed(run) : undefined
      },
      close() {
        if (db.open) db.close()
      },
    }
  } catch (error) {
    db.close()
    throw error
  }
}
