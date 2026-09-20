import type { PagePart } from '../contract.ts'
import { estimateTokens } from '../tokens.ts'
import { fits, minus, partCost, share, type Budget } from './budget.ts'
import type { PageDocument } from './document.ts'
import type { Candidate } from './goal.ts'
import { clipEnd, makePart } from './range.ts'

/** A run of consecutive blocks chosen on one page: a ranked passage, possibly widened with context. */
interface Span {
  candidate: Candidate
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

function plus(left: Budget, right: Budget): Budget {
  return { tokens: left.tokens + right.tokens, chars: left.chars + right.chars }
}

function whole(candidate: Candidate): Span {
  return {
    candidate,
    from: candidate.from,
    to: candidate.block,
    end: candidate.end,
    clipped: false,
  }
}

/** Best passage that fits the page's fair share; an oversized best passage is cut at a line instead. */
function firstPick(document: PageDocument, ranked: Candidate[], room: Budget): Span | undefined {
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
  const cost = { tokens: estimateTokens(text), chars: text.length }
  if (added + cost.chars > MAX_CONTEXT_CHARS || !fits(ledger.room, cost)) return 0
  if (backwards) span.from = head
  else [span.to, span.end] = [index, block.end]
  for (let shown = Math.min(head, index); shown <= index; shown += 1) covered.add(shown)
  charge(ledger, context.page, cost)
  return cost.chars
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
  candidates: Candidate[][],
  fair: Budget,
  ledger: Ledger,
): Span[][] {
  return documents.map((document, page) => {
    const ranked = [...(candidates[page] ?? [])].sort(byScore)
    const span = firstPick(document, ranked, smaller(fair, ledger.room))
    if (!span) return []
    charge(ledger, page, spanCost(document, span))
    return [span]
  })
}

function fillByScore(candidates: Candidate[][], spans: Span[][], ledger: Ledger): void {
  const taken = new Set(spans.flat().map((span) => span.candidate))
  for (const candidate of candidates.flat().sort(byScore)) {
    if (ledger.room.tokens < MIN_USEFUL_TOKENS) break
    if (taken.has(candidate) || !fits(ledger.room, candidate.cost)) continue
    spans[candidate.page]?.push(whole(candidate))
    charge(ledger, candidate.page, candidate.cost)
  }
}

/**
 * One budget for all pages: every page with a relevant passage gets its best one first, then the
 * remaining room goes to the highest-scoring passages wherever they are, and what is still left
 * widens the passages of pages that received little.
 */
export function selectPassages(
  documents: PageDocument[],
  candidates: Candidate[][],
  budget: Budget,
  widen = true,
): PageSelection[] {
  const ledger: Ledger = { room: budget, used: [] }
  const contenders = candidates.filter((list) => list.length > 0).length
  const fair = share(budget, contenders)
  const spans = pickFirst(documents, candidates, fair, ledger)
  fillByScore(candidates, spans, ledger)
  const target = {
    tokens: Math.floor(fair.tokens * CONTEXT_TARGET),
    chars: Math.floor(fair.chars * CONTEXT_TARGET),
  }
  if (widen)
    documents.forEach((document, page) =>
      widenPage({ document, page, covered: new Set(), ledger, target }, spans[page] ?? []),
    )
  return documents.map((document, page) => {
    const chosen = new Set((spans[page] ?? []).map((span) => span.candidate))
    return {
      parts: toParts(document, spans[page] ?? []),
      more:
        (candidates[page] ?? []).some((candidate) => !chosen.has(candidate)) ||
        (spans[page] ?? []).some((span) => span.clipped),
    }
  })
}
