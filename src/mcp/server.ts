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
import { ajv, getSchema, parseContract } from '../shared/contracts.ts'

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
        : { valid: false, data: undefined, errorMessage: ajv.errorsText(validate.errors) }
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
  const server = new McpServer({ name: 'web-research-mcp', version: '0.1.0' })
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
        'Search free keyless sources. Use sites/exclude_domains for strict domain filtering. evidence_mode=extract reads a bounded number of results and returns exact text excerpts with snapshot cursors. Relevance is lexical matching; confidence describes traceability, not truth. Search cursors read frozen candidates; repeat the same query/options.',
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
        'Fetch anonymous public HTML/text as readable Markdown or text. Supply url for a new fetch or cursor for an immutable saved snapshot, never both. max_chars counts Unicode code points. A nonempty next_cursor reads the next page. A search evidence snapshot_cursor opens the exact cited text; omitted format inherits a cursor format.',
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
