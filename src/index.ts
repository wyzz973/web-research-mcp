/** Library entry. MCP and CLI are thin shells over the same object. */
import { databasePath, loadConfig, type Config } from './config.ts'
import type { FetchRequest, FetchResult, SearchRequest, SearchResult, Store } from './contract.ts'
import { createReader } from './fetch/index.ts'
import { createSearcher } from './search/index.ts'
import { createSqliteStore } from './store/sqlite.ts'

export type * from './contract.ts'
export type { Config } from './config.ts'
export { loadConfig } from './config.ts'
export { renderFetch, renderSearch } from './render/text.ts'

export interface WebResearch {
  readonly config: Config
  readonly store: Store
  /** Broad web search. Never throws: failures are reported in the result. */
  search(request: SearchRequest, signal?: AbortSignal): Promise<SearchResult>
  /** Read pages verbatim and find evidence. Never throws: failures are reported in the result. */
  fetch(request: FetchRequest, signal?: AbortSignal): Promise<FetchResult>
  close(): Promise<void>
}

export interface WebResearchOptions {
  config?: Config
  /** SQLite file path, or ":memory:". Defaults to the per-user data directory. */
  storePath?: string
}

export async function createWebResearch(options: WebResearchOptions = {}): Promise<WebResearch> {
  const config = options.config ?? loadConfig()
  const store = await createSqliteStore(options.storePath ?? databasePath(config))
  const searcher = createSearcher({ config, store })
  const reader = createReader({ config, store })
  const never = new AbortController().signal
  let closed = false
  return {
    config,
    store,
    search: (request, signal) => searcher.search(request, signal ?? never),
    fetch: (request, signal) => reader.fetch(request, signal ?? never),
    async close() {
      if (closed) return
      closed = true
      await Promise.allSettled([searcher.close(), reader.close()])
      store.close()
    },
  }
}
