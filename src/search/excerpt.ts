/**
 * Excerpt selection: the most query-relevant run of consecutive sentences that fits a budget.
 * Text is never rewritten. The only characters we add are "…" where source text was left out and
 * a closing code fence when a cut would otherwise leave one open.
 *
 * Two kinds of text are left out on purpose, because they spend tokens without helping anyone
 * decide whether to open the page:
 *  - low-information lines (see low-information.ts) score nothing and are trimmed from both ends
 *    of an excerpt; between two kept sentences they stay, so the text remains contiguous;
 *  - a prose sentence that already occurs earlier in the same excerpt is shown once.
 */
import { withoutInvisible } from '../invisible.ts'
import { charsWithinTokens, estimateTokens } from '../tokens.ts'
import { headOf } from './cut.ts'
import { contentWeight, lowInformationLines } from './low-information.ts'
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
/** A repeat must be a real sentence: long enough that saying it twice is no coincidence. */
const MIN_SENTENCE_WEIGHT = 16
const MIN_SENTENCE_WORDS = 4
/** Chinese and Japanese sentences have no spaces to count words by. */
const MIN_UNSPACED_WEIGHT = 40
/** How far past a sentence we look to see what follows it. */
const LOOKAHEAD_CHARS = 16

const FENCE_LINE = /^\s*```/u
const SENTENCE_END = /(?:[.!?]+["'”’)\]]*(?=\s)|[。！？；]+[”’」』）]*)\s*|\n+/gu
const SENTENCE_FINAL = /[.!?。！？]["'”’)\]」』）]*$/u
const STATEMENT_PUNCTUATION = /[{};=]/u

/** A sentence, a line, or a whole fenced code block: the smallest piece we keep or drop. */
interface Unit {
  /** Position among all units of the result, across passages. */
  index: number
  passage: number
  start: number
  end: number
  tokens: number
  chars: number
  /** Indexes into the term list. Always empty for a low-information unit. */
  terms: number[]
  lowInformation: boolean
  /** Set for prose sentences: the text by which a repeat is recognized. */
  sentence: string | undefined
  opensPassage: boolean
  closesPassage: boolean
}

interface Window {
  from: number
  to: number
  /** The single unit at `from` is larger than the budget and has to be cut. */
  cut: boolean
}

interface Span {
  start: number
  end: number
  fenced: boolean
}

function fencedBlocks(text: string): Span[] {
  const blocks: Span[] = []
  let open: number | undefined
  let offset = 0
  for (const line of text.split('\n')) {
    const lineEnd = Math.min(offset + line.length + 1, text.length)
    if (FENCE_LINE.test(line)) {
      if (open === undefined) open = offset
      else {
        blocks.push({ start: open, end: lineEnd, fenced: true })
        open = undefined
      }
    }
    offset = lineEnd
  }
  // A fence the source already cut open runs to the end of the passage.
  if (open !== undefined) blocks.push({ start: open, end: text.length, fenced: true })
  return blocks
}

function sentenceSpans(text: string, from: number, to: number, spans: Span[]): void {
  const slice = text.slice(from, to)
  let last = 0
  for (const match of slice.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length
    spans.push({ start: from + last, end: from + end, fenced: false })
    last = end
  }
  if (last < slice.length) spans.push({ start: from + last, end: to, fenced: false })
}

function spansOf(text: string): Span[] {
  const spans: Span[] = []
  let cursor = 0
  for (const block of fencedBlocks(text)) {
    sentenceSpans(text, cursor, block.start, spans)
    spans.push(block)
    cursor = block.end
  }
  sentenceSpans(text, cursor, text.length, spans)
  return spans.filter(({ start, end }) => text.slice(start, end).trim().length > 0)
}

/**
 * The text by which a repeated sentence is recognized, or undefined when the unit is not clearly
 * a prose sentence. Code repeats itself by nature and must stay intact, so anything that looks
 * like it is left alone: statement punctuation, fewer than MIN_SENTENCE_WORDS words, or a "." that
 * is followed by a lower-case letter (`controller. abort(...)` in flattened code).
 */
function sentenceOf(body: string, span: Span, following: string): string | undefined {
  if (span.fenced || /^\s*\p{Ll}/u.test(following)) return undefined
  const text = body.replace(/\s+/gu, ' ').trim()
  if (!SENTENCE_FINAL.test(text) || STATEMENT_PUNCTUATION.test(text)) return undefined
  const words = text.split(' ').filter((word) => contentWeight(word) > 0).length
  const wordy = words >= MIN_SENTENCE_WORDS || contentWeight(text) >= MIN_UNSPACED_WEIGHT
  return wordy && contentWeight(text) >= MIN_SENTENCE_WEIGHT ? text : undefined
}

function segment(text: string, passage: number, terms: readonly Term[]): Omit<Unit, 'index'>[] {
  const spans = spansOf(text)
  const bodies = spans.map((span) => text.slice(span.start, span.end))
  // Judged as a reader would see it: invisible characters must not split a word or hide a match.
  const visible = bodies.map(withoutInvisible)
  const low = lowInformationLines(visible)
  return spans.map((span, position) => {
    const body = bodies[position] ?? ''
    const lowInformation = low[position] === true
    const lower = (visible[position] ?? '').toLowerCase()
    return {
      passage,
      start: span.start,
      end: span.end,
      tokens: estimateTokens(body),
      chars: body.length,
      terms: lowInformation
        ? []
        : terms.flatMap((term, termIndex) => (term.matches(lower) ? [termIndex] : [])),
      lowInformation,
      sentence: lowInformation
        ? undefined
        : sentenceOf(
            visible[position] ?? '',
            span,
            text.slice(span.end, span.end + LOOKAHEAD_CHARS),
          ),
      opensPassage: position === 0,
      closesPassage: position === spans.length - 1,
    }
  })
}

function crossesGap(units: readonly Unit[], index: number): boolean {
  const previous = units[index - 1]
  return index > 0 && previous !== undefined && previous.passage !== units[index]?.passage
}

/**
 * Running totals of a sliding window, so every step is O(terms in one unit). A sentence that is
 * already in the window costs only the "…" that will stand in its place.
 */
class Tally {
  tokens = 0
  chars = 0
  matchedUnits = 0
  private readonly terms: readonly Term[]
  private readonly counts: number[]
  private readonly sentences = new Map<string, number>()

  constructor(terms: readonly Term[]) {
    this.terms = terms
    this.counts = terms.map(() => 0)
  }

  /** Whether the window would still fit `limit` with `unit` appended. */
  fitsWith(unit: Unit, gap: boolean, limit: ExcerptLimit): boolean {
    const repeat = unit.sentence !== undefined && this.sentences.has(unit.sentence)
    const extra = gap ? 2 : 1
    const tokens = repeat ? GAP_TOKENS * extra : unit.tokens + (gap ? GAP_TOKENS : 0)
    const chars = repeat ? GAP_CHARS * extra : unit.chars + (gap ? GAP_CHARS : 0)
    return this.tokens + tokens <= limit.tokens && this.chars + chars <= limit.chars
  }

  /** `direction` 1 appends a unit at the end of the window, -1 removes its first unit. */
  shift(unit: Unit, gap: boolean, direction: 1 | -1): void {
    if (gap) this.spend(GAP_TOKENS, GAP_CHARS, direction)
    if (this.isRepeat(unit, direction)) return this.spend(GAP_TOKENS, GAP_CHARS, direction)
    this.spend(unit.tokens, unit.chars, direction)
    if (unit.terms.length) this.matchedUnits += direction
    for (const term of unit.terms) this.counts[term] = (this.counts[term] ?? 0) + direction
  }

  /**
   * Leaving, the first occurrence hands its place to the next one, which has the same text and
   * so the same size: the window only loses the "…" that stood for that repeat.
   */
  private isRepeat(unit: Unit, direction: 1 | -1): boolean {
    if (unit.sentence === undefined) return false
    const before = this.sentences.get(unit.sentence) ?? 0
    const after = before + direction
    if (after > 0) this.sentences.set(unit.sentence, after)
    else this.sentences.delete(unit.sentence)
    return direction === 1 ? before > 0 : after > 0
  }

  private spend(tokens: number, chars: number, direction: 1 | -1): void {
    this.tokens += direction * tokens
    this.chars += direction * chars
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
  const room = Math.min(charsWithinTokens(body, limit.tokens), limit.chars, body.length)
  const head = headOf(body, room)
  const boundary = Math.max(head.lastIndexOf('\n'), head.lastIndexOf(' '))
  const kept = boundary > room * 0.6 ? head.slice(0, boundary) : head
  return closeOpenFence(`${unit.opensPassage ? '' : '… '}${kept.trimEnd()}…`)
}

/** Scores only what survives the cut, so a match beyond the cut cannot win the comparison. */
function cutScore(cut: string, terms: readonly Term[]): number {
  const lower = withoutInvisible(cut).toLowerCase()
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
 * Returns undefined when there is nothing worth starting from.
 */
function bestWindow({ texts, units, terms }: Excerptable, limit: ExcerptLimit): Window | undefined {
  const tally = new Tally(terms)
  const anyMatch = units.some((unit) => unit.terms.length > 0)
  let best: Window | undefined
  let bestScore = -1
  let to = 0
  for (let from = 0; from < units.length; from += 1) {
    to = Math.max(to, from)
    for (let next = units[to]; next !== undefined; next = units[to]) {
      const gap = to > from && crossesGap(units, to)
      if (!tally.fitsWith(next, gap, limit)) break
      tally.shift(next, gap, 1)
      to += 1
    }
    const first = units[from]
    if (first === undefined) break
    const empty = to === from
    const score = empty
      ? cutScore(cutUnit(texts[first.passage] ?? '', first, limit), terms)
      : tally.score()
    const eligible = !first.lowInformation && (!anyMatch || first.terms.length > 0)
    // Strictly greater: on a tie the earlier window wins.
    if (eligible && score > bestScore) {
      bestScore = score
      best = { from, to: empty ? from + 1 : to, cut: empty }
    }
    if (!empty) tally.shift(first, to > from + 1 && crossesGap(units, from + 1), -1)
  }
  return best
}

/** The units of a window that are shown: repeats dropped, low-information ends trimmed. */
function shownUnits(units: readonly Unit[], window: Window): Unit[] {
  const seen = new Set<string>()
  const kept = units.slice(window.from, window.to).filter((unit) => {
    if (unit.sentence === undefined) return true
    if (seen.has(unit.sentence)) return false
    seen.add(unit.sentence)
    return true
  })
  const first = kept.findIndex((unit) => !unit.lowInformation)
  const last = kept.findLastIndex((unit) => !unit.lowInformation)
  return first < 0 ? [] : kept.slice(first, last + 1)
}

/** Maximal runs of shown units that are contiguous in the source. */
function runsOf(shown: readonly Unit[]): Unit[][] {
  const runs: Unit[][] = []
  for (const unit of shown) {
    const run = runs.at(-1)
    const previous = run?.at(-1)
    if (run && previous && previous.passage === unit.passage && previous.index + 1 === unit.index)
      run.push(unit)
    else runs.push([unit])
  }
  return runs
}

function joinRuns(parts: readonly string[]): string {
  return parts.reduce((joined, part, index) => {
    if (index === 0) return part
    const previous = parts[index - 1] ?? ''
    const inline = !previous.includes('\n') && !part.includes('\n')
    return `${joined}${inline ? ' … ' : PASSAGE_GAP}${part}`
  }, '')
}

/** One "…" stands wherever source text was left out: before, between, and after the runs. */
function render(texts: readonly string[], units: readonly Unit[], window: Window): string {
  const shown = shownUnits(units, window)
  const first = shown[0]
  const last = shown.at(-1)
  if (!first || !last) return ''
  const parts = runsOf(shown).map((run) => {
    const from = run[0]
    const to = run.at(-1)
    if (!from || !to) return ''
    // Balanced per run: a fence the source left open must not swallow what follows it.
    return closeOpenFence((texts[from.passage] ?? '').slice(from.start, to.end).trim())
  })
  return `${first.opensPassage ? '' : '… '}${joinRuns(parts)}${last.closesPassage ? '' : ' …'}`
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
  const units = texts
    .flatMap((text, passage) => segment(text, passage, terms))
    .map((unit, index) => ({ ...unit, index }))
  const source = { texts, units, terms }
  const whole = render(texts, units, { from: 0, to: units.length, cut: false })
  if (within(whole, limit)) return whole
  const room = {
    tokens: Math.max(limit.tokens - MARKER_TOKENS, 1),
    chars: Math.max(limit.chars - MARKER_CHARS, 1),
  }
  const window = bestWindow(source, room)
  if (!window) return ''
  const first = units[window.from]
  if (window.cut && first !== undefined) return cutUnit(texts[first.passage] ?? '', first, room)
  return renderWithin(source, window, limit)
}
