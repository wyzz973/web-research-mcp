import { afterEach, describe, expect, it } from 'vitest'
import { createHostGate } from '../../src/fetch/host-gate.ts'
import { isAllowed, parseRobots } from '../../src/fetch/robots.ts'
import { createHarness, fixture, type Harness } from './helpers.ts'

let harness: Harness | undefined
afterEach(() => {
  harness?.close()
  harness = undefined
})

const AGENT = 'web-research-mcp'
const STAR_ONLY = [
  '# comment line',
  'User-agent: Googlebot',
  'Disallow: /only-for-google',
  '',
  'Sitemap: https://example.com/sitemap.xml',
  'User-agent: *',
  'User-Agent: other-bot',
  'Disallow: /private/   # trailing comment',
  'Allow: /private/press/',
  'Disallow: /*.pdf$',
  'Disallow: /search?*q=',
  'Disallow:',
  'Crawl-delay: 10',
].join('\r\n')

const ROBOTS = STAR_ONLY

describe('robots rules', () => {
  const rules = parseRobots(STAR_ONLY, AGENT)

  it('uses the * group when no group names us, ignoring other crawlers and empty rules', () => {
    expect(rules).toEqual([
      { allow: false, pattern: '/private/' },
      { allow: true, pattern: '/private/press/' },
      { allow: false, pattern: '/*.pdf$' },
      { allow: false, pattern: '/search?*q=' },
    ])
  })

  it.each([
    ['/', true],
    ['/docs/page', true],
    ['/only-for-google', true],
    ['/private/', false],
    ['/private/report', false],
    ['/private/press/2026', true],
    ['/files/manual.pdf', false],
    ['/files/manual.pdf?download=1', true],
    ['/search?lang=en&q=robots', false],
    ['/search?lang=en', true],
  ])('%s -> allowed %s', (path, allowed) => {
    expect(isAllowed(rules, path)).toBe(allowed)
  })

  it('lets a group that names us replace the * group entirely, in either direction', () => {
    const stricter = 'User-agent: *\nAllow: /docs/\n\nUser-agent: WEB-RESEARCH-MCP\nDisallow: /'
    expect(parseRobots(stricter, AGENT)).toEqual([{ allow: false, pattern: '/' }])
    expect(isAllowed(parseRobots(stricter, AGENT), '/docs/page')).toBe(false)
    const looser = 'User-agent: *\nDisallow: /\n\nUser-agent: web-research-mcp\nDisallow: /drafts/'
    expect(isAllowed(parseRobots(looser, AGENT), '/docs/page')).toBe(true)
    expect(isAllowed(parseRobots(looser, AGENT), '/drafts/x')).toBe(false)
  })

  it('treats a named group without rules as "everything is allowed for you"', () => {
    const open = 'User-agent: *\nDisallow: /\n\nUser-agent: web-research-mcp\nDisallow:'
    expect(parseRobots(open, AGENT)).toEqual([])
    expect(isAllowed(parseRobots(open, AGENT), '/anything')).toBe(true)
  })

  it('applies a group shared by * and our token, and merges several groups that name us', () => {
    const shared = [
      'User-agent: *',
      'User-agent: web-research-mcp',
      'Disallow: /shared/',
      '',
      'User-agent: web-research-mcp',
      'Disallow: /ours/',
      '',
      'User-agent: *',
      'Disallow: /star-only/',
    ].join('\n')
    const ours = parseRobots(shared, AGENT)
    expect(ours).toEqual([
      { allow: false, pattern: '/shared/' },
      { allow: false, pattern: '/ours/' },
    ])
    expect(parseRobots(shared, 'another-bot')).toEqual([
      { allow: false, pattern: '/shared/' },
      { allow: false, pattern: '/star-only/' },
    ])
  })

  it('lets Allow win a tie and treats no rules as allowed', () => {
    expect(isAllowed(parseRobots('User-agent: *\nDisallow: /a\nAllow: /a', AGENT), '/a/b')).toBe(
      true,
    )
    expect(isAllowed([], '/anything')).toBe(true)
  })

  it('matches wildcards in linear time even for hostile patterns', () => {
    const hostile = parseRobots(`User-agent: *\nDisallow: /${'*a'.repeat(400)}*b$`, AGENT)
    const started = Date.now()
    expect(isAllowed(hostile, `/${'a'.repeat(20_000)}`)).toBe(true)
    expect(Date.now() - started).toBeLessThan(500)
  })
})

