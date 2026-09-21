import type { PagePart } from '../contract.ts'
import { fits, minus, partCost, type Budget } from './budget.ts'
import { makePart } from './range.ts'
import type { PageDocument } from './document.ts'
import { throwIfAborted } from '../errors.ts'
import { foldText, foldTextSliced, MAX_FOLD_CHARS, type Folded } from './visible.ts'

export { foldSteps, foldText, foldTextSliced, MAX_FOLD_CHARS, type Folded } from './visible.ts'

export interface Match {
  start: number
  end: number
  kind: 'exact' | 'normalized'
}

const CONTEXT_CHARS = 200
const SNAP_CHARS = 30
/** Merged contexts stop growing here so one dense paragraph cannot eat the whole budget. */
const MAX_GROUP_CHARS = 1200
/** Cached maps are dropped, oldest first, beyond this many snapshots or this much visible text. */
const CACHE_ENTRIES = 4
const CACHE_CHARS = 4_000_000

/** Resolves to undefined when the snapshot is too large for visible-text matching. */
export type FoldCache = (
  snapshotId: string,
  markdown: string,
  signal: AbortSignal,
) => Promise<Folded | undefined>

type Fold = (markdown: string, signal: AbortSignal) => Promise<Folded | undefined>

/** What is known about one snapshot: its map, or that it is too large to have one. */
interface Known {
  folded: Folded | undefined
  chars: number
  sourceChars: number
}

/**
 * Snapshots never change, so each is folded once and the outcome is kept for the next find,
 * including the outcome that the visible text is too large. Callers that ask for the same
 * snapshot at the same time share one computation; if its owner is cancelled, the others start
 * their own.
 */
export function createFoldCache(fold: Fold = foldTextSliced): FoldCache {
  const ready = new Map<string, Known>()
  const pending = new Map<string, Promise<Folded | undefined>>()

  function remember(snapshotId: string, known: Known): void {
    ready.set(snapshotId, known)
    let total = [...ready.values()].reduce((sum, entry) => sum + entry.chars, 0)
    for (const [id, entry] of ready) {
      if (ready.size <= CACHE_ENTRIES && (total <= CACHE_CHARS || ready.size === 1)) break
      ready.delete(id)
      total -= entry.chars
    }
  }

  /**
   * A snapshot id is unique and its text never changes, so the id alone would do — until an id
   * is swept and issued again while the old entry is still here. The source length is already
   * kept, so checking it costs nothing (seventh audit round).
   */
  function recall(snapshotId: string, sourceChars: number): Known | undefined {
    const hit = ready.get(snapshotId)
    if (!hit || hit.sourceChars !== sourceChars) return undefined
    ready.delete(snapshotId)
    ready.set(snapshotId, hit)
    return hit
  }

  return async (snapshotId, markdown, signal) => {
    if (markdown.length > MAX_FOLD_CHARS) return undefined
    for (;;) {
      const known = recall(snapshotId, markdown.length)
      if (known) return known.folded
      const shared = pending.get(snapshotId)
      if (!shared) break
      try {
        return await shared
      } catch {
        // The computation belonged to a caller that was cancelled; carry on with our own.
        throwIfAborted(signal)
      }
    }
    const task = fold(markdown, signal).finally(() => pending.delete(snapshotId))
    pending.set(snapshotId, task)
    const folded = await task
    remember(snapshotId, {
      folded,
      chars: folded ? folded.text.length : 0,
      sourceChars: markdown.length,
    })
    return folded
  }
}

/** A text that occurs this often is not a quote; counting stops here and the result says so. */
export const MAX_MATCHES = 10_000

/** A combining mark, or the vowel or final consonant of a Hangul syllable written in parts. */
const CONTINUES_CHARACTER = /[\p{M}\u1160-\u11FF\uD7B0-\uD7FF]/uy

/**
 * True when the text goes on inside the character that an occurrence ends in. Letters are
 * compared in their decomposed form, so that both spellings of an accented letter match; read
 * naively, "cafe" would then be found in "caf\u00E9" and one Hangul syllable inside another.
 */
function endsInsideCharacter(text: string, end: number): boolean {
  CONTINUES_CHARACTER.lastIndex = end
  return CONTINUES_CHARACTER.test(text)
}

function allIndexes(haystack: string, needle: string): number[] {
  const found: number[] = []
  let at = haystack.indexOf(needle)
  while (at !== -1 && found.length < MAX_MATCHES) {
    if (!endsInsideCharacter(haystack, at + needle.length)) found.push(at)
    at = haystack.indexOf(needle, at + needle.length)
  }
  return found
}

function normalizedMatches(markdown: string, needle: string, folded: Folded): Match[] {
  const target = foldText(needle)?.text.trim() ?? ''
  if (target === '') return []
  return allIndexes(folded.text, target).map((at) => ({
    start: folded.starts[at] ?? 0,
    end: folded.ends[at + target.length - 1] ?? markdown.length,
    kind: 'normalized' as const,
  }))
}

/** Both lists are sorted and free of overlaps in themselves, so one sweep merges them. */
function mergeMatches(exact: Match[], loose: Match[]): Match[] {
  const merged: Match[] = []
  let next = 0
  for (const match of loose) {
    while (next < exact.length && (exact[next]?.end ?? 0) <= match.start) {
      const hit = exact[next]
      if (hit) merged.push(hit)
      next += 1
    }
    const covered = (exact[next]?.start ?? Number.POSITIVE_INFINITY) < match.end
    if (!covered) merged.push(match)
  }
  return [...merged, ...exact.slice(next)].slice(0, MAX_MATCHES)
}

/**
 * Verbatim occurrences of the Markdown first; then occurrences in the visible text, which ignore
 * links, escapes, emphasis, layout markers, case, and spacing. A visible match runs from its first
 * to its last matched character, markup in between included. The visible text is never computed
 * here: without `folded` (a snapshot too large to fold) only verbatim occurrences are reported.
 */
export function findMatches(markdown: string, needle: string, folded: Folded | undefined): Match[] {
  if (needle.trim() === '') return []
  const exact: Match[] = allIndexes(markdown, needle).map((start) => ({
    start,
    end: start + needle.length,
    kind: 'exact',
  }))
  return folded ? mergeMatches(exact, normalizedMatches(markdown, needle, folded)) : exact
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
  folded: Folded | undefined,
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
