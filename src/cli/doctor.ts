/**
 * `web-research doctor`: explains, without spending any search quota, why the tool can or cannot
 * work on this machine. Reachability probes only list the tools of a hosted endpoint.
 */
import { EnvHttpProxyAgent, fetch as undiciFetch, type Dispatcher } from 'undici'
import { databasePath, loadConfig, type Config } from '../config.ts'
import { createCooldowns } from '../search/cooldown.ts'
import { createSqliteStore } from '../store/sqlite.ts'
import { VERSION } from '../version.ts'

interface Check {
  name: string
  ok: boolean
  detail: string
}

/** Hosts contacted when no key is configured. The probe only checks that each one answers. */
const ANONYMOUS_ENDPOINTS: Record<string, string> = {
  exa: 'https://mcp.exa.ai/mcp',
  parallel: 'https://search.parallel.ai/mcp',
  tavily: 'https://api.tavily.com/',
}

/** Same proxy variables as the search client, so a proxied network is not reported as unreachable. */
function proxyDispatcher(): Dispatcher | undefined {
  const names = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy']
  return names.some((name) => Boolean(process.env[name])) ? new EnvHttpProxyAgent() : undefined
}

function nodeCheck(): Check {
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number)
  const ok = major > 22 || (major === 22 && minor >= 13)
  return {
    name: 'node',
    ok,
    detail: `${process.versions.node} on ${process.platform}-${process.arch}${ok ? '' : ' (need 22.13 or newer)'}`,
  }
}

async function storeCheck(config: Config): Promise<{ check: Check; usage: Check[] }> {
  const location = databasePath(config)
  try {
    const store = await createSqliteStore(location)
    try {
      const cooldowns = createCooldowns(() => new Date(), store)
      const usage = ['exa', 'parallel', 'tavily'].map((source) => {
        const today = store.usageTodayBySource(source)
        const cooling = cooldowns.get(source)
        // A source that is being left alone explains "why was it not used" better than any log.
        const paused = cooling
          ? `; paused for ${Math.ceil(cooling.retryAfterS / 60)} min after ${cooling.code}`
          : ''
        return {
          name: `usage.${source}`,
          ok: !cooling,
          detail: `${today.calls} calls today, est. $${today.cost_usd.toFixed(3)}${paused}`,
        }
      })
      const journal = store.journalMode ?? 'unknown'
      const detail =
        journal === 'wal' ? location : `${location} (journal mode ${journal}; WAL unavailable here)`
      return { check: { name: 'state', ok: true, detail }, usage }
    } finally {
      store.close()
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error'
    return { check: { name: 'state', ok: false, detail: `${location}: ${reason}` }, usage: [] }
  }
}

async function reachable(id: string, url: string, userAgent: string): Promise<Check> {
  const started = performance.now()
  const host = new URL(url).host
  const dispatcher = proxyDispatcher()
  try {
    const response = await undiciFetch(url, {
      method: 'GET',
      headers: { accept: 'application/json, text/event-stream', 'user-agent': userAgent },
      signal: AbortSignal.timeout(8000),
      redirect: 'manual',
      ...(dispatcher ? { dispatcher } : {}),
    })
    await response.body?.cancel()
    const ms = Math.round(performance.now() - started)
    // Any HTTP answer proves the host is reachable; these endpoints reject a bare GET by design.
    return {
      name: `reach.${id}`,
      ok: true,
      detail: `${host} answered HTTP ${response.status} in ${ms} ms`,
    }
  } catch (error) {
    const cause =
      error instanceof Error ? (error.cause as { code?: string } | undefined) : undefined
    const reason = cause?.code ?? (error instanceof Error ? error.name : 'error')
    return { name: `reach.${id}`, ok: false, detail: `${host} unreachable (${reason})` }
  } finally {
    await dispatcher?.close()
  }
}

function sourceChecks(config: Config): Check[] {
  const keys: [string, string | undefined, string][] = [
    ['exa', config.sources.exaApiKey, 'EXA_API_KEY'],
    ['parallel', config.sources.parallelApiKey, 'PARALLEL_API_KEY'],
    ['tavily', config.sources.tavilyApiKey, 'TAVILY_API_KEY'],
  ]
  return keys.map(([id, key, variable]) => {
    const mode = key
      ? `API key from ${variable}`
      : config.sources.anonymous
        ? 'anonymous free tier'
        : 'disabled'
    return { name: `source.${id}`, ok: mode !== 'disabled', detail: mode }
  })
}

export async function runDoctor(options: { json: boolean }): Promise<number> {
  const config = loadConfig()
  const state = await storeCheck(config)
  const sources = sourceChecks(config)
  const probes = config.sources.anonymous
    ? await Promise.all(
        Object.entries(ANONYMOUS_ENDPOINTS).map(([id, url]) =>
          reachable(id, url, config.userAgent),
        ),
      )
    : []
  const checks = [nodeCheck(), state.check, ...sources, ...probes, ...state.usage]
  const anySource = sources.some((check) => check.ok)
  const healthy =
    checks
      .filter((check) => !check.name.startsWith('reach.'))
      .every(
        (check) => check.ok || check.name.startsWith('source.') || check.name.startsWith('usage.'),
      ) && anySource
  if (options.json) {
    process.stdout.write(`${JSON.stringify({ version: VERSION, healthy, checks })}\n`)
  } else {
    process.stdout.write(`web-research ${VERSION} doctor\n`)
    for (const check of checks)
      process.stdout.write(
        `${check.ok ? 'ok  ' : 'FAIL'}  ${check.name.padEnd(16)} ${check.detail}\n`,
      )
    if (!anySource)
      process.stdout.write(
        'No search source is available. Set EXA_API_KEY, TAVILY_API_KEY or PARALLEL_API_KEY, or enable anonymous sources with WEB_RESEARCH_ANONYMOUS_SOURCES=1.\n',
      )
    if (config.sources.anonymous)
      process.stdout.write(
        'Anonymous sources are on: for sources without a key, queries are sent to the public free endpoints of Exa (mcp.exa.ai), Parallel (search.parallel.ai) and Tavily (api.tavily.com). Turn this off with WEB_RESEARCH_ANONYMOUS_SOURCES=0.\n',
      )
  }
  return healthy ? 0 : 4
}
