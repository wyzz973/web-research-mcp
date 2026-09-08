#!/usr/bin/env node
/** Composition root and supported executable entry. */
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createMcpServer } from './server.ts'
import { loadConfiguration } from '../shared/config.ts'
import { AppError } from '../shared/errors.ts'
import { createDocumentLoader } from '../fetch/index.ts'
import { createSearxngProvider } from '../search/searxng.ts'
import { createSnapshotStore } from '../storage/index.ts'
import { createWebFetch } from '../tools/webfetch.ts'
import { createWebSearch } from '../tools/websearch.ts'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      'web-research-mcp [--config file.json]\n\nEnvironment: SEARXNG_URL, SEARXNG_ENGINES, WEB_RESEARCH_DATA_DIR\nRequires Node 24. No search API key is used. Without a configured search endpoint, webfetch remains available.\n',
    )
    return
  }
  if (args.includes('--version')) {
    process.stdout.write('0.1.0\n')
    return
  }
  if (args.length && !(args.length === 2 && args[0] === '--config' && args[1]))
    throw new AppError('INVALID_ARGUMENT', 'Usage: web-research-mcp [--config file.json]')
  if (Number(process.versions.node.split('.')[0]) !== 24)
    throw new AppError('INVALID_ARGUMENT', 'Use Node 24.x for this release.')
  const config = loadConfiguration(args[1], process.env)
  const lifetime = new AbortController()
  const provider =
    config.search.base_url && config.search.engine_allowlist.length
      ? createSearxngProvider({
          baseUrl: config.search.base_url,
          engines: config.search.engine_allowlist,
          timeoutMs: config.search.provider_timeout_ms,
        })
      : undefined
  const loader = createDocumentLoader({
    deadlineMs: config.fetch.deadline_ms,
    maxCompressedBytes: config.fetch.max_compressed_bytes,
    maxDecompressedBytes: config.fetch.max_decompressed_bytes,
    maxRedirects: config.fetch.max_redirects,
    globalConcurrency: config.fetch.global_concurrency,
    perHostConcurrency: config.fetch.per_host_concurrency,
    parserTimeoutMs: config.fetch.parser_timeout_ms,
    parserMemoryMb: config.fetch.parser_memory_mb,
    parserConcurrency: config.fetch.parser_worker_concurrency,
    userAgent: config.fetch.user_agent,
  })
  const store = createSnapshotStore({
    directory: config.storage.directory,
    ttlSeconds: config.storage.snapshot_ttl_seconds,
    maxBytes: config.storage.max_bytes,
  })
  const active = new Set<Promise<unknown>>()
  function track<T>(task: Promise<T>): Promise<T> {
    active.add(task)
    return task.finally(() => {
      active.delete(task)
    })
  }
  const websearch = createWebSearch(config, provider, loader, store)
  const webfetch = createWebFetch(config, loader, store)
  const handle = serveStdio(
    () =>
      createMcpServer(
        {
          websearch: (input, signal) => track(websearch(input, signal)),
          webfetch: (input, signal) => track(webfetch(input, signal)),
        },
        lifetime.signal,
      ),
    { onerror: () => process.stderr.write('{"level":"error","event":"mcp_protocol_error"}\n') },
  )
  let stopping: Promise<void> | undefined
  const shutdown = () => {
    stopping ??= (async () => {
      lifetime.abort(new AppError('CANCELLED', 'The MCP service is shutting down.'))
      const timer = setTimeout(() => {
        process.stderr.write('{"level":"error","event":"shutdown_timeout"}\n')
        process.exit(1)
      }, 10_000)
      timer.unref()
      try {
        await Promise.allSettled([loader.close(), provider?.close() ?? Promise.resolve()])
        await Promise.allSettled(active)
        await handle.close()
        store.close()
      } finally {
        clearTimeout(timer)
      }
    })()
    stopping.catch(() => {
      process.stderr.write('{"level":"error","event":"shutdown_failed"}\n')
      process.exitCode = 1
    })
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  process.stdin.once('end', shutdown)
  process.stderr.write(
    JSON.stringify({
      level: 'info',
      event: 'ready',
      search_configured: Boolean(provider),
      version: '0.1.0',
    }) + '\n',
  )
}

main().catch((error: unknown) => {
  process.stderr.write(
    JSON.stringify({
      level: 'error',
      event: 'startup_failed',
      message: error instanceof AppError ? error.message : 'Unable to initialize the MCP service.',
    }) + '\n',
  )
  process.exitCode = 1
})
