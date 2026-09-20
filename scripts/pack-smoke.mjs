/**
 * Release-entry check: packs the built package, installs the tarball into an empty project, and
 * drives the installed entry points. Source tests cannot catch a missing file in `files`, a bin
 * without a shebang, or a worker that only resolves inside the repository.
 *
 * Needs the npm registry (to install dependencies) but no search source and no web page.
 *
 *   pnpm build && node scripts/pack-smoke.mjs
 */
import { execFileSync, execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const manifest = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'))
const work = mkdtempSync(path.join(tmpdir(), 'wrm-pack-'))
const failures = []
function check(name, condition, detail = '') {
  console.log(`${condition ? 'ok  ' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
  if (!condition) failures.push(name)
}

/** npm is a .cmd shim on Windows, which only a shell can run. */
function npm(args, cwd) {
  const options = { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }
  if (process.platform !== 'win32') return execFileSync('npm', args, options)
  const quoted = ['npm', ...args].map((arg) => (/\s/u.test(arg) ? `"${arg}"` : arg))
  return execSync(quoted.join(' '), options)
}

function inherited(names) {
  return Object.fromEntries(
    names.flatMap((name) => (process.env[name] === undefined ? [] : [[name, process.env[name]]])),
  )
}

let client
try {
  const packed = JSON.parse(npm(['pack', '--json', '--pack-destination', work], root))
  const tarball = path.join(work, packed[0].filename)
  const shipped = packed[0].files.map((file) => file.path)
  check(
    'tarball carries only the build, the readme, and the license',
    shipped.every((file) => /^(dist\/|README\.md$|LICENSE$|package\.json$)/u.test(file)),
    `${shipped.length} files`,
  )
  check(
    'tarball carries no source maps of tests or fixtures',
    !shipped.some((f) => /tests?\//u.test(f)),
  )

  const project = path.join(work, 'project')
  mkdirSync(project)
  writeFileSync(path.join(project, 'package.json'), '{"name":"wrm-pack-smoke","private":true}\n')
  npm(['install', '--no-audit', '--no-fund', '--omit=dev', tarball], project)
  const installed = path.join(project, 'node_modules', manifest.name)

  for (const [name, target] of Object.entries(manifest.bin)) {
    const entry = path.join(installed, target)
    check(
      `bin ${name} starts with a node shebang`,
      readFileSync(entry, 'utf8').startsWith('#!/usr/bin/env node'),
    )
  }

  const cli = path.join(installed, manifest.bin['web-research'])
  const version = execFileSync(process.execPath, [cli, '--version'], { encoding: 'utf8' }).trim()
  check('installed CLI reports the package version', version === manifest.version, version)
  const help = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8' })
  check('installed CLI prints help', help.includes('search') && help.includes('fetch'))

  const library = await import(pathToFileURL(path.join(installed, 'dist', 'index.js')).href)
  check('library entry exports createWebResearch', typeof library.createWebResearch === 'function')

  // The extraction worker is a separate file resolved at run time: the classic packaging miss.
  const extract = await import(
    pathToFileURL(path.join(installed, 'dist', 'extract', 'index.js')).href
  )
  const html = `<!doctype html><title>Pack smoke</title><main><h1>Heading</h1><p>${'Body text. '.repeat(40)}</p></main>`
  const reply = await extract.extractHtml(
    { html: new TextEncoder().encode(html), url: 'https://example.org/', contentType: 'text/html' },
    { timeoutMs: 20_000, memoryMb: 512 },
    new AbortController().signal,
  )
  check(
    'installed extraction worker converts a page',
    reply.ok === true && reply.value.markdown.includes('Body text.'),
  )

  const dataDir = path.join(work, 'data')
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(installed, manifest.bin['web-research-mcp'])],
    env: {
      ...inherited(['PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'USERPROFILE', 'HOME']),
      WEB_RESEARCH_DATA_DIR: dataDir,
      WEB_RESEARCH_ANONYMOUS_SOURCES: '0',
    },
    stderr: 'pipe',
  })
  client = new Client({ name: 'pack-smoke', version: '1.0.0' })
  await client.connect(transport)
  const { tools } = await client.listTools()
  check(
    'installed MCP server lists exactly web_search and web_fetch',
    tools.map((tool) => tool.name).join() === 'web_search,web_fetch',
  )
  const refused = await client.callTool({
    name: 'web_fetch',
    arguments: { url: 'http://127.0.0.1:8080/admin' },
  })
  const text = (refused.content ?? []).map((block) => block.text ?? '').join('\n')
  check(
    'installed MCP server refuses a private address',
    refused.isError === true && text.includes('unsafe_url'),
  )
} finally {
  await client?.close().catch(() => undefined)
  rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
}

if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join('; ')}`)
  process.exitCode = 1
} else console.log('\npackage entry points work when installed from the tarball')
