import { describe, expect, it } from 'vitest'
import {
  canonicalUrl,
  dedupeKey,
  hostMatchesSites,
  languageOfLabel,
  mirrorIdentity,
  siteFromInput,
  siteOf,
} from '../../src/search/url.ts'

describe('canonicalUrl', () => {
  it('lower-cases the host and drops default ports, fragments and credentials', () => {
    expect(canonicalUrl('HTTPS://User:Pass@Example.COM:443/Path/Page?b=2&a=1#section')).toBe(
      'https://example.com/Path/Page?b=2&a=1',
    )
    expect(canonicalUrl('http://example.com:80/')).toBe('http://example.com/')
    expect(canonicalUrl('https://example.com:8443/x')).toBe('https://example.com:8443/x')
    expect(canonicalUrl('https://example.com./x#:~:text=quote')).toBe('https://example.com/x')
  })

  it('removes tracking parameters and leaves every other parameter exactly as it was', () => {
    expect(
      canonicalUrl(
        'https://example.com/a?utm_source=x&id=7&UTM_Medium=y&q=a%20b+c&fbclid=1&gclid=2&srsltid=3',
      ),
    ).toBe('https://example.com/a?id=7&q=a%20b+c')
    expect(canonicalUrl('https://example.com/a?utm_campaign=only')).toBe('https://example.com/a')
    expect(canonicalUrl('https://example.com/a?reference=kept&refs=kept')).toBe(
      'https://example.com/a?reference=kept&refs=kept',
    )
  })

  it('keeps ?ref=, which selects the branch on GitHub and GitLab', () => {
    const readme = 'https://github.com/nodejs/node/blob/main/README.md?ref=v22.x'
    expect(canonicalUrl(readme)).toBe(readme)
    expect(dedupeKey(readme)).not.toBe(
      dedupeKey('https://github.com/nodejs/node/blob/main/README.md'),
    )
  })

  it('is conservative with trailing slashes: only repeated ones are collapsed', () => {
    expect(canonicalUrl('https://example.com/docs/')).toBe('https://example.com/docs/')
    expect(canonicalUrl('https://example.com/docs///')).toBe('https://example.com/docs/')
    expect(canonicalUrl('https://example.com/a//b')).toBe('https://example.com/a//b')
  })

  it('rejects what is not an absolute http(s) URL', () => {
    for (const raw of [
      '',
      'example.com/x',
      'ftp://example.com/',
      'javascript:alert(1)',
      'https://',
    ])
      expect(canonicalUrl(raw)).toBeUndefined()
    expect(canonicalUrl(`https://example.com/${'a'.repeat(3000)}`)).toBeUndefined()
  })

  it('is idempotent', () => {
    const once = canonicalUrl('https://Example.com/a%20b/?x=%7B1%7D&utm_source=z#f')
    expect(once && canonicalUrl(once)).toBe(once)
  })
})

describe('dedupeKey', () => {
  const key = (raw: string) => dedupeKey(canonicalUrl(raw) ?? '')

  it('treats scheme, "www." and one trailing slash as the same page', () => {
    expect(key('http://www.example.com/docs/')).toBe(key('https://example.com/docs'))
    expect(key('https://example.com/')).toBe(key('https://example.com'))
  })

  it('keeps pages apart that differ in path case, query or port', () => {
    expect(key('https://example.com/Docs')).not.toBe(key('https://example.com/docs'))
    expect(key('https://example.com/a?id=1')).not.toBe(key('https://example.com/a?id=2'))
    expect(key('https://example.com:8443/a')).not.toBe(key('https://example.com/a'))
  })
})

describe('siteOf and hostMatchesSites', () => {
  it('shows the host without "www."', () => {
    expect(siteOf('https://www.developer.mozilla.org/en-US/')).toBe('developer.mozilla.org')
  })

  it('counts subdomains as part of a site, but not look-alike hosts', () => {
    expect(hostMatchesSites('docs.python.org', ['python.org'])).toBe(true)
    expect(hostMatchesSites('python.org', ['python.org'])).toBe(true)
    expect(hostMatchesSites('notpython.org', ['python.org'])).toBe(false)
    expect(hostMatchesSites('mit.edu', ['edu'])).toBe(true)
  })
})

