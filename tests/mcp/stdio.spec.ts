import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { afterEach, describe, expect, it } from 'vitest'

const entry = fileURLToPath(new URL('../../src/mcp/stdio.ts', import.meta.url))
const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.reverse()) await close().catch(() => undefined)
  cleanup.length = 0
})

/** Windows needs SystemRoot and friends to start a child process; API keys must not leak in. */
function inherited(names: string[]): Record<string, string> {
  return Object.fromEntries(
    names.flatMap((name) => {
      const value = process.env[name]
      return value === undefined ? [] : [[name, value]]
    }),
  )
}

/** Starts the real stdio entry with no keys and anonymous sources off, so nothing touches the network. */
async function connect() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'wrm-mcp-'))
  cleanup.push(() => rm(dataDir, { recursive: true, force: true }))
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry],
    env: {
      ...inherited(['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'HOME']),
      WEB_RESEARCH_DATA_DIR: dataDir,
      WEB_RESEARCH_ANONYMOUS_SOURCES: '0',
    },
    stderr: 'pipe',
  })
  const client = new Client({ name: 'stdio-e2e', version: '1.0.0' })
  cleanup.push(() => client.close())
  await client.connect(transport)
  return client
}

function text(result: unknown): string {
  const content = (result as { content?: { type: string; text?: string }[] }).content ?? []
  return content.map((block) => block.text ?? '').join('\n')
}

describe('MCP stdio entry', () => {
  it('exposes exactly two read-only tools with self-contained descriptions', async () => {
    const client = await connect()
    const { tools } = await client.listTools()
    expect(tools.map((tool) => tool.name)).toEqual(['web_search', 'web_fetch'])
    for (const tool of tools) {
      expect(tool.description?.length ?? 0).toBeGreaterThan(200)
      expect(tool.description?.length ?? 0).toBeLessThan(2000)
      expect(tool.annotations?.readOnlyHint).toBe(true)
      expect(tool.outputSchema).toBeUndefined()
    }
  }, 30_000)

  it('reports a missing search source as an actionable error, never as an empty result', async () => {
    const client = await connect()
    const result = await client.callTool({ name: 'web_search', arguments: { query: 'anything' } })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('web_search error')
    expect(text(result)).toContain('no_source_available')
    expect(text(result)).toContain('EXA_API_KEY')
  }, 30_000)

  it('refuses to fetch private addresses before any connection is made', async () => {
    const client = await connect()
    const result = await client.callTool({
      name: 'web_fetch',
      arguments: { url: 'http://127.0.0.1:8080/admin' },
    })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('unsafe_url')
  }, 30_000)

  it('accepts slightly wrong argument shapes instead of rejecting them at the protocol layer', async () => {
    const client = await connect()
    const result = await client.callTool({
      name: 'web_search',
      arguments: { query: 'anything', sites: 'example.org', max_results: '5', bogus: true },
    })
    expect(text(result)).toContain('no_source_available')
    expect(text(result)).not.toContain('invalid_input')
  }, 30_000)
})
