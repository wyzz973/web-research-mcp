import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createSqliteStore } from '../../src/store/sqlite.ts'

const run = promisify(execFile)
const directories: string[] = []
function temporaryDatabase(): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'wrm-store-'))
  directories.push(directory)
  return path.join(directory, 'state.sqlite')
}
afterEach(() => {
  vi.useRealTimers()
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('sqlite store', () => {
  it('stores records under fresh short ids and forgets them after their ttl', async () => {
    const store = await createSqliteStore(':memory:')
    vi.useFakeTimers({ now: new Date('2026-09-21T00:00:00Z') })
    const id = store.insertRecord('search', '', { query: 'x' }, 60)
    expect(id).toMatch(/^[a-z0-9]{4,}$/u)
    expect(store.getRecord<{ query: string }>('search', id)?.value).toEqual({ query: 'x' })
    expect(store.getRecord('cursor', id)).toBeUndefined()
    vi.setSystemTime(new Date('2026-09-21T00:01:01Z'))
    expect(store.getRecord('search', id)).toBeUndefined()
    store.close()
  })

  it('keeps snapshots immutable and returns the newest one for a URL', async () => {
    const store = await createSqliteStore(':memory:')
    const base = {
      url: 'https://example.org/a',
      final_url: 'https://example.org/a',
      http_status: 200,
      content_type: 'text/html',
      title: 'A',
      sha256: 'x',
      retrieved_at: '2026-09-21T00:00:00Z',
      hidden_removed: 0,
    }
    vi.useFakeTimers({ now: new Date('2026-09-21T00:00:00Z') })
    const first = store.insertSnapshot({ ...base, markdown: 'one' }, 3600)
    vi.setSystemTime(new Date('2026-09-21T00:10:00Z'))
    const second = store.insertSnapshot({ ...base, markdown: 'two' }, 3600)
    expect(first.id).not.toBe(second.id)
    expect(store.getSnapshot(first.id)?.markdown).toBe('one')
    expect(store.latestSnapshotForUrl(base.url)?.id).toBe(second.id)
    expect(store.latestSnapshotForUrl('https://example.org/other')).toBeUndefined()
    store.close()
  })

  it('keeps a per-source usage ledger for the current day', async () => {
    const store = await createSqliteStore(':memory:')
    store.addUsage('exa', 2, 0.014)
    store.addUsage('exa', 1, 0.007)
    store.addUsage('tavily', 1, 0)
    expect(store.usageTodayBySource('exa')).toEqual({
      calls: 3,
      cost_usd: expect.closeTo(0.021, 5),
    })
    expect(store.usageToday().calls).toBe(4)
    store.close()
  })

  it('lets two processes write the same database at once without losing rows', async () => {
    const location = temporaryDatabase()
    const writer = fileURLToPath(new URL('../helpers/store-writer.ts', import.meta.url))
    const [first, second] = await Promise.all(
      ['alpha', 'beta'].map((label) => run(process.execPath, [writer, location, label, '150'])),
    )
    const ids = [
      ...(JSON.parse(first!.stdout) as string[]),
      ...(JSON.parse(second!.stdout) as string[]),
    ]
    expect(new Set(ids).size).toBe(300)
    const store = await createSqliteStore(location)
    expect(store.usageTodayBySource('alpha').calls).toBe(150)
    expect(store.usageTodayBySource('beta').calls).toBe(150)
    for (const id of ids.slice(0, 20)) expect(store.getRecord('stress', id)).toBeDefined()
    store.close()
  }, 60_000)
})