describe('siteFromInput', () => {
  it('finds the host in the shapes models send', () => {
    expect(siteFromInput('Example.com')).toBe('example.com')
    expect(siteFromInput('https://www.example.com/docs?x=1')).toBe('example.com')
    expect(siteFromInput('"site:docs.python.org"')).toBe('docs.python.org')
    expect(siteFromInput('例え.jp')).toBe('xn--r8jz45g.jp')
  })

  it('returns undefined when there is no public host', () => {
    for (const entry of ['', 'two words', 'localhost', '127.0.0.1', 'intranet.local', 'ftp://x'])
      expect(siteFromInput(entry)).toBeUndefined()
  })
})

describe('mirrorIdentity', () => {
  it('gives a page and its translated mirrors the same key', () => {
    const plain = mirrorIdentity('https://javascript.info/fetch-abort')
    expect(plain).toEqual({ key: 'javascript.info||/fetch-abort', language: '', certain: false })
    expect(mirrorIdentity('https://fa.javascript.info/fetch-abort/')).toEqual({
      key: plain?.key,
      language: 'fa',
      certain: true,
    })
    expect(mirrorIdentity('https://www.ko.javascript.info/fetch-abort')?.key).toBe(plain?.key)
    expect(mirrorIdentity('https://www.javascript.info/fetch-abort')).toEqual(plain)
  })

  it('knows which labels can hardly be anything but a language', () => {
    const certain = (host: string) => mirrorIdentity(`https://${host}/pricing`)?.certain
    for (const host of ['fr.example.com', 'zh.example.com', 'ko.example.com', 'uk.example.com'])
      expect(certain(host)).toBe(true)
    // A region or script subtag settles it, whatever the primary code is.
    for (const host of ['zh-cn.example.com', 'pt-br.example.com', 'it-it.example.com'])
      expect(certain(host)).toBe(true)
    // Codes that are just as often a region, a department, or a product.
    for (const code of 'eu it is no id ml hr ga ca be pa te sk bg cs da'.split(' '))
      expect(certain(`${code}.example.com`)).toBe(false)
    // Not a language label at all: the host is its own page.
    expect(mirrorIdentity('https://api.example.com/guide')).toMatchObject({
      key: 'example.com|api|/guide',
      language: '',
    })
    expect(mirrorIdentity('https://my.example.com/guide')?.language).toBe('')
  })

  it('keeps different pages and sites apart', () => {
    const base = mirrorIdentity('https://fr.docs.example.com/guide')?.key
    expect(mirrorIdentity('https://de.docs.example.com/guide')?.key).toBe(base)
    expect(mirrorIdentity('https://de.api.example.com/guide')?.key).not.toBe(base)
    expect(mirrorIdentity('https://de.docs.example.com/other')?.key).not.toBe(base)
    expect(mirrorIdentity('https://de.docs.example.org/guide')?.key).not.toBe(base)
    expect(mirrorIdentity('https://de.docs.example.com/guide?page=2')?.key).not.toBe(base)
  })

  it('never folds home pages or addresses without a registrable domain', () => {
    expect(mirrorIdentity('https://fr.example.com/')).toBeUndefined()
    expect(mirrorIdentity('https://192.168.1.1/page')).toBeUndefined()
  })

  it('recognizes language labels only', () => {
    expect(languageOfLabel('pt-br')).toBe('pt')
    expect(languageOfLabel('zh-hans')).toBe('zh')
    expect(languageOfLabel('fil')).toBe('fil')
    for (const label of ['api', 'my', 'xx', 'docs', 'e', 'en-'])
      expect(languageOfLabel(label)).toBeUndefined()
  })
})
