import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterEach, describe, expect, it } from 'vitest'
import { parseContract } from '../src/shared/contracts.ts'
import type { WebSearchOutput } from '../src/generated/websearch.output.ts'
import type { WebFetchOutput } from '../src/generated/webfetch.output.ts'

const entry = fileURLToPath(new URL('../dist/mcp/stdio.js', import.meta.url))
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.reverse()) await close()
  cleanup.length = 0
})

async function directory() {
  const value = await mkdtemp(join(tmpdir(), 'web-research-mcp-stdio-'))
  cleanup.push(() => rm(value, { recursive: true, force: true }))
  return value
}

async function connect(cwd: string, env: Record<string, string>) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    cwd,
    env,
    stderr: 'pipe',
  })
  const client = new Client({ name: 'built-entry-test', version: '1.0.0' })
  let stderr = ''
  transport.stderr?.on('data', (data: Buffer) => {
    stderr += data.toString()
  })
  cleanup.push(() => client.close())
  await client.connect(transport)
  return { client, stderr: () => stderr }
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Expected JSON object')
  return Object.fromEntries(Object.entries(value))
}

describe('built MCP stdio executable', () => {
  it('discovers tools, strictly filters domains, and reads a frozen cursor after process restart', async () => {
    const cwd = await directory()
    let requests = 0
    let query = ''
    const row = (url: string) => ({
      title: 'MCP evidence',
      content: 'Tools are available',
      url,
      engines: ['duckduckgo'],
    })
    const server = createServer((request, response) => {
      requests += 1
      const url = new URL(request.url ?? '/', 'http://localhost')
      query = url.searchParams.get('q') ?? ''
      // Real SearXNG unions categories with explicit engines. Model the network boundary accordingly.
      const injected = url.searchParams.has('categories')
        ? [{ ...row('https://example.org/injected'), engines: ['bing'] }]
        : []
      response.writeHead(200, { 'content-type': 'application/json' }).end(
        JSON.stringify({
          results: [
            row('https://example.org.evil.net/wrong'),
            row('https://private.example.org/secret'),
            row('https://example.org/a?utm_source=campaign'),
            row('https://example.org/a'),
            row('https://docs.example.org/b'),
            row('https://example.org/c'),
            ...injected,
          ],
          unresponsive_engines: [],
          paging: false,
        }),
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    cleanup.push(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    })
    const address = server.address()
    if (!address || typeof address !== 'object') throw new Error('Missing fixture address')
    const env = {
      WEB_RESEARCH_DATA_DIR: join(cwd, 'data'),
      SEARXNG_URL: `http://127.0.0.1:${address.port}`,
      SEARXNG_ENGINES: 'duckduckgo',
    }
    const firstSession = await connect(cwd, env)
    const tools = await firstSession.client.listTools()
    expect(
      tools.tools.map((tool) => tool.name).sort((left, right) => left.localeCompare(right)),
    ).toEqual(['webfetch', 'websearch'])
    const args = {
      query: 'MCP tools',
      sites: ['example.org'],
      exclude_domains: ['private.example.org'],
      limit: 1,
    }
    const result = await firstSession.client.callTool({ name: 'websearch', arguments: args })
    const first = parseContract<WebSearchOutput>('websearch.output', result.structuredContent)
    expect(first.status).toBe('ok')
    expect(first.results.map((item) => item.url)).toEqual(['https://example.org/a'])
    expect(first.scope?.removed_count).toBe(2)
    expect(first.results[0]?.confidence.fact_probability).toBeNull()
    expect(first.results[0]?.source_metadata).toMatchObject({
      source_url: 'https://example.org/a',
      hostname: 'example.org',
      favicon_url: 'https://example.org/favicon.ico',
      logo_url: null,
      metadata_source: 'url_only',
      assets_verified: false,
      provenance: { favicon_url: 'origin_fallback' },
    })
    expect(typeof first.next_cursor).toBe('string')
    expect(query).toContain('site:example.org')
    expect(requests).toBe(1)
    const text = result.content.find((item) => item.type === 'text')
    expect(text?.type === 'text' ? JSON.parse(text.text) : undefined).toEqual(first)
    await firstSession.client.close()

    const secondSession = await connect(cwd, env)
    const page = await secondSession.client.callTool({
      name: 'websearch',
      arguments: { ...args, cursor: first.next_cursor },
    })
    const second = parseContract<WebSearchOutput>('websearch.output', page.structuredContent)
    expect(second.status).toBe('ok')
    expect(second.results.map((item) => [item.rank, item.url])).toEqual([
      [2, 'https://docs.example.org/b'],
    ])
    expect(requests).toBe(1)
    const blocked = await secondSession.client.callTool({
      name: 'webfetch',
      arguments: { url: env.SEARXNG_URL },
    })
    expect(
      parseContract<WebFetchOutput>('webfetch.output', blocked.structuredContent).error?.code,
    ).toBe('FETCH_BLOCKED')
    expect(blocked.isError).toBe(true)
    expect(requests).toBe(1)
    expect(secondSession.stderr()).toContain('"event":"ready"')

    const rankedArgs = { ...args, ranking_mode: 'bm25_mmr' }
    const rankedCall = await secondSession.client.callTool({
      name: 'websearch',
      arguments: rankedArgs,
    })
    const ranked = parseContract<WebSearchOutput>('websearch.output', rankedCall.structuredContent)
    expect(ranked.results[0]?.ranking).toMatchObject({
      method: 'bm25_mmr',
      original_rank: 1,
      corpus_size: 3,
    })
    const afterRankingRequests = requests
    await secondSession.client.close()
    const thirdSession = await connect(cwd, env)
    const rankedNext = await thirdSession.client.callTool({
      name: 'websearch',
      arguments: { ...rankedArgs, cursor: ranked.next_cursor },
    })
    const continued = parseContract<WebSearchOutput>(
      'websearch.output',
      rankedNext.structuredContent,
    )
    expect(continued.results[0]?.rank).toBe(2)
    expect(continued.results[0]?.ranking?.method).toBe('bm25_mmr')
    expect(requests).toBe(afterRankingRequests)
  })

  it('rejects invalid tool arguments without accepting the request', async () => {
    const cwd = await directory()
    const { client } = await connect(cwd, { WEB_RESEARCH_DATA_DIR: join(cwd, 'data') })
    const result = await client.callTool({
      name: 'webfetch',
      arguments: { url: 'https://example.org', cursor: 'invalid' },
    })
    expect(result.isError).toBe(true)
    const message = result.content.find((item) => item.type === 'text')
    expect(message?.type === 'text' ? message.text : '').toContain(
      'Invalid arguments for tool webfetch',
    )
    expect(result.structuredContent).toBeUndefined()
    const conflict = await client.callTool({
      name: 'websearch',
      arguments: { query: 'MCP', sites: ['example.org'], include_domains: ['example.org'] },
    })
    expect(conflict.isError).toBe(true)
    const conflictMessage = conflict.content.find((item) => item.type === 'text')
    expect(conflictMessage?.type === 'text' ? conflictMessage.text : '').toContain(
      'Provide sites or include_domains, not both.',
    )
  })

  it('fails startup with a nonzero exit and protocol-clean stdout for invalid configuration', async () => {
    const cwd = await directory()
    const child = spawn(process.execPath, [entry], {
      cwd,
      env: { WEB_RESEARCH_DATA_DIR: join(cwd, 'data'), SEARXNG_ENGINES: 'paid-api' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (data: Buffer) => {
      stdout += data.toString()
    })
    child.stderr.on('data', (data: Buffer) => {
      stderr += data.toString()
    })
    const [code] = await once(child, 'exit')
    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('"event":"startup_failed"')
  })

  it('supports legacy initialize and tools/list frames on the built entry', async () => {
    const cwd = await directory()
    const child = spawn(process.execPath, [entry], {
      cwd,
      env: { WEB_RESEARCH_DATA_DIR: join(cwd, 'data') },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    const lines = createInterface({ input: child.stdout })
    const pending = new Map<number, (value: Record<string, unknown>) => void>()
    lines.on('line', (line) => {
      const message = record(JSON.parse(line))
      if (typeof message.id === 'number') pending.get(message.id)?.(message)
    })
    child.stderr.resume()
    cleanup.push(async () => {
      const exited = once(child, 'exit')
      child.stdin.end()
      await exited
      lines.close()
    })
    async function request(id: number, method: string, params: Record<string, unknown>) {
      const response = new Promise<Record<string, unknown>>((resolve) => pending.set(id, resolve))
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      return response
    }
    const initialized = await request(1, 'initialize', {
      protocolVersion: '2025-11-25',
      capabilities: {},
      clientInfo: { name: 'legacy-fixture', version: '1.0.0' },
    })
    expect(record(initialized.result).protocolVersion).toBe('2025-11-25')
    child.stdin.write(
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n',
    )
    const listing = await request(2, 'tools/list', {})
    const tools = record(listing.result).tools
    expect(Array.isArray(tools)).toBe(true)
    if (!Array.isArray(tools)) throw new Error('Missing legacy tools')
    expect(
      tools
        .map((tool) => String(record(tool).name))
        .sort((left, right) => left.localeCompare(right)),
    ).toEqual(['webfetch', 'websearch'])
  })
})
