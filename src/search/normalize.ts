/**
 * Tolerant input handling for web_search. Weaker models often send slightly wrong shapes; what
 * can be repaired without guessing is repaired and explained in `notes`, the rest is rejected
 * with a message that says how to fix it (docs/design/conventions.md, section 7).
 */
import type { Config } from '../config.ts'
import type { Depth, Recency, ResolvedSearch, SearchRequest } from '../contract.ts'
import { WebError } from '../errors.ts'
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

function tidy(text: string): string {
  return text.normalize('NFC').replace(/\s+/gu, ' ').trim()
}

/** Cuts at a word boundary when one is near the limit. */
function clip(text: string, limit: number): string {
  if (text.length <= limit) return text
  const head = text.slice(0, limit)
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

function resolveQueries(request: SearchRequest, notes: string[]): Queries {
  const raw = [
    ...singleQuery(request.query, notes),
    ...stringList(request.queries, 'queries', notes),
  ]
  const moved = raw.map((query) => moveSiteOperators(tidy(query)))
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

function resolveGoal(value: unknown, notes: string[]): string | undefined {
  if (!present(value)) return undefined
  if (typeof value !== 'string') return invalid('goal must be a string')
  const goal = tidy(value)
  if (goal.length > MAX_GOAL_CHARS)
    notes.push(`goal was shortened to ${MAX_GOAL_CHARS} characters.`)
  return clip(goal, MAX_GOAL_CHARS)
}

function unknownArguments(request: SearchRequest): string | undefined {
  const names = Object.keys(request)
    .filter((name) => !KNOWN_ARGUMENTS.has(name) && present(request[name]))
    .map((name) => name.replace(/[^\w.-]/gu, '').slice(0, 24))
    .filter(Boolean)
  if (names.length === 0) return undefined
  const shown = names.slice(0, 5).join(', ')
  const more = names.length > 5 ? ` and ${names.length - 5} more` : ''
  return `Unknown arguments were ignored: ${shown}${more}.`
}

function resolveCursor(value: unknown): string | undefined {
  if (!present(value)) return undefined
  if (typeof value !== 'string') return invalid('cursor must be a string')
  const cursor = value.trim().replace(/^["']+|["']+$/gu, '')
  if (/^c_[a-z0-9]{3,16}$/u.test(cursor)) return cursor
  throw new WebError(
    'expired_ref',
    'This cursor is not valid or has expired; run web_search again.',
  )
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

export function normalizeSearch(request: SearchRequest, config: Config): NormalizedSearch {
  if (typeof request !== 'object' || request === null || Array.isArray(request))
    invalid('arguments must be an object such as {"query": "..."}')
  const notes: string[] = []
  const maxResults = resolveMaxResults(request.max_results, config, notes)
  const maxTokens = resolveMaxTokens(request.max_tokens, config, notes)
  const ignored = unknownArguments(request)
  if (ignored) notes.push(ignored)

  const cursor = resolveCursor(request.cursor)
  if (cursor) {
    if (present(request.query) || present(request.queries))
      notes.push('cursor was given, so the other search arguments were ignored.')
    return { kind: 'cursor', cursor, maxResults, maxTokens, notes }
  }

  const { queries, sites: sitesFromQueries } = resolveQueries(request, notes)
  if (queries.length === 0) invalid('query is required: pass query, queries, or a cursor')
  return {
    kind: 'query',
    search: {
      queries,
      maxResults: maxResults ?? config.limits.searchDefaultResults,
      goal: resolveGoal(request.goal, notes),
      sites: resolveSites(request.sites, sitesFromQueries, notes),
      recency: oneOf(request.recency, 'recency', RECENCIES),
      depth: oneOf(request.depth, 'depth', DEPTHS) ?? 'standard',
      maxTokens:
        maxTokens ?? Math.min(config.limits.searchDefaultTokens, config.limits.maxOutputTokens),
      notes,
    },
  }
}
