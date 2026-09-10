/** Shared application composition for local MCP and the acceptance workbench. */
import type { RuntimeConfiguration } from '../generated/config.ts'
import { createDocumentLoader } from '../fetch/index.ts'
import { createSearxngProvider } from '../search/searxng.ts'
import { createSnapshotStore } from '../storage/index.ts'
import { createWebFetch } from './webfetch.ts'
import { createWebSearch } from './websearch.ts'

export function createResearchRuntime(config: RuntimeConfiguration) {
  const provider =
    config.search.base_url && config.search.engine_allowlist.length
      ? createSearxngProvider({
          baseUrl: config.search.base_url,
          engines: config.search.engine_allowlist,
          timeoutMs: config.search.provider_timeout_ms,
        })
      : undefined
  const loader = createDocumentLoader({
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
  })
  const store = createSnapshotStore({
    directory: config.storage.directory,
    ttlSeconds: config.storage.snapshot_ttl_seconds,
    maxBytes: config.storage.max_bytes,
  })
  let closing: Promise<void> | undefined
  return {
    provider,
    websearch: createWebSearch(config, provider, loader, store),
    webfetch: createWebFetch(config, loader, store),
    close(): Promise<void> {
      closing ??= (async () => {
        const outcomes = await Promise.allSettled([
          loader.close(),
          provider?.close() ?? Promise.resolve(),
        ])
        store.close()
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
