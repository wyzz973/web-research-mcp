import { JSDOM } from 'jsdom'
import { describe, expect, it } from 'vitest'
import { extractSourceMetadata } from '../src/fetch/metadata.ts'
import { createSourceMetadata, safeMetadataUrl } from '../src/shared/source-metadata.ts'
import { parseContract } from '../src/shared/contracts.ts'

function metadata(head: string, language = 'zh-CN') {
  const dom = new JSDOM(`<html lang="${language}"><head>${head}</head><body></body></html>`, {
    url: 'https://docs.example.co.uk/start/page',
  })
  try {
    const result = extractSourceMetadata(
      dom.window.document,
      'https://docs.example.co.uk/start/page',
    )
    return parseContract<typeof result>('source-metadata', result)
  } finally {
    dom.window.close()
  }
}

describe('source display metadata', () => {
  it('bounds frontend display text in code points without splitting emoji', () => {
    const result = metadata(`<meta property="og:site_name" content="${'🙂'.repeat(301)}">`)
    expect(result.site_name).toBe('🙂'.repeat(300))
  })
  it('preserves long actual source URLs while bounding optional page-declared asset URLs', () => {
    const sourceUrl = `https://example.com/start?value=${'a'.repeat(4200)}`
    const finalUrl = `https://docs.example.com/article?value=${'b'.repeat(4200)}`
    const result = createSourceMetadata(sourceUrl, finalUrl, '2026-09-09T00:00:00.000Z')
    expect(parseContract('source-metadata', result)).toEqual(result)
    expect(result.source_url).toBe(sourceUrl)
    expect(result.final_url).toBe(finalUrl)
    expect(result.metadata_url).toBe(finalUrl)
    expect(result.favicon_url).toBe('https://docs.example.com/favicon.ico')
    expect(safeMetadataUrl(finalUrl, sourceUrl)).toBeNull()
  })

  it('rejects impossible calendar days and ambiguous local times instead of inventing dates', () => {
    expect(metadata('<meta name="date" content="2026-02-30">').published_at).toBeNull()
    expect(metadata('<meta name="date" content="2026-09-09T08:00:00">').published_at).toBeNull()
    expect(metadata('<meta name="date" content="2024-02-29">').published_at).toBe(
      '2024-02-29T00:00:00.000Z',
    )
  })

  it('keeps request, observed URL and declared canonical separate, with explicit fallback provenance', () => {
    const result = createSourceMetadata(
      'https://example.com/start',
      'https://docs.example.co.uk/article?part=2',
      '2026-09-09T00:00:00.000Z',
    )
    expect(result).toMatchObject({
      source_url: 'https://example.com/start',
      final_url: 'https://docs.example.co.uk/article?part=2',
      canonical_url: null,
      hostname: 'docs.example.co.uk',
      domain: 'example.co.uk',
      origin: 'https://docs.example.co.uk',
      display_url: 'docs.example.co.uk/article?part=2',
      site_name: 'docs.example.co.uk',
      favicon_url: 'https://docs.example.co.uk/favicon.ico',
      logo_url: null,
      metadata_source: 'url_only',
      metadata_url: 'https://docs.example.co.uk/article?part=2',
      assets_verified: false,
      provenance: { favicon_url: 'origin_fallback', site_name: 'hostname', logo_url: 'none' },
    })
    expect(parseContract('source-metadata', result)).toEqual(result)
    expect(createSourceMetadata('https://example.com')).toMatchObject({
      final_url: null,
      retrieved_at: null,
      metadata_url: null,
    })
  })

  it('extracts declarations before article mutation and resolves relative assets against document base', () => {
    const result = metadata(`
      <base href="https://assets.example.org/library/">
      <meta property="og:site_name" content="Evidence &amp; Research">
      <meta name="application-name" content="Lower precedence">
      <meta name="description" content="Plain description">
      <meta property="og:description" content="A reliable public article.">
      <meta property="og:image" content="../preview.png">
      <meta property="article:published_time" content="2026-09-08T08:30:00+08:00">
      <meta property="article:modified_time" content="2026-09-09T00:00:00Z">
      <link rel="canonical" href="https://example.co.uk/official">
      <link rel="apple-touch-icon" href="apple.png">
      <link rel="shortcut icon" href="icon.svg">
      <script type="application/ld+json">{"@graph":[{"@type":"WebSite","logo":{"@type":"ImageObject","contentUrl":"brand.png"}}]}</script>
    `)
    expect(result).toMatchObject({
      source_url: 'https://docs.example.co.uk/start/page',
      final_url: 'https://docs.example.co.uk/start/page',
      metadata_url: 'https://docs.example.co.uk/start/page',
      canonical_url: 'https://example.co.uk/official',
      site_name: 'Evidence & Research',
      description: 'A reliable public article.',
      language: 'zh-CN',
      favicon_url: 'https://assets.example.org/library/icon.svg',
      logo_url: 'https://assets.example.org/library/brand.png',
      image_url: 'https://assets.example.org/preview.png',
      published_at: '2026-09-08T00:30:00.000Z',
      modified_at: '2026-09-09T00:00:00.000Z',
      assets_verified: false,
      metadata_source: 'html',
      provenance: {
        site_name: 'opengraph',
        favicon_url: 'html_link',
        logo_url: 'json_ld',
        image_url: 'opengraph',
        canonical_url: 'html_link',
      },
    })
  })

  it('does not call preview images logos, and uses application name or hostname when needed', () => {
    expect(metadata('<meta property="og:image" content="/preview.jpg">')).toMatchObject({
      logo_url: null,
      image_url: 'https://docs.example.co.uk/preview.jpg',
      provenance: { logo_url: 'none', site_name: 'hostname' },
    })
    expect(
      metadata(
        '<meta name="application-name" content="Public Docs"><link rel="apple-touch-icon" href="/apple.png">',
      ),
    ).toMatchObject({
      site_name: 'Public Docs',
      favicon_url: 'https://docs.example.co.uk/apple.png',
      provenance: { site_name: 'application_name', favicon_url: 'html_link' },
    })
  })

  it('drops executable, credential and private-host metadata without losing safe fallback', () => {
    expect(
      metadata(`
      <link rel="icon" href="data:image/svg+xml,evil">
      <link rel="canonical" href="http://127.1/private">
      <meta property="og:image" content="http://user:password@cdn.example.org/image.png">
      <script type="application/ld+json">{"@type":"Organization","logo":"http://localhost/private"}</script>
    `),
    ).toMatchObject({
      canonical_url: null,
      image_url: null,
      logo_url: null,
      favicon_url: 'https://docs.example.co.uk/favicon.ico',
      assets_verified: false,
      provenance: { canonical_url: 'none', favicon_url: 'origin_fallback' },
    })
  })

  it('tolerates malformed, oversized and deeply nested JSON-LD and accepts a later bounded declaration', () => {
    const result = metadata(`
      <script type="application/ld+json">{broken</script>
      <script type="application/ld+json">${JSON.stringify({ '@type': 'Organization', logo: `/${'a'.repeat(65_000)}` })}</script>
      <script type="application/ld+json">${'['.repeat(20)}{"@type":"Organization","logo":"/too-deep.png"}${']'.repeat(20)}</script>
      <script type="application/ld+json">{"@type":["Thing","https://schema.org/Organization"],"logo":{"url":"/correct.svg"}}</script>
    `)
    expect(result.logo_url).toBe('https://docs.example.co.uk/correct.svg')
  })

  it('does not present a mentioned third-party organization as the site logo', () => {
    expect(
      metadata(`<script type="application/ld+json">{
      "@type":"Article",
      "mentions":{"@type":"Organization","logo":"https://other.example.org/brand.png"},
      "about":{"@type":"Organization","logo":"/also-not-site.png"}
    }</script>`).logo_url,
    ).toBeNull()
  })

  it('takes the explicit site publisher logo ahead of a generic top-level organization', () => {
    expect(
      metadata(`<script type="application/ld+json">{"@graph":[
      {"@type":"Organization","logo":"/generic.png"},
      {"@type":"Article","url":"https://docs.example.co.uk/start/page",
       "publisher":{"@type":"Organization","url":"https://docs.example.co.uk/","logo":"/publisher.svg"},
       "mentions":{"@type":"Organization","logo":"/unrelated.png"}}
    ]}</script>`).logo_url,
    ).toBe('https://docs.example.co.uk/publisher.svg')
  })

  it('rejects cross-origin organization identities and prefers a site declaration in stable document order', () => {
    expect(
      metadata(`<script type="application/ld+json">[
      {"@type":"Organization","url":"https://other.example.org/","logo":"/wrong-origin.png"},
      {"@type":"Organization","@id":"https://other.example.org/#org","logo":"/wrong-id.png"}
    ]</script>`).logo_url,
    ).toBeNull()
    expect(
      metadata(`<script type="application/ld+json">{"@graph":[
      {"@type":"Article","publisher":{"@type":"Organization","logo":"/publisher.png"}},
      {"@type":"WebSite","@id":"https://docs.example.co.uk/#website","logo":"/site-first.png"},
      {"@type":"WebSite","logo":"/site-second.png"}
    ]}</script>`).logo_url,
    ).toBe('https://docs.example.co.uk/site-first.png')
  })

  it('bounds text declarations, strips markup, ignores invalid dates and never executes JSON-LD', () => {
    const result = metadata(
      `
      <meta property="og:site_name" content="&lt;script&gt;name&lt;/script&gt; ${'x'.repeat(400)}">
      <meta name="description" content="${'d'.repeat(1500)}">
      <meta name="date" content="yesterday">
      <script type="application/ld+json">globalThis.fetch('http://localhost');</script>
    `,
      'a'.repeat(100),
    )
    expect(result.site_name).toHaveLength(300)
    expect(result.site_name).not.toContain('<')
    expect(result.description).toHaveLength(1000)
    expect(result.language).toHaveLength(64)
    expect(result.published_at).toBeNull()
    expect(result.logo_url).toBeNull()
  })
})

