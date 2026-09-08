import { describe, expect, it } from 'vitest'
import { canonicalUrl, matchesScope, resolveScope } from '../src/shared/domain-scope.ts'

describe('domain scope', () => {
  it('normalizes IDNA, root dots and duplicate names', () => {
    expect(resolveScope({ sites: ['例子.中国', 'XN--FSQU00A.XN--FIQS8S.'] }).sites).toEqual([
      'xn--fsqu00a.xn--fiqs8s',
    ])
  })
  it.each([
    'https://example.com',
    'example.com/path',
    'example.com:80',
    '*.example.com',
    'a@example.com',
    'localhost',
    'com',
    'co.uk',
    'github.io',
    '127.0.0.1',
    '127.1',
    '0x7f.1',
    'bad..com',
    '-bad.com',
  ])('rejects non-site %s', (site) => {
    expect(() => resolveScope({ sites: [site] })).toThrow()
  })
  it('checks label boundaries and exclusion priority', () => {
    const scope = resolveScope({ sites: ['example.com'], exclude_domains: ['private.example.com'] })
    expect(matchesScope('https://news.example.com/story', scope)).toBe(true)
    for (const value of [
      'https://evil-example.com',
      'https://example.com.evil.net',
      'https://private.example.com',
      'https://a.private.example.com',
      'https://example.com@evil.net',
      'file:///example.com',
    ]) {
      expect(matchesScope(value, scope)).toBe(false)
    }
  })
  it('applies exact matching to both includes and excludes', () => {
    const scope = resolveScope({ exclude_domains: ['example.com'], include_subdomains: false })
    expect(matchesScope('https://example.com', scope)).toBe(false)
    expect(matchesScope('https://news.example.com', scope)).toBe(true)
    expect(
      matchesScope(
        'https://news.example.com',
        resolveScope({ sites: ['example.com'], include_subdomains: false }),
      ),
    ).toBe(false)
  })
  it('rejects complete coverage and duplicate aliases, preserves partial overlap', () => {
    expect(() =>
      resolveScope({ sites: ['news.example.com'], exclude_domains: ['example.com'] }),
    ).toThrow()
    expect(() => resolveScope({ sites: [], include_domains: [] })).toThrow()
    expect(
      resolveScope({ sites: ['example.com'], exclude_domains: ['news.example.com'] }).sites,
    ).toEqual(['example.com'])
    expect(
      resolveScope({ sites: ['example.com', 'other.com'], exclude_domains: ['example.com'] }).sites,
    ).toHaveLength(2)
  })
  it('removes only fragment and known tracking while retaining encoding, order, and duplicate semantic parameters', () => {
    expect(
      canonicalUrl('https://EXAMPLE.com:443/a?b=2&x=%20&x=+&ref=semantic&utm_source=ad&a=1#top'),
    ).toBe('https://example.com/a?b=2&x=%20&x=+&ref=semantic&a=1')
    expect(canonicalUrl('https://example.com/?utm_custom=semantic')).toBe(
      'https://example.com/?utm_custom=semantic',
    )
  })
})
