/**
 * URL identity for result lists. Two levels, on purpose:
 *  - `canonicalUrl` is what we show. It only removes what is never part of a page's identity
 *    (fragment, credentials, tracking parameters, a search engine's redirect wrapper), so every
 *    shown URL is one a source returned or pointed at.
 *  - `dedupeKey` is what we compare. It may be looser (scheme, "www.", "m.", trailing slash,
 *    parameter order, escape spelling) because a wrong guess there merges two list entries but
 *    never produces an address that does not exist.
 */
import { parse } from 'tldts'

const MAX_URL_LENGTH = 2048
const MAX_UNWRAP_DEPTH = 2

// `ref` is deliberately absent: on GitHub and GitLab `?ref=<branch>` selects the content.
const TRACKING_PARAMETERS = new Set([
  'ref_src',
  'ref_url',
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'yclid',
  'twclid',
  'ttclid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'mkt_tok',
  '_hsenc',
  '_hsmi',
  'hsctatracking',
  '_ga',
  '_gl',
  'srsltid',
  'vero_id',
  'vero_conv',
  'oly_anon_id',
  'oly_enc_id',
  's_cid',
  'spm',
])

function isTracking(name: string): boolean {
  const lower = name.toLowerCase()
  return lower.startsWith('utm_') || TRACKING_PARAMETERS.has(lower)
}

function parameterName(pair: string): string {
  const raw = pair.split('=', 1)[0] ?? ''
  try {
    return decodeURIComponent(raw.replaceAll('+', ' '))
  } catch {
    return raw
  }
}

/** Filters pairs textually so the remaining parameters keep their original encoding and order. */
function withoutTracking(search: string): string {
  if (search.length <= 1) return ''
  const kept = search
    .slice(1)
    .split('&')
    .filter((pair) => pair.length > 0 && !isTracking(parameterName(pair)))
  return kept.length ? `?${kept.join('&')}` : ''
}

function parseHttpUrl(raw: string): URL | undefined {
  const trimmed = raw.trim()
  if (!trimmed || trimmed.length > MAX_URL_LENGTH) return undefined
  try {
    const url = new URL(trimmed)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname ? url : undefined
  } catch {
    return undefined
  }
}

interface Redirector {
  host: RegExp
  path: RegExp
  parameters: readonly string[]
  decode?: (value: string) => string | undefined
}

/** Bing wraps the target as "a1" + base64url. */
function decodeBing(value: string): string | undefined {
  if (!value.startsWith('a1')) return undefined
  return Buffer.from(value.slice(2), 'base64url').toString('utf8')
}

