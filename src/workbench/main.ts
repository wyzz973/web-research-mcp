#!/usr/bin/env node
/** Local acceptance UI entry, intentionally separate from MCP stdio and remote transports. */
import { readFile, stat } from 'node:fs/promises'
import { loadConfiguration } from '../shared/config.ts'
import { AppError } from '../shared/errors.ts'
import { createResearchRuntime } from '../tools/runtime.ts'
import { startWorkbench } from './server.ts'

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  let configPath: string | undefined
  let port = 18900
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]
    const value = args[i + 1]
    if (key === '--help') {
      process.stdout.write(
        'web-research-workbench [--config file.json] [--port 18900]\nLocal browser UI; binds only 127.0.0.1.\n',
      )
      return
    }
    if (key === '--config' && value) configPath = value
    else if (key === '--port' && value && /^\d+$/u.test(value)) port = Number(value)
    else
      throw new AppError('INVALID_ARGUMENT', 'Usage: workbench [--config file.json] [--port 18900]')
  }
  if (
    Number(process.versions.node.split('.')[0]) !== 24 ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535
  )
    throw new AppError('INVALID_ARGUMENT', 'Use Node 24 and a port between 1024 and 65535.')
  const config = loadConfiguration(configPath, process.env)
  const runtime = createResearchRuntime(config)
  try {
    const workbench = await startWorkbench({
      port,
      uiDirectory: new URL('../../ui/', import.meta.url),
      websearch: runtime.websearch,
      webfetch: runtime.webfetch,
      status: () => ({
        service: 'ready',
        package_version: '0.3.0',
        schema_version: '0.3-draft',
        search_configured: Boolean(runtime.provider),
        ...(runtime.provider?.inspect() ?? { status: 'unconfigured', engines: [], endpoint: null }),
      }),
      async evaluation() {
        const file = new URL('../../evals/reports/latest.json', import.meta.url)
        try {
          if ((await stat(file)).size > 4 * 1024 * 1024)
            throw new Error('Evaluation report too large')
          const report: unknown = JSON.parse(await readFile(file, 'utf8'))
          if (!report || typeof report !== 'object' || Array.isArray(report))
            throw new Error('Invalid report')
          return { available: true, ...report }
        } catch (error) {
          if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
            return {
              available: false,
              message: 'Run pnpm eval to generate the local evaluation report.',
            }
          throw error
        }
      },
    })
    let stopping: Promise<void> | undefined
    const shutdown = () => {
      stopping ??= (async () => {
        const deadline = setTimeout(() => process.exit(1), 10_000)
        deadline.unref()
        try {
          await workbench.close()
          await runtime.close()
        } finally {
          clearTimeout(deadline)
        }
      })()
      stopping.catch(() => {
        process.stderr.write('Workbench shutdown failed.\n')
        process.exitCode = 1
      })
    }
    process.once('SIGINT', shutdown)
    process.once('SIGTERM', shutdown)
    process.stdout.write(`Research workbench: ${workbench.url}\n`)
  } catch (error) {
    await runtime.close()
    throw error
  }
}
main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof AppError ? error.message : 'Unable to start local workbench; check configuration and port.'}\n`,
  )
  process.exitCode = 1
})
