/** Install the packed release into a clean directory and exercise its real bin. */
import { spawn } from 'node:child_process'
import { mkdtemp, mkdir, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const root = fileURLToPath(new URL('../', import.meta.url))
const temp = await mkdtemp(path.join(tmpdir(), 'web-research-packed-'))
function command(bin, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] })
    let output = ''
    child.stdout.on('data', (chunk) => {
      output += chunk
    })
    child.stderr.on('data', (chunk) => {
      output += chunk
    })
    child.on('error', reject)
    child.on('exit', (code) =>
      code === 0 ? resolve(output) : reject(new Error(`${bin} failed (${code}): ${output}`)),
    )
  })
}
let client
try {
  const packed = path.join(temp, 'packed')
  const consumer = path.join(temp, 'consumer')
  await mkdir(packed)
  await mkdir(consumer)
  await command('pnpm', ['pack', '--pack-destination', packed], root)
  const file = (await readdir(packed)).find((name) => name.endsWith('.tgz'))
  if (!file) throw new Error('No packed artifact')
  await command(
    'npm',
    [
      'install',
      '--prefix',
      consumer,
      '--no-audit',
      '--no-fund',
      '--ignore-scripts',
      path.join(packed, file),
    ],
    consumer,
  )
  // The one reviewed native build is performed under the same Node 24 as the consumer.
  await command('npm', ['rebuild', 'better-sqlite3', '--prefix', consumer], consumer)
  const installed = path.join(consumer, 'node_modules', 'web-research-mcp')
  const files = await readdir(installed)
  if (files.includes('src') || files.includes('data') || files.includes('.cache'))
    throw new Error('Package contains development or runtime state.')
  const args = [path.join(installed, 'dist', 'mcp', 'stdio.js')]
  await command(process.execPath, [...args, '--help'], consumer)
  client = new Client({ name: 'packed-consumer', version: '0.1.0' })
  const transport = new StdioClientTransport({
    command: process.execPath,
    args,
    env: { WEB_RESEARCH_DATA_DIR: path.join(temp, 'data') },
    stderr: 'pipe',
  })
  transport.stderr?.resume()
  await client.connect(transport)
  const tools = await client.listTools()
  if (tools.tools.length !== 2) throw new Error('Installed tools missing')
  const fetched = await client.callTool({
    name: 'webfetch',
    arguments: { url: 'http://127.0.0.1/' },
  })
  if (fetched.structuredContent?.error?.code !== 'FETCH_BLOCKED')
    throw new Error('Installed fetch policy failed')
  // Load the installed parser worker itself; no source tree or caller dev dependencies are available.
  const { extractHtml } = await import(
    pathToFileURL(path.join(installed, 'dist', 'fetch', 'extractor.js')).href
  )
  const article =
    '<!doctype html><title>Packed extraction</title><article><h1>Packed extraction</h1>' +
    '<p>The isolated packaged parser returns original readable evidence with stable document structure.</p>'.repeat(
      12,
    ) +
    '</article>'
  const extracted = await extractHtml(
    Buffer.from(article),
    'https://example.com/article',
    'text/html',
    new AbortController().signal,
    15_000,
    128,
  )
  if (!extracted.text.includes('original readable evidence'))
    throw new Error('Installed worker failed to extract the document.')
  process.stderr.write(
    'PASS: clean packed install, native SQLite, installed MCP bin, schemas and worker artifact.\n',
  )
} finally {
  await client?.close()
  await rm(temp, { recursive: true, force: true })
}
