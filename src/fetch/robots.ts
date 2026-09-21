/**
 * robots.txt, as far as a single-page reader needs it. A group that names our product token is
 * the only one that applies; without one, the "*" group applies. Within the chosen group the
 * longest matching pattern wins and Allow wins a tie. Rules are cached in the shared store, so
 * separate processes (and separate CLI runs) ask each host once an hour, not once per read.
 *
 * Two different kinds of "we do not know the rules" are kept apart. A robots.txt that cannot be
 * fetched leaves the policy unknown, and the page is read. A robots.txt that was published but
 * is too large to evaluate completely is a policy we would knowingly follow only in part, so the
 * host is treated as refusing.
 */
import type { Config } from '../config.ts'
import type { Store } from '../contract.ts'
import { WebError, throwIfAborted } from '../errors.ts'
import { safeGet, type NetworkDependencies } from '../net/safe-http.ts'
import { runSliced, runToEnd } from './slices.ts'

export interface RobotsRule {
  allow: boolean
  pattern: string
}

export interface RobotsPolicy {
  rules: RobotsRule[]
  /** The file holds more than can be evaluated; nothing may be assumed to be allowed. */
  incomplete: boolean
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
/** RFC 9309 asks for at least 500 KiB to be parsed. */
const MAX_BYTES = 512 * 1024
const MAX_TIMEOUT_MS = 5000
/** Not a practical limit: 512 KB of the shortest possible rule lines is about this many. */
export const MAX_RULES = 50_000
export const MAX_PATTERN_CHARS = 1000
/** Longer addresses are matched by their beginning; no real rule reaches this far. */
const MAX_MATCHED_PATH_CHARS = 4096
/** Rules evaluated between two yields. */
const RULES_PER_STEP = 512
const MEMO_ENTRIES = 64

function field(line: string): { key: string; value: string } | undefined {
  const text = line.split('#')[0] ?? ''
  const colon = text.indexOf(':')
  if (colon === -1) return undefined
  return { key: text.slice(0, colon).trim().toLowerCase(), value: text.slice(colon + 1).trim() }
}

function isRule(entry: { key: string; value: string }): boolean {
  return (entry.key === 'allow' || entry.key === 'disallow') && entry.value !== ''
}

/** One group of rules while parsing; `incomplete` once anything in it had to be left out. */
interface Collected {
  rules: RobotsRule[]
  incomplete: boolean
}

function collect(into: Collected, entry: { key: string; value: string }): void {
  if (entry.value.length > MAX_PATTERN_CHARS || into.rules.length >= MAX_RULES) {
    into.incomplete = true
    return
  }
  into.rules.push({ allow: entry.key === 'allow', pattern: entry.value })
}

/**
 * Rules of the group that applies to `agent`. Consecutive User-agent lines share one group. A
 * group naming the agent replaces the "*" group entirely, even when it is more permissive or
 * has no rules at all: that is how a site addresses one crawler differently from the rest.
 */
export function parseRobots(text: string, agent: string): RobotsPolicy {
  const token = agent.toLowerCase()
  const named: Collected = { rules: [], incomplete: false }
  const star: Collected = { rules: [], incomplete: false }
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
    if (!isRule(entry)) continue
    if (group.named) collect(named, entry)
    if (group.star) collect(star, entry)
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

/** Longest match wins and Allow wins a tie, evaluated in steps so that a huge file can pause. */
export function* allowedSteps(rules: RobotsRule[], fullPath: string): Generator<void, boolean> {
  const path = fullPath.slice(0, MAX_MATCHED_PATH_CHARS)
  let decision: RobotsRule | undefined
  for (const [index, rule] of rules.entries()) {
    if (index % RULES_PER_STEP === RULES_PER_STEP - 1) yield
    if (!matches(rule.pattern, path)) continue
    const longer = !decision || rule.pattern.length > decision.pattern.length
    const tieForAllow = decision?.pattern.length === rule.pattern.length && rule.allow
    if (longer || tieForAllow) decision = rule
  }
  return decision?.allow ?? true
}

export function isAllowed(rules: RobotsRule[], path: string): boolean {
  return runToEnd(allowedSteps(rules, path))
}

function isRuleList(value: unknown): value is RobotsRule[] {
  return (
    Array.isArray(value) &&
    value.every(
      (rule: unknown) =>
        typeof rule === 'object' &&
        rule !== null &&
        'allow' in rule &&
        typeof rule.allow === 'boolean' &&
        'pattern' in rule &&
        typeof rule.pattern === 'string',
    )
  )
}

function readCached(value: unknown): RobotsPolicy | undefined {
  if (typeof value !== 'object' || value === null || !('rules' in value)) return undefined
  if (!isRuleList(value.rules)) return undefined
  return { rules: value.rules, incomplete: 'incomplete' in value && value.incomplete === true }
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

  const NO_RULES: RobotsPolicy = { rules: [], incomplete: false }

  /** Undefined means "could not find out". A missing file (4xx) means there are no rules. */
  async function download(
    origin: string,
    signal: AbortSignal,
    paced: boolean,
  ): Promise<RobotsPolicy | undefined> {
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
      if (response.status >= 400 && response.status < 500) return NO_RULES
      if (response.status < 200 || response.status >= 300) return undefined
      const text = response.body.toString('utf8')
      // A "soft 404" HTML page is not a robots file and carries no rules.
      return /^\s*(?:<!doctype\s+html|<html)/iu.test(text) ? NO_RULES : parseRobots(text, agent)
    } catch (error) {
      throwIfAborted(signal)
      // A published file that is larger than we read is a policy we cannot evaluate, not a missing one.
      if (error instanceof WebError && error.code === 'too_large')
        return { rules: [], incomplete: true }
      return undefined
    }
  }

  /** Parsed policies of recently used hosts, so that a large record is not re-read for every hop. */
  const memo = new Map<string, { policy: RobotsPolicy; expires: number }>()

  function memoize(origin: string, policy: RobotsPolicy, ttlSeconds: number): void {
    memo.delete(origin)
    memo.set(origin, { policy, expires: Date.now() + ttlSeconds * 1000 })
    const oldest = memo.size > MEMO_ENTRIES ? memo.keys().next().value : undefined
    if (oldest !== undefined) memo.delete(oldest)
  }

  /** A locked or failing state file must not turn a successful robots check into a page failure. */
  function remember(origin: string, policy: RobotsPolicy | undefined): void {
    const ttlSeconds = policy ? KNOWN_TTL_S : UNKNOWN_TTL_S
    memoize(origin, policy ?? NO_RULES, ttlSeconds)
    try {
      store.putRecord(RECORD_KIND, origin, policy ?? NO_RULES, ttlSeconds)
    } catch {
      // Not cached across processes: the next process asks the host again.
    }
  }

  async function downloadAndStore(
    origin: string,
    signal: AbortSignal,
    paced: boolean,
  ): Promise<RobotsPolicy> {
    const policy = await download(origin, signal, paced)
    // Failing open is deliberate: this reads one page a person asked for, and a broken robots.txt
    // should not be reported as the site's refusal. The short TTL makes the next read ask again.
    remember(origin, policy)
    return policy ?? NO_RULES
  }

  function cachedPolicy(origin: string): RobotsPolicy | undefined {
    const known = memo.get(origin)
    if (known && known.expires > Date.now()) return known.policy
    try {
      return readCached(store.getRecord<unknown>(RECORD_KIND, origin)?.value)
    } catch {
      return undefined
    }
  }

  const pending = new Map<string, Promise<RobotsPolicy>>()

  /** Pages of one host that load together share a single robots.txt request. */
  async function policyFor(
    origin: string,
    signal: AbortSignal,
    paced: boolean,
  ): Promise<{ policy: RobotsPolicy; downloaded: boolean }> {
    const cached = cachedPolicy(origin)
    if (cached) return { policy: cached, downloaded: false }
    const shared = pending.get(origin)
    if (shared) {
      try {
        return { policy: await shared, downloaded: false }
      } catch {
        // The request belonged to a caller that was cancelled; carry on with our own.
        throwIfAborted(signal)
      }
    }
    const task = downloadAndStore(origin, signal, paced).finally(() => pending.delete(origin))
    pending.set(origin, task)
    return { policy: await task, downloaded: true }
  }

  return async (url, signal, paced = true) => {
    const { policy, downloaded } = await policyFor(url.origin, signal, paced)
    if (policy.incomplete)
      throw new WebError(
        'robots_disallowed',
        "The site's robots.txt has more rules than can be evaluated completely, so the site is treated as refusing automated reading. This is not an explicit refusal of this path; use another source.",
      )
    const allowed = await runSliced(
      allowedSteps(policy.rules, `${url.pathname}${url.search}`),
      signal,
    )
    if (allowed) return downloaded
    throw new WebError(
      'robots_disallowed',
      "The site's robots.txt disallows automated reading of this path; that is the site's wish, so use another source.",
    )
  }
}
