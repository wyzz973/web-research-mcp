/** Manual acceptance through the real built stdio server. */
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { fileURLToPath } from 'node:url'

const [name, json, flag, config] = process.argv.slice(2)
if (
  !['websearch', 'webfetch'].includes(name) ||
  !json ||
  (flag && (flag !== '--config' || !config))
) {
  throw new Error("Usage: pnpm call <websearch|webfetch> 'JSON arguments' [--config file.json]")
}
const input = JSON.parse(json)
const args = [fileURLToPath(new URL('../dist/mcp/stdio.js', import.meta.url))]
if (config) args.push('--config', config)
const env = Object.fromEntries(
  ['SEARXNG_URL', 'SEARXNG_ENGINES', 'WEB_RESEARCH_DATA_DIR'].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : [],
  ),
)
const transport = new StdioClientTransport({ command: process.execPath, args, env, stderr: 'pipe' })
transport.stderr?.on('data', (chunk) => process.stderr.write(chunk))
const client = new Client({ name: 'web-research-manual-acceptance', version: '0.1.0' })
try {
  await client.connect(transport)
  const result = await client.callTool({ name, arguments: input }, undefined, { timeout: 65_000 })
  process.stdout.write(JSON.stringify(result.structuredContent ?? result, null, 2) + '\n')
  if (result.isError) process.exitCode = 1
} finally {
  await client.close()
}
