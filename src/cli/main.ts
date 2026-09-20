#!/usr/bin/env node
/** Command line shell. Same objects as MCP: text view by default, `--json` for programs. */
import { writeFileSync } from 'node:fs'
import { parseArgs } from 'node:util'
import { createWebResearch } from '../index.ts'
import { renderFetch, renderSearch } from '../render/text.ts'
import { VERSION } from '../version.ts'
import { exitCodeFor, fetchRequest, HELP, OPTIONS, searchRequest } from './args.ts'
import { runDoctor } from './doctor.ts'

function emit(text: string, file: string | undefined): void {
  if (file) writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`)
  else process.stdout.write(text.endsWith('\n') ? text : `${text}\n`)
}

async function main(argv: string[]): Promise<number> {
  let parsed
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true })
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : 'invalid arguments'}\n\n${HELP}`,
    )
    return 2
  }
  const { values, positionals } = parsed
  const [command, ...rest] = positionals
  if (values.version) {
    process.stdout.write(`${VERSION}\n`)
    return 0
  }
  if (values.help || !command) {
    process.stdout.write(HELP)
    return command || values.help ? 0 : 2
  }
  if (command === 'mcp') {
    const { runMcpStdio } = await import('../mcp/run.ts')
    await runMcpStdio()
    return -1
  }
  if (command === 'doctor') return runDoctor({ json: values.json === true })
  if (command !== 'search' && command !== 'fetch') {
    process.stderr.write(`unknown command "${command}"\n\n${HELP}`)
    return 2
  }
  if (!rest.length && !values.cursor) {
    process.stderr.write(
      `${command} needs at least one ${command === 'search' ? 'query' : 'URL or ref'}\n`,
    )
    return 2
  }
  const controller = new AbortController()
  const interrupt = (): void => controller.abort()
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  const research = await createWebResearch()
  try {
    if (command === 'search') {
      const result = await research.search(searchRequest(rest, values), controller.signal)
      emit(values.json ? JSON.stringify(result) : renderSearch(result), values.output)
      return exitCodeFor(result.status, result.error)
    }
    const result = await research.fetch(fetchRequest(rest, values), controller.signal)
    emit(values.json ? JSON.stringify(result) : renderFetch(result), values.output)
    return exitCodeFor(result.status, result.error)
  } finally {
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    await research.close()
  }
}

main(process.argv.slice(2)).then(
  (code) => {
    if (code >= 0) process.exitCode = code
  },
  (error: unknown) => {
    process.stderr.write(`web-research: ${error instanceof Error ? error.message : 'failed'}\n`)
    process.exitCode = 1
  },
)
