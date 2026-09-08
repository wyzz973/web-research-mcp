/** Startup configuration: explicit merge, fixed policies, and no ambient reads during execution. */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { homedir } from 'node:os'
import type { RuntimeConfiguration } from '../generated/config.ts'
import { parseContract } from './contracts.ts'
import { AppError } from './errors.ts'
import { KEYLESS_ENGINES, validSearchEndpoint } from './search-policy.ts'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function merge(base: unknown, patch: unknown): unknown {
  if (!record(base) || !record(patch)) return patch
  const result: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key))
      throw new AppError('INVALID_ARGUMENT', 'Invalid configuration key.')
    result[key] = key in base ? merge(base[key], value) : value
  }
  return result
}

/** Resolve config once; explicitly passed environment is never forwarded to providers. */
export function loadConfiguration(
  filename?: string,
  environment: NodeJS.ProcessEnv = {},
): RuntimeConfiguration {
  const base: unknown = JSON.parse(
    readFileSync(new URL('../../config/defaults.example.json', import.meta.url), 'utf8'),
  )
  const override: unknown = filename ? JSON.parse(readFileSync(filename, 'utf8')) : {}
  if (!record(override))
    throw new AppError('INVALID_ARGUMENT', 'Configuration must be a JSON object.')
  const config = parseContract<RuntimeConfiguration>('config', merge(base, override))
  if (environment.SEARXNG_URL) config.search.base_url = environment.SEARXNG_URL
  if (environment.SEARXNG_ENGINES)
    config.search.engine_allowlist = environment.SEARXNG_ENGINES.split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  if (config.search.base_url !== null && !validSearchEndpoint(config.search.base_url))
    throw new AppError(
      'INVALID_ARGUMENT',
      'SEARXNG_URL must be an HTTP(S) endpoint without credentials, query, or fragment.',
    )
  if (
    config.search.engine_allowlist.some(
      (engine) => !(KEYLESS_ENGINES as readonly string[]).includes(engine),
    )
  )
    throw new AppError(
      'INVALID_ARGUMENT',
      'Only the fixed anonymous search engine allowlist is supported.',
    )
  config.storage.directory =
    environment.WEB_RESEARCH_DATA_DIR ??
    (filename && record(override.storage) && typeof override.storage.directory === 'string'
      ? path.resolve(path.dirname(path.resolve(filename)), override.storage.directory)
      : path.join(homedir(), '.local', 'share', 'web-research-mcp'))
  if (
    config.fetch.max_chars > config.fetch.max_output_chars ||
    config.search.evidence.default_max_results > config.search.evidence.max_results
  ) {
    throw new AppError(
      'INVALID_ARGUMENT',
      'Default output/evidence budget exceeds its deployment maximum.',
    )
  }
  return parseContract<RuntimeConfiguration>('config', config)
}
