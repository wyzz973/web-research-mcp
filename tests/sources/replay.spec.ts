/**
 * Replays of whole HTTP bodies recorded from the anonymous tiers on 2026-09-21. They pin the
 * live wire formats (SSE envelope, JSON-RPC envelope with structuredContent, keyless REST body),
 * so a parser change that would break against the real services fails here first.
 */
import { describe, expect, it } from 'vitest'
import { canonicalUrl } from '../../src/search/url.ts'
import { createExaSource } from '../../src/sources/exa.ts'
import { createParallelSource } from '../../src/sources/parallel.ts'
import { createTavilySource } from '../../src/sources/tavily.ts'
import type { SourceHit } from '../../src/sources/types.ts'
import { fixture, never, scriptedHttp, sourceRequest } from './helpers.ts'

function expectUsable(hits: SourceHit[]): void {
  for (const hit of hits) {
    expect(canonicalUrl(hit.url)).toBeDefined()
    expect(hit.title).not.toMatch(/\n/u)
    expect(hit.passages.length).toBeGreaterThan(0)
    expect(hit.passages.every((passage) => passage.trim() === passage && passage.length > 0)).toBe(
      true,
    )
    if (hit.published !== undefined) expect(hit.published).toMatch(/^\d{4}-\d{2}-\d{2}$/u)
  }
}

describe('recorded live answers', () => {
  it('Exa hosted MCP: event stream with one JSON-RPC result', async () => {
    const { http } = scriptedHttp(() => ({
      contentType: 'text/event-stream',
      body: fixture('exa-mcp-http-body.sse.txt'),
    }))
    const hits = await createExaSource({ http, apiKey: undefined }).search(sourceRequest(), never)
    expect(hits).toHaveLength(15)
    expect(hits[0]).toMatchObject({
      url: 'https://developer.mozilla.org/en-US/docs/Web/API/AbortSignal/timeout_static',
      title: 'AbortSignal: timeout() static method - Web APIs | MDN',
      published: '2026-09-01',
    })
    expect(hits.filter((hit) => hit.published)).toHaveLength(13)
    expectUsable(hits)
  })

  it('Parallel hosted MCP: JSON body whose text block is the search document', async () => {
    const { http } = scriptedHttp(() => ({ body: fixture('parallel-mcp-http-body.json') }))
    const hits = await createParallelSource({ http, apiKey: undefined }).search(
      sourceRequest(),
      never,
    )
    expect(hits).toHaveLength(10)
    expect(hits[0]?.url).toBe('https://developer.mozilla.org/de/docs/Web/API/AbortSignal')
    expect(hits.filter((hit) => hit.published)).toHaveLength(2)
    expectUsable(hits)
  })

  it('Tavily keyless: REST body', async () => {
    const { http } = scriptedHttp(() => ({ body: fixture('tavily-keyless-http-body.json') }))
    const hits = await createTavilySource({ http, apiKey: undefined }).search(
      sourceRequest(),
      never,
    )
    expect(hits).toHaveLength(15)
    expect(hits[0]?.url).toBe(
      'https://betterstack.com/community/guides/scaling-nodejs/understanding-abortcontroller',
    )
    expectUsable(hits)
  })
})
