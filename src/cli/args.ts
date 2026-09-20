/** Pure argument handling for the CLI, kept separate from the entry point so it can be unit tested. */
import type { parseArgs } from 'node:util'
import type { FetchRequest, SearchRequest, Status, ToolError } from '../contract.ts'
import { VERSION } from '../version.ts'

export const HELP = `web-research ${VERSION} - web search and verbatim page reading for LLM agents

Usage:
  web-research search <query> [more queries...] [options]
  web-research fetch <url|ref> [more...] [options]
  web-research doctor [--json]
  web-research mcp                      start the MCP server on stdio

search options:
  --max-results <n>    number of results (default 10, up to 50)
  --goal <text>        what you hope to find; improves excerpts
  --site <domain>      restrict to a domain (repeatable)
  --recency <period>   day | week | month | year
  --depth <level>      fast | standard | deep
  --cursor <id>        continue a previous search

fetch options:
  --goal <text>        return the passages most relevant to this goal
  --section <id>       read one section from the outline
  --find <text>        locate exact text (use it to verify a quote)
  --cursor <id>        continue reading
  --fresh              ignore the cached snapshot

common options:
  --max-tokens <n>     approximate size of the output
  --json               print the result object as JSON
  -o, --output <file>  write the output to a file instead of stdout
  -h, --help           show this help
  -v, --version        show the version

Exit codes: 0 results returned, 2 invalid usage, 3 nothing found, 4 upstream or network failure, 1 internal error.
`

export const OPTIONS = {
  'max-results': { type: 'string' },
  'max-tokens': { type: 'string' },
  goal: { type: 'string' },
  site: { type: 'string', multiple: true },
  recency: { type: 'string' },
  depth: { type: 'string' },
  cursor: { type: 'string' },
  section: { type: 'string' },
  find: { type: 'string' },
  fresh: { type: 'boolean' },
  json: { type: 'boolean' },
  output: { type: 'string', short: 'o' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
} as const

export type Values = ReturnType<
  typeof parseArgs<{ options: typeof OPTIONS; allowPositionals: true }>
>['values']

export function exitCodeFor(status: Status, error: ToolError | undefined): number {
  if (status === 'ok' || status === 'partial') return 0
  if (status === 'empty') return 3
  if (error?.code === 'invalid_input') return 2
  if (error?.code === 'internal') return 1
  return 4
}

function defined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T
}

export function searchRequest(queries: string[], values: Values): SearchRequest {
  return defined({
    queries: queries.length ? queries : undefined,
    max_results: values['max-results'],
    max_tokens: values['max-tokens'],
    goal: values.goal,
    sites: values.site,
    recency: values.recency,
    depth: values.depth,
    cursor: values.cursor,
  })
}

export function fetchRequest(targets: string[], values: Values): FetchRequest {
  const urls = targets.filter((target) => /^https?:\/\//iu.test(target) || target.includes('.'))
  const refs = targets.filter((target) => !urls.includes(target))
  return defined({
    urls: urls.length ? urls : undefined,
    refs: refs.length ? refs : undefined,
    goal: values.goal,
    section: values.section,
    find: values.find,
    max_tokens: values['max-tokens'],
    cursor: values.cursor,
    fresh: values.fresh,
  })
}
