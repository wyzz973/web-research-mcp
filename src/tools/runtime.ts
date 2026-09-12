/** Shared application composition for MCP and local observation; each resource has one owner. */
import type { RuntimeConfiguration } from '../generated/config.ts'
import type { WebSearchOutput } from '../generated/websearch.output.ts'
import type { WebFetchOutput } from '../generated/webfetch.output.ts'
import { createCrawl4aiLoader, crawl4aiStatus } from '../fetch/crawl4ai.ts'
import { createFetchRouter } from '../fetch/router.ts'
import { createDocumentLoader } from '../fetch/index.ts'
import { createSearxngProvider } from '../search/searxng.ts'
import { createResilientProvider } from '../search/resilient.ts'
import { createSnapshotStore } from '../storage/index.ts'
import { createTraceStore } from '../storage/traces.ts'
import {
  createTraceRecorder,
  noOpTraceRecorder,
  type TraceRunOptions,
  type TraceStore,
} from '../shared/trace.ts'
import { createWebFetch } from './webfetch.ts'
import { createWebSearch } from './websearch.ts'

export function createResearchRuntime(config: RuntimeConfiguration) {
  let traces: TraceStore | undefined
  let traceStatus = 'disabled'
  if (config.observability?.enabled) {
    try {
      traces = createTraceStore({ directory: config.storage.directory })
      traceStatus = 'enabled'
    } catch {
      traceStatus = 'storage_unavailable'
    }
  }
  const tracer = traces
    ? createTraceRecorder({
        store: traces,
        captureContent: config.observability?.capture_content ?? false,
        onError: () => {
          traceStatus = 'storage_unavailable'
        },
      })
    : noOpTraceRecorder
  const provider =
    config.search.base_url && config.search.engine_allowlist.length
      ? createSearxngProvider({
          baseUrl: config.search.base_url,
          engines: config.search.engine_allowlist,
          timeoutMs: config.search.provider_timeout_ms,
          tracer,
        })
      : undefined
  const resilient = provider
    ? createResilientProvider(provider, {
        onEvent: (event) => tracer.event(`search.${event.type}`, event.outcome ?? 'ok', event),
      })
    : undefined
  const fetchOptions = {
    deadlineMs: config.fetch.deadline_ms,
    maxCompressedBytes: config.fetch.max_compressed_bytes,
    maxDecompressedBytes: config.fetch.max_decompressed_bytes,
    maxRedirects: config.fetch.max_redirects,
    globalConcurrency: config.fetch.global_concurrency,
    perHostConcurrency: config.fetch.per_host_concurrency,
    parserTimeoutMs: config.fetch.parser_timeout_ms,
    parserMemoryMb: config.fetch.parser_memory_mb,
    parserConcurrency: config.fetch.parser_worker_concurrency,
    userAgent: config.fetch.user_agent,
    tracer,
  }
  const browser = createCrawl4aiLoader({
    ...fetchOptions,
    deadlineMs: config.fetch.crawl4ai.deadline_ms,
    enabled: config.fetch.crawl4ai.enabled,
    waitMs: config.fetch.crawl4ai.wait_ms,
    concurrency: config.fetch.crawl4ai.concurrency,
  })
  const loader = createFetchRouter(createDocumentLoader(fetchOptions), browser, {
    defaultEngine: config.fetch.default_engine,
    allowFallback: config.fetch.browser_fallback,
    tracer,
  })

  const store = createSnapshotStore({
    directory: config.storage.directory,
    ttlSeconds: config.storage.snapshot_ttl_seconds,
    maxBytes: config.storage.max_bytes,
  })
  const search = createWebSearch(config, resilient, loader, store, tracer)
  const fetch = createWebFetch(config, loader, store, tracer)
  function observed<T extends WebSearchOutput | WebFetchOutput>(
    name: string,
    fn: (input: unknown, signal: AbortSignal) => Promise<T>,
  ) {
    return (input: unknown, signal: AbortSignal, options?: TraceRunOptions): Promise<T> =>
      tracer.run(
        name,
        input,
        async () => {
          const output = await fn(input, signal)
          const common = {
            status: output.status,
            request_id: output.request_id,
            error: output.error,
            warnings: output.warnings.slice(0, 3).map((w) => w.slice(0, 160)),
          }
          tracer.annotate(
            'results' in output
              ? {
                  ...common,
                  result_count: output.results.length,
                  evidence_summary: output.evidence_summary,
                  source_previews: output.results.slice(0, 2).map((row) => ({
                    source_id: row.source_id,
                    url: row.url,
                    title: row.title.slice(0, 120),
                    evidence_status: row.evidence_status,
                    quote: row.evidence[0]?.quote.slice(0, 300) ?? null,
                  })),
                  has_more_results: Boolean(output.next_cursor),
                }
              : {
                  ...common,
                  view: output.view,
                  snapshot_id: output.snapshot_id,
                  content_sha256: output.content_sha256,
                  content_chars: Array.from(output.content ?? '').length,
                  content_preview: output.content?.slice(0, 900),
                  has_more: Boolean(output.next_cursor),
                },
          )
          const traceId = tracer.currentTraceId()
          return traceId ? { ...output, trace_id: traceId } : output
        },
        options,
      )
  }
  let closing: Promise<void> | undefined
  return {
    provider,
    crawl4ai: () => ({
      ...crawl4aiStatus(),
      enabled: config.fetch.crawl4ai.enabled,
      default_engine: config.fetch.default_engine,
    }),
    resilient,
    traces,
    get traceStatus() {
      return traceStatus
    },
    websearch: observed('websearch', search),
    webfetch: observed('webfetch', fetch),
    close(): Promise<void> {
      closing ??= (async () => {
        const outcomes = await Promise.allSettled([
          loader.close(),
          resilient?.close() ?? Promise.resolve(),
        ])
        try {
          store.close()
        } finally {
          traces?.close()
        }
        const errors = outcomes.filter(
          (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
        )
        if (errors.length)
          throw new AggregateError(
            errors.map((outcome) => outcome.reason),
            'Runtime shutdown failed.',
          )
      })()
      return closing
    },
  }
}
