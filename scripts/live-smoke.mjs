/** Explicit, opt-in real-network verification through the built MCP subprocess. */
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
if (!process.env.SEARXNG_URL || !process.env.SEARXNG_ENGINES)
  throw new Error('Set SEARXNG_URL and SEARXNG_ENGINES explicitly.')
const outputDir = path.join(root, 'artifacts', 'live')
await mkdir(outputDir, { recursive: true })
const client = new Client({ name: 'web-research-live-smoke', version: '0.1.0' })
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'dist/mcp/stdio.js')],
  env: {
    SEARXNG_URL: process.env.SEARXNG_URL,
    SEARXNG_ENGINES: process.env.SEARXNG_ENGINES,
    WEB_RESEARCH_DATA_DIR: path.join(outputDir, 'data'),
  },
  stderr: 'pipe',
})
transport.stderr?.on('data', (chunk) => process.stderr.write(chunk))
const records = []
try {
  await client.connect(transport)
  const tools = await client.listTools()
  if (!['websearch', 'webfetch'].every((name) => tools.tools.some((tool) => tool.name === name)))
    throw new Error('Missing advertised tools.')
  const started = Date.now()
  const search = await client.callTool(
    {
      name: 'websearch',
      arguments: {
        query: 'MCP tools structuredContent',
        sites: ['modelcontextprotocol.io'],
        limit: 3,
        evidence_mode: 'extract',
        max_evidence_results: 2,
      },
    },
    undefined,
    { timeout: 65_000 },
  )
  const data = search.structuredContent
  records.push({ stage: 'search', duration_ms: Date.now() - started, output: data })
  if (!data || data.status === 'error' || !data.results?.length)
    throw new Error(`Live search failed: ${JSON.stringify(data)}`)
  const evidence = data.results.flatMap((row) => row.evidence)
  if (!evidence.length) throw new Error('No exact page evidence obtained during real search.')
  for (const row of data.results) {
    if (
      !row.source_metadata ||
      row.source_metadata.source_url !== row.url ||
      row.source_metadata.assets_verified !== false
    )
      throw new Error('Missing or incorrectly attributed frontend source metadata.')
    if (row.evidence.length > 3 || row.evidence_chars > 4000)
      throw new Error('Default evidence response exceeded its paragraph budget.')
  }
  if (
    !evidence.some(
      (entry) =>
        entry.quote.length > 300 && entry.quote.toLowerCase().includes('structuredcontent'),
    )
  )
    throw new Error('Paragraph evidence did not include sufficient query-focused context.')
  const first = evidence[0]
  const read = await client.callTool({
    name: 'webfetch',
    arguments: { cursor: first.snapshot_cursor, format: 'text', max_chars: 12000 },
  })
  records.push({ stage: 'evidence-read', output: read.structuredContent })
  if (
    read.structuredContent?.snapshot_id !== first.snapshot_id ||
    read.structuredContent?.content_sha256 !== first.content_sha256
  )
    throw new Error('Evidence cursor did not resolve the same snapshot.')
  const expandable = data.results.find((row) => row.next_evidence_cursor)
  if (expandable) {
    const more = await client.callTool({
      name: 'webfetch',
      arguments: { cursor: expandable.next_evidence_cursor, format: 'text' },
    })
    const next = more.structuredContent
    records.push({ stage: 'more-related-evidence', output: next })
    if (
      !next ||
      next.view !== 'evidence' ||
      !next.evidence.length ||
      next.snapshot_id !== expandable.evidence[0].snapshot_id ||
      next.content.length > 4000
    )
      throw new Error('Related evidence continuation failed.')
    if (
      next.evidence.some((e) =>
        expandable.evidence.some(
          (initial) => e.start_char < initial.end_char && e.end_char > initial.start_char,
        ),
      )
    )
      throw new Error('Related evidence continuation repeated an original range.')
  }
  const chinese = await client.callTool(
    {
      name: 'websearch',
      arguments: {
        query: 'JavaScript Promise 异步',
        sites: ['developer.mozilla.org'],
        limit: 3,
        language: 'zh-CN',
      },
    },
    undefined,
    { timeout: 30_000 },
  )
  records.push({ stage: 'chinese-search', output: chinese.structuredContent })
  if (chinese.structuredContent?.status === 'error' || !chinese.structuredContent?.results?.length)
    throw new Error('Chinese site-scoped search did not return results.')
  const blocked = await client.callTool({
    name: 'webfetch',
    arguments: { url: 'http://127.0.0.1/' },
  })
  records.push({ stage: 'blocked-loopback', output: blocked.structuredContent })
  if (blocked.structuredContent?.error?.code !== 'FETCH_BLOCKED')
    throw new Error('Public URL restriction failed.')
  await writeFile(
    path.join(outputDir, 'result.json'),
    JSON.stringify(
      {
        checked_at: new Date().toISOString(),
        node: process.version,
        engines: process.env.SEARXNG_ENGINES,
        success: true,
        records,
      },
      null,
      2,
    ) + '\n',
  )
  process.stderr.write(
    `PASS: ${data.results.length} scoped English results, ${evidence.length} exact excerpts, same-snapshot read, Chinese scoped results and blocked loopback.\n`,
  )
} catch (error) {
  await writeFile(
    path.join(outputDir, 'result.json'),
    JSON.stringify(
      {
        checked_at: new Date().toISOString(),
        node: process.version,
        success: false,
        error: error.message,
        records,
      },
      null,
      2,
    ) + '\n',
  )
  throw error
} finally {
  await client.close()
}
