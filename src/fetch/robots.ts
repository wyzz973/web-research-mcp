/**
 * robots.txt, as far as a single-page reader needs it. A group that names our product token is
 * the only one that applies; without one, the "*" group applies. Within the chosen group the
 * longest matching pattern wins and Allow wins a tie. Rules are cached in the shared store, so
 * separate processes (and separate CLI runs) ask each host once an hour, not once per read.
 */
import type { Config } from '../config.ts'
import type { Store } from '../contract.ts'
import { WebError, throwIfAborted } from '../errors.ts'
import { safeGet, type NetworkDependencies } from '../net/safe-http.ts'

export interface RobotsRule {
  allow: boolean
  pattern: string
}

/**
 * Throws `robots_disallowed` when the path is refused. Resolves to true when this call had to
 * download robots.txt, so the caller knows the host was contacted a moment ago.
 */
export type RobotsCheck = (url: URL, signal: AbortSignal, paced?: boolean) => Promise<boolean>

const RECORD_KIND = 'robots'
const KNOWN_TTL_S = 3600
/** A host whose robots.txt could not be read is asked again soon. */
const UNKNOWN_TTL_S = 60
const MAX_BYTES = 512 * 1024
const MAX_TIMEOUT_MS = 5000
const MAX_RULES = 2000
const MAX_PATTERN_CHARS = 1000

function field(line: string): { key: string; value: string } | undefined {
  const text = line.split('#')[0] ?? ''
  const colon = text.indexOf(':')
  if (colon === -1) return undefined
  return { key: text.slice(0, colon).trim().toLowerCase(), value: text.slice(colon + 1).trim() }
}

function toRule(entry: { key: string; value: string }): RobotsRule | undefined {
  if (entry.key !== 'allow' && entry.key !== 'disallow') return undefined
  if (entry.value === '' || entry.value.length > MAX_PATTERN_CHARS) return undefined
  return { allow: entry.key === 'allow', pattern: entry.value }
}

/**
 * Rules of the group that applies to `agent`. Consecutive User-agent lines share one group. A
 * group naming the agent replaces the "*" group entirely, even when it is more permissive or
 * has no rules at all: that is how a site addresses one crawler differently from the rest.
 */
export function parseRobots(text: string, agent: string): RobotsRule[] {
  const token = agent.toLowerCase()
  const named: RobotsRule[] = []
  const star: RobotsRule[] = []
  let namedSeen = false
  let group = { named: false, star: false }
  let inAgentList = false
  for (const line of text.split(/\r\n?|\n/u)) {
    const entry = field(line)
    if (!entry || entry.key === 'sitemap') continue
    if (entry.key === 'user-agent') {
      if (!inAgentList) group = { named: false, star: false }
      const value = entry.value.toLowerCase()
      if (value === '*') group.star = true
      if (value === token) group.named = namedSeen = true
      inAgentList = true
      continue
    }
    inAgentList = false
    const rule = toRule(entry)
    if (!rule) continue
    if (group.named && named.length < MAX_RULES) named.push(rule)
    if (group.star && star.length < MAX_RULES) star.push(rule)
  }
  return namedSeen ? named : star
}

/** `*` matches any run of characters and a final `$` anchors the end. Linear scans, no regex. */
function matches(pattern: string, path: string): boolean {
  const anchored = pattern.endsWith('$')
  const pieces = (anchored ? pattern.slice(0, -1) : pattern).split('*')
  const first = pieces[0] ?? ''
  if (!path.startsWith(first)) return false
  let position = first.length
  for (const piece of pieces.slice(1, anchored ? -1 : undefined)) {
    const found = path.indexOf(piece, position)
    if (found === -1) return false
    position = found + piece.length
  }
  if (!anchored) return true
  if (pieces.length === 1) return path.length === first.length
  const last = pieces.at(-1) ?? ''
  return path.length - last.length >= position && path.endsWith(last)
}

export function isAllowed(rules: RobotsRule[], path: string): boolean {
  let decision: RobotsRule | undefined
  for (const rule of rules) {
    if (!matches(rule.pattern, path)) continue
    const longer = !decision || rule.pattern.length > decision.pattern.length
    const tieForAllow = decision?.pattern.length === rule.pattern.length && rule.allow
    if (longer || tieForAllow) decision = rule
  }
  return decision?.allow ?? true
}

