/** Check the managed native process, UI/static assets and keyless engine configuration; no search requests. */
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { access } from 'node:fs/promises'
import path from 'node:path'
import { nativePaths } from './searxng-native-install.mjs'

const cli = fileURLToPath(new URL('./searxng-native.mjs', import.meta.url))
const status = spawnSync(process.execPath, [cli, 'status'], { encoding: 'utf8' })
if (status.status !== 0) throw new Error('Native status command failed.')
const state = JSON.parse(status.stdout)
if (state.status !== 'ready') throw new Error('Managed native SearXNG is not ready.')
const origin = new URL(state.url)
if (origin.hostname !== '127.0.0.1') throw new Error('Native endpoint is not loopback-only.')
for (const route of ['/healthz', '/', '/static/themes/simple/sxng-ltr.min.css']) {
  const response = await fetch(new URL(route, origin), { signal: AbortSignal.timeout(15_000) })
  if (!response.ok || !(await response.text()).length)
    throw new Error(`Native route failed: ${route}`)
}
const response = await fetch(new URL('/config', origin), { signal: AbortSignal.timeout(15_000) })
if (!response.ok) throw new Error('Native config endpoint failed.')
const config = await response.json()
const engines = config.engines.map((engine) => engine.name).sort()
if (JSON.stringify(engines) !== JSON.stringify(['bing', 'brave', 'duckduckgo', 'google']))
  throw new Error('Unexpected native engine set.')
for (const name of ['sxng_cache_DATA_CACHE.db', 'sxng_cache_ENGINES_CACHE.db'])
  await access(path.join(nativePaths().data, name))
process.stderr.write(
  'PASS: native process identity, health, HTML UI, CSS, private cache location and keyless engine allowlist. No Docker commands or upstream search requests.\n',
)