describe('metadata URL filtering without network access', () => {
  it.each([
    'javascript:alert(1)',
    'data:image/png,aaa',
    'file:///etc/passwd',
    'http://user:password@example.com/icon',
    'http://localhost/icon',
    'http://a.localhost/icon',
    'http://printer.local/icon',
    'http://127.1/icon',
    'http://2130706433/icon',
    'http://0x7f000001/icon',
    'http://[::1]/icon',
    'http://[::ffff:127.0.0.1]/icon',
    'http://[fc00::1]/icon',
    'http://169.254.169.254/icon',
    'http://192.168.1.1/icon',
    'http://10.0.0.1/icon',
    'http://224.0.0.1/icon',
    'http://localhost./icon',
    'https://example.com/' + 'x'.repeat(4096),
  ])('does not expose an unsafe asset URL %s', (value) => {
    expect(safeMetadataUrl(value, 'https://example.com/page')).toBeNull()
  })

  it('allows actual external CDN declarations and public IP URLs without claiming verification', () => {
    expect(safeMetadataUrl('//cdn.example.net/logo.svg', 'https://example.com/page')).toBe(
      'https://cdn.example.net/logo.svg',
    )
    expect(safeMetadataUrl('https://8.8.8.8/logo.png', 'https://example.com')).toBe(
      'https://8.8.8.8/logo.png',
    )
  })
})
