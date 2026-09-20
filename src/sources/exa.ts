/**
 * Exa. With EXA_API_KEY: the REST search API with highlights (no page text is bought).
 * Without a key: Exa's public hosted MCP endpoint, which answers in a plain-text block format.
 */
import { WebError } from '../errors.ts'
import type { ApiHttp } from '../net/api-http.ts'
import { callHostedTool } from './hosted-mcp.ts'
import {
  cleanPassages,
  cleanTitle,
  isRecord,
  objectiveWithHints,
  parseJson,
  recencyStart,
  toIsoDate,
  type JsonRecord,
} from './shared.ts'
import type { SourceAdapter, SourceHit, SourceRequest } from './types.ts'

const ID = 'exa'
const HOSTED_MCP_URL = 'https://mcp.exa.ai/mcp'
const REST_URL = 'https://api.exa.ai/search'
/** List price of one search with up to 25 results, checked 2026-09-20. */
const UNIT_COST_USD = 0.007
const MAX_RESULTS_PER_CALL = 25
const HIGHLIGHT_CHARS = 2000
/** Exa answers 402 when the account is out of credits. */
const QUOTA_STATUSES = [402] as const

const BLOCK_SEPARATOR = /\n+---\n+(?=Title: )/u
const FIELD = /^(Title|URL|Published|Author): ?(.*)$/u
const BODY = /^(?:Highlights|Text|Summary):\s?/u
const HIGHLIGHT_GAP = /^[ \t]*\.\.\.[ \t]*$/mu

export interface ExaOptions {
  http: ApiHttp
  apiKey: string | undefined
}

/** Header values may span lines (authors scraped with their markup whitespace). */
function readFields(lines: readonly string[]): Map<string, string> {
  const fields = new Map<string, string>()
  let current: string | undefined
  for (const line of lines) {
    const match = FIELD.exec(line)
    if (match?.[1]) current = match[1]
    if (current)
      fields.set(current, `${fields.get(current) ?? ''} ${match ? (match[2] ?? '') : line}`)
  }
  return fields
}

function parseBlock(block: string): SourceHit | undefined {
  const lines = block.split('\n')
  const bodyAt = lines.findIndex((line) => BODY.test(line))
  const fields = readFields(bodyAt < 0 ? lines : lines.slice(0, bodyAt))
  const url = fields.get('URL')?.trim()
  if (!url) return undefined
  const body = bodyAt < 0 ? '' : lines.slice(bodyAt).join('\n').replace(BODY, '')
  const published = toIsoDate(fields.get('Published')?.trim())
  const title = cleanTitle(fields.get('Title'))
  return {
    url,
    title: title === 'N/A' ? '' : title,
    passages: cleanPassages(body.split(HIGHLIGHT_GAP)),
    ...(published ? { published } : {}),
  }
}

/** Parses the text the hosted `web_search_exa` tool returns. */
export function parseExaText(text: string): SourceHit[] {
  const normalized = text.replace(/\r\n?/gu, '\n').trim()
  const hits = normalized
    .split(BLOCK_SEPARATOR)
    .map(parseBlock)
    .filter((hit) => hit !== undefined)
  if (hits.length > 0 || normalized.length === 0) return hits
  // Anything that is neither results nor a "nothing found" sentence is a format we do not know.
  if (/\bno\b[^.\n]{0,40}\bresults?\b/iu.test(normalized)) return []
  throw new WebError('parse_failed', 'exa answered in a format this version does not understand.')
}

function passagesOf(result: JsonRecord): string[] {
  if (Array.isArray(result.highlights)) return cleanPassages(result.highlights)
  return cleanPassages([result.text ?? result.summary])
}

/** Parses the body of `POST /search`. */
export function parseExaJson(body: string): SourceHit[] {
  const payload = parseJson(body, ID)
  if (!isRecord(payload) || !Array.isArray(payload.results))
    throw new WebError('parse_failed', 'exa answered without a results list.')
  return payload.results.filter(isRecord).flatMap((result) => {
    if (typeof result.url !== 'string') return []
    const published = toIsoDate(result.publishedDate)
    return [
      {
        url: result.url,
        title: cleanTitle(result.title),
        passages: passagesOf(result),
        ...(published ? { published } : {}),
      },
    ]
  })
}

function restBody(request: SourceRequest): JsonRecord {
  const query = request.queries[0] ?? ''
  return {
    query,
    type: 'auto',
    numResults: Math.min(request.maxResults, MAX_RESULTS_PER_CALL),
    contents: {
      highlights: {
        maxCharacters: HIGHLIGHT_CHARS,
        ...(request.goal ? { query: request.goal } : {}),
      },
    },
    ...(request.sites.length ? { includeDomains: request.sites } : {}),
    ...(request.recency
      ? { startPublishedDate: recencyStart(request.recency, request.now).toISOString() }
      : {}),
  }
}

export function createExaSource(options: ExaOptions): SourceAdapter {
  const { http, apiKey } = options

  async function searchWithKey(request: SourceRequest, key: string, signal: AbortSignal) {
    const response = await http(
      {
        url: REST_URL,
        method: 'POST',
        headers: { 'x-api-key': key, accept: 'application/json' },
        json: restBody(request),
        quotaStatuses: QUOTA_STATUSES,
      },
      signal,
    )
    return parseExaJson(response.body)
  }

  async function searchAnonymously(request: SourceRequest, signal: AbortSignal) {
    const query = request.queries[0] ?? ''
    const text = await callHostedTool(
      http,
      {
        source: ID,
        url: HOSTED_MCP_URL,
        tool: 'web_search_exa',
        args: {
          query,
          // The tool requires an objective; without a goal the query is the best statement of it.
          objective: objectiveWithHints(request.goal ?? query, request),
          numResults: Math.min(request.maxResults, MAX_RESULTS_PER_CALL),
        },
      },
      signal,
    )
    return parseExaText(text)
  }

  return {
    id: ID,
    free: () => apiKey === undefined,
    maxResultsPerCall: () => MAX_RESULTS_PER_CALL,
    nativeFilters: () => apiKey !== undefined,
    unitCostUsd: () => (apiKey === undefined ? 0 : UNIT_COST_USD),
    search: (request, signal) =>
      apiKey === undefined
        ? searchAnonymously(request, signal)
        : searchWithKey(request, apiKey, signal),
  }
}
