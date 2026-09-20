import type { PagePart } from '../contract.ts'
import { fits, minus, partCost, type Budget } from './budget.ts'
import { makePart } from './range.ts'
import type { PageDocument } from './document.ts'

export interface Match {
  start: number
  end: number
  kind: 'exact' | 'normalized'
}

const CONTEXT_CHARS = 200
const SNAP_CHARS = 30
/** Merged contexts stop growing here so one dense paragraph cannot eat the whole budget. */
const MAX_GROUP_CHARS = 1200
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u00AB\u00BB\u300C\u300D\u300E\u300F\uFF02]/u
const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032\uFF07`]/u
const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/u
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/u

/** Case, whitespace runs, quote and dash styles, and Markdown emphasis or escapes do not count. */
function fold(char: string, next: string | undefined): string {
  if (char === '\\' && next !== undefined && ASCII_PUNCTUATION.test(next)) return ''
  if (char === '*') return ''
  if (/\s/u.test(char)) return ' '
  if (DOUBLE_QUOTES.test(char)) return '"'
  if (SINGLE_QUOTES.test(char)) return "'"
  if (DASHES.test(char)) return '-'
  return char.charCodeAt(0) < 128 ? char.toLowerCase() : char.normalize('NFKC').toLowerCase()
}

export interface Folded {
  text: string
  /** For each folded UTF-16 unit, the source span it came from. */
  starts: Int32Array
  ends: Int32Array
}

/** Walks code points but records UTF-16 offsets, the unit every snapshot offset is expressed in. */
export function foldText(source: string): Folded {
  const pieces: string[] = []
  const starts: number[] = []
  const ends: number[] = []
  let offset = 0
  let lastWasSpace = true
  for (const char of source) {
    const folded = fold(char, source[offset + char.length])
    const skip = folded === '' || (folded === ' ' && lastWasSpace)
    if (!skip) {
      pieces.push(folded)
      for (let unit = 0; unit < folded.length; unit += 1) {
        starts.push(offset)
        ends.push(offset + char.length)
      }
      lastWasSpace = folded === ' '
    }
    offset += char.length
  }
  return { text: pieces.join(''), starts: Int32Array.from(starts), ends: Int32Array.from(ends) }
}

export type FoldCache = (snapshotId: string, markdown: string) => Folded

/** Folding a long document costs tens of milliseconds; snapshots never change, so keep a few. */
export function createFoldCache(capacity = 4): FoldCache {
  const cache = new Map<string, Folded>()
  return (snapshotId, markdown) => {
    const hit = cache.get(snapshotId)
    if (hit) {
      cache.delete(snapshotId)
      cache.set(snapshotId, hit)
      return hit
    }
    const folded = foldText(markdown)
    cache.set(snapshotId, folded)
    const oldest = cache.size > capacity ? cache.keys().next().value : undefined
    if (oldest !== undefined) cache.delete(oldest)
    return folded
  }
}

function allIndexes(haystack: string, needle: string): number[] {
  const found: number[] = []
  for (
    let at = haystack.indexOf(needle);
    at !== -1;
    at = haystack.indexOf(needle, at + needle.length)
  )
    found.push(at)
  return found
}

function normalizedMatches(markdown: string, needle: string, folded: Folded): Match[] {
  const target = foldText(needle).text.trim()
  if (target === '') return []
  return allIndexes(folded.text, target).map((at) => ({
    start: folded.starts[at] ?? 0,
    end: folded.ends[at + target.length - 1] ?? markdown.length,
    kind: 'normalized' as const,
  }))
}

/** Verbatim occurrences first; folded occurrences are added where no verbatim one already covers them. */
export function findMatches(markdown: string, needle: string, folded?: Folded): Match[] {
  if (needle.trim() === '') return []
  const exact: Match[] = allIndexes(markdown, needle).map((start) => ({
    start,
    end: start + needle.length,
    kind: 'exact',
  }))
  const loose = normalizedMatches(markdown, needle, folded ?? foldText(markdown)).filter(
    (match) => !exact.some((hit) => match.start < hit.end && match.end > hit.start),
  )
  return [...exact, ...loose].sort((left, right) => left.start - right.start)
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

function contextStart(markdown: string, matchStart: number, floor: number): number {
  const rough = Math.max(floor, matchStart - CONTEXT_CHARS)
  const window = markdown.slice(Math.max(floor, rough - SNAP_CHARS), rough)
  const space = window.search(/\s\S*$/u)
  const start = space === -1 ? rough : rough - window.length + space + 1
  return isLowSurrogate(markdown.charCodeAt(start)) ? start - 1 : start
}

function contextEnd(markdown: string, matchEnd: number): number {
  const rough = Math.min(markdown.length, matchEnd + CONTEXT_CHARS)
  const space = markdown.slice(rough, rough + SNAP_CHARS).search(/\s/u)
  const end = space === -1 ? rough : rough + space
  return isLowSurrogate(markdown.charCodeAt(end)) ? end + 1 : end
}

interface Group {
  start: number
  end: number
  first: Match
  count: number
}

/**
 * Neighbouring matches share one context instead of repeating the same text. When a group is
 * full, the previous context gives up its tail, so parts never overlap and never leave a gap
 * between matches that sit close together.
 */
function groupMatches(markdown: string, matches: Match[]): Group[] {
  const groups: Group[] = []
  for (const match of matches) {
    const last = groups.at(-1)
    const end = contextEnd(markdown, match.end)
    if (last && match.start < last.end && end - last.start <= MAX_GROUP_CHARS) {
      last.end = Math.max(last.end, end)
      last.count += 1
      continue
    }
    if (last && match.start < last.end) last.end = match.start
    const start = contextStart(markdown, match.start, last?.end ?? 0)
    groups.push({ start: Math.max(start, last?.end ?? 0), end, first: match, count: 1 })
  }
  return groups
}

function toPart(document: PageDocument, group: Group): PagePart {
  const part = makePart(document, group.start, group.end)
  const located = makePart(document, group.first.start, group.first.end)
  if (located.section !== undefined) part.section = located.section
  if (located.heading !== undefined) part.heading = located.heading
  part.match = group.first.kind
  part.match_start = group.first.start
  part.match_end = group.first.end
  if (group.count > 1) part.match_count = group.count
  return part
}

export interface FindRead {
  parts: PagePart[]
  total: number
  /** Number of matches consumed so far, counting the skipped ones; the cursor resumes here. */
  consumed: number
}

/** Matches from index `from` onward, as many as the budget allows and never fewer than one. */
export function readMatches(
  document: PageDocument,
  needle: string,
  from: number,
  budget: Budget,
  folded?: Folded,
): FindRead {
  const matches = findMatches(document.markdown, needle, folded)
  const parts: PagePart[] = []
  let room = budget
  let consumed = Math.min(from, matches.length)
  for (const group of groupMatches(document.markdown, matches.slice(consumed))) {
    const part = toPart(document, group)
    const cost = partCost(part.text)
    if (parts.length > 0 && !fits(room, cost)) break
    parts.push(part)
    room = minus(room, cost)
    consumed += group.count
  }
  return { parts, total: matches.length, consumed }
}
