/** Tolerant argument handling: repair what is unambiguous and say so; reject only what is not. */
import type { Config } from '../config.ts'
import type { FetchRequest, FetchTarget, ResolvedFetch } from '../contract.ts'
import { WebError } from '../errors.ts'
import { isSnapshotId, parseRef } from '../ids.ts'

const KNOWN = new Set([
  'url',
  'urls',
  'ref',
  'refs',
  'goal',
  'section',
  'find',
  'max_tokens',
  'cursor',
  'fresh',
  'render',
])
const MIN_TOKENS = 500
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/iu
const LOOKS_LIKE_HOST = /^(?:[\w-]+\.)+[a-z]{2,}(?:[/:?#]|$)/iu
const PARAMETER_NAME = /^[\w-]{1,40}$/u

function invalid(message: string): WebError {
  return new WebError('invalid_input', message)
}

function parseListString(value: string): string[] {
  const trimmed = value.trim()
  if (trimmed.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (Array.isArray(parsed)) return parsed.filter((item) => typeof item === 'string')
    } catch {
      // Not JSON after all; fall through and treat it as plain text.
    }
  }
  return trimmed.split(/,\s+(?=https?:\/\/)|\s+/iu)
}

function stringList(value: unknown, name: string): string[] {
  if (value === undefined || value === null) return []
  const items = typeof value === 'string' ? parseListString(value) : value
  if (!Array.isArray(items) || items.some((item) => typeof item !== 'string'))
    throw invalid(`${name} must be a string or an array of strings`)
  return (items as string[]).map((item) => item.trim()).filter((item) => item !== '')
}

function optionalText(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value !== 'string' && typeof value !== 'number')
    throw invalid(`${name} must be a string`)
  const text = String(value).trim()
  return text === '' ? undefined : text
}

function isRefLike(value: string): boolean {
  return parseRef(value) !== undefined || isSnapshotId(value) || /^r\d{1,3}$/u.test(value)
}

function toTarget(value: string, from: 'url' | 'ref', notes: Set<string>): FetchTarget {
  if (from === 'url' && isRefLike(value)) {
    notes.add('a ref was passed as url; it was read as ref')
    return { ref: value }
  }
  if (from === 'ref' && /^https?:\/\//iu.test(value)) {
    notes.add('a URL was passed as ref; it was read as url')
    return { url: value }
  }
  if (from === 'ref') return { ref: value }
  if (!HAS_SCHEME.test(value) && LOOKS_LIKE_HOST.test(value)) {
    notes.add('added https:// to a URL without a scheme')
    return { url: `https://${value}` }
  }
  return { url: value }
}

function collectTargets(
  request: FetchRequest,
  maxPages: number,
  notes: Set<string>,
): FetchTarget[] {
  const raw = [
    ...stringList(request.url, 'url').map((value) => toTarget(value, 'url', notes)),
    ...stringList(request.urls, 'urls').map((value) => toTarget(value, 'url', notes)),
    ...stringList(request.ref, 'ref').map((value) => toTarget(value, 'ref', notes)),
    ...stringList(request.refs, 'refs').map((value) => toTarget(value, 'ref', notes)),
  ]
  const seen = new Set<string>()
  const targets = raw.filter((target) => {
    const key = target.url ?? `ref:${target.ref ?? ''}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (targets.length < raw.length) notes.add('duplicate targets were read once')
  if (targets.length > maxPages)
    notes.add(`only the first ${maxPages} of ${targets.length} targets were read`)
  return targets.slice(0, maxPages)
}

function resolveMaxTokens(value: unknown, config: Config, notes: Set<string>): number {
  const ceiling = config.limits.maxOutputTokens
  const fallback = Math.min(config.limits.fetchDefaultTokens, ceiling)
  if (value === undefined || value === null || value === '') return fallback
  const parsed = typeof value === 'string' ? Number(value.trim()) : value
  if (typeof parsed !== 'number' || !Number.isFinite(parsed) || parsed <= 0) {
    notes.add(`max_tokens was not a positive number; used ${fallback}`)
    return fallback
  }
  const wanted = Math.floor(parsed)
  if (wanted > ceiling) notes.add(`max_tokens was lowered to the server limit of ${ceiling}`)
  if (wanted < MIN_TOKENS) notes.add(`max_tokens was raised to the minimum of ${MIN_TOKENS}`)
  return Math.min(ceiling, Math.max(MIN_TOKENS, wanted))
}

function resolveFlag(value: unknown): boolean {
  if (typeof value === 'string') return ['true', '1', 'yes'].includes(value.trim().toLowerCase())
  return value === true || value === 1
}

function noteUnknown(request: FetchRequest, notes: Set<string>): void {
  const unknown = Object.keys(request).filter((key) => !KNOWN.has(key))
  if (unknown.length === 0) return
  const named = unknown.filter((key) => PARAMETER_NAME.test(key)).slice(0, 5)
  notes.add(`ignored unknown parameters: ${named.join(', ') || `${unknown.length} unnamed`}`)
}

/** Everything that can be decided without the store or the network. */
export function normalizeFetch(request: FetchRequest, config: Config): ResolvedFetch {
  const notes = new Set<string>()
  noteUnknown(request, notes)
  if (resolveFlag(request.render))
    notes.add('render is not available in this build; the page was read without a browser')
  const cursor = optionalText(request.cursor, 'cursor')
  const targets = collectTargets(request, config.limits.fetchMaxPages, notes)
  const section = optionalText(request.section, 'section')
  if (!cursor && targets.length === 0)
    throw invalid('pass url, urls, ref, or refs to say which page to read')
  if (!cursor && section !== undefined && targets.length > 1)
    throw invalid('section reads one page; pass a single url or ref with it')
  return {
    targets,
    goal: optionalText(request.goal, 'goal'),
    section,
    find: optionalText(request.find, 'find'),
    maxTokens: resolveMaxTokens(request.max_tokens, config, notes),
    cursor,
    fresh: resolveFlag(request.fresh),
    notes: [...notes],
  }
}
