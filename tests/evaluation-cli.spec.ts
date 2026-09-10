import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'

const execute = promisify(execFile)
const directories: string[] = []
const moduleUrl = new URL('../scripts/eval-data.mjs', import.meta.url).href
const fixturePool = {
  version: 1,
  kind: 'live_mcp',
  query: { id: 'q001', query: 'test', language: 'en', category: 'exact', sites: [] },
  captured_at: '2026-09-10T00:00:00Z',
  node: 'v24.20.0',
  status: 'partial',
  elapsed_ms: 10,
  response_sha256: 'a'.repeat(64),
  candidates: [
    { id: 'a', url: 'https://example.com', title: 'test', snippet: '', original_rank: 1 },
  ],
  evidence: { target_results: 1, verified_results: 0 },
}

async function runValidation(value: unknown, validator = 'validatePool') {
  return execute(process.execPath, [
    '--input-type=module',
    '-e',
    `const api = await import(${JSON.stringify(moduleUrl)}); api.assertValid(api.${validator}, JSON.parse(process.argv[1]));`,
    JSON.stringify(value),
  ])
}
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

it('validates live pools and rejects fixture masquerading, unknown fields and invalid URLs', async () => {
  await expect(runValidation(fixturePool)).resolves.toMatchObject({ stdout: '' })
  await expect(runValidation({ ...fixturePool, kind: 'synthetic' })).rejects.toThrow()
  await expect(runValidation({ ...fixturePool, secret: 'unexpected' })).rejects.toThrow()
  await expect(
    runValidation({
      ...fixturePool,
      candidates: [{ ...fixturePool.candidates[0], url: 'javascript:alert(1)' }],
    }),
  ).rejects.toThrow()
})

it('requires assessor type, date and graded reasons rather than silently creating labels', async () => {
  const labels = {
    version: 1,
    query_id: 'q001',
    pool_sha256: 'b'.repeat(64),
    assessor: { kind: 'agent', id: 'test-agent' },
    judged_at: '2026-09-10T00:00:00Z',
    basis: 'title_snippet',
    judgments: [{ id: 'a', grade: 2, reason: 'Explicitly relevant title.' }],
  }
  await expect(runValidation(labels, 'validateJudgments')).resolves.toMatchObject({ stdout: '' })
  await expect(
    runValidation({ ...labels, assessor: { id: 'anonymous' } }, 'validateJudgments'),
  ).rejects.toThrow()
  await expect(
    runValidation(
      { ...labels, judgments: [{ id: 'a', grade: 3, reason: 'bad' }] },
      'validateJudgments',
    ),
  ).rejects.toThrow()
})

it('freezes raw response hashes, rejects tampering and refuses to overwrite a different pool', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'eval-cli-'))
  directories.push(directory)
  const input = path.join(directory, 'input'),
    output = path.join(directory, 'output')
  await mkdir(input)
  const response = {
    query: 'test',
    status: 'partial',
    results: [{ source_id: 'a', url: 'https://example.com', title: 'test', snippet: '' }],
    evidence_summary: { target_results: 1, verified_results: 0 },
  }
  const record = {
    ...fixturePool,
    input: { query: 'test', language: 'en', sites: [], ranking_mode: 'upstream' },
    response,
    response_sha256: createHash('sha256').update(JSON.stringify(response)).digest('hex'),
  }
  const file = path.join(input, 'q001.json')
  await writeFile(file, JSON.stringify(record))
  const script = new URL('../scripts/freeze-eval.mjs', import.meta.url).pathname
  await execute(process.execPath, [script, input, output])
  const original = await readFile(path.join(output, 'q001.json'), 'utf8')
  await execute(process.execPath, [script, input, output])
  for (const changed of [
    { ...record, status: 'ok' },
    { ...record, input: { ...record.input, query: 'different' } },
    { ...record, input: { ...record.input, language: 'zh' } },
    { ...record, input: { ...record.input, ranking_mode: 'bm25' } },
    { ...record, candidates: [{ ...fixturePool.candidates[0], title: 'edited' }] },
    { ...record, response: undefined, response_sha256: null },
  ]) {
    await writeFile(file, JSON.stringify(changed))
    await expect(execute(process.execPath, [script, input, output])).rejects.toThrow()
  }
  const rerankedResponse = {
    ...response,
    results: response.results.map((item) => ({ ...item, ranking: { method: 'bm25' } })),
  }
  await writeFile(
    file,
    JSON.stringify({
      ...record,
      response: rerankedResponse,
      response_sha256: createHash('sha256').update(JSON.stringify(rerankedResponse)).digest('hex'),
    }),
  )
  await expect(execute(process.execPath, [script, input, output])).rejects.toThrow('reranked')
  await writeFile(file, JSON.stringify({ ...record, elapsed_ms: 100 }))
  await expect(execute(process.execPath, [script, input, output])).rejects.toThrow()
  expect(await readFile(path.join(output, 'q001.json'), 'utf8')).toBe(original)
  await writeFile(file, JSON.stringify({ ...record, response: { status: 'empty' } }))
  await expect(execute(process.execPath, [script, input, output])).rejects.toThrow('hash mismatch')
})

it('rejects contradictory status, evidence counts and duplicate candidate identities', async () => {
  for (const pool of [
    { ...fixturePool, status: 'error' },
    { ...fixturePool, status: 'empty' },
    { ...fixturePool, evidence: { target_results: 1, verified_results: 2 } },
    { ...fixturePool, evidence: { target_results: 2, verified_results: 1 } },
    {
      ...fixturePool,
      candidates: [fixturePool.candidates[0], { ...fixturePool.candidates[0], original_rank: 2 }],
    },
  ])
    await expect(runValidation(pool)).rejects.toThrow('Invalid candidate')
})
