/** Explicit low-rate recording through the real built MCP; never assigns relevance labels. */
import { parseContract } from '../dist/shared/contracts.js'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { mkdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { assertValid, validateCatalog, readBoundedJson } from './eval-data.mjs'

const root = fileURLToPath(new URL('../', import.meta.url))
const args = process.argv.slice(2)
const options = new Map()
for (let i = 0; i < args.length; i += 2) {
  const key = args[i],
    value = args[i + 1]
  if (
    !['--limit', '--offset', '--interval-ms', '--out', '--config'].includes(key) ||
    !value ||
    options.has(key)
  )
    throw new Error(
      'Usage: node scripts/collect-eval.mjs [--limit 1..56] [--offset N] [--interval-ms 15000..60000] [--out directory] [--config file]',
    )
  options.set(key, value)
}
const count = Number(options.get('--limit') ?? 3)
const offset = Number(options.get('--offset') ?? 0)
const interval = Number(options.get('--interval-ms') ?? 15000)
if (
  !Number.isInteger(count) ||
  count < 1 ||
  count > 56 ||
  !Number.isInteger(offset) ||
  offset < 0 ||
  !Number.isInteger(interval) ||
  interval < 15000 ||
  interval > 60000
)
  throw new Error('Invalid bounded collection options.')
const catalog = assertValid(
  validateCatalog,
  await readBoundedJson(path.join(root, 'evals/queries.json')),
)
const selected = catalog.queries.slice(offset, offset + count)
if (!selected.length) throw new Error('No queries selected.')
const directory = path.resolve(
  options.get('--out') ??
    path.join(root, 'artifacts/evaluation', new Date().toISOString().replaceAll(':', '-')),
)
await mkdir(directory, { recursive: true, mode: 0o700 })
const env = Object.fromEntries(
  ['SEARXNG_URL', 'SEARXNG_ENGINES'].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : [],
  ),
)
env.WEB_RESEARCH_DATA_DIR = path.join(directory, 'snapshots')
const config = options.get('--config') ?? path.join(root, 'config/local.example.json')
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'dist/mcp/stdio.js'), '--config', config],
  env,
  stderr: 'pipe',
})
transport.stderr?.on('data', (chunk) => process.stderr.write(chunk))
const client = new Client({ name: 'web-research-evaluation-collector', version: '1.0.0' })
const controller = new AbortController()
const onSignal = () => controller.abort()
process.once('SIGINT', onSignal)
process.once('SIGTERM', onSignal)
try {
  await client.connect(transport)
  for (const [index, query] of selected.entries()) {
    if (controller.signal.aborted) break
    if (index) await delay(interval, undefined, { signal: controller.signal })
    const started = performance.now()
    const record = {
      version: 1,
      kind: 'live_mcp',
      query,
      captured_at: new Date().toISOString(),
      node: process.version,
      input: {
        query: query.query,
        language: query.language,
        sites: query.sites,
        limit: 10,
        ranking_mode: 'upstream',
        evidence_mode: 'extract',
        max_evidence_results: 1,
      },
    }
    try {
      const result = await client.callTool(
        { name: 'websearch', arguments: record.input },
        undefined,
        { timeout: 65000, signal: controller.signal },
      )
      const response = parseContract('websearch.output', result.structuredContent ?? result)
      const candidates = response.results.map((item, index) => ({
        id: item.source_id ?? `rank-${index + 1}`,
        url: item.url,
        title: item.title,
        snippet: item.snippet,
        original_rank: index + 1,
      }))
      record.response = response
      record.response_sha256 = createHash('sha256').update(JSON.stringify(response)).digest('hex')
      record.status = response.status
      record.candidates = candidates
    } catch (error) {
      record.status = 'transport_error'
      record.response_sha256 = null
      record.error = { name: error.name, message: error.message }
      record.candidates = []
    }
    record.elapsed_ms = Math.round(performance.now() - started)
    await writeFile(
      path.join(directory, `${query.id}.json`),
      JSON.stringify(record, null, 2) + '\n',
      { flag: 'wx', mode: 0o600 },
    )
    process.stderr.write(
      `${query.id} ${record.status} candidates=${record.candidates.length} elapsed_ms=${record.elapsed_ms}\n`,
    )
  }
} catch (error) {
  if (!controller.signal.aborted) throw error
} finally {
  process.removeListener('SIGINT', onSignal)
  process.removeListener('SIGTERM', onSignal)
  await client.close()
}
process.stderr.write(`Recorded in ${directory}\n`)
