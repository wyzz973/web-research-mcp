/** Reproducible same-pool comparisons; no network calls, missing labels stay unmeasured. */
import { mkdir, readdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { rankCandidates, RETRIEVAL_VERSION } from '../dist/ranking/retrieval.js'
import { evaluateRanking } from '../dist/ranking/evaluation.js'
import {
  assertValid,
  readBoundedJson,
  validateCatalog,
  validatePool,
  validateJudgments,
  poolHash,
} from './eval-data.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const options = new Map()
for (let i = 0; i < args.length; i += 2) {
  if (
    !['--pools', '--judgments', '--out'].includes(args[i]) ||
    !args[i + 1] ||
    options.has(args[i])
  )
    throw new Error(
      'Usage: node scripts/evaluate.mjs [--pools directory] [--judgments directory] [--out file]',
    )
  options.set(args[i], args[i + 1])
}
const catalog = assertValid(
  validateCatalog,
  await readBoundedJson(path.join(root, 'evals/queries.json')),
)
const poolsDir = path.resolve(options.get('--pools') ?? path.join(root, 'evals/pools'))
const judgmentsDir = path.resolve(options.get('--judgments') ?? path.join(root, 'evals/judgments'))
const files = (await readdir(poolsDir)).filter((name) => /^q\d{3}\.json$/.test(name)).sort()
const seen = new Set()
const rows = []
for (const file of files) {
  const pool = assertValid(validatePool, await readBoundedJson(path.join(poolsDir, file)))
  if (
    seen.has(pool.query.id) ||
    !catalog.queries.some((query) => JSON.stringify(query) === JSON.stringify(pool.query))
  )
    throw new Error('Duplicate or non-catalog pool query.')
  seen.add(pool.query.id)
  const row = {
    query_id: pool.query.id,
    language: pool.query.language,
    category: pool.query.category,
    status: pool.status,
    error_code: pool.error_code ?? null,
    candidates: pool.candidates.length,
    elapsed_ms: pool.elapsed_ms,
    evidence: pool.evidence,
    judgment_status: pool.candidates.length ? 'missing' : 'not_applicable_no_candidates',
    rankings: {},
  }
  let labels
  try {
    labels = assertValid(validateJudgments, await readBoundedJson(path.join(judgmentsDir, file)))
  } catch (error) {
    if (error.code !== 'ENOENT') throw error
  }
  if (labels) {
    if (labels.query_id !== pool.query.id || labels.pool_sha256 !== poolHash(pool))
      throw new Error(`Judgments are for a different frozen pool: ${file}`)
    row.judgment_status = 'complete'
    row.assessor = labels.assessor
    row.basis = labels.basis
  }
  for (const mode of ['upstream', 'bm25', 'bm25_mmr']) {
    const start = performance.now()
    const ranking = rankCandidates(pool.query.query, pool.candidates, {
      mode,
      language: pool.query.language,
    })
    const elapsed = performance.now() - start
    const order = ranking.map((item) => item.candidate.id)
    row.rankings[mode] = {
      order,
      elapsed_ms: Number(elapsed.toFixed(3)),
      metrics_at_5: labels ? evaluateRanking(order, labels.judgments, 5) : null,
      metrics_at_10: labels ? evaluateRanking(order, labels.judgments, 10) : null,
      metrics_at_20: labels ? evaluateRanking(order, labels.judgments, 20) : null,
    }
  }
  rows.push(row)
}
const average = (values) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null
const percentile = (values, p) =>
  values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null
const summary = {}
for (const mode of ['upstream', 'bm25', 'bm25_mmr']) {
  const measured = rows
    .map((row) => row.rankings[mode].metrics_at_10)
    .filter((metrics) => metrics?.ndcg != null)
  summary[mode] = {
    measured_queries: measured.length,
    ndcg_at_5: average(
      rows.map((row) => row.rankings[mode].metrics_at_5?.ndcg).filter((value) => value != null),
    ),
    pooled_recall_at_5: average(
      rows
        .map((row) => row.rankings[mode].metrics_at_5?.pooledRecall)
        .filter((value) => value != null),
    ),
    ndcg_at_10: average(measured.map((value) => value.ndcg)),
    mrr_at_10: average(measured.map((value) => value.mrr)),
    pooled_recall_at_20: average(
      rows
        .map((row) => row.rankings[mode].metrics_at_20?.pooledRecall)
        .filter((value) => value != null),
    ),
    ranking_p95_ms: percentile(
      rows.map((row) => row.rankings[mode].elapsed_ms),
      0.95,
    ),
  }
}
const totals = rows.reduce((result, row) => {
  result[row.status] = (result[row.status] ?? 0) + 1
  return result
}, {})
const report = {
  version: 1,
  generated_at: new Date().toISOString(),
  node: process.version,
  icu: process.versions.icu,
  algorithm: RETRIEVAL_VERSION,
  caveats: [
    'Agent judgments are not human gold labels.',
    'Candidate pools are top 10 from one sampling window; pooled recall is not web recall.',
    'No independent engine lists recorded: RRF not evaluated.',
    'Small or blocked samples cannot establish general improvement.',
    'Live latency includes optional evidence fetching; ranking timing is one local pass, not a load benchmark.',
  ],
  coverage: {
    catalog_queries: catalog.queries.length,
    recorded_queries: rows.length,
    unrecorded_queries: catalog.queries
      .filter((query) => !seen.has(query.id))
      .map((query) => query.id),
    judged_queries: rows.filter((row) => row.judgment_status === 'complete').length,
    totals,
    queries_with_candidates: rows.filter((row) => row.candidates > 0).length,
    evidence_target_results: rows.reduce((sum, row) => sum + row.evidence.target_results, 0),
    evidence_verified_results: rows.reduce((sum, row) => sum + row.evidence.verified_results, 0),
  },
  summary,
  availability: {
    completed_queries: rows.filter((row) => ['ok', 'partial', 'empty'].includes(row.status)).length,
    nonempty_queries: rows.filter((row) => row.candidates > 0).length,
    failed_queries: rows.filter((row) =>
      ['error', 'transport_error', 'unknown'].includes(row.status),
    ).length,
    completion_rate: rows.length
      ? rows.filter((row) => ['ok', 'partial', 'empty'].includes(row.status)).length / rows.length
      : null,
  },
  evidence: {
    target_results: rows.reduce((sum, row) => sum + row.evidence.target_results, 0),
    verified_results: rows.reduce((sum, row) => sum + row.evidence.verified_results, 0),
    coverage:
      rows.reduce((sum, row) => sum + row.evidence.target_results, 0) > 0
        ? rows.reduce((sum, row) => sum + row.evidence.verified_results, 0) /
          rows.reduce((sum, row) => sum + row.evidence.target_results, 0)
        : null,
  },
  live_latency_ms: {
    p50: percentile(
      rows.map((row) => row.elapsed_ms),
      0.5,
    ),
    p95: percentile(
      rows.map((row) => row.elapsed_ms),
      0.95,
    ),
  },
  rows,
}
const output = JSON.stringify(report, null, 2) + '\n'
const outputPath = path.resolve(
  options.get('--out') ?? path.join(root, 'evals/reports/latest.json'),
)
await mkdir(path.dirname(outputPath), { recursive: true })
await writeFile(outputPath, output)
process.stdout.write(output)
