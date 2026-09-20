import { readFileSync } from 'node:fs'
import { WebError } from '../../src/errors.ts'
import type { ApiHttp, ApiRequest, ApiResponse } from '../../src/net/api-http.ts'
import type { SourceRequest } from '../../src/sources/types.ts'

export const never = new AbortController().signal

export function fixture(name: string): string {
  return readFileSync(new URL(`../fixtures/sources/${name}`, import.meta.url), 'utf8')
}

/** An offline ApiHttp that records every request and answers from a script. */
export function scriptedHttp(answer: (request: ApiRequest) => Partial<ApiResponse> | WebError) {
  const requests: ApiRequest[] = []
  const http: ApiHttp = (request) => {
    requests.push(request)
    const result = answer(request)
    if (result instanceof WebError) return Promise.reject(result)
    return Promise.resolve({ status: 200, contentType: 'application/json', body: '', ...result })
  }
  return { http, requests }
}

/** The JSON-RPC envelope a hosted MCP endpoint wraps a tool result in. */
export function toolResult(text: string, isError = false): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    result: { content: [{ type: 'text', text }], isError },
  })
}

export function sourceRequest(overrides: Partial<SourceRequest> = {}): SourceRequest {
  return {
    queries: ['abort fetch timeout'],
    goal: undefined,
    sites: [],
    recency: undefined,
    maxResults: 15,
    now: new Date('2026-09-21T12:00:00Z'),
    ...overrides,
  }
}

export async function failure(promise: Promise<unknown>): Promise<WebError> {
  const error: unknown = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  )
  if (!(error instanceof WebError)) throw new Error('expected a WebError')
  return error
}

export function jsonBody(request: ApiRequest | undefined): Record<string, unknown> {
  return (request?.json ?? {}) as Record<string, unknown>
}
