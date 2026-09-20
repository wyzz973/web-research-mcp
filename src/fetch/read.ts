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
import { selectPassages } from './select.ts'

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
  /** Goal mode found nothing relevant on this page. */
  nothingRelevant?: boolean
  error?: ToolError
}

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

/**
 * Candidates per page, in page order. Pages shown whole contribute all their passages, so that a
 * repost of them on another page is recognized; they take no part in the ranking itself.
 */
function goalCandidates(
  pages: ReadablePage[],
  whole: Set<ReadablePage>,
  options: GoalOptions,
): Candidate[][] {
  const shown = options.shown ?? []
  const documents = pages.map((page) => page.document)
  const isWhole = (index: number): boolean => isShownWhole(pages, whole, index)
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
  return dropReposts(
    lists,
    pages.map((page) => page.n),
  )
}

function isShownWhole(pages: ReadablePage[], whole: Set<ReadablePage>, index: number): boolean {
  const page = pages[index]
  return page !== undefined && whole.has(page)
}

function readWhole(page: ReadablePage, passages: Candidate[]): PageRead {
  const read = readFull(page.document)
  const alsoIn = [...new Set(passages.flatMap((passage) => passage.alsoIn))]
  const part = read.parts[0]
  if (part && alsoIn.length > 0) part.also_in = alsoIn.sort((left, right) => left - right)
  return read
}

/**
 * Evidence mode. Pages that fit are returned whole; for the others the best passages are chosen
 * under one shared budget, widened with context when there is room, and listed in document order.
 */
export function readGoal(pages: ReadablePage[], options: GoalOptions): PageRead[] {
  const shown = options.shown ?? []
  const granted =
    shown.length === 0
      ? pagesShownWhole(pages, options.budget)
      : { whole: new Set<ReadablePage>(), room: options.budget }
  const candidates = goalCandidates(pages, granted.whole, options)
  const single = pages.length === 1 ? pages[0] : undefined
  const outlined =
    single && !granted.whole.has(single)
      ? reserveOutline(single.document.outline, granted.room, options.maxTokens)
      : undefined
  const selections = selectPassages(
    pages.map((page) => page.document),
    candidates.map((list, index) => (isShownWhole(pages, granted.whole, index) ? [] : list)),
    outlined?.room ?? granted.room,
  )
  return pages.map((page, index) => {
    if (granted.whole.has(page)) return readWhole(page, candidates[index] ?? [])
    const selection = selections[index] ?? { parts: [], more: false }
    const read: PageRead = { mode: 'goal', parts: selection.parts, truncated: true }
    if (selection.parts.length === 0 && shown.length === 0) read.nothingRelevant = true
    const delivered: [number, number][] = [
      ...shown,
      ...selection.parts.map((part): [number, number] => [part.start, part.end]),
    ]
    const cursor = selection.more ? goalCursor(page, options.goal, delivered) : undefined
    if (cursor) read.cursor = cursor
    return outlined ? attachOutline(read, outlined) : read
  })
}
