/** Explicit operator probe; one bounded aggregate request, never bypasses upstream suspension. */
import { parseArgs } from 'node:util'
import { createSearxngProvider } from '../dist/search/searxng.js'
import { loadConfiguration } from '../dist/shared/config.js'

const { values } = parseArgs({
  options: {
    config: { type: 'string' },
    query: { type: 'string', default: 'MCP tools' },
    language: { type: 'string', default: 'en' },
  },
})
const config = loadConfiguration(values.config, process.env)
if (!config.search.base_url) throw new Error('Configure SEARXNG_URL or --config before probing.')
const provider = createSearxngProvider({
  baseUrl: config.search.base_url,
  engines: config.search.engine_allowlist,
  timeoutMs: config.search.provider_timeout_ms,
})
try {
  let result
  try {
    const page = await provider.searchPage(
      {
        query: values.query,
        language: values.language,
        timeRange: 'any',
        page: 1,
      },
      AbortSignal.timeout(config.search.provider_timeout_ms + 1000),
    )
    result = {
      status: page.errors.length ? 'partial' : page.sources.length ? 'ok' : 'empty',
      result_count: page.sources.length,
      errors: page.errors,
    }
  } catch (error) {
    result = {
      status: 'error',
      error: error.code ?? 'UPSTREAM_UNAVAILABLE',
      message: error.message,
    }
    process.exitCode = 1
  }
  const diagnostics = provider.inspect()
  if (diagnostics.status === 'degraded') process.exitCode = 2
  process.stdout.write(
    `${JSON.stringify({ scope: 'single_process_probe', result, diagnostics }, null, 2)}\n`,
  )
} finally {
  await provider.close()
}
