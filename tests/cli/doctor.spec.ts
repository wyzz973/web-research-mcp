import { execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { WebError } from '../../src/errors.ts'
import { createCooldowns } from '../../src/search/cooldown.ts'
import { createSqliteStore } from '../../src/store/sqlite.ts'

const run = promisify(execFile)
const entry = fileURLToPath(new URL('../../src/cli/main.ts', import.meta.url))
const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

const KEYS = {
  EXA_API_KEY: 'exa-SECRETSECRET1',
  PARALLEL_API_KEY: 'par-SECRETSECRET2',
  TAVILY_API_KEY: 'tvly-SECRETSECRET3',
}

/** Anonymous sources are off in every case, so doctor has no endpoint to probe: no network. */
async function doctor(environment: Record<string, string>, flags: string[] = []) {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'wrm-doctor-'))
  directories.push(dataDir)
  const inherited = Object.fromEntries(
    ['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'HOME'].flatMap((name) =>
      process.env[name] === undefined ? [] : [[name, process.env[name]]],
    ),
  )
  const env = {
    ...inherited,
    WEB_RESEARCH_DATA_DIR: dataDir,
    WEB_RESEARCH_ANONYMOUS_SOURCES: '0',
    ...environment,
  }
  const result = await run(process.execPath, [entry, 'doctor', ...flags], { env }).catch(
    (error: { code?: number; stdout?: string; stderr?: string }) => ({
      code: error.code ?? 1,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
    }),
  )
  return {
    code: 'code' in result ? result.code : 0,
    output: `${result.stdout}${result.stderr}`,
    dataDir,
  }
}

describe('web-research doctor', () => {
  it('names the variable a key came from and never prints the key', async () => {
    for (const flags of [[], ['--json']]) {
      const { code, output } = await doctor(KEYS, flags)
      expect(code).toBe(0)
      expect(output).toContain('API key from EXA_API_KEY')
      expect(output).not.toMatch(/SECRETSECRET/u)
    }
  }, 30_000)

  it('fails with an actionable message when no source can be used', async () => {
    const { code, output } = await doctor({})
    expect(code).toBe(4)
    expect(output).toContain('No search source is available')
    expect(output).toContain('EXA_API_KEY')
  }, 30_000)

  it('shows a source that is being left alone, and why', async () => {
    const first = await doctor(KEYS)
    const store = await createSqliteStore(path.join(first.dataDir, 'state-v2.sqlite'))
    createCooldowns(() => new Date(), store).fail(
      'tavily',
      new WebError('budget_exhausted', 'quota is used up'),
    )
    store.close()
    const env = { ...KEYS, WEB_RESEARCH_DATA_DIR: first.dataDir }
    const { code, output } = await doctor(env)
    expect(output).toMatch(
      /usage\.tavily\s+0 calls today.*paused for \d+ min after budget_exhausted/u,
    )
    expect(code).toBe(0)
  }, 30_000)
})
