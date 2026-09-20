/**
 * Excerpt selection: the most query-relevant run of consecutive sentences that fits a budget.
 * Text is never rewritten. The only characters we add are "…" where source text was left out and
 * a closing code fence when a cut would otherwise leave one open.
 */
import { charsWithinTokens, estimateTokens } from '../tokens.ts'
import type { Term } from './terms.ts'

export interface ExcerptLimit {
  tokens: number
  chars: number
}

/** Separates passages that are not contiguous in the source page. */
export const PASSAGE_GAP = '\n…\n'

const GAP_TOKENS = 2
const GAP_CHARS = PASSAGE_GAP.length
/** Room kept for the "…" markers and a closing fence. */
const MARKER_TOKENS = 6
const MARKER_CHARS = 12

const FENCE_LINE = /^\s*```/u
const SENTENCE_END = /(?:[.!?]+["'”’)\]]*(?=\s)|[。！？；]+[”’」』）]*)\s*|\n+/gu

/** A sentence, a line, or a whole fenced code block: the smallest piece we keep or drop. */
interface Unit {
  passage: number
  start: number
  end: number
  tokens: number
  chars: number
  /** Indexes into the term list. */
  terms: number[]
  opensPassage: boolean
  closesPassage: boolean
}

interface Window {
  from: number
  to: number
  /** The single unit at `from` is larger than the budget and has to be cut. */
  cut: boolean
}

type Span = [start: number, end: number]

function fencedBlocks(text: string): Span[] {
  const blocks: Span[] = []
  let open: number | undefined
  let offset = 0
  for (const line of text.split('\n')) {
    const lineEnd = Math.min(offset + line.length + 1, text.length)
    if (FENCE_LINE.test(line)) {
      if (open === undefined) open = offset
      else {
        blocks.push([open, lineEnd])
        open = undefined
      }
    }
    offset = lineEnd
  }
  // A fence the source already cut open runs to the end of the passage.
  if (open !== undefined) blocks.push([open, text.length])
  return blocks
}

function sentenceSpans(text: string, from: number, to: number, spans: Span[]): void {
  const slice = text.slice(from, to)
  let last = 0
  for (const match of slice.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length
    spans.push([from + last, from + end])
    last = end
  }
  if (last < slice.length) spans.push([from + last, to])
}

function spansOf(text: string): Span[] {
  const spans: Span[] = []
  let cursor = 0
  for (const [start, end] of fencedBlocks(text)) {
    sentenceSpans(text, cursor, start, spans)
    spans.push([start, end])
    cursor = end
  }
  sentenceSpans(text, cursor, text.length, spans)
  return spans.filter(([start, end]) => text.slice(start, end).trim().length > 0)
}

function segment(text: string, passage: number, terms: readonly Term[]): Unit[] {
  const spans = spansOf(text)
  return spans.map(([start, end], index) => {
    const body = text.slice(start, end)
    const lower = body.toLowerCase()
    return {
      passage,
      start,
      end,
      tokens: estimateTokens(body),
      chars: body.length,
      terms: terms.flatMap((term, termIndex) => (term.matches(lower) ? [termIndex] : [])),
      opensPassage: index === 0,
      closesPassage: index === spans.length - 1,
    }
  })
}

function crossesGap(units: readonly Unit[], index: number): boolean {
  const previous = units[index - 1]
  return index > 0 && previous !== undefined && previous.passage !== units[index]?.passage
}

/** Running totals of a sliding window, so every step is O(terms in one unit). */
class Tally {
  tokens = 0
  chars = 0
  matchedUnits = 0
  private readonly terms: readonly Term[]
  private readonly counts: number[]

  constructor(terms: readonly Term[]) {
    this.terms = terms
    this.counts = terms.map(() => 0)
  }

  shift(unit: Unit, gap: boolean, direction: 1 | -1): void {
    this.tokens += direction * (unit.tokens + (gap ? GAP_TOKENS : 0))
    this.chars += direction * (unit.chars + (gap ? GAP_CHARS : 0))
    if (unit.terms.length) this.matchedUnits += direction
    for (const term of unit.terms) this.counts[term] = (this.counts[term] ?? 0) + direction
  }

  /** Distinct terms dominate; more matching sentences break ties. */
  score(): number {
    const distinct = this.terms.reduce(
      (sum, term, index) => sum + ((this.counts[index] ?? 0) > 0 ? term.weight : 0),
      0,
    )
    return distinct * 1000 + this.matchedUnits
  }
}

function closeOpenFence(text: string): string {
  const fences = text.split('\n').filter((line) => FENCE_LINE.test(line)).length
  return fences % 2 === 1 ? `${text}\n\`\`\`` : text
}

/** For a sentence or code block that is larger than the whole budget. */
function cutUnit(text: string, unit: Unit, limit: ExcerptLimit): string {
  const body = text.slice(unit.start, unit.end).trim()
  let room = Math.min(charsWithinTokens(body, limit.tokens), limit.chars, body.length)
  // Never split a surrogate pair.
  if (room > 0 && /[\uD800-\uDBFF]/u.test(body.charAt(room - 1))) room -= 1
  const head = body.slice(0, room)
  const boundary = Math.max(head.lastIndexOf('\n'), head.lastIndexOf(' '))
  const kept = boundary > room * 0.6 ? head.slice(0, boundary) : head
  return closeOpenFence(`${unit.opensPassage ? '' : '… '}${kept.trimEnd()}…`)
}

