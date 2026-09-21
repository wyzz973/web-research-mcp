/**
 * Tolerant input handling for web_search. Weaker models often send slightly wrong shapes; what
 * can be repaired without guessing is repaired and explained in `notes`, the rest is rejected
 * with a message that says how to fix it (docs/design/conventions.md, section 7).
 */
import type { Config } from '../config.ts'
import type { Depth, Recency, ResolvedSearch, SearchRequest } from '../contract.ts'
import { WebError } from '../errors.ts'
import { stripInvisible } from '../invisible.ts'
import { headOf } from './cut.ts'
import { siteFromInput } from './url.ts'

export type NormalizedSearch =
  | { kind: 'query'; search: ResolvedSearch }
  | {
      kind: 'cursor'
      cursor: string
      /** Only set when the caller overrides the page size stored with the cursor. */
      maxResults: number | undefined
      maxTokens: number | undefined
      notes: string[]
      /**
       * The search to run when the cursor turns out to be gone. Set when the caller also sent a
       * usable query: it already told us what it wants, so asking it to search again is a wasted turn.
       */
      fallback: ResolvedSearch | undefined
    }

const KNOWN_ARGUMENTS = new Set([
  'query',
  'queries',
  'max_results',
  'goal',
  'sites',
  'recency',
  'depth',
  'max_tokens',
  'cursor',
])
const RECENCIES: readonly Recency[] = ['day', 'week', 'month', 'year']
const DEPTHS: readonly Depth[] = ['fast', 'standard', 'deep']

const MAX_QUERIES = 5
/** Tavily rejects longer queries; the others gain nothing from them. */
const MAX_QUERY_CHARS = 400
const MAX_GOAL_CHARS = 500
const MAX_SITES = 20
/** Below this not even one result fits next to the header. */
const MIN_TOKENS = 200

function invalid(message: string): never {
  throw new WebError('invalid_input', message)
}

function present(value: unknown): boolean {
  if (value === undefined || value === null) return false
  return typeof value !== 'string' || value.trim().length > 0
}

/** Counts what `tidy` took out across one request, so that one note can say so. */
interface Hidden {
  removed: number
}

/**
 * Queries and goals are often pasted text. Characters nobody can see are taken out before anything
 * else: they would split words, miss the cache, and travel on to the sources, where a sentence
 * spelled in tag characters is read by whatever model sits behind the search.
 */
function tidy(text: string, hidden: Hidden): string {
  // Line and page breaks are controls too, but they are whitespace: nothing hidden, not counted.
  const visible = stripInvisible(text.replace(/[\r\v\f\u0085]+/gu, ' '))
  hidden.removed += visible.removed
  return visible.text.normalize('NFC').replace(/\s+/gu, ' ').trim()
}

function hiddenNote(hidden: Hidden): string | undefined {
  if (hidden.removed === 0) return undefined
  return hidden.removed === 1
    ? '1 invisible character was removed from the request.'
    : `${hidden.removed} invisible characters were removed from the request.`
}

/** Cuts at a word boundary when one is near the limit. */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = headOf(text, limit)
  const space = head.lastIndexOf(' ')
  return (space > limit * 0.6 ? head.slice(0, space) : head).trim()
}

function jsonStringArray(text: string): unknown[] | undefined {
  const trimmed = text.trim()
  if (!trimmed.startsWith('[') || !trimmed.endsWith(']')) return undefined
  try {
    const parsed = JSON.parse(trimmed) as unknown
    return Array.isArray(parsed) ? parsed : undefined
  } catch {
    return undefined
  }
}

function listItem(item: unknown, name: string): string[] {
  if (typeof item === 'string') return [item]
  if (typeof item === 'number' && Number.isFinite(item)) return [String(item)]
  if (item === undefined || item === null) return []
  return invalid(`${name} must contain only strings`)
}

function stringList(value: unknown, name: string, notes: string[]): string[] {
  if (!present(value)) return []
  if (Array.isArray(value)) return value.flatMap((item) => listItem(item, name))
  if (typeof value !== 'string') return invalid(`${name} must be a list of strings`)
  const embedded = jsonStringArray(value)
  if (embedded) {
    notes.push(`${name} was a JSON string and was read as a list.`)
    return embedded.flatMap((item) => listItem(item, name))
  }
  notes.push(`${name} was a string and was read as a one-item list.`)
  return [value]
}

/** Numeric strings are read silently: the repair is lossless and CLI flags are always strings. */
function integer(value: unknown, name: string): number | undefined {
  if (!present(value)) return undefined
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && /^[+-]?\d+(?:\.\d+)?$/u.test(value.trim()))
    return Math.trunc(Number(value))
  return invalid(`${name} must be a whole number`)
}

