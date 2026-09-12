import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfiguration } from '../src/shared/config.ts'

const directories: string[] = []

function configFile(value: unknown): string {
  const directory = mkdtempSync(join(tmpdir(), 'web-research-config-'))
  directories.push(directory)
  const filename = join(directory, 'settings.json')
  writeFileSync(filename, JSON.stringify(value))
  return filename
}

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('configuration admission at startup', () => {
  it.each([
    'not-a-url',
    'file:///etc/passwd',
    'ftp://example.org/',
    'https://user:password@example.org/',
    'https://example.org/?key=value',
    'https://example.org/#fragment',
  ])('rejects invalid search URL %s even when no engines are configured', (value) => {
    expect(() => loadConfiguration(undefined, { SEARXNG_URL: value })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    )
    expect(() => loadConfiguration(configFile({ search: { base_url: value } }))).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    )
  })

  it.each([
    'braveapi',
    'google api',
    'bing_api',
    'duckduckgo,tavily',
    'unknown',
    'duckduckgo,duckduckgo',
  ])('rejects unapproved or duplicate engines %s even without a search URL', (engines) => {
    expect(() => loadConfiguration(undefined, { SEARXNG_ENGINES: engines })).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    )
  })

  it.each([
    { unknown: true },
    { search: { typo: 'ignored?' } },
    { search: { upstream_policy: { allow_keyed_fallback: true } } },
    { search: { upstream_policy: { requires_account: true } } },
    { search: { upstream_policy: { allow_paid_proxy_dependency: true } } },
    { fetch: { public_urls_only: false } },
    { fetch: { crawl4ai: { concurrency: 3 } } },
  ])('rejects unknown fields and weakened fixed policies %j', (override) => {
    expect(() => loadConfiguration(configFile(override))).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    )
  })

  it('accepts a valid endpoint without engines so startup can expose fetch-only tools', () => {
    const config = loadConfiguration(undefined, { SEARXNG_URL: 'http://127.0.0.1:8080/' })
    expect(config.search.base_url).toBe('http://127.0.0.1:8080/')
    expect(config.search.engine_allowlist).toEqual([])
    expect(loadConfiguration().search.base_url).toBeNull()
  })

  it('accepts the explicit keyless allowlist without requiring a configured endpoint', () => {
    const config = loadConfiguration(undefined, { SEARXNG_ENGINES: ' duckduckgo, bing ' })
    expect(config.search.engine_allowlist).toEqual(['duckduckgo', 'bing'])
    expect(config.search.base_url).toBeNull()
  })

  it('resolves relative data directories against the config location and gives explicit environment precedence', () => {
    const filename = configFile({ storage: { directory: 'private-data' } })
    expect(loadConfiguration(filename).storage.directory).toBe(join(filename, '..', 'private-data'))
    const explicit = join(tmpdir(), 'explicit-web-research-data')
    expect(loadConfiguration(filename, { WEB_RESEARCH_DATA_DIR: explicit }).storage.directory).toBe(
      explicit,
    )
  })

  it('rejects prototype keys from parsed external JSON without mutating built-in prototypes', () => {
    const override: unknown = JSON.parse('{"search":{"__proto__":{"polluted":true}}}')
    expect(() => loadConfiguration(configFile(override))).toThrow(
      expect.objectContaining({ code: 'INVALID_ARGUMENT' }),
    )
    expect(Object.prototype).not.toHaveProperty('polluted')
  })

  it('rejects defaults that exceed deployment output or evidence limits', () => {
    expect(() =>
      loadConfiguration(configFile({ fetch: { max_chars: 2000, max_output_chars: 1000 } })),
    ).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
    expect(() =>
      loadConfiguration(
        configFile({ search: { evidence: { default_max_results: 3, max_results: 1 } } }),
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_ARGUMENT' }))
  })
})
