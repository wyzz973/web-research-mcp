/**
 * One stateless `tools/call` against a vendor-hosted MCP endpoint. Exa and Parallel expose their
 * anonymous tiers this way; both answer a bare JSON-RPC POST without a session handshake.
 */
import { WebError } from '../errors.ts'
import type { ApiHttp } from '../net/api-http.ts'
import { isRecord, vendorFailure, type JsonRecord } from './shared.ts'

export interface HostedToolCall {
  /** Source id used in error messages. */
  source: string
  url: string
  tool: string
  args: JsonRecord
}

/** The `data:` payload of one event block. Multi-line data is joined with "\n". */
function eventData(block: string): string | undefined {
  const data = block
    .split(/\r\n?|\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /u, ''))
  return data.length ? data.join('\n') : undefined
}

/** `data:` payloads of every event in a body, in order. */
export function sseEventData(body: string): string[] {
  return body
    .split(/\r\n\r\n|\n\n|\r\r/u)
    .map(eventData)
    .filter((data) => data !== undefined)
}

function asRpcResponse(text: string | undefined): JsonRecord | undefined {
  if (text === undefined) return undefined
  try {
    const value = JSON.parse(text) as unknown
    return isRecord(value) && ('result' in value || 'error' in value) ? value : undefined
  } catch {
    return undefined
  }
}

/** The last event that carries a JSON-RPC response; progress notifications may precede it. */
function rpcResponseFromStream(body: string): JsonRecord | undefined {
  return sseEventData(body).map(asRpcResponse).findLast(Boolean)
}

function textContent(result: JsonRecord): string {
  const content = Array.isArray(result.content) ? result.content : []
  return content
    .filter((item): item is JsonRecord => isRecord(item) && item.type === 'text')
    .map((item) => (typeof item.text === 'string' ? item.text : ''))
    .join('\n')
}

function unwrap(response: JsonRecord, source: string): string {
  if (isRecord(response.error))
    throw vendorFailure(
      typeof response.error.message === 'string' ? response.error.message : '',
      source,
    )
  if (!isRecord(response.result))
    throw new WebError('parse_failed', `${source} returned a JSON-RPC message without a result.`)
  const text = textContent(response.result)
  if (response.result.isError === true) throw vendorFailure(text, source)
  return text
}

/** Returns the text content of the tool result. */
export async function callHostedTool(
  http: ApiHttp,
  call: HostedToolCall,
  signal: AbortSignal,
): Promise<string> {
  // A streaming transport hands over each event once; the answer is parsed there and only there.
  let streamed: JsonRecord | undefined
  const response = await http(
    {
      url: call.url,
      method: 'POST',
      headers: { accept: 'application/json, text/event-stream' },
      json: {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: call.tool, arguments: call.args },
      },
      streamComplete(eventBlock) {
        streamed = asRpcResponse(eventData(eventBlock))
        return streamed !== undefined
      },
    },
    signal,
  )
  const message =
    streamed ??
    (response.contentType === 'text/event-stream'
      ? rpcResponseFromStream(response.body)
      : asRpcResponse(response.body))
  if (!message) throw new WebError('parse_failed', `${call.source} returned no JSON-RPC response.`)
  return unwrap(message, call.source)
}