describe('robots through the reader', () => {
  const article = { body: fixture('article.html') }

  it('refuses a disallowed path without requesting it', async () => {
    harness = await createHarness({
      '/robots.txt': { body: ROBOTS, headers: { 'content-type': 'text/plain' } },
      '/private/report': article,
    })
    const result = await harness.fetch({ url: 'https://example.com/private/report' })
    expect(result.pages[0]?.error).toMatchObject({ code: 'robots_disallowed' })
    expect(result.pages[0]?.error?.message).toContain("site's wish")
    expect(harness.requests).toEqual([])
    expect(harness.robotsRequests).toEqual(['https://example.com/robots.txt'])
  })

  it('reads allowed paths and asks each host for its rules only once', async () => {
    harness = await createHarness({
      '/robots.txt': { body: ROBOTS, headers: { 'content-type': 'text/plain' } },
      '/private/press/a': article,
      '/docs': article,
    })
    const result = await harness.fetch({
      urls: ['https://example.com/private/press/a', 'https://example.com/docs'],
      goal: 'retries',
    })
    expect(result.status).toBe('ok')
    await harness.fetch({ url: 'https://example.com/docs', fresh: true })
    expect(harness.robotsRequests).toHaveLength(1)
  })

  it('checks the rules of a redirect target too', async () => {
    harness = await createHarness({
      '/robots.txt': {
        body: 'User-agent: *\nDisallow: /members/',
        headers: { 'content-type': 'text/plain' },
      },
      '/open': { status: 302, headers: { location: '/members/page' } },
      '/members/page': article,
    })
    const result = await harness.fetch({ url: 'https://example.com/open' })
    expect(result.pages[0]?.error?.code).toBe('robots_disallowed')
    expect(harness.requests).toEqual(['https://example.com/open'])
  })

  it.each([
    ['is missing', { status: 404 }],
    ['is forbidden', { status: 403 }],
    ['fails on the server', { status: 503 }],
    ['is an HTML page', { body: '<!doctype html><html><body>Disallow: /</body></html>' }],
  ])('reads the page when robots.txt %s', async (_name, robots) => {
    harness = await createHarness({ '/robots.txt': robots, '/docs': article })
    expect((await harness.fetch({ url: 'https://example.com/docs' })).status).toBe('ok')
  })

  it('obeys a group that names us even when the * group allows the path', async () => {
    harness = await createHarness({
      '/robots.txt': {
        body: 'User-agent: *\nAllow: /docs/\n\nUser-agent: web-research-mcp\nDisallow: /',
        headers: { 'content-type': 'text/plain' },
      },
      '/docs/page': article,
    })
    const result = await harness.fetch({ url: 'https://example.com/docs/page' })
    expect(result.pages[0]?.error?.code).toBe('robots_disallowed')
    expect(harness.requests).toEqual([])
  })

  it('does not need robots.txt to read a stored snapshot or a cached page', async () => {
    harness = await createHarness({ '/docs': article })
    const first = await harness.fetch({ url: 'https://example.com/docs' })
    await harness.fetch({ url: 'https://example.com/docs' })
    await harness.fetch({ ref: first.pages[0]?.snapshot, find: 'retries' })
    expect(harness.robotsRequests).toHaveLength(1)
    expect(harness.requests).toHaveLength(1)
  })

  it('still reads the page when the rules cannot be written to the state file', async () => {
    harness = await createHarness({ '/docs': article })
    const putRecord = harness.store.putRecord.bind(harness.store)
    harness.store.putRecord = (kind, id, value, ttl) => {
      if (kind === 'robots') throw new Error('database is locked')
      putRecord(kind, id, value, ttl)
    }
    expect((await harness.fetch({ url: 'https://example.com/docs' })).status).toBe('ok')
  })
})

