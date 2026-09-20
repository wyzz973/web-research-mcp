/** The five ways to read a snapshot. Pure: no network, no store; every part is a verbatim slice. */
import type { OutlineEntry, PagePart, ReadMode, ToolError } from '../contract.ts'
import { estimateTokens } from '../tokens.ts'
import { atLeast, fits, minus, MIN_CONTENT, PART_OVERHEAD, share, type Budget } from './budget.ts'
import { MAX_SHOWN_RANGES, type CursorState } from './cursor.ts'
import type { PageDocument } from './document.ts'
import { readMatches, type FoldCache } from './find.ts'
import {
  dropReposts,
  keepRelevant,
  rankPassages,
  wholePagePassages,
  type Candidate,
} from './goal.ts'
import { fitOutline } from './outline.ts'
import { makePart, readRange } from './range.ts'
import { findSection, nearestSectionIds } from './section.ts'
import { selectPassages, type PageSelection } from './select.ts'

export interface ReadablePage {
  n: number
  snapshot: string
  document: PageDocument
}

export interface PageRead {
  mode: ReadMode
  parts: PagePart[]
  truncated: boolean
  cursor?: CursorState
  findTotal?: number
  outline?: OutlineEntry[]
  /** Outline entries that did not fit even after dropping every deeper level. */
  outlineDropped?: number
  /** Goal mode: no passage matched the goal terms, so the beginning of the page is shown instead. */
  nothingRelevant?: boolean
  /** Goal mode: every relevant passage of this page was already shown from another page. */
  onlyReposts?: boolean
  error?: ToolError
}

/** How many look-alike passages stand in for a find that matched nothing. */
const CLOSEST_PASSAGES = 3
/** Share of `max_tokens` an outline may use before it starts losing levels. */
const OUTLINE_SHARE = 0.15

function fullCost(document: PageDocument): Budget {
  return {
    tokens: document.totalTokens + PART_OVERHEAD.tokens,
    chars: document.markdown.length + PART_OVERHEAD.chars,
  }
}

function readFull(document: PageDocument): PageRead {
  return {
    mode: 'full',
    parts: [makePart(document, 0, document.markdown.length)],
    truncated: false,
  }
}

function readCursorState(
  snapshot: string,
  part: PagePart | undefined,
  end: number,
): CursorState | undefined {
  if (!part || part.end >= end) return undefined
  return { kind: 'read', snapshot, offset: part.end }
}

interface Outlined {
  room: Budget
  entries: OutlineEntry[]
  dropped: number
}

/** The outline is paid for out of the same budget as the content it helps to navigate. */
function reserveOutline(entries: OutlineEntry[], budget: Budget, maxTokens: number): Outlined {
  const fitted = fitOutline(entries, Math.floor(maxTokens * OUTLINE_SHARE))
  const room = atLeast(minus(budget, { tokens: fitted.tokens, chars: fitted.chars }), MIN_CONTENT)
  return { room, entries: fitted.entries, dropped: fitted.dropped }
}

function attachOutline(read: PageRead, outlined: Outlined): PageRead {
  if (outlined.entries.length > 0) read.outline = outlined.entries
  if (outlined.dropped > 0) read.outlineDropped = outlined.dropped
  return read
}

/** No goal, section, or find: the whole page when it fits, otherwise its beginning plus a map. */
export function readLead(page: ReadablePage, budget: Budget, maxTokens: number): PageRead {
  const { document, snapshot } = page
  if (fits(budget, fullCost(document))) return readFull(document)
  const outlined = reserveOutline(document.outline, budget, maxTokens)
  const part = readRange(document, 0, document.markdown.length, outlined.room)
  const read: PageRead = { mode: 'lead', parts: part ? [part] : [], truncated: true }
  const cursor = readCursorState(snapshot, part, document.markdown.length)
  if (cursor) read.cursor = cursor
  return attachOutline(read, outlined)
}

function sectionMissing(outline: OutlineEntry[], requested: string): ToolError {
  if (outline.length === 0)
    return {
      code: 'invalid_input',
      message:
        'This page has no headings, so it has no sections; read it with find or without section.',
    }
  const nearest = nearestSectionIds(outline, requested).join(', ')
  return {
    code: 'invalid_input',
    message: `No such section in this page. Closest section ids: ${nearest}. Omit section to get the outline.`,
  }
}

