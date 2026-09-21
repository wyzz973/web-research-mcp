import type { PagePart } from '../contract.ts'
import { fits, minus, PART_OVERHEAD, partCost, plus, share, type Budget } from './budget.ts'
import { tilesTokens, type PageDocument } from './document.ts'
import type { Candidate } from './goal.ts'
import { clipEnd, makePart } from './range.ts'
import { runToEnd } from './slices.ts'

/** A candidate whose display cost has been measured; only the strongest few ever are. */
interface Priced extends Candidate {
  cost: Budget
}

/** A run of consecutive blocks chosen on one page: a ranked passage, possibly widened with context. */
interface Span {
  candidate: Priced
  from: number
  to: number
  /** Where the shown text ends; differs from the last block's end only when that block was cut. */
  end: number
  clipped: boolean
}

export interface PageSelection {
  parts: PagePart[]
  /** Relevant passages exist that the budget did not admit. */
  more: boolean
}

/** What is left for everyone, and what each page has used so far. */
interface Ledger {
  room: Budget
  used: Budget[]
}

const MIN_USEFUL_TOKENS = 40
/** Context added around one passage stops here, so a single hit cannot swallow its whole section. */
const MAX_CONTEXT_CHARS = 1500
/** A page whose passages use less than this part of its fair share gets context around them. */
const CONTEXT_TARGET = 0.5

function byScore(left: Candidate, right: Candidate): number {
  return right.score - left.score || left.page - right.page || left.start - right.start
}

function smaller(left: Budget, right: Budget): Budget {
  return { tokens: Math.min(left.tokens, right.tokens), chars: Math.min(left.chars, right.chars) }
}

function whole(candidate: Priced): Span {
  return {
    candidate,
    from: candidate.from,
    to: candidate.block,
    end: candidate.end,
    clipped: false,
  }
}

/** Best passage that fits the page's fair share; an oversized best passage is cut at a line instead. */
function firstPick(document: PageDocument, ranked: Priced[], room: Budget): Span | undefined {
  const fitting = ranked.find((candidate) => fits(room, candidate.cost))
  if (fitting) return whole(fitting)
  const best = ranked[0]
  if (!best) return undefined
  const end = clipEnd(document.markdown, best.start, best.end, room)
  return end > best.start ? { ...whole(best), end, clipped: true } : undefined
}

function spanCost(document: PageDocument, span: Span): Budget {
  if (!span.clipped) return span.candidate.cost
  return partCost(document.markdown.slice(span.candidate.start, span.end))
}

function spanStart(document: PageDocument, span: Span): number {
  return document.blocks[span.from]?.start ?? span.candidate.start
}

function charge(ledger: Ledger, page: number, cost: Budget): void {
  ledger.room = minus(ledger.room, cost)
  ledger.used[page] = plus(ledger.used[page] ?? { tokens: 0, chars: 0 }, cost)
}

function belowTarget(ledger: Ledger, page: number, target: Budget): boolean {
  const used = ledger.used[page] ?? { tokens: 0, chars: 0 }
  return used.tokens < target.tokens && used.chars < target.chars
}

interface Widening {
  document: PageDocument
  page: number
  covered: Set<number>
  ledger: Ledger
  target: Budget
}

/**
 * Tries to show block `index` with the span. Context never leaves the section: a heading stops
 * it, except that the first block of the section brings its heading along.
 */
function takeNeighbour(context: Widening, span: Span, index: number, added: number): number {
  const { document, covered, ledger } = context
  const block = document.blocks[index]
  if (!block || block.kind === 'heading' || covered.has(index)) return 0
  const backwards = index < span.from
  if (backwards && document.blocks[span.from]?.kind === 'heading') return 0
  const head = backwards && document.blocks[index - 1]?.kind === 'heading' ? index - 1 : index
  const text = backwards
    ? document.markdown.slice(
        document.blocks[head]?.start ?? block.start,
        spanStart(document, span),
      )
    : document.markdown.slice(span.end, block.end)
  // Length first: a neighbour can be megabytes, and pricing reads all of it.
  if (added + text.length > MAX_CONTEXT_CHARS) return 0
  // Charged like a part of its own. That overstates a little, since the text joins an existing
  // part, but every cost in this file is then counted the same way and the total never exceeds
  // the budget.
  const cost = partCost(text)
  if (!fits(ledger.room, cost)) return 0
  if (backwards) span.from = head
  else [span.to, span.end] = [index, block.end]
  for (let shown = Math.min(head, index); shown <= index; shown += 1) covered.add(shown)
  charge(ledger, context.page, cost)
  return text.length
}

