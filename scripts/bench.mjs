/**
 * Small live benchmark for web_search: latency, result counts, and whether a domain that should
 * answer the query shows up near the top. It is a smoke signal, not a relevance judgment.
 *
 *   pnpm build && node scripts/bench.mjs [--n 12] [--depth standard] [--out evals/runs/x.json]
 *
 * Every query is a real upstream call (cold cache, temporary state directory), so keep n small:
 * anonymous tiers are a courtesy of the vendors.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const { values } = parseArgs({
  options: {
    n: { type: 'string', default: '12' },
    depth: { type: 'string', default: 'standard' },
    out: { type: 'string' },
  },
})
const sampleSize = Math.min(Math.max(Number(values.n) || 12, 1), 40)

const dataDir = mkdtempSync(path.join(tmpdir(), 'wrm-bench-'))
process.env.WEB_RESEARCH_DATA_DIR = dataDir
const { createWebResearch } = await import('../dist/index.js')

/** Queries that name a domain which ought to answer them, spread across categories. */
function sample(queries, size) {
  const judged = queries.filter((query) => query.sites.length > 0)
  const byCategory = Map.groupBy(judged, (query) => query.category)
  const picked = []
  while (picked.length < size && [...byCategory.values()].some((group) => group.length)) {
    for (const group of byCategory.values()) {
      const next = group.shift()
      if (next && picked.length < size) picked.push(next)
    }
  }
  return picked
}

function onDomain(url, domains) {
  try {
    const host = new URL(url).hostname
    return domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
  } catch {
    return false
  }
}

function percentile(sorted, fraction) {
  if (!sorted.length) return 0
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]
}

const { queries } = JSON.parse(readFileSync(path.join(root, 'evals', 'queries.json'), 'utf8'))
const research = await createWebResearch()
const rows = []
try {
  for (const item of sample(queries, sampleSize)) {
    const started = performance.now()
    const result = await research.search({
      query: item.query,
      max_results: 10,
      depth: values.depth,
    })
    const ms = Math.round(performance.now() - started)
    const rank = result.results.findIndex((hit) => onDomain(hit.url, item.sites)) + 1
    rows.push({
      id: item.id,
      category: item.category,
      language: item.language,
      query: item.query,
      expected: item.sites,
      status: result.status,
      ms,
      results: result.results.length,
      tokens: result.tokens,
      sources: result.sources.map((source) => `${source.id}:${source.status}`),
      provider_calls: result.usage.provider_calls,
      first_expected_rank: rank || null,
      top3: result.results.slice(0, 3).map((hit) => hit.url),
    })
    const mark = rank === 0 ? 'miss' : `#${rank}`
    console.log(
      `${item.id} ${result.status.padEnd(7)} ${String(ms).padStart(5)} ms  ${String(result.results.length).padStart(2)} results  expected ${mark.padEnd(4)}  ${item.query}`,
    )
  }
} finally {
  await research.close()
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

const answered = rows.filter((row) => row.results > 0)
const latencies = rows.map((row) => row.ms).sort((a, b) => a - b)
const within = (k) => rows.filter((row) => row.first_expected_rank && row.first_expected_rank <= k)
const summary = {
  date: new Date().toISOString(),
  depth: values.depth,
  queries: rows.length,
  answered: answered.length,
  errors: rows.filter((row) => row.status === 'error').length,
  provider_calls: rows.reduce((sum, row) => sum + row.provider_calls, 0),
  latency_ms: {
    p50: percentile(latencies, 0.5),
    p90: percentile(latencies, 0.9),
    max: latencies.at(-1),
  },
  expected_domain_in_top3: within(3).length,
  expected_domain_in_top10: within(10).length,
  mean_tokens: Math.round(
    rows.reduce((sum, row) => sum + row.tokens, 0) / Math.max(rows.length, 1),
  ),
}
console.log(`\n${JSON.stringify(summary, null, 2)}`)
if (values.out) {
  const target = path.resolve(root, values.out)
  mkdirSync(path.dirname(target), { recursive: true })
  writeFileSync(target, `${JSON.stringify({ summary, rows }, null, 2)}\n`)
  console.log(`written to ${path.relative(root, target)}`)
}
