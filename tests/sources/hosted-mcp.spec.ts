import { describe, expect, it } from 'vitest'
import type { ApiHttp } from '../../src/net/api-http.ts'
import { callHostedTool, sseEventData } from '../../src/sources/hosted-mcp.ts'
import { failure, never, scriptedHttp, toolResult } from './helpers.ts'

const call = {
  source: 'exa',
  url: 'https://mcp.example.test/mcp',
  tool: 'web_search_exa',
  args: { query: 'q' },
}

describe('callHostedTool', () => {
  it('posts one stateless JSON-RPC tools/call and accepts both response encodings', async () => {
    const { http, requests } = scriptedHttp(() => ({ body: toolResult('hello') }))
    expect(await callHostedTool(http, call, never)).toBe('hello')
    expect(requests[0]).toMatchObject({
      url: call.url,
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream' },
      json: {
        jsonrpc: '2.0',
        method: 'tools/call',
        params: { name: 'web_search_exa', arguments: { query: 'q' } },
      },
    })
  })

  it('takes the JSON-RPC response from an event stream, skipping notifications', async () => {
    const progress = JSON.stringify({ jsonrpc: '2.0', method: 'notifications/progress' })
    const body = `event: message\ndata: ${progress}\n\nevent: message\r\ndata: ${toolResult('from stream')}\r\n\r\n`
    const { http } = scriptedHttp(() => ({ contentType: 'text/event-stream', body }))
    expect(await callHostedTool(http, call, never)).toBe('from stream')
  })

  it('tells the HTTP layer which event completes the answer, and parses that event only once', async () => {
    const seen: boolean[] = []
    const streaming: ApiHttp = (request) => {
      const progress = 'data: {"jsonrpc":"2.0","method":"notifications/progress"}'
      seen.push(request.streamComplete?.(progress) ?? false)
      seen.push(
        request.streamComplete?.(`event: message\ndata: ${toolResult('streamed')}`) ?? false,
      )
      // The body is deliberately useless: the answer must come from the event seen above.
      return Promise.resolve({ status: 200, contentType: 'text/event-stream', body: '' })
    }
    expect(await callHostedTool(streaming, call, never)).toBe('streamed')
    expect(seen).toEqual([false, true])
  })

  it('joins several text blocks', async () => {
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        content: [
          { type: 'text', text: 'a' },
          { type: 'image', data: '...' },
          { type: 'text', text: 'b' },
        ],
      },
    })
    const { http } = scriptedHttp(() => ({ body }))
    expect(await callHostedTool(http, call, never)).toBe('a\nb')
  })

  it('classifies a tool error without echoing the vendor text', async () => {
    const vendorText = 'You have hit the free MCP rate limit. Create an API key at example.test.'
    const { http } = scriptedHttp(() => ({ body: toolResult(vendorText, true) }))
    const error = await failure(callHostedTool(http, call, never))
    expect(error.code).toBe('rate_limited')
    expect(error.message).not.toContain('example.test')
  })

  it('classifies JSON-RPC errors', async () => {
    const rpcError = (message: string) =>
      JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32000, message } })
    const denied = scriptedHttp(() => ({ body: rpcError('Unauthorized') }))
    expect((await failure(callHostedTool(denied.http, call, never))).code).toBe('blocked')
    const broken = scriptedHttp(() => ({ body: rpcError('Invalid params') }))
    expect((await failure(callHostedTool(broken.http, call, never))).code).toBe('upstream_error')
  })

  it('reports a body without a JSON-RPC response as parse_failed', async () => {
    const html = scriptedHttp(() => ({ contentType: 'text/html', body: '<html>gateway</html>' }))
    expect((await failure(callHostedTool(html.http, call, never))).code).toBe('parse_failed')
    const empty = scriptedHttp(() => ({ contentType: 'text/event-stream', body: ': ping\n\n' }))
    expect((await failure(callHostedTool(empty.http, call, never))).code).toBe('parse_failed')
  })
})

describe('sseEventData', () => {
  it('joins multi-line data and ignores comments and other fields', () => {
    expect(sseEventData(': hi\nid: 1\ndata: {"a":\ndata: 1}\n\ndata:second\n\n')).toEqual([
      '{"a":\n1}',
      'second',
    ])
  })
})