/** The block after the passage first, then the one before it, and so on while there is room. */
function widenSpan(context: Widening, span: Span): void {
  let added = 0
  let forward = true
  let backward = true
  while ((forward || backward) && belowTarget(context.ledger, context.page, context.target)) {
    const after: number = forward ? takeNeighbour(context, span, span.to + 1, added) : 0
    added += after
    forward = after > 0
    if (!backward || !belowTarget(context.ledger, context.page, context.target)) continue
    const before: number = takeNeighbour(context, span, span.from - 1, added)
    added += before
    backward = before > 0
  }
}

/**
 * A lone sentence is weak evidence, and an unused budget helps nobody. When a page's passages
 * take less than half of its fair share, the best passages get the text around them, within
 * their own section.
 */
function widenPage(context: Widening, spans: Span[]): void {
  for (const span of spans)
    for (let index = span.from; index <= span.to; index += 1) context.covered.add(index)
  const ranked = [...spans].sort((left, right) => byScore(left.candidate, right.candidate))
  for (const span of ranked) if (!span.clipped) widenSpan(context, span)
}

/** Passages in document order. Passages separated only by whitespace are one passage. */
function toParts(document: PageDocument, spans: Span[]): PagePart[] {
  const parts: PagePart[] = []
  for (const span of [...spans].sort((left, right) => left.from - right.from)) {
    const start = spanStart(document, span)
    const previous = parts.at(-1)
    const joins =
      previous !== undefined &&
      !previous.clipped &&
      start >= previous.end &&
      document.markdown.slice(previous.end, start).trim() === ''
    const part = makePart(document, joins ? previous.start : start, span.end)
    const alsoIn = new Set([...(joins ? (previous.also_in ?? []) : []), ...span.candidate.alsoIn])
    if (alsoIn.size > 0) part.also_in = [...alsoIn].sort((left, right) => left - right)
    if (span.clipped) part.clipped = true
    if (joins) parts.pop()
    parts.push(part)
  }
  return parts
}

function pickFirst(
  documents: PageDocument[],
  candidates: Priced[][],
  fair: Budget,
  ledger: Ledger,
): Span[][] {
  return documents.map((document, page) => {
    const span = firstPick(document, candidates[page] ?? [], smaller(fair, ledger.room))
    if (!span) return []
    charge(ledger, page, spanCost(document, span))
    return [span]
  })
}

function fillByScore(candidates: Priced[][], spans: Span[][], ledger: Ledger): void {
  const taken = new Set(spans.flat().map((span) => span.candidate))
  for (const candidate of candidates.flat().sort(byScore)) {
    if (ledger.room.tokens < MIN_USEFUL_TOKENS) break
    if (taken.has(candidate) || !fits(ledger.room, candidate.cost)) continue
    spans[candidate.page]?.push(whole(candidate))
    charge(ledger, candidate.page, candidate.cost)
  }
}

/** Items handled between two yields. */
const ITEMS_PER_STEP = 4096
/**
 * No budget holds more passages than this: the largest response is 10,000 tokens and every
 * passage costs at least its label. Only these are sorted, priced, and offered to the budget.
 */
const STRONGEST_OVERALL = 2000
/** Each page's own best few, so its guaranteed first passage can be one that fits. */
const STRONGEST_PER_PAGE = 32

/** Keeps the `limit` best items seen so far; the root of the heap is the weakest of them. */
class Strongest {
  private readonly heap: Candidate[] = []
  private readonly limit: number

  constructor(limit: number) {
    this.limit = limit
  }

  offer(candidate: Candidate): void {
    const { heap } = this
    if (heap.length < this.limit) {
      heap.push(candidate)
      this.siftUp(heap.length - 1)
    } else if (heap[0] && byScore(candidate, heap[0]) < 0) {
      heap[0] = candidate
      this.siftDown(0)
    }
  }

  values(): Candidate[] {
    return this.heap
  }

  /** True when the item at `a` is weaker than the item at `b`. */
  private weaker(a: number, b: number): boolean {
    const left = this.heap[a]
    const right = this.heap[b]
    return left !== undefined && right !== undefined && byScore(left, right) > 0
  }

  private swap(a: number, b: number): void {
    const { heap } = this
    const held = heap[a]
    const other = heap[b]
    if (held === undefined || other === undefined) return
    heap[a] = other
    heap[b] = held
  }