function oneOf<T extends string>(
  value: unknown,
  name: string,
  allowed: readonly T[],
): T | undefined {
  if (!present(value)) return undefined
  const text = typeof value === 'string' ? value.trim().toLowerCase() : undefined
  const found = allowed.find((item) => item === text)
  return found ?? invalid(`${name} must be one of ${allowed.join(', ')}`)
}

function clamp(value: number, low: number, high: number, name: string, notes: string[]): number {
  const bounded = Math.min(Math.max(value, low), high)
  if (bounded !== value) notes.push(`${name} was limited to ${bounded}.`)
  return bounded
}

const BOOLEAN_OPERATOR = /^(?:OR|AND|\|)$/u

/** "fetch timeout site:nodejs.org" -> query "fetch timeout", site "nodejs.org". */
function moveSiteOperators(query: string): { query: string; sites: string[] } {
  const tokens = query.split(' ')
  const sites: string[] = []
  const moved = tokens.map((token) => {
    const operand = /^site:(.+)$/iu.exec(token)?.[1]
    const site = operand ? siteFromInput(operand) : undefined
    if (site) sites.push(site)
    return site !== undefined
  })
  if (sites.length === 0) return { query, sites }
  // "a site:x.com OR site:y.com" must not become "a OR".
  const rest = tokens.filter(
    (token, index) =>
      !moved[index] &&
      !(BOOLEAN_OPERATOR.test(token) && (moved[index - 1] === true || moved[index + 1] === true)),
  )
  // A query that was only an operator still needs words to search for.
  return { query: rest.join(' ') || sites.join(' '), sites }
}