describe('pacing within one fetch', () => {
  const article = { body: fixture('article.html') }
  const INTERVAL = 150

  function gap(h: Harness, from: string, to: string): number {
    const start = h.startedAt.find((entry) => entry.url === from)?.ms ?? Number.NaN
    const end = h.startedAt.find((entry) => entry.url === to)?.ms ?? Number.NaN
    return end - start
  }

  it('does not wait a second time after downloading robots.txt for the same host', async () => {
    harness = await createHarness({ '/docs': article }, undefined, INTERVAL)
    await harness.fetch({ url: 'https://example.com/docs' })
    expect(gap(harness, 'https://example.com/robots.txt', 'https://example.com/docs')).toBeLessThan(
      INTERVAL - 30,
    )
  })

  it('does not pace a redirect that stays on the host, but still checks its path against the rules', async () => {
    harness = await createHarness(
      {
        '/robots.txt': {
          body: 'User-agent: *\nDisallow: /members/',
          headers: { 'content-type': 'text/plain' },
        },
        '/a': { status: 302, headers: { location: '/b' } },
        '/b': { status: 302, headers: { location: '/members/c' } },
        '/members/c': article,
      },
      undefined,
      INTERVAL,
    )
    const result = await harness.fetch({ url: 'https://example.com/a' })
    expect(gap(harness, 'https://example.com/a', 'https://example.com/b')).toBeLessThan(
      INTERVAL - 30,
    )
    expect(result.pages[0]?.error?.code).toBe('robots_disallowed')
    expect(harness.requests).toEqual(['https://example.com/a', 'https://example.com/b'])
  })

  it('asks a new host for its rules when a redirect changes host', async () => {
    harness = await createHarness(
      {
        'https://short.example.com/x': {
          status: 301,
          headers: { location: 'https://www.example.org/article' },
        },
        'https://www.example.org/robots.txt': {
          body: 'User-agent: *\nDisallow: /article',
          headers: { 'content-type': 'text/plain' },
        },
        'https://www.example.org/article': article,
      },
      undefined,
      0,
    )
    const result = await harness.fetch({ url: 'https://short.example.com/x' })
    expect(result.pages[0]?.error?.code).toBe('robots_disallowed')
    expect(harness.robotsRequests).toEqual([
      'https://short.example.com/robots.txt',
      'https://www.example.org/robots.txt',
    ])
    expect(harness.requests).toEqual(['https://short.example.com/x'])
  })

  it('spaces two pages of one host that are read in the same call', async () => {
    harness = await createHarness({ '/one': article, '/two': article }, undefined, INTERVAL)
    await harness.fetch({
      urls: ['https://example.com/one', 'https://example.com/two'],
      goal: 'retries',
    })
    const pages = harness.startedAt
      .filter((entry) => !entry.url.endsWith('/robots.txt'))
      .map((entry) => entry.ms)
    expect(Math.abs((pages[1] ?? 0) - (pages[0] ?? 0))).toBeGreaterThanOrEqual(INTERVAL - 40)
  })
})

describe('host gate', () => {
  const never = (): AbortSignal => new AbortController().signal

  it('spaces request starts to one host and does not delay other hosts', async () => {
    const gate = createHostGate(2, 60)
    const started = Date.now()
    const marks: Record<string, number> = {}
    await Promise.all([
      gate.pace('a.example.com', never()).then(() => (marks.a1 = Date.now() - started)),
      gate.pace('a.example.com', never()).then(() => (marks.a2 = Date.now() - started)),
      gate.pace('a.example.com', never()).then(() => (marks.a3 = Date.now() - started)),
      gate.pace('b.example.com', never()).then(() => (marks.b1 = Date.now() - started)),
    ])
    expect(marks.a1).toBeLessThan(40)
    expect(marks.b1).toBeLessThan(40)
    expect(marks.a2).toBeGreaterThanOrEqual(55)
    expect(marks.a3).toBeGreaterThanOrEqual(115)
  })

  it('stops waiting when cancelled', async () => {
    const gate = createHostGate(2, 10_000)
    await gate.pace('a.example.com', never())
    const abort = new AbortController()
    const waiting = gate.pace('a.example.com', abort.signal)
    abort.abort()
    await expect(waiting).rejects.toMatchObject({ code: 'cancelled' })
  })

  it('holds at most the configured number of slots per host', async () => {
    const gate = createHostGate(2, 0)
    let active = 0
    let peak = 0
    const task = async (): Promise<void> => {
      active += 1
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, 10))
      active -= 1
    }
    await Promise.all(
      Array.from({ length: 6 }, () => gate.withSlot('a.example.com', never(), task)),
    )
    expect(peak).toBe(2)
  })
})
