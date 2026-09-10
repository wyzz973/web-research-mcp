#!/usr/bin/env node
/** Composition root and supported executable entry. */
import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createMcpServer } from './server.ts'
import { loadConfiguration } from '../shared/config.ts'
import { AppError } from '../shared/errors.ts'
import { createResearchRuntime } from '../tools/runtime.ts'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(
      'web-research-mcp [--config file.json]\n\nEnvironment: SEARXNG_URL, SEARXNG_ENGINES, WEB_RESEARCH_DATA_DIR\nRequires Node 24. No search API key is used. Without a configured search endpoint, webfetch remains available.\n',
    )
    return
  }
  if (args.includes('--version')) {
    process.stdout.write('0.3.0\n')
    return
  }
  if (args.length && !(args.length === 2 && args[0] === '--config' && args[1]))
    throw new AppError('INVALID_ARGUMENT', 'Usage: web-research-mcp [--config file.json]')
  if (Number(process.versions.node.split('.')[0]) !== 24)
    throw new AppError('INVALID_ARGUMENT', 'Use Node 24.x for this release.')
  const config = loadConfiguration(args[1], process.env)
  const lifetime = new AbortController()
  const runtime = createResearchRuntime(config)
  const active = new Set<Promise<unknown>>()
  function track<T>(task: Promise<T>): Promise<T> {
    active.add(task)
    return task.finally(() => {
      active.delete(task)
    })
  }
  const { websearch, webfetch } = runtime
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
        await Promise.allSettled(active)
        await handle.close()
        await runtime.close()
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
      search_configured: Boolean(runtime.provider),
      version: '0.3.0',
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