/** Link wrappers of search engines and social sites: the result is the page behind them. */
const REDIRECTORS: readonly Redirector[] = [
  { host: /^(?:www\.)?google\.[a-z.]{2,6}$/u, path: /^\/url$/u, parameters: ['q', 'url'] },
  { host: /^(?:www\.)?bing\.com$/u, path: /^\/ck\/a$/u, parameters: ['u'], decode: decodeBing },
  { host: /^duckduckgo\.com$/u, path: /^\/l\/?$/u, parameters: ['uddg'] },
  { host: /^(?:www\.)?youtube\.com$/u, path: /^\/redirect$/u, parameters: ['q'] },
  { host: /^lm?\.facebook\.com$/u, path: /^\/l\.php$/u, parameters: ['u'] },
  { host: /^out\.reddit\.com$/u, path: /^\//u, parameters: ['url'] },
  { host: /^link\.zhihu\.com$/u, path: /^\/$/u, parameters: ['target'] },
]

function redirectTarget(url: URL): URL | undefined {
  const rule = REDIRECTORS.find(
    (entry) => entry.host.test(url.hostname) && entry.path.test(url.pathname),
  )
  if (!rule) return undefined
  for (const parameter of rule.parameters) {
    const value = url.searchParams.get(parameter)
    const target = value
      ? parseHttpUrl(rule.decode ? (rule.decode(value) ?? '') : value)
      : undefined
    if (target) return target
  }
  return undefined
}

function unwrap(url: URL): URL {
  let current = url
  for (let depth = 0; depth < MAX_UNWRAP_DEPTH; depth += 1) {
    const target = redirectTarget(current)
    if (!target) break
    current = target
  }
  return current
}

/** Returns undefined for anything that is not an absolute http(s) URL. */
export function canonicalUrl(raw: string): string | undefined {
  const parsed = parseHttpUrl(raw)
  if (!parsed) return undefined
  const url = unwrap(parsed)
  url.username = ''
  url.password = ''
  url.hash = ''
  url.hostname = url.hostname.replace(/\.$/u, '')
  url.pathname = url.pathname.replace(/\/{2,}$/u, '/')
  url.search = withoutTracking(url.search)
  return url.href
}

const MOBILE_LABELS = new Set(['m', 'mobile'])

function subdomainLabels(hostname: string): { labels: string[]; domain: string } {
  const parsed = parse(hostname)
  if (!parsed.domain) return { labels: [], domain: hostname }
  return { labels: (parsed.subdomain ?? '').split('.').filter(Boolean), domain: parsed.domain }
}

/** "www.", and the mobile label of "m.example.com" or "en.m.wikipedia.org", name the same site. */
function comparableHost(hostname: string): string {
  const { labels, domain } = subdomainLabels(hostname)
  if (labels[0] === 'www') labels.shift()
  if (MOBILE_LABELS.has(labels[0] ?? '')) labels.shift()
  else if (MOBILE_LABELS.has(labels.at(-1) ?? '')) labels.pop()
  return [...labels, domain].join('.')
}

/** "%7e" and "~", "%2f" and "%2F" are the same octets. */
function normalizeEscapes(text: string): string {
  return text.replace(/%[0-9a-f]{2}/giu, (escape) => {
    const char = String.fromCharCode(Number.parseInt(escape.slice(1), 16))
    return /[\w.~-]/u.test(char) ? char : escape.toUpperCase()
  })
}

/** Parameter order rarely matters; repeated names keep their relative order. */
function comparableSearch(search: string): string {
  if (search.length <= 1) return ''
  const pairs = search.slice(1).split('&').filter(Boolean).map(normalizeEscapes)
  const name = (pair: string) => pair.split('=', 1)[0] ?? ''
  return `?${pairs.toSorted((a, b) => (name(a) < name(b) ? -1 : name(a) > name(b) ? 1 : 0)).join('&')}`
}

/** Comparison key for an already canonical URL. */
export function dedupeKey(canonical: string): string {
  const url = new URL(canonical)
  const port = url.port ? `:${url.port}` : ''
  const path = normalizeEscapes(url.pathname).replace(/\/+$/u, '')
  return `${comparableHost(url.hostname)}${port}${path}${comparableSearch(url.search)}`
}

/** Lower is the better address to show when two spellings name one page. */
export function displayRank(canonical: string): number {
  const url = new URL(canonical)
  const { labels } = subdomainLabels(url.hostname)
  const mobile = labels.some((label) => MOBILE_LABELS.has(label))
  return (url.protocol === 'https:' ? 0 : 1) + (mobile ? 2 : 0)
}

function bareHost(hostname: string): string {
  return hostname.replace(/^www\./u, '')
}

/** Host shown next to a title: "developer.mozilla.org". */
export function siteOf(canonical: string): string {
  return bareHost(new URL(canonical).hostname)
}

export function hostMatchesSites(host: string, sites: readonly string[]): boolean {
  return sites.some((site) => host === site || host.endsWith(`.${site}`))
}

/**
 * A `sites` entry as models write them: "example.com", "https://example.com/docs",
 * "site:example.com", "*.example.com". Returns the host, or undefined when there is none.
 */
export function siteFromInput(entry: string): string | undefined {
  const stripped = entry
    .trim()
    .replace(/^["']+|["']+$/gu, '')
    .replace(/^site:/iu, '')
    .replace(/^\*\./u, '')
  if (!stripped || /\s/u.test(stripped)) return undefined
  const url = parseHttpUrl(
    /^[a-z][a-z0-9+.-]*:\/\//iu.test(stripped) ? stripped : `https://${stripped}`,
  )
  if (!url) return undefined
  const host = bareHost(url.hostname.replace(/\.$/u, ''))
  const parsed = parse(host)
  if (parsed.isIp || !parsed.isIcann) return undefined
  // A bare public suffix ("edu", "gov.cn") is a legitimate restriction.
  return parsed.domain || parsed.publicSuffix === host ? host : undefined
}

// Languages that sites actually publish translations under. "my" is left out: as a subdomain it
// almost always means an account area, not Burmese.
const LANGUAGE_CODES = new Set(
  (
    'af ar az be bg bn bs ca cs cy da de el en es et eu fa fi fil fr ga gl gu he hi hr hu hy id is ' +
    'it ja ka kk km kn ko lo lt lv mk ml mn mr ms nb ne nl nn no pa pl pt ro ru si sk sl sq sr sv ' +
    'sw ta te th tl tr uk ur uz vi zh'
  ).split(' '),
)

/** "fa", "zh-cn", "pt-br", "zh-hans" -> primary subtag; anything else -> undefined. */
export function languageOfLabel(label: string): string | undefined {
  const match = /^([a-z]{2,3})(?:-[a-z]{2,4})?$/u.exec(label)
  return match?.[1] && LANGUAGE_CODES.has(match[1]) ? match[1] : undefined
}

/**
 * Codes that are rarely anything but a language or a locale when they lead a host name. Every
 * other code in LANGUAGE_CODES is also a common functional subdomain ("eu" region, "it" and "hr"
 * departments, "id" sign-in, "ml", "cs", "ga", ...), so on its own it proves nothing.
 */
const UNAMBIGUOUS_LANGUAGE_CODES = new Set(
  'en fr de es pt ru ja zh ko fa tr pl nl sv fi hu el he ro vi th ar hi uk'.split(' '),
)

export interface MirrorIdentity {
  /** Equal for pages that differ only by their language subdomain. */
  key: string
  /** Primary language subtag of the subdomain; "" for a host without a language label. */
  language: string
  /** The label can hardly be anything but a language: an unambiguous code, or one with a region. */
  certain: boolean
}

/**
 * Translated mirrors such as fr.javascript.info/fetch-abort and javascript.info/fetch-abort:
 * same registrable domain, same remaining subdomain, same path and query; only the language
 * label differs or is absent. Which hosts with the same key are actually folded is decided in
 * fuse.ts. Home pages get no identity: a two-letter subdomain on a bare "/" is too often
 * something else.
 */
export function mirrorIdentity(canonical: string): MirrorIdentity | undefined {
  const url = new URL(canonical)
  const parsed = parse(url.hostname)
  const path = url.pathname.replace(/\/+$/u, '')
  if (!parsed.domain || parsed.isIp || !path) return undefined
  const labels = (parsed.subdomain ?? '').split('.').filter(Boolean)
  if (labels[0] === 'www') labels.shift()
  const label = labels[0] ?? ''
  const language = languageOfLabel(label) ?? ''
  if (language) labels.shift()
  return {
    key: `${parsed.domain}|${labels.join('.')}|${path}${url.search}`,
    language,
    certain: language !== '' && (label.includes('-') || UNAMBIGUOUS_LANGUAGE_CODES.has(language)),
  }
}
