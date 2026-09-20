/**
 * Parallel. With PARALLEL_API_KEY: the REST search API. Without a key: Parallel's public hosted
 * MCP endpoint, whose tool result is the same JSON document wrapped in a text block. One call
 * carries several queries, so a multi-query search costs a single request here.
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
  vendorFailure,
  type JsonRecord,
} from './shared.ts'
import type { SourceAdapter, SourceHit, SourceRequest } from './types.ts'

const ID = 'parallel'
const HOSTED_MCP_URL = 'https://search.parallel.ai/mcp'
const REST_URL = 'https://api.parallel.ai/v1/search'
/** List price of one "basic" search, checked 2026-09-20. The mode is pinned so the estimate holds. */
const UNIT_COST_USD = 0.005
const MODE = 'basic'
const MAX_QUERIES_PER_CALL = 5
const MAX_RESULTS_PER_CALL = 20
/** The hosted tool takes no result count and answers with ten. */
const HOSTED_RESULTS_PER_CALL = 10

export interface ParallelOptions {
  http: ApiHttp
  apiKey: string | undefined
}

/** Parses the search document: the REST body, or the text of the hosted `web_search` tool. */
export function parseParallelJson(text: string): SourceHit[] {
  const trimmed = text.trim()
  // The hosted tool reports problems as prose instead of JSON.
  if (!trimmed.startsWith('{')) throw vendorFailure(trimmed, ID)
  const payload = parseJson(trimmed, ID)
  if (!isRecord(payload) || !Array.isArray(payload.results))
    throw new WebError('parse_failed', 'parallel answered without a results list.')
  return payload.results.filter(isRecord).flatMap((result) => {
    if (typeof result.url !== 'string') return []
    const published = toIsoDate(result.publish_date)
    return [
      {
        url: result.url,
        title: cleanTitle(result.title),
        passages: cleanPassages(Array.isArray(result.excerpts) ? result.excerpts : []),
        ...(published ? { published } : {}),
      },
    ]
  })
}

function objectiveOf(request: SourceRequest): string {
  return request.goal ?? request.queries.join('; ')
}

function restBody(request: SourceRequest): JsonRecord {
  const sourcePolicy = {
    ...(request.sites.length ? { include_domains: request.sites } : {}),
    ...(request.recency
      ? { after_date: recencyStart(request.recency, request.now).toISOString().slice(0, 10) }
      : {}),
  }
  return {
    objective: objectiveOf(request),
    search_queries: request.queries,
    mode: MODE,
    advanced_settings: {
      max_results: Math.min(request.maxResults, MAX_RESULTS_PER_CALL),
      ...(Object.keys(sourcePolicy).length ? { source_policy: sourcePolicy } : {}),
    },
  }
}

export function createParallelSource(options: ParallelOptions): SourceAdapter {
  const { http, apiKey } = options

  async function searchWithKey(request: SourceRequest, key: string, signal: AbortSignal) {
    const response = await http(
      {
        url: REST_URL,
        method: 'POST',
        headers: { 'x-api-key': key, accept: 'application/json' },
        json: restBody(request),
        quotaStatuses: [402],
      },
      signal,
    )
    return parseParallelJson(response.body)
  }

  async function searchAnonymously(request: SourceRequest, signal: AbortSignal) {
    const text = await callHostedTool(
      http,
      {
        source: ID,
        url: HOSTED_MCP_URL,
        tool: 'web_search',
        args: {
          objective: objectiveWithHints(objectiveOf(request), request),
          search_queries: request.queries,
        },
      },
      signal,
    )
    return parseParallelJson(text)
  }

  return {
    id: ID,
    maxQueriesPerCall: MAX_QUERIES_PER_CALL,
    free: () => apiKey === undefined,
    maxResultsPerCall: () =>
      apiKey === undefined ? HOSTED_RESULTS_PER_CALL : MAX_RESULTS_PER_CALL,
    nativeFilters: () => apiKey !== undefined,
    unitCostUsd: () => (apiKey === undefined ? 0 : UNIT_COST_USD),
    search: (request, signal) =>
      apiKey === undefined
        ? searchAnonymously(request, signal)
        : searchWithKey(request, apiKey, signal),
  }
}
