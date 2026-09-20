/** The built-in sources. A source exists only when it can run: with its key, or anonymously. */
import type { Config } from '../config.ts'
import type { ApiHttp } from '../net/api-http.ts'
import { createExaSource } from './exa.ts'
import { createParallelSource } from './parallel.ts'
import { createTavilySource } from './tavily.ts'
import type { SourceAdapter } from './types.ts'

export type { SourceAdapter, SourceHit, SourceRequest } from './types.ts'

export function createDefaultSources(config: Config, http: ApiHttp): SourceAdapter[] {
  const { anonymous, exaApiKey, parallelApiKey, tavilyApiKey } = config.sources
  const sources: SourceAdapter[] = []
  if (exaApiKey || anonymous) sources.push(createExaSource({ http, apiKey: exaApiKey }))
  if (parallelApiKey || anonymous)
    sources.push(createParallelSource({ http, apiKey: parallelApiKey }))
  if (tavilyApiKey || anonymous) sources.push(createTavilySource({ http, apiKey: tavilyApiKey }))
  return sources
}
