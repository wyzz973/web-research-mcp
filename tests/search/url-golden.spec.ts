/**
 * Golden table for URL identity. `same` pairs must collapse into one result; `different` pairs
 * must stay apart. Every row is a case that a result list has actually contained; add a row
 * before changing `canonicalUrl` or `dedupeKey`.
 */
import { describe, expect, it } from 'vitest'
import { canonicalUrl, dedupeKey } from '../../src/search/url.ts'

function keyOf(raw: string): string {
  const canonical = canonicalUrl(raw)
  if (!canonical) throw new Error(`not a usable URL: ${raw}`)
  return dedupeKey(canonical)
}

const same: ReadonlyArray<[why: string, a: string, b: string]> = [
  ['trailing slash', 'https://example.com/docs/', 'https://example.com/docs'],
  ['root with and without slash', 'https://example.com/', 'https://example.com'],
  ['repeated trailing slashes', 'https://example.com/docs///', 'https://example.com/docs'],
  ['host case', 'https://EXAMPLE.com/Docs', 'https://example.com/Docs'],
  ['scheme case', 'HTTPS://example.com/a', 'https://example.com/a'],
  ['http and https', 'http://example.com/a', 'https://example.com/a'],
  ['www', 'https://www.example.com/a', 'https://example.com/a'],
  ['default https port', 'https://example.com:443/a', 'https://example.com/a'],
  ['default http port', 'http://example.com:80/a', 'http://example.com/a'],
  ['trailing dot on the host', 'https://example.com./a', 'https://example.com/a'],
  ['fragment', 'https://example.com/a#install', 'https://example.com/a'],
  ['text fragment', 'https://example.com/a#:~:text=quoted%20words', 'https://example.com/a'],
  ['credentials', 'https://user:secret@example.com/a', 'https://example.com/a'],
  ['IDN and its punycode', 'https://例え.jp/ページ', 'https://xn--r8jz45g.jp/ページ'],
  ['IDN host case', 'https://BÜCHER.example/a', 'https://xn--bcher-kva.example/a'],
  ['mobile subdomain', 'https://m.example.com/story/1', 'https://example.com/story/1'],
  [
    'mobile Wikipedia',
    'https://en.m.wikipedia.org/wiki/SQLite',
    'https://en.wikipedia.org/wiki/SQLite',
  ],
  ['mobile. subdomain', 'https://mobile.example.com/a', 'https://www.example.com/a'],
  [
    'utm parameters',
    'https://example.com/a?utm_source=hn&utm_medium=social',
    'https://example.com/a',
  ],
  [
    'utm next to a real parameter',
    'https://example.com/a?id=7&utm_campaign=x',
    'https://example.com/a?id=7',
  ],
  ['click ids', 'https://example.com/a?fbclid=abc&gclid=def&msclkid=ghi', 'https://example.com/a'],
  ['Google merchant id', 'https://example.com/p/1?srsltid=AfmBOo', 'https://example.com/p/1'],
  ['tracking parameter case', 'https://example.com/a?UTM_Source=x', 'https://example.com/a'],
  ['parameter order', 'https://example.com/s?b=2&a=1', 'https://example.com/s?a=1&b=2'],
  ['empty query', 'https://example.com/a?', 'https://example.com/a'],
  ['escape case', 'https://example.com/a%2fb', 'https://example.com/a%2Fb'],
  ['escaped unreserved character', 'https://example.com/%7Euser/', 'https://example.com/~user'],
  [
    'escaped and literal non-ASCII path',
    'https://example.com/caf%C3%A9',
    'https://example.com/café',
  ],
  [
    'Google redirect',
    'https://www.google.com/url?q=https://example.com/a&sa=U&ved=2ah',
    'https://example.com/a',
  ],
  [
    'Google redirect, url= form',
    'https://www.google.co.uk/url?url=https%3A%2F%2Fexample.com%2Fa',
    'https://example.com/a',
  ],
  [
    'DuckDuckGo redirect',
    'https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fa&rut=abc',
    'https://example.com/a',
  ],
  [
    'Bing redirect',
    'https://www.bing.com/ck/a?!&&p=abc&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9h&ntb=1',
    'https://example.com/a',
  ],
  [
    'YouTube redirect',
    'https://www.youtube.com/redirect?q=https%3A%2F%2Fexample.com%2Fa&v=xyz',
    'https://example.com/a',
  ],
  [
    'redirect whose target carries tracking',
    'https://www.google.com/url?q=https%3A%2F%2Fexample.com%2Fa%3Futm_source%3Dg',
    'https://example.com/a',
  ],
  ['surrounding whitespace', '  https://example.com/a \n', 'https://example.com/a'],
]

const different: ReadonlyArray<[why: string, a: string, b: string]> = [
  ['?id= selects the page', 'https://example.com/item?id=1', 'https://example.com/item?id=2'],
  [
    '?id= must not be dropped',
    'https://news.ycombinator.com/item?id=41234567',
    'https://news.ycombinator.com/item',
  ],
  [
    '?ref= selects the branch',
    'https://github.com/o/r/blob/main/a.md?ref=v2',
    'https://github.com/o/r/blob/main/a.md',
  ],
  ['?page=', 'https://example.com/list?page=2', 'https://example.com/list'],
  [
    '?v= on YouTube',
    'https://www.youtube.com/watch?v=aaaaaaaaaaa',
    'https://www.youtube.com/watch?v=bbbbbbbbbbb',
  ],
  ['path case', 'https://example.com/Docs', 'https://example.com/docs'],
  ['path segment', 'https://example.com/docs/a', 'https://example.com/docs/b'],
  ['index.html is not assumed', 'https://example.com/docs/index.html', 'https://example.com/docs/'],
  ['non-default port', 'https://example.com:8443/a', 'https://example.com/a'],
  ['subdomain', 'https://docs.example.com/a', 'https://example.com/a'],
  ['language subdomain', 'https://fr.example.com/a', 'https://example.com/a'],
  ['look-alike host', 'https://example.com.evil.test/a', 'https://example.com/a'],
  [
    'repeated parameter order',
    'https://example.com/s?tag=a&tag=b',
    'https://example.com/s?tag=b&tag=a',
  ],
  ['escaped slash is not a slash', 'https://example.com/a%2Fb', 'https://example.com/a/b'],
  ['inner double slash', 'https://example.com/a//b', 'https://example.com/a/b'],
  [
    'a search page is not a redirect',
    'https://www.google.com/search?q=https://example.com/a',
    'https://example.com/a',
  ],
]

describe('URL identity, golden table', () => {
  it.each(same)('same page: %s', (_why, a, b) => {
    expect(keyOf(a)).toBe(keyOf(b))
  })

  it.each(different)('different pages: %s', (_why, a, b) => {
    expect(keyOf(a)).not.toBe(keyOf(b))
  })

  it('shows the page behind a redirect, without the wrapper', () => {
    expect(canonicalUrl('https://www.google.com/url?q=https://example.com/a%3Fid%3D7&sa=U')).toBe(
      'https://example.com/a?id=7',
    )
    expect(canonicalUrl('https://duckduckgo.com/l/?uddg=javascript%3Aalert(1)')).toBe(
      'https://duckduckgo.com/l/?uddg=javascript%3Aalert(1)',
    )
  })

  it('is stable: canonicalizing twice changes nothing', () => {
    for (const [, a, b] of [...same, ...different])
      for (const raw of [a, b]) {
        const once = canonicalUrl(raw)
        expect(once && canonicalUrl(once)).toBe(once)
      }
  })
})