export function readSection(
  page: ReadablePage,
  requested: string,
  budget: Budget,
  maxTokens: number,
): PageRead {
  const { document, snapshot } = page
  const entry = findSection(document.outline, requested)
  if (!entry)
    return {
      mode: 'section',
      parts: [],
      truncated: false,
      error: sectionMissing(document.outline, requested),
    }
  const whole = readRange(document, entry.start, entry.end, budget)
  if (whole && whole.end >= entry.end) return { mode: 'section', parts: [whole], truncated: false }
  // An oversized section gets a map of its own subsections, so the next call can be precise.
  const inside = document.outline.filter((sub) => sub.start > entry.start && sub.end <= entry.end)
  const outlined = reserveOutline(inside, budget, maxTokens)
  const part = readRange(document, entry.start, entry.end, outlined.room)
  const read: PageRead = { mode: 'section', parts: part ? [part] : [], truncated: true }
  if (part) read.cursor = { kind: 'read', snapshot, offset: part.end, end: entry.end }
  return attachOutline(read, outlined)
}

/** Continue a lead, section, or cursor read from the stored offset. */
export function readOnward(
  page: ReadablePage,
  state: Extract<CursorState, { kind: 'read' }>,
  budget: Budget,
): PageRead {
  const { document, snapshot } = page
  const limit = Math.min(state.end ?? document.markdown.length, document.markdown.length)
  const part = readRange(document, Math.min(state.offset, limit), limit, budget)
  const read: PageRead = { mode: 'cursor', parts: part ? [part] : [], truncated: false }
  if (part && part.end < limit) {
    read.truncated = true
    read.cursor = { kind: 'read', snapshot, offset: part.end }
    if (state.end !== undefined) read.cursor.end = state.end
  }
  return read
}

function spent(parts: PagePart[]): Budget {
  return parts.reduce(
    (sum, part) => ({
      tokens: sum.tokens + estimateTokens(part.text) + PART_OVERHEAD.tokens,
      chars: sum.chars + part.text.length + PART_OVERHEAD.chars,
    }),
    { tokens: 0, chars: 0 },
  )
}

/** Each page gets an equal slice of what is left, so an early page cannot starve a later one. */
export function readFind(
  pages: ReadablePage[],
  needle: string,
  from: number,
  budget: Budget,
  fold?: FoldCache,
): PageRead[] {
  let room = budget
  return pages.map((page, index) => {
    const folded = fold?.(page.snapshot, page.document.markdown)
    const slice = share(room, pages.length - index)
    const found = readMatches(page.document, needle, from, slice, folded)
    room = minus(room, spent(found.parts))
    const read: PageRead = {
      mode: 'find',
      parts: found.parts,
      truncated: found.consumed < found.total,
      findTotal: found.total,
    }
    if (read.truncated)
      read.cursor = { kind: 'find', snapshot: page.snapshot, find: needle, from: found.consumed }
    return read
  })
}

function overlapsShown(candidate: Candidate, shown: [number, number][]): boolean {
  return shown.some(([start, end]) => candidate.start < end && candidate.end > start)
}

function goalCursor(
  page: ReadablePage,
  goal: string,
  shown: [number, number][],
): CursorState | undefined {
  return shown.length > MAX_SHOWN_RANGES
    ? undefined
    : { kind: 'goal', snapshot: page.snapshot, goal, shown }
}

/**
 * A page whose whole text costs no more than its fair share is shown whole: a complete short
 * page beats excerpts of it. Each grant frees room, so the share is recomputed until no further
 * page fits.
 */
function pagesShownWhole(
  pages: ReadablePage[],
  budget: Budget,
): { whole: Set<ReadablePage>; room: Budget } {
  const whole = new Set<ReadablePage>()
  let room = budget
  for (;;) {
    const pending = pages.filter((page) => !whole.has(page))
    const fair = share(room, pending.length)
    const fitting = pending.filter((page) => fits(fair, fullCost(page.document)))
    if (fitting.length === 0) return { whole, room }
    for (const page of fitting) {
      whole.add(page)
      room = minus(room, fullCost(page.document))
    }
  }
}

export interface GoalOptions {
  goal: string
  budget: Budget
  maxTokens: number
  /** Ranges already delivered by earlier calls of the same cursor chain (single page only). */
  shown?: [number, number][]
}

interface GoalCandidates {
  lists: Candidate[][]
  /** Pages on which at least one passage matched the goal, before reposts were removed. */
  matched: boolean[]
}

/**
 * Candidates per page, in page order. Pages shown whole contribute all their passages, so that a
 * repost of them on another page is recognized; they take no part in the ranking itself.
 */
function goalCandidates(
  pages: ReadablePage[],
  whole: Set<ReadablePage>,
  options: GoalOptions,
): GoalCandidates {
  const shown = options.shown ?? []
  const documents = pages.map((page) => page.document)
  const isWhole = (index: number): boolean => memberAt(pages, whole, index)
  const ranked = rankPassages(documents, options.goal).map((list, index) =>
    isWhole(index) ? [] : list,
  )
  // The floor is taken before removing what was already shown, so a cursor chain ends when
  // relevance runs out instead of sliding down to ever weaker passages.
  const lists = keepRelevant(ranked).map((list, index) => {
    const document = documents[index]
    if (document && isWhole(index)) return wholePagePassages(document, index)
    return list.filter((candidate) => !overlapsShown(candidate, shown))
  })
  return {
    lists: dropReposts(
      lists,
      pages.map((page) => page.n),
    ),
    matched: ranked.map((list) => list.length > 0),
  }
}

