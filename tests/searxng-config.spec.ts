import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('bundled keyless SearXNG deployment', () => {
  it('pins the image digest and only publishes on loopback', async () => {
    const compose = await readFile(new URL('../deploy/compose.yaml', import.meta.url), 'utf8')
    expect(compose).toContain(
      'searxng/searxng@sha256:3547509b419cd6a67333d6d68bd1ffad8d46d3669d82e7a7bd538f7b45827432',
    )
    expect(compose).toContain("'127.0.0.1:18888:8080'")
    expect(compose).not.toMatch(/network_mode:\s*host/u)
    expect(compose).not.toContain('0.0.0.0:')
    expect(compose).not.toContain(':latest')
  })
  it('keeps only explicit anonymous web adapters and has no committed secret', async () => {
    const template = await readFile(
      new URL('../deploy/settings.template.yaml', import.meta.url),
      'utf8',
    )
    const adapters = [...template.matchAll(/^\s+engine: (\S+)$/gmu)].map((match) => match[1])
    const keepOnly = template.match(/keep_only:([\s\S]+?)\n\n/u)?.[1]
    expect(adapters).toEqual(['duckduckgo', 'bing', 'google', 'brave'])
    expect(keepOnly?.match(/- (\S+)/gu)).toEqual(['- duckduckgo', '- bing', '- google', '- brave'])
    expect(template).toContain('brave_category: search')
    expect(template).toContain("secret_key: '__LOCAL_RANDOM_SECRET__'")
    expect(template).not.toMatch(/(?:api_key|api_token|access_token|password):/iu)
    expect(template).toContain('public_instance: false')
  })
  it('keeps generated secrets outside tracked deployment files', async () => {
    const [script, ignore] = await Promise.all([
      readFile(new URL('../scripts/searxng-setup.mjs', import.meta.url), 'utf8'),
      readFile(new URL('../.gitignore', import.meta.url), 'utf8'),
    ])
    expect(ignore).toMatch(/^\.cache\/$/mu)
    expect(script).toContain('randomBytes(32)')
    expect(script).toContain('0o600')
    expect(script).toContain('../.cache/searxng/')
  })
})