function readCached(value: unknown): RobotsRule[] | undefined {
  if (typeof value !== 'object' || value === null || !('rules' in value)) return undefined
  const { rules } = value
  if (!Array.isArray(rules)) return undefined
  const valid = rules.every(
    (rule: unknown) =>
      typeof rule === 'object' &&
      rule !== null &&
      'allow' in rule &&
      typeof rule.allow === 'boolean' &&
      'pattern' in rule &&
      typeof rule.pattern === 'string',
  )
  return valid ? (rules as RobotsRule[]) : undefined
}

export interface RobotsDependencies {
  config: Config
  store: Store
  network?: NetworkDependencies
  /** Runs before each robots.txt request; used for per-host pacing. */
  beforeRequest?: (url: URL, signal: AbortSignal) => Promise<void>
}

export function createRobotsCheck(dependencies: RobotsDependencies): RobotsCheck {
  const { config, store } = dependencies
  const agent = config.userAgent.split(/[/\s]/u)[0] ?? ''

  /** Undefined means "could not find out". A missing file (4xx) means there are no rules. */
  async function download(
    origin: string,
    signal: AbortSignal,
    paced: boolean,
  ): Promise<RobotsRule[] | undefined> {
    const options = {
      userAgent: config.userAgent,
      accept: 'text/plain, */*;q=0.1',
      timeoutMs: Math.min(config.fetch.timeoutMs, MAX_TIMEOUT_MS),
      maxBytes: MAX_BYTES,
      maxRedirects: config.fetch.maxRedirects,
      ...(paced && dependencies.beforeRequest ? { beforeHop: dependencies.beforeRequest } : {}),
    }
    try {
      const response = await safeGet(`${origin}/robots.txt`, options, signal, dependencies.network)
      if (response.status >= 400 && response.status < 500) return []
      if (response.status < 200 || response.status >= 300) return undefined
      const text = response.body.toString('utf8')
      // A "soft 404" HTML page is not a robots file and carries no rules.
      return /^\s*(?:<!doctype\s+html|<html)/iu.test(text) ? [] : parseRobots(text, agent)
    } catch {
      throwIfAborted(signal)
      return undefined
    }
  }

  /** A locked or failing state file must not turn a successful robots check into a page failure. */
  function remember(origin: string, rules: RobotsRule[] | undefined): void {
    try {
      store.putRecord(
        RECORD_KIND,
        origin,
        { rules: rules ?? [] },
        rules ? KNOWN_TTL_S : UNKNOWN_TTL_S,
      )
    } catch {
      // Not cached: the next read asks the host again.
    }
  }

  async function downloadAndStore(
    origin: string,
    signal: AbortSignal,
    paced: boolean,
  ): Promise<RobotsRule[]> {
    const rules = await download(origin, signal, paced)
    // Failing open is deliberate: this reads one page a person asked for, and a broken robots.txt
    // should not be reported as the site's refusal. The short TTL makes the next read ask again.
    remember(origin, rules)
    return rules ?? []
  }

  function cachedRules(origin: string): RobotsRule[] | undefined {
    try {
      return readCached(store.getRecord<unknown>(RECORD_KIND, origin)?.value)
    } catch {
      return undefined
    }
  }

  const pending = new Map<string, Promise<RobotsRule[]>>()

  /** Pages of one host that load together share a single robots.txt request. */
  async function rulesFor(
    origin: string,
    signal: AbortSignal,
    paced: boolean,
  ): Promise<{ rules: RobotsRule[]; downloaded: boolean }> {
    const cached = cachedRules(origin)
    if (cached) return { rules: cached, downloaded: false }
    const shared = pending.get(origin)
    if (shared) {
      try {
        return { rules: await shared, downloaded: false }
      } catch {
        // The request belonged to a caller that was cancelled; carry on with our own.
        throwIfAborted(signal)
      }
    }
    const task = downloadAndStore(origin, signal, paced).finally(() => pending.delete(origin))
    pending.set(origin, task)
    return { rules: await task, downloaded: true }
  }

  return async (url, signal, paced = true) => {
    const { rules, downloaded } = await rulesFor(url.origin, signal, paced)
    if (isAllowed(rules, `${url.pathname}${url.search}`)) return downloaded
    throw new WebError(
      'robots_disallowed',
      "The site's robots.txt disallows automated reading of this path; that is the site's wish, so use another source.",
    )
  }
}