/** Scores only what survives the cut, so a match beyond the cut cannot win the comparison. */
function cutScore(cut: string, terms: readonly Term[]): number {
  const lower = cut.toLowerCase()
  const distinct = terms.reduce((sum, term) => sum + (term.matches(lower) ? term.weight : 0), 0)
  return distinct * 1000 + (distinct > 0 ? 1 : 0)
}

interface Excerptable {
  texts: readonly string[]
  units: readonly Unit[]
  terms: readonly Term[]
}

/**
 * Every candidate starts at a sentence that matches and runs forward as far as the budget allows,
 * so the budget goes to the match and what follows it, not to whatever happened to precede it.
 */
function bestWindow({ texts, units, terms }: Excerptable, limit: ExcerptLimit): Window {
  const tally = new Tally(terms)
  const anyMatch = units.some((unit) => unit.terms.length > 0)
  let best: Window = { from: 0, to: 1, cut: true }
  let bestScore = -1
  let to = 0
  for (let from = 0; from < units.length; from += 1) {
    to = Math.max(to, from)
    for (let next = units[to]; next !== undefined; next = units[to]) {
      const gap = to > from && crossesGap(units, to)
      const tokens = tally.tokens + next.tokens + (gap ? GAP_TOKENS : 0)
      const chars = tally.chars + next.chars + (gap ? GAP_CHARS : 0)
      if (tokens > limit.tokens || chars > limit.chars) break
      tally.shift(next, gap, 1)
      to += 1
    }
    const first = units[from]
    if (first === undefined) break
    const empty = to === from
    const score = empty
      ? cutScore(cutUnit(texts[first.passage] ?? '', first, limit), terms)
      : tally.score()
    const eligible = !anyMatch || first.terms.length > 0
    // Strictly greater: on a tie the earlier window wins.
    if (eligible && score > bestScore) {
      bestScore = score
      best = { from, to: empty ? from + 1 : to, cut: empty }
    }
    if (!empty) tally.shift(first, to > from + 1 && crossesGap(units, from + 1), -1)
  }
  return best
}

function joinParts(parts: readonly string[]): string {
  return parts.reduce((joined, part, index) => {
    if (index === 0) return part
    const previous = parts[index - 1] ?? ''
    const inline = !previous.includes('\n') && !part.includes('\n')
    return `${joined}${inline ? ' … ' : PASSAGE_GAP}${part}`
  }, '')
}

function render(texts: readonly string[], units: readonly Unit[], window: Window): string {
  const parts: string[] = []
  let index = window.from
  while (index < window.to) {
    const first = units[index]
    if (first === undefined) break
    let last = first
    while (index + 1 < window.to && units[index + 1]?.passage === first.passage) {
      index += 1
      last = units[index] ?? last
    }
    const body = (texts[first.passage] ?? '').slice(first.start, last.end).trim()
    // Balanced per passage: a fence the source left open must not swallow the next passage.
    parts.push(
      closeOpenFence(`${first.opensPassage ? '' : '… '}${body}${last.closesPassage ? '' : ' …'}`),
    )
    index += 1
  }
  return joinParts(parts)
}

/** Size of the whole text as `pickExcerpt` would return it with an unlimited budget. */
export function measurePassages(passages: readonly string[]): ExcerptLimit {
  const text = passages.join(PASSAGE_GAP)
  return { tokens: estimateTokens(text), chars: text.length }
}

function within(text: string, limit: ExcerptLimit): boolean {
  return text.length <= limit.chars && estimateTokens(text) <= limit.tokens
}

/**
 * The window was sized from per-sentence estimates; the markers and fence closers added while
 * rendering can tip it over, so the rendered text has the last word and sheds sentences if needed.
 */
function renderWithin(source: Excerptable, window: Window, limit: ExcerptLimit): string {
  const { texts, units } = source
  for (let to = window.to; to > window.from; to -= 1) {
    const text = render(texts, units, { ...window, to })
    if (within(text, limit)) return text
  }
  const first = units[window.from]
  return first ? cutUnit(texts[first.passage] ?? '', first, limit) : ''
}

export function pickExcerpt(
  passages: readonly string[],
  terms: readonly Term[],
  limit: ExcerptLimit,
): string {
  const texts = passages.filter((passage) => passage.trim().length > 0)
  if (texts.length === 0 || limit.tokens <= 0 || limit.chars <= 0) return ''
  const units = texts.flatMap((text, index) => segment(text, index, terms))
  if (units.length === 0) return ''
  const source = { texts, units, terms }
  const whole = render(texts, units, { from: 0, to: units.length, cut: false })
  if (within(whole, limit)) return whole
  const room = {
    tokens: Math.max(limit.tokens - MARKER_TOKENS, 1),
    chars: Math.max(limit.chars - MARKER_CHARS, 1),
  }
  const window = bestWindow(source, room)
  const first = units[window.from]
  if (window.cut && first !== undefined) return cutUnit(texts[first.passage] ?? '', first, room)
  return renderWithin(source, window, limit)
}
