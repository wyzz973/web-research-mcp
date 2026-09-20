/**
 * Tavily. One REST endpoint serves both tiers: a Bearer key, or the documented keyless mode
 * (`X-Tavily-Access-Mode: keyless`), which is free and rate limited per client.
 */
import { WebError } from '../errors.ts'
import type { ApiHttp } from '../net/api-http.ts'
import {
  cleanPassages,
  cleanTitle,
  isRecord,
  parseJson,
  toIsoDate,
  vendorFailure,
  type JsonRecord,
} from './shared.ts'
import type { SourceAdapter, SourceHit, SourceRequest } from './types.ts'

const ID = 'tavily'
const SEARCH_URL = 'https://api.tavily.com/search'
/** List price of one basic search (1 credit), checked 2026-09-20. */
const UNIT_COST_USD = 0.008
const MAX_RESULTS_PER_CALL = 20
/** 432: plan limit reached. 433: pay-as-you-go limit reached. */
const QUOTA_STATUSES = [432, 433] as const

export interface TavilyOptions {
  http: ApiHttp
  apiKey: string | undefined
}

function vendorMessage(payload: JsonRecord): string {
  const detail = isRecord(payload.detail) ? payload.detail.error : payload.detail
  return [detail, payload.error, payload.message]
    .filter((part): part is string => typeof part === 'string')
    .join(' ')
}

/** Parses the body of `POST /search`. */
export function parseTavilyJson(body: string): SourceHit[] {
  const payload = parseJson(body, ID)
  if (!isRecord(payload)) throw new WebError('parse_failed', 'tavily answered without an object.')
  // Keyless mode explains an exhausted allowance in prose inside a successful response.
  if (!Array.isArray(payload.results)) {
    const message = vendorMessage(payload)
    if (message) throw vendorFailure(message, ID)
    throw new WebError('parse_failed', 'tavily answered without a results list.')
  }
  return payload.results.filter(isRecord).flatMap((result) => {
    if (typeof result.url !== 'string') return []
    const published = toIsoDate(result.published_date)
    return [
      {
        url: result.url,
        title: cleanTitle(result.title),
        passages: cleanPassages([result.content]),
        ...(published ? { published } : {}),
      },
    ]
  })
}

function requestBody(request: SourceRequest): JsonRecord {
  return {
    query: request.queries[0] ?? '',
    search_depth: 'basic',
    max_results: Math.min(request.maxResults, MAX_RESULTS_PER_CALL),
    include_answer: false,
    include_raw_content: false,
    ...(request.sites.length ? { include_domains: request.sites } : {}),
    ...(request.recency ? { time_range: request.recency } : {}),
  }
}

export function createTavilySource(options: TavilyOptions): SourceAdapter {
  const { http, apiKey } = options
  const authorization: Record<string, string> =
    apiKey === undefined
      ? { 'x-tavily-access-mode': 'keyless' }
      : { authorization: `Bearer ${apiKey}` }

  return {
    id: ID,
    free: () => apiKey === undefined,
    maxResultsPerCall: () => MAX_RESULTS_PER_CALL,
    nativeFilters: () => true,
    unitCostUsd: () => (apiKey === undefined ? 0 : UNIT_COST_USD),
    async search(request, signal) {
      const response = await http(
        {
          url: SEARCH_URL,
          method: 'POST',
          headers: { ...authorization, accept: 'application/json' },
          json: requestBody(request),
          quotaStatuses: QUOTA_STATUSES,
        },
        signal,
      )
      return parseTavilyJson(response.body)
    },
  }
}