function memberAt(pages: ReadablePage[], set: Set<ReadablePage>, index: number): boolean {
  const page = pages[index]
  return page !== undefined && set.has(page)
}

function readWhole(page: ReadablePage, passages: Candidate[]): PageRead {
  const read = readFull(page.document)
  const alsoIn = [...new Set(passages.flatMap((passage) => passage.alsoIn))]
  const part = read.parts[0]
  if (part && alsoIn.length > 0) part.also_in = alsoIn.sort((left, right) => left - right)
  return read
}

/**
 * Words are matched literally, so a page about "abort" has no passage for a goal that says
 * "cancel". Such a page is still worth reading: it gets the default view, its beginning and its
 * outline, within its fair share of what is left.
 */
function readUnmatched(
  pages: ReadablePage[],
  unmatched: Set<ReadablePage>,
  room: Budget,
  pending: number,
  maxTokens: number,
): { reads: Map<ReadablePage, PageRead>; room: Budget } {
  const reads = new Map<ReadablePage, PageRead>()
  const fair = share(room, pending)
  let left = room
  for (const page of pages) {
    if (!unmatched.has(page)) continue
    const read = readLead(page, fair, pages.length === 1 ? maxTokens : fair.tokens)
    read.nothingRelevant = true
    reads.set(page, read)
    left = minus(left, fair)
  }
  return { reads, room: left }
}

function readSelected(
  page: ReadablePage,
  selection: PageSelection,
  options: GoalOptions,
  matched: boolean,
): PageRead {
  const shown = options.shown ?? []
  const read: PageRead = { mode: 'goal', parts: selection.parts, truncated: true }
  if (selection.parts.length === 0 && shown.length === 0 && matched) read.onlyReposts = true
  const delivered: [number, number][] = [
    ...shown,
    ...selection.parts.map((part): [number, number] => [part.start, part.end]),
  ]
  const cursor = selection.more ? goalCursor(page, options.goal, delivered) : undefined
  if (cursor) read.cursor = cursor
  return read
}

/**
 * Evidence mode. Pages that fit are returned whole; pages without any matching passage get the
 * default view; for the others the best passages are chosen under one shared budget, widened
 * with context when there is room, and listed in document order.
 */
export function readGoal(pages: ReadablePage[], options: GoalOptions): PageRead[] {
  const firstCall = (options.shown ?? []).length === 0
  const granted = firstCall
    ? pagesShownWhole(pages, options.budget)
    : { whole: new Set<ReadablePage>(), room: options.budget }
  const candidates = goalCandidates(pages, granted.whole, options)
  const unmatched = new Set(
    pages.filter(
      (page, index) => firstCall && !granted.whole.has(page) && !candidates.matched[index],
    ),
  )
  const fallback = readUnmatched(
    pages,
    unmatched,
    granted.room,
    pages.length - granted.whole.size,
    options.maxTokens,
  )
  const single = pages.length === 1 ? pages[0] : undefined
  const outlined =
    single && !granted.whole.has(single) && !unmatched.has(single)
      ? reserveOutline(single.document.outline, fallback.room, options.maxTokens)
      : undefined
  const selections = selectPassages(
    pages.map((page) => page.document),
    candidates.lists.map((list, index) =>
      memberAt(pages, granted.whole, index) || memberAt(pages, unmatched, index) ? [] : list,
    ),
    outlined?.room ?? fallback.room,
  )
  return pages.map((page, index) => {
    if (granted.whole.has(page)) return readWhole(page, candidates.lists[index] ?? [])
    const unmatchedRead = fallback.reads.get(page)
    if (unmatchedRead) return unmatchedRead
    const selection = selections[index] ?? { parts: [], more: false }
    const read = readSelected(page, selection, options, candidates.matched[index] ?? false)
    return outlined ? attachOutline(read, outlined) : read
  })
}

/**
 * find had no match at all. The passages that share the most words with the text are shown in
 * its place, so the call is not a dead end; they carry no `match`, because they are not one.
 */
export function readClosest(pages: ReadablePage[], needle: string, budget: Budget): PageRead[] {
  const documents = pages.map((page) => page.document)
  const closest = keepRelevant(rankPassages(documents, needle)).map((list) =>
    list.toSorted((left, right) => right.score - left.score).slice(0, CLOSEST_PASSAGES),
  )
  const selections = selectPassages(documents, closest, budget, false)
  return pages.map((_, index) => ({
    mode: 'find',
    parts: selections[index]?.parts ?? [],
    truncated: false,
    findTotal: 0,
  }))
}
