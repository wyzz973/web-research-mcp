/**
 * The daily cap of an anonymous source and the daily budget of paid sources must hold when
 * several agent processes share one state file. A check followed by a write is not enough: the
 * processes pass the check together. These tests start real processes with real searchers.
 */
import { execFile } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createSqliteStore } from '../../src/store/sqlite.ts'

const run = promisify(execFile)
const worker = fileURLToPath(new URL('../helpers/search-worker.ts', import.meta.url))
const PROCESSES = 6
const directories: string[] = []

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

interface WorkerReport {
  calls: number
  statuses: Record<string, number>
}

async function race(tier: 'free' | 'paid', searches: number, env: Record<string, string>) {
  const directory = mkdtempSync(path.join(tmpdir(), 'wrm-limits-'))
  directories.push(directory)
  const location = path.join(directory, 'state.sqlite')
  ;(await createSqliteStore(location)).close()
  const startAt = String(Date.now() + 1500)
  const outputs = await Promise.all(
    Array.from({ length: PROCESSES }, (_, index) =>
      run(process.execPath, [worker, location, tier, String(searches), startAt, `p${index}`], {
        env: { ...process.env, WEB_RESEARCH_DATA_DIR: directory, ...env },
      }),
    ),
  )
  const reports = outputs.map((output) => JSON.parse(output.stdout) as WorkerReport)
  const store = await createSqliteStore(location)
  const ledger = store.usageTodayBySource('counting')
  store.close()
  return { reports, ledger, calls: reports.reduce((sum, report) => sum + report.calls, 0) }
}

describe('limits across processes', () => {
  it('sends exactly the capped number of anonymous calls, however many processes race for them', async () => {
    const { reports, ledger, calls } = await race('free', 40, {
      WEB_RESEARCH_ANONYMOUS_DAILY_CAP: '20',
    })
    expect(calls).toBe(20)
    expect(ledger.calls).toBe(20)
    // Everything beyond the cap was refused before anything was sent, and said so.
    const refused = reports.reduce(
      (sum, report) => sum + (report.statuses.budget_exhausted ?? 0),
      0,
    )
    expect(refused).toBe(PROCESSES * 40 - 20)
  }, 120_000)

  it('never books more paid calls than the daily budget covers', async () => {
    const { ledger, calls } = await race('paid', 10, { WEB_RESEARCH_DAILY_BUDGET_USD: '1' })
    // 0.3 a call: three fit into one dollar, the fourth would not.
    expect(calls).toBe(3)
    expect(calls * 0.3).toBeLessThanOrEqual(1)
    expect(ledger.calls).toBe(3)
    expect(ledger.cost_usd).toBeCloseTo(0.9, 6)
  }, 120_000)
})
