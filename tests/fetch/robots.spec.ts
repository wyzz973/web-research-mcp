import { afterEach, describe, expect, it } from 'vitest'
import { createHostGate } from '../../src/fetch/host-gate.ts'
import {
  isAllowed,
  MAX_PATTERN_CHARS,
  MAX_RULES,
  parseRobots,
  type RobotsRule,
} from '../../src/fetch/robots.ts'
import { cpuRatio, createHarness, fixture, type Harness, MAX_GROWTH } from './helpers.ts'

let harness: Harness | undefined
afterEach(() => {
  harness?.close()
  harness = undefined
})

const AGENT = 'web-research-mcp'

/** The rules that apply to us, for files small enough to be evaluated completely. */
function rulesOf(text: string, agent = AGENT): RobotsRule[] {
  const policy = parseRobots(text, agent)
  expect(policy.incomplete).toBe(false)
  return policy.rules
}
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
  const rules = rulesOf(STAR_ONLY, AGENT)

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
    expect(rulesOf(stricter, AGENT)).toEqual([{ allow: false, pattern: '/' }])
    expect(isAllowed(rulesOf(stricter, AGENT), '/docs/page')).toBe(false)
    const looser = 'User-agent: *\nDisallow: /\n\nUser-agent: web-research-mcp\nDisallow: /drafts/'
    expect(isAllowed(rulesOf(looser, AGENT), '/docs/page')).toBe(true)
    expect(isAllowed(rulesOf(looser, AGENT), '/drafts/x')).toBe(false)
  })

  it('treats a named group without rules as "everything is allowed for you"', () => {
    const open = 'User-agent: *\nDisallow: /\n\nUser-agent: web-research-mcp\nDisallow:'
    expect(rulesOf(open, AGENT)).toEqual([])
    expect(isAllowed(rulesOf(open, AGENT), '/anything')).toBe(true)
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
    const ours = rulesOf(shared, AGENT)
    expect(ours).toEqual([
      { allow: false, pattern: '/shared/' },
      { allow: false, pattern: '/ours/' },
    ])
    expect(rulesOf(shared, 'another-bot')).toEqual([
      { allow: false, pattern: '/shared/' },
      { allow: false, pattern: '/star-only/' },
    ])
  })

  it('lets Allow win a tie and treats no rules as allowed', () => {
    expect(isAllowed(rulesOf('User-agent: *\nDisallow: /a\nAllow: /a', AGENT), '/a/b')).toBe(true)
    expect(isAllowed([], '/anything')).toBe(true)
  })

  it('matches wildcards in linear time even for hostile patterns', () => {
    const hostile = rulesOf(`User-agent: *\nDisallow: /${'*a'.repeat(400)}*b$`, AGENT)
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

describe('a robots.txt too large to evaluate completely', () => {
  const article = { body: fixture('article.html') }
  const plain = (body: string): { body: string; headers: Record<string, string> } => ({
    body,
    headers: { 'content-type': 'text/plain' },
  })
  const REFUSAL =
    /has more rules than can be evaluated completely.*not an explicit refusal of this path/u

  it('evaluates thousands of rules normally: the last of 2,001 decides', async () => {
    const rules = Array.from({ length: 2000 }, (_, index) => `Disallow: /private/area-${index}/`)
    harness = await createHarness({
      '/robots.txt': plain(['User-agent: *', ...rules, 'Disallow: /docs/secret'].join('\n')),
      '/docs/secret': article,
      '/docs/open': article,
    })
    const refused = await harness.fetch({ url: 'https://example.com/docs/secret' })
    expect(refused.pages[0]?.error?.code).toBe('robots_disallowed')
    expect(refused.pages[0]?.error?.message).toContain('disallows automated reading of this path')
    expect((await harness.fetch({ url: 'https://example.com/docs/open' })).status).toBe('ok')
    expect(harness.requests).toEqual(['https://example.com/docs/open'])
  })

  it('treats the host as refusing when a pattern is too long to evaluate', async () => {
    const long = `Disallow: /${'x'.repeat(MAX_PATTERN_CHARS)}`
    expect(parseRobots(`User-agent: *\n${long}\nDisallow: /a`, AGENT)).toEqual({
      rules: [{ allow: false, pattern: '/a' }],
      incomplete: true,
    })
    harness = await createHarness({
      '/robots.txt': plain(`User-agent: *\n${long}`),
      '/docs': article,
    })
    const result = await harness.fetch({ url: 'https://example.com/docs' })
    expect(result.pages[0]?.error?.code).toBe('robots_disallowed')
    expect(result.pages[0]?.error?.message).toMatch(REFUSAL)
    expect(harness.requests).toEqual([])
  })

  it('treats the host as refusing when there are more rules than are kept', () => {
    const many = [
      'User-agent: *',
      ...Array.from({ length: MAX_RULES + 1 }, (_, index) => `Allow: /${index}`),
    ]
    const policy = parseRobots(many.join('\n'), AGENT)
    expect(policy.incomplete).toBe(true)
    expect(policy.rules).toHaveLength(MAX_RULES)
  })

  it('only counts what applies to us: an oversized group for another crawler changes nothing', () => {
    const other = ['User-agent: bigbot', `Disallow: /${'y'.repeat(MAX_PATTERN_CHARS + 5)}`]
    const policy = parseRobots([...other, '', 'User-agent: *', 'Disallow: /a'].join('\n'), AGENT)
    expect(policy).toEqual({ rules: [{ allow: false, pattern: '/a' }], incomplete: false })
  })

  it('treats the host as refusing when the file is larger than is read, and remembers it', async () => {
    harness = await createHarness({
      '/robots.txt': plain(`User-agent: *\n${'Allow: /some/allowed/path\n'.repeat(30_000)}`),
      '/docs': article,
    })
    const first = await harness.fetch({ url: 'https://example.com/docs' })
    expect(first.pages[0]?.error?.message).toMatch(REFUSAL)
    await harness.fetch({ url: 'https://example.com/docs' })
    expect(harness.robotsRequests).toHaveLength(1)
    expect(harness.requests).toEqual([])
  })

  it('evaluates a large file in linear time', () => {
    const file = (rules: number): string =>
      [
        'User-agent: *',
        ...Array.from({ length: rules }, (_, index) => `Disallow: /area-${index}/*/private$`),
      ].join('\n')
    const small = file(5000)
    const large = file(20_000)
    // Many addresses per run, so that the smaller file is slow enough to be measured at all:
    // the clock has to be well clear of its own granularity, which is about 16 ms on Windows.
    const paths = Array.from(
      { length: 120 },
      (_, index) => `/${'segment/'.repeat(30)}page-${index}?id=1`,
    )
    // Parsing is not what this measures, and it was being done on every run of both sizes: a
    // Windows runner spent the whole 20 s budget on it. Rules are read once and only read from
    // afterwards, so evaluation is all that is left in the measurement.
    const parsed = (text: string): RobotsRule[] => {
      const policy = parseRobots(text, AGENT)
      expect(policy.incomplete).toBe(false)
      for (const path of paths) expect(isAllowed(policy.rules, path)).toBe(true)
      return policy.rules
    }
    const few = parsed(small)
    const many = parsed(large)
    const ratio = cpuRatio(
      () => {
        for (const path of paths) isAllowed(few, path)
      },
      () => {
        for (const path of paths) isAllowed(many, path)
      },
    )
    // Four times the rules: about 4 when linear, about 16 when quadratic.
    expect(ratio).toBeDefined()
    expect(ratio).toBeLessThanOrEqual(MAX_GROWTH)
  })
})
