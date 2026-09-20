import { serveStdio } from '@modelcontextprotocol/server/stdio'
import { createWebResearch } from '../index.ts'
import { createMcpServer, type OutputMode } from './server.ts'

function outputMode(env: NodeJS.ProcessEnv): OutputMode {
  return env.WEB_RESEARCH_MCP_OUTPUT === 'json' ? 'json' : 'text'
}

/** Owns every resource of the stdio server and releases them on stdin EOF or a signal. */
export async function runMcpStdio(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const research = await createWebResearch()
  const lifetime = new AbortController()
  const active = new Set<Promise<unknown>>()
  function track<T>(task: Promise<T>): Promise<T> {
    active.add(task)
    return task.finally(() => active.delete(task))
  }
  const handle = serveStdio(
    () =>
      createMcpServer(
        {
          search: (request, signal) => track(research.search(request, signal)),
          fetch: (request, signal) => track(research.fetch(request, signal)),
        },
        { config: research.config, output: outputMode(env), lifetime: lifetime.signal },
      ),
    { onerror: () => process.stderr.write('web-research-mcp: protocol error\n') },
  )
  let stopping: Promise<void> | undefined
  const shutdown = (): void => {
    stopping ??= (async () => {
      lifetime.abort()
      const guard = setTimeout(() => process.exit(1), 10_000)
      guard.unref()
      try {
        await Promise.allSettled(active)
        await handle.close()
        await research.close()
      } finally {
        clearTimeout(guard)
      }
    })()
    stopping.catch(() => {
      process.exitCode = 1
    })
  }
  process.once('SIGTERM', shutdown)
  process.once('SIGINT', shutdown)
  process.stdin.once('end', shutdown)
  process.stdin.once('close', shutdown)
}
