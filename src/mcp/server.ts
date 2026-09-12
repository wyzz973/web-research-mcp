/** MCP protocol adapter. Business handlers remain usable without an SDK dependency. */
import {
  fromJsonSchema,
  McpServer,
  type JsonSchemaType,
  type JsonSchemaValidator,
  type JSONObject,
} from '@modelcontextprotocol/server'
import type { WebSearchInput } from '../generated/websearch.input.ts'
import type { WebSearchOutput } from '../generated/websearch.output.ts'
import type { WebFetchInput } from '../generated/webfetch.input.ts'
import type { WebFetchOutput } from '../generated/webfetch.output.ts'
import { ajv, getSchema, parseContract, validationMessage } from '../shared/contracts.ts'

export interface ToolHandlers {
  websearch(args: unknown, signal: AbortSignal): Promise<WebSearchOutput>
  webfetch(args: unknown, signal: AbortSignal): Promise<WebFetchOutput>
}

const validator = {
  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    const validate = ajv.compile<T>(schema)
    return (value) =>
      validate(value)
        ? { valid: true, data: value, errorMessage: undefined }
        : {
            valid: false,
            data: undefined,
            errorMessage: validationMessage(schema.title, value, validate.errors),
          }
  },
}

function schema<T>(name: string) {
  // Author schemas are parsed and compiled by Ajv; SDK's type adds its known object-root marker.
  return fromJsonSchema<T>(getSchema(name) as JsonSchemaType, validator)
}

/** Return the same validated content for structured and text-only clients. */
function response(name: string, value: WebSearchOutput | WebFetchOutput) {
  parseContract(name, value)
  const text = JSON.stringify(value)
  const structuredContent = JSON.parse(text) as JSONObject
  return {
    resultType: 'complete' as const,
    isError: value.status === 'error',
    content: [{ type: 'text' as const, text }],
    structuredContent,
  }
}

export function createMcpServer(handlers: ToolHandlers, lifetime: AbortSignal): McpServer {
  const server = new McpServer({ name: 'web-research-mcp', version: '0.5.0' })
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  }
  server.registerTool(
    'websearch',
    {
      title: 'Search public web sources',
      description:
        'Search free keyless sources. Use sites/exclude_domains for strict domain filtering. evidence_mode=extract reads a bounded number of results (optional fetch_engine=static|crawl4ai|auto) and returns paragraph-level excerpts, source_metadata for display, and snapshot cursors. Use next_evidence_cursor with webfetch to read more related evidence. Relevance is lexical matching; confidence describes traceability, not truth. ranking_mode optionally reranks the frozen title/snippet pool with bm25 or bm25_mmr; default upstream order is preserved. Ranking scores are not probabilities. Search cursors read frozen candidates; repeat the same query/options.',
      inputSchema: schema<WebSearchInput>('websearch.input'),
      outputSchema: schema<WebSearchOutput>('websearch.output'),
      annotations,
    },
    async (args, context) =>
      response(
        'websearch.output',
        await handlers.websearch(args, AbortSignal.any([context.mcpReq.signal, lifetime])),
      ),
  )
  server.registerTool(
    'webfetch',
    {
      title: 'Read a public page or saved snapshot',
      description:
        'Fetch anonymous public HTML/text as readable Markdown or text. engine=crawl4ai uses a protected local Chromium renderer; auto tries it after static extraction fails or yields very short HTML text. Browser rendering requires local setup and respects network/robots rules. Omit engine for cursor reads. Supply url for a new fetch or cursor for an immutable saved snapshot, never both. max_chars counts Unicode code points. A nonempty next_cursor reads the next page. A search snapshot_cursor opens the full cited text; next_evidence_cursor opens a non-contiguous evidence view with more related paragraphs. The response view identifies document versus evidence. Omitted format inherits a cursor format.',
      inputSchema: schema<WebFetchInput>('webfetch.input'),
      outputSchema: schema<WebFetchOutput>('webfetch.output'),
      annotations,
    },
    async (args, context) =>
      response(
        'webfetch.output',
        await handlers.webfetch(args, AbortSignal.any([context.mcpReq.signal, lifetime])),
      ),
  )
  return server
}
