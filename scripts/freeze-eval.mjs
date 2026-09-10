/** Export bounded public ranking inputs; raw MCP payloads and cursors remain in local artifacts. */
import { readdir, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { assertValid, validatePool, readBoundedJson, poolHash } from './eval-data.mjs'
const root = fileURLToPath(new URL('../', import.meta.url))
const [input, output = path.join(root, 'evals/pools'), ...rest] = process.argv.slice(2)
if (!input || rest.length)
  throw new Error('Usage: node scripts/freeze-eval.mjs RECORDED_DIRECTORY [POOL_DIRECTORY]')
await mkdir(output, { recursive: true })
for (const file of (await readdir(input)).filter((name) => /^q\d{3}\.json$/.test(name)).sort()) {
  const record = await readBoundedJson(path.join(input, file))
  if (
    record.response &&
    createHash('sha256').update(JSON.stringify(record.response)).digest('hex') !==
      record.response_sha256
  )
    throw new Error(`Raw response hash mismatch: ${file}`)
  if (
    record.input?.query !== record.query?.query ||
    record.input?.language !== record.query?.language ||
    JSON.stringify(record.input?.sites) !== JSON.stringify(record.query?.sites) ||
    (record.input?.ranking_mode !== undefined && record.input.ranking_mode !== 'upstream')
  )
    throw new Error(`Recorded query/input or upstream ranking mode mismatch: ${file}`)
  if (record.response) {
    if (record.status !== record.response.status || record.response.query !== record.query.query) {
      throw new Error(`Recorded status/query differs from hashed response: ${file}`)
    }
    if (
      !Array.isArray(record.response.results) ||
      record.response.results.some((item) => item.ranking && item.ranking.method !== 'upstream')
    ) {
      throw new Error(`Cannot call a locally reranked response upstream: ${file}`)
    }
  } else if (
    record.status !== 'transport_error' ||
    record.response_sha256 !== null ||
    !Array.isArray(record.candidates) ||
    record.candidates.length !== 0
  ) {
    throw new Error(`Missing response is only allowed for explicit transport errors: ${file}`)
  }
  const candidates = (record.response?.results ?? []).map((item, index) => ({
    id: item.source_id ?? `rank-${index + 1}`,
    url: item.url,
    title: item.title,
    snippet: item.snippet,
    original_rank: index + 1,
  }))
  if (JSON.stringify(candidates) !== JSON.stringify(record.candidates)) {
    throw new Error(`Candidate projection differs from hashed raw response: ${file}`)
  }
  const summary = record.response?.evidence_summary
  const pool = assertValid(validatePool, {
    version: record.version,
    kind: record.kind,
    query: record.query,
    captured_at: record.captured_at,
    node: record.node,
    status: record.status,
    elapsed_ms: record.elapsed_ms,
    response_sha256: record.response_sha256 ?? null,
    error_code: record.response?.error?.code ?? record.error?.name ?? null,
    candidates,
    evidence: {
      target_results: summary?.target_results ?? 0,
      verified_results: summary?.verified_results ?? 0,
    },
  })
  const destination = path.join(output, file)
  try {
    await writeFile(destination, JSON.stringify(pool, null, 2) + '\n', { flag: 'wx' })
  } catch (error) {
    if (error.code !== 'EEXIST' || poolHash(await readBoundedJson(destination)) !== poolHash(pool))
      throw error
  }
}
process.stderr.write(`Frozen public pools: ${path.resolve(output)}\n`)