function unique(values: string[]): string[] {
  const seen = new Set<string>()
  return values.filter((value) => {
    const key = value.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function singleQuery(value: unknown, notes: string[]): string[] {
  if (!present(value)) return []
  if (Array.isArray(value)) {
    notes.push('query was a list and was merged into queries.')
    return value.flatMap((item) => listItem(item, 'query'))
  }
  if (typeof value === 'string') return [value]
  if (typeof value === 'number' && Number.isFinite(value)) return [String(value)]
  return invalid('query must be a string')
}

interface Queries {
  queries: string[]
  sites: string[]
}

function resolveQueries(request: SearchRequest, notes: string[], hidden: Hidden): Queries {
  const raw = [
    ...singleQuery(request.query, notes),
    ...stringList(request.queries, 'queries', notes),
  ]
  const moved = raw.map((query) => moveSiteOperators(tidy(query, hidden)))
  const sites = moved.flatMap((entry) => entry.sites)
  if (sites.length) notes.push('site: operators were moved from the query into sites.')
  const texts = moved.map((entry) => entry.query).filter((query) => query.length > 0)
  if (texts.some((query) => query.length > MAX_QUERY_CHARS))
    notes.push(`Queries were shortened to ${MAX_QUERY_CHARS} characters.`)
  const queries = unique(texts.map((query) => clip(query, MAX_QUERY_CHARS)))
  if (queries.length > MAX_QUERIES) notes.push(`Only the first ${MAX_QUERIES} queries were used.`)
  return { queries: queries.slice(0, MAX_QUERIES), sites }
}

function splitSites(value: string, notes: string[]): string[] {
  const entries = value.split(/[,\s]+/u).filter(Boolean)
  if (entries.length) notes.push('sites was a string and was read as a list.')
  return entries
}

function resolveSites(value: unknown, fromQueries: string[], notes: string[]): string[] {
  const entries =
    typeof value === 'string' && !jsonStringArray(value)
      ? splitSites(value, notes)
      : stringList(value, 'sites', notes)
  const hosts = entries.map(
    (entry, index) =>
      siteFromInput(entry) ?? invalid(`sites[${index}] is not a domain name such as "example.com"`),
  )
  const reduced = entries.some((entry, index) => entry.trim().toLowerCase() !== hosts[index])
  if (reduced) notes.push('sites entries were reduced to their domain names.')
  const sites = unique([...hosts, ...fromQueries])
  if (sites.length > MAX_SITES) notes.push(`Only the first ${MAX_SITES} sites were used.`)
  return sites.slice(0, MAX_SITES)
}

function resolveGoal(value: unknown, notes: string[], hidden: Hidden): string | undefined {
  if (!present(value)) return undefined
  if (typeof value !== 'string') return invalid('goal must be a string')
  const goal = tidy(value, hidden)
  // Nothing visible is no goal: an empty one would still count as a different search.
  if (!goal) return undefined
  if (goal.length > MAX_GOAL_CHARS)
    notes.push(`goal was shortened to ${MAX_GOAL_CHARS} characters.`)
  return clip(goal, MAX_GOAL_CHARS)
}

const MAX_NAMES_IN_NOTE = 5
const MAX_NAME_CHARS = 32

/**
 * Notes are printed outside the untrusted block, so nothing a web page wrote may reach them. An
 * argument name comes from the model, but models copy from pages: only identifier characters
 * survive, in a bounded number of bounded names. A name made of nothing else is counted, not shown.
 */
function unknownArguments(request: SearchRequest): string | undefined {
  const unknown = Object.keys(request).filter(
    (name) => !KNOWN_ARGUMENTS.has(name) && present(request[name]),
  )
  if (unknown.length === 0) return undefined
  const names = unknown
    .map((name) => name.replace(/[^A-Za-z0-9_]/gu, '').slice(0, MAX_NAME_CHARS))
    .filter(Boolean)
  const shown = names.slice(0, MAX_NAMES_IN_NOTE)
  const hidden = unknown.length - shown.length
  if (shown.length === 0) return `${unknown.length} unknown arguments were ignored.`
  const more = hidden > 0 ? ` and ${hidden} more` : ''
  return `Unknown arguments were ignored: ${shown.join(', ')}${more}.`
}

const CURSOR_GONE = 'The cursor was not valid or had expired, so the query was searched again.'

/** The cursor as written, or undefined when it cannot be one. */
function resolveCursor(value: unknown): { cursor: string | undefined; given: boolean } {
  if (!present(value)) return { cursor: undefined, given: false }
  if (typeof value !== 'string') return invalid('cursor must be a string')
  const cursor = value.trim().replace(/^["']+|["']+$/gu, '')
  return { cursor: /^c_[a-z0-9]{3,16}$/u.test(cursor) ? cursor : undefined, given: true }
}

function resolveMaxTokens(value: unknown, config: Config, notes: string[]): number | undefined {
  const requested = integer(value, 'max_tokens')
  if (requested === undefined) return undefined
  return clamp(requested, MIN_TOKENS, config.limits.maxOutputTokens, 'max_tokens', notes)
}

function resolveMaxResults(value: unknown, config: Config, notes: string[]): number | undefined {
  const requested = integer(value, 'max_results')
  if (requested === undefined) return undefined
  return clamp(requested, 1, config.limits.searchMaxResults, 'max_results', notes)
}

interface PageShape {
  maxResults: number | undefined
  maxTokens: number | undefined
}

function resolveQuerySearch(
  request: SearchRequest,
  config: Config,
  shape: PageShape,
  notes: string[],
): ResolvedSearch {
  const hidden: Hidden = { removed: 0 }
  const { queries, sites: sitesFromQueries } = resolveQueries(request, notes, hidden)
  if (queries.length === 0) invalid('query is required: pass query, queries, or a cursor')
  const goal = resolveGoal(request.goal, notes, hidden)
  const removed = hiddenNote(hidden)
  if (removed) notes.push(removed)
  return {
    queries,
    maxResults: shape.maxResults ?? config.limits.searchDefaultResults,
    goal,
    sites: resolveSites(request.sites, sitesFromQueries, notes),
    recency: oneOf(request.recency, 'recency', RECENCIES),
    depth: oneOf(request.depth, 'depth', DEPTHS) ?? 'standard',
    maxTokens:
      shape.maxTokens ?? Math.min(config.limits.searchDefaultTokens, config.limits.maxOutputTokens),
    notes,
  }
}

/** The query sent along with a cursor, as a search of its own; undefined when it cannot be one. */
function fallbackSearch(
  request: SearchRequest,
  config: Config,
  shape: PageShape,
  notes: readonly string[],
): ResolvedSearch | undefined {
  if (!present(request.query) && !present(request.queries)) return undefined
  try {
    return resolveQuerySearch(request, config, shape, [CURSOR_GONE, ...notes])
  } catch {
    // While the cursor works the other arguments are ignored, so their flaws must not matter.
    return undefined
  }
}

export function normalizeSearch(request: SearchRequest, config: Config): NormalizedSearch {
  if (typeof request !== 'object' || request === null || Array.isArray(request))
    invalid('arguments must be an object such as {"query": "..."}')
  const notes: string[] = []
  const shape = {
    maxResults: resolveMaxResults(request.max_results, config, notes),
    maxTokens: resolveMaxTokens(request.max_tokens, config, notes),
  }
  const ignored = unknownArguments(request)
  if (ignored) notes.push(ignored)

  const { cursor, given } = resolveCursor(request.cursor)
  if (!given) return { kind: 'query', search: resolveQuerySearch(request, config, shape, notes) }
  const fallback = fallbackSearch(request, config, shape, notes)
  if (cursor) {
    const ignoring = fallback
      ? ['cursor was given, so the other search arguments were ignored.']
      : []
    return { kind: 'cursor', cursor, ...shape, notes: [...notes, ...ignoring], fallback }
  }
  // Not even shaped like a cursor: nothing to look up.
  if (fallback) return { kind: 'query', search: fallback }
  throw new WebError(
    'expired_ref',
    'This cursor is not valid or has expired; run web_search again.',
  )
}