  private siftUp(from: number): void {
    let at = from
    while (at > 0) {
      const parent = (at - 1) >> 1
      if (!this.weaker(at, parent)) return
      this.swap(at, parent)
      at = parent
    }
  }

  private siftDown(from: number): void {
    let at = from
    for (;;) {
      const left = 2 * at + 1
      const right = left + 1
      let weakest = at
      if (left < this.heap.length && this.weaker(left, weakest)) weakest = left
      if (right < this.heap.length && this.weaker(right, weakest)) weakest = right
      if (weakest === at) return
      this.swap(at, weakest)
      at = weakest
    }
  }
}

/** Above this a passage is priced from the sizes measured during analysis, not read again. */
const REMEASURE_CHARS = 1 << 16

/**
 * What showing a passage costs. A passage can be one block of megabytes; it will be cut to the
 * budget anyway, so its price comes from the tiles measured once, which is never too low: tiles
 * include the white space after a block.
 */
function candidateCost(document: PageDocument | undefined, candidate: Candidate): Budget {
  if (!document) return partCost('')
  const chars = candidate.end - candidate.start
  if (chars <= REMEASURE_CHARS)
    return partCost(document.markdown.slice(candidate.start, candidate.end))
  return {
    tokens: tilesTokens(document, candidate.from, candidate.block) + PART_OVERHEAD.tokens,
    chars: chars + PART_OVERHEAD.chars,
  }
}

/**
 * A page can have a million relevant passages. Sorting and pricing them all would stall the
 * process for nothing, so one linear pass keeps the strongest overall and per page, and only
 * those go on: best first, with their display cost measured.
 */
function* strongestPriced(
  documents: PageDocument[],
  candidates: Candidate[][],
): Generator<void, Priced[][]> {
  const overall = new Strongest(STRONGEST_OVERALL)
  const perPage = candidates.map(() => new Strongest(STRONGEST_PER_PAGE))
  let seen = 0
  for (const [page, list] of candidates.entries()) {
    for (const candidate of list) {
      overall.offer(candidate)
      perPage[page]?.offer(candidate)
      seen += 1
      if (seen % ITEMS_PER_STEP === 0) yield
    }
  }
  const strongest = new Set(overall.values())
  const priced: Priced[][] = []
  let pending = 0
  for (const page of candidates.keys()) {
    const document = documents[page]
    const kept = new Set(perPage[page]?.values() ?? [])
    for (const candidate of strongest) if (candidate.page === page) kept.add(candidate)
    const list: Priced[] = []
    for (const candidate of [...kept].sort(byScore)) {
      list.push({ ...candidate, cost: candidateCost(document, candidate) })
      pending += Math.min(candidate.end - candidate.start, REMEASURE_CHARS)
      if (pending < REMEASURE_CHARS) continue
      pending = 0
      yield
    }
    priced.push(list)
  }
  return priced
}

/**
 * One budget for all pages: every page with a relevant passage gets its best one first, then the
 * remaining room goes to the highest-scoring passages wherever they are, and what is still left
 * widens the passages of pages that received little.
 */
export function* selectSteps(
  documents: PageDocument[],
  candidates: Candidate[][],
  budget: Budget,
  widen = true,
): Generator<void, PageSelection[]> {
  const priced = yield* strongestPriced(documents, candidates)
  const ledger: Ledger = { room: budget, used: [] }
  const contenders = priced.filter((list) => list.length > 0).length
  const fair = share(budget, contenders)
  const spans = pickFirst(documents, priced, fair, ledger)
  fillByScore(priced, spans, ledger)
  yield
  const target = {
    tokens: Math.floor(fair.tokens * CONTEXT_TARGET),
    chars: Math.floor(fair.chars * CONTEXT_TARGET),
  }
  if (widen)
    documents.forEach((document, page) =>
      widenPage({ document, page, covered: new Set(), ledger, target }, spans[page] ?? []),
    )
  return documents.map((document, page) => ({
    parts: toParts(document, spans[page] ?? []),
    more:
      (candidates[page]?.length ?? 0) > (spans[page]?.length ?? 0) ||
      (spans[page] ?? []).some((span) => span.clipped),
  }))
}

export function selectPassages(
  documents: PageDocument[],
  candidates: Candidate[][],
  budget: Budget,
  widen = true,
): PageSelection[] {
  return runToEnd(selectSteps(documents, candidates, budget, widen))
}
