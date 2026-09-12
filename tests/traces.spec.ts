import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import {
  createTraceRecorder,
  noOpTraceRecorder,
  sanitizeTraceData,
  TRACE_MAX_BYTES,
} from '../src/shared/trace.ts'
import type { TraceRun, TraceStore } from '../src/shared/trace.ts'
import { createTraceStore } from '../src/storage/traces.ts'
import { AppError } from '../src/shared/errors.ts'

const directories: string[] = []
const stores: TraceStore[] = []
function directory(): string {
  const value = mkdtempSync(join(tmpdir(), 'web-research-traces-'))
  directories.push(value)
  return value
}
function open(path = directory(), readOnly = false): TraceStore {
  const store = createTraceStore({ directory: path, readOnly })
  stores.push(store)
  return store
}
function fixture(id = 'test', started = Date.now()): TraceRun {
  return {
    id,
    tool: 'websearch',
    started_at: new Date(started).toISOString(),
    status: 'ok',
    owner_pid: process.pid,
    capture_content: false,
    truncated: false,
    input: null,
    spans: [],
  }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close()
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('local bounded traces', () => {
  it('records concurrently nested spans against their actual async parent and correlates final request id', async () => {
    const store = open()
    const trace = createTraceRecorder({ store })
    const result = await trace.run(
      'websearch',
      { query: 'private query' },
      async () => {
        await Promise.all(
          ['a', 'b'].map((name) =>
            trace.span(name, null, async () => {
              await new Promise<void>((resolve) => setImmediate(resolve))
              return trace.span(`${name}.child`, null, async () => ({ status: 'ok', count: 2 }))
            }),
          ),
        )
        return { status: 'partial', request_id: 'request_test' }
      },
      { clientRequestId: '12345678-1234-1234-1234-123456789abc' },
    )
    expect(result.status).toBe('partial')
    const summary = store.list()[0]
    expect(summary?.spans).toEqual([])
    expect(summary?.request_id).toBe('request_test')
    expect(summary?.client_request_id).toBe('12345678-1234-1234-1234-123456789abc')
    const run = store.get(summary?.id ?? '')
    expect(run?.status).toBe('partial')
    expect(run?.spans).toHaveLength(4)
    for (const name of ['a', 'b']) {
      const parent = run?.spans.find((item) => item.name === name)
      expect(parent?.parent_id).toBeNull()
      expect(run?.spans.find((item) => item.name === `${name}.child`)?.parent_id).toBe(parent?.id)
    }
    expect(trace.currentTraceId()).toBeUndefined()
  })

  it('isolates concurrent runs and opts into content per run without exposing credentials or URL queries', async () => {
    const store = open()
    const trace = createTraceRecorder({ store })
    await Promise.all(
      [false, true].map((captureContent) =>
        trace.run(
          `tool-${captureContent}`,
          {
            query: 'sensitive-query',
            url: 'https://user:password@example.org/article?token=bad#private',
            headers: { authorization: 'secret-value' },
          },
          async () =>
            trace.span('fetch', { body: 'private-body', api_key: 'private-key' }, async () => ({
              status: 'ok',
            })),
          { captureContent },
        ),
      ),
    )
    const runs = store.list().map((summary) => store.get(summary.id))
    const hidden = JSON.stringify(runs.find((run) => !run?.capture_content))
    expect(hidden).not.toContain('sensitive-query')
    expect(hidden).not.toContain('private-body')
    const visible = JSON.stringify(runs.find((run) => run?.capture_content))
    expect(visible).toContain('sensitive-query')
    expect(visible).toContain('private-body')
    for (const data of [hidden, visible]) {
      expect(data).not.toContain('secret-value')
      expect(data).not.toContain('private-key')
      expect(data).not.toContain('token=bad')
      expect(data).not.toContain('user:password')
    }
  })

  it('preserves an annotated root summary without replacing the business response or actual status', async () => {
    const store = open()
    const trace = createTraceRecorder({ store, captureContent: true })
    const response = {
      request_id: 'request_summary',
      status: 'partial',
      results: Array.from({ length: 8 }, () => ({ content: 'large body'.repeat(1000) })),
    }
    const result = await trace.run('summary', { query: 'example' }, async () => {
      trace.annotate({ result_count: response.results.length, evidence_summary: { verified: 3 } })
      return response
    })
    expect(result).toBe(response)
    const run = store.get(store.list()[0]?.id ?? '')
    expect(run?.status).toBe('partial')
    expect(run?.request_id).toBe('request_summary')
    expect(run?.output).toEqual({ result_count: 8, evidence_summary: { verified: 3 } })
    expect(JSON.stringify(run)).not.toContain('large body')
  })

  it('preserves business error, cancellation and explicit degraded statuses', async () => {
    const store = open()
    const trace = createTraceRecorder({ store })
    await trace.run('returned-error', null, async () =>
      trace.span('provider', null, async () => ({
        status: 'error',
        error: { code: 'UPSTREAM_BLOCKED' },
      })),
    )
    await expect(
      trace.run('cancelled', null, async () =>
        trace.span('network', null, () => Promise.reject(new AppError('CANCELLED', 'private URL'))),
      ),
    ).rejects.toThrow('private URL')
    await trace.run('annotated', null, async () => {
      trace.annotate({ reason: 'partial' }, 'partial')
      trace.event('skipped', 'skipped', { count: 0 })
      return { status: 'ok' }
    })
    expect(store.list().find((run) => run.tool === 'returned-error')?.status).toBe('error')
    expect(store.list().find((run) => run.tool === 'cancelled')?.status).toBe('cancelled')
    expect(store.list().find((run) => run.tool === 'annotated')?.status).toBe('partial')
    expect(JSON.stringify(store.list())).not.toContain('private URL')
  })

  it('makes in-progress runs visible to a separate read-only connection without marking live owners dead', async () => {
    const path = directory()
    const store = open(path)
    const reader = open(path, true)
    const trace = createTraceRecorder({ store })
    await trace.run('live', null, async () => {
      const summary = reader.list()[0]
      expect(summary?.status).toBe('running')
      expect(reader.get(summary?.id ?? '')?.status).toBe('running')
      expect(() => reader.put(fixture())).toThrow('read only')
      return { status: 'ok' }
    })
    expect(reader.list()[0]?.status).toBe('ok')
  })

  it('reads persisted runs from a departed process as interrupted without inventing completion time', () => {
    const path = directory()
    const moduleUrl = new URL('../src/storage/traces.ts', import.meta.url).href
    const script = `import {createTraceStore} from ${JSON.stringify(moduleUrl)}; const s=createTraceStore({directory:${JSON.stringify(path)}});s.put({...${JSON.stringify(fixture('departed'))},owner_pid:process.pid,status:'running'});s.close();`
    execFileSync(process.execPath, ['--input-type=module', '-e', script], { stdio: 'pipe' })
    const store = open(path)
    expect(store.get('departed')?.status).toBe('interrupted')
    expect(store.get('departed')?.ended_at).toBeUndefined()
  })

  it('limits span count and record bytes while leaving all business operations active', async () => {
    const store = open()
    const trace = createTraceRecorder({ store, captureContent: true })
    let calls = 0
    await trace.run('bounded', { query: 'x'.repeat(20000) }, async () => {
      for (let index = 0; index < 230; index += 1)
        await trace.span('step', { text: '🙂'.repeat(3000) }, async () => {
          calls += 1
          return { text: 'z'.repeat(3000) }
        })
      return { status: 'ok' }
    })
    const run = store.get(store.list()[0]?.id ?? '')
    expect(calls).toBe(230)
    expect(run?.truncated).toBe(true)
    expect(run?.spans.length).toBeLessThanOrEqual(200)
    expect(Buffer.byteLength(JSON.stringify(run))).toBeLessThanOrEqual(TRACE_MAX_BYTES)
  })

  it('ignores optional storage and summary failures and bypasses orphan spans', async () => {
    const store: TraceStore = {
      put() {
        throw new Error('disk full')
      },
      list: () => [],
      get: () => undefined,
      close() {},
    }
    const trace = createTraceRecorder({ store })
    expect(
      await trace.run('safe', null, () =>
        trace.span(
          'summary-failure',
          null,
          async () => 42,
          () => {
            throw new Error('summary')
          },
        ),
      ),
    ).toBe(42)
    expect(await trace.span('outside', null, async () => 3)).toBe(3)
    expect(await noOpTraceRecorder.run('disabled', null, async () => 4)).toBe(4)
    await expect(
      trace.run('failure', null, () => Promise.reject(new Error('original'))),
    ).rejects.toThrow('original')
  })

  it('keeps operational checksums and error codes while default content stays hidden', () => {
    expect(
      JSON.stringify(sanitizeTraceData({ query: { status: 'private nested query' } })),
    ).not.toContain('private nested query')
    const value = sanitizeTraceData({
      content_sha256: 'abc123',
      contentSha256: 'def456',
      checksum: '012345',
      last_error: 'UPSTREAM_BLOCKED',
      extractor_version: 'readability-v1',
      extractorVersion: 'parser-v2',
      content_type: 'text/html',
      query: 'private question',
      content: 'private body',
      title: 'private title',
    })
    expect(value).toMatchObject({
      content_sha256: 'abc123',
      contentSha256: 'def456',
      checksum: '012345',
      last_error: 'UPSTREAM_BLOCKED',
      extractor_version: 'readability-v1',
      extractorVersion: 'parser-v2',
      content_type: 'text/html',
    })
    expect(JSON.stringify(value)).not.toContain('private')
  })

  it('notifies storage degradation once and isolates a throwing observer from business outcomes', async () => {
    let calls = 0
    const store: TraceStore = {
      put() {
        throw new Error('database path with secrets')
      },
      list: () => [],
      get: () => undefined,
      close() {},
    }
    const trace = createTraceRecorder({
      store,
      onError() {
        calls += 1
        throw new Error('observer failed')
      },
    })
    expect(
      await trace.run('success', null, async () => trace.span('step', null, async () => 42)),
    ).toBe(42)
    await expect(
      trace.run('cancel', null, () =>
        Promise.reject(new AppError('CANCELLED', 'original cancellation')),
      ),
    ).rejects.toThrow('original cancellation')
    expect(calls).toBe(1)
  })

  it('retains at most 100 recent runs for 24 hours and creates private files', () => {
    const path = directory()
    const store = open(path)
    const now = Date.now()
    store.put(fixture('expired', now - 25 * 3600000))
    for (let index = 0; index < 105; index += 1) store.put(fixture(`run-${index}`, now + index))
    expect(store.list()).toHaveLength(100)
    expect(store.get('expired')).toBeUndefined()
    expect(store.get('run-0')).toBeUndefined()
    expect(statSync(path).mode & 0o777).toBe(0o700)
    expect(statSync(join(path, 'traces.sqlite')).mode & 0o777).toBe(0o600)
  })

  it('rejects unknown database versions and malformed stored records without deleting them', () => {
    const path = directory()
    const store = open(path)
    store.put(fixture())
    const database = new Database(join(path, 'traces.sqlite'))
    database.prepare('UPDATE traces SET payload = ?').run('{"status":"ok"}')
    expect(store.get('test')).toBeUndefined()
    database.pragma('user_version = 2')
    expect(() => open(path)).toThrow('Unsupported')
    expect(database.prepare('SELECT COUNT(*) AS n FROM traces').get()).toEqual({ n: 1 })
    database.close()
  })

  it('does not execute accessors or retain non-JSON objects and bounds hostile nested input', () => {
    let invoked = false
    const input = {
      get query() {
        invoked = true
        return 'secret'
      },
      payload: new Error('secret'),
      authorization: 'secret',
    }
    const encoded = JSON.stringify(sanitizeTraceData(input, true))
    expect(invoked).toBe(false)
    expect(encoded).not.toContain('secret')
    const circular: Record<string, unknown> = {}
    circular.self = circular
    expect(JSON.stringify(sanitizeTraceData(circular))).toContain('circular')
    let nested: unknown = Array(100).fill(1)
    for (let index = 0; index < 10; index += 1) nested = Array(100).fill(nested)
    expect(JSON.stringify(sanitizeTraceData(nested)).length).toBeLessThanOrEqual(2000)
  })
})
