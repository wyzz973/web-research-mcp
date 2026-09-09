import type { DocumentSnapshot, Passage, Segment } from '../shared/types.ts'
import { createSegmenter, scoreRelevance } from './lexical.ts'

interface ContextUnit {
  start: number
  end: number
  heading: boolean
  terms: string[]
}

interface Window {
  start: number
  end: number
}

function qualifiesContext(text: string): boolean {
  return /^(?:if|unless|except|however|but|for|when|provided|otherwise|only|this|these|those|it|they|such|servers?|clients?)\b|\b(?:not|never|must|should|may)\b|^(?:如果|除非|但是|然而|这些|该|此|注意|例如|为了)|(?:不能|不得|不应|必须|应当)/iu.test(
    text.trim(),
  )
}

function isHeading(text: string): boolean {
  const trimmed = text.trim()
  return trimmed.length > 0 && trimmed.length <= 100 && !/[.!?。！？;；:]\s*$/u.test(trimmed)
}

/** Soft line breaks are spaces for sentence detection only; all quotes use untouched source text. */
function sentenceUnits(
  segment: Segment,
  sentenceSegmenter: Intl.Segmenter,
): { start: number; end: number }[] {
  const units: { start: number; end: number }[] = []
  let offset = segment.start_char
  for (const part of sentenceSegmenter.segment(segment.text.replace(/[\r\n]/gu, ' '))) {
    const end = offset + Array.from(part.segment).length
    units.push({ start: offset, end })
    offset = end
  }
  return units
}

/**
 * Return paragraph evidence in deterministic relevance/diversity order, bounded per passage.
 * Offsets count Unicode code points. Oversized paragraphs use complete sentences; an oversized
 * sentence is omitted, never cut. maxPassages only truncates the selection, preserving page order.
 */
export function selectPassages(
  query: string,
  snapshot: DocumentSnapshot,
  options: { maxPassages: number; maxChars: number; language?: string },
): Passage[] {
  if (options.maxPassages <= 0 || options.maxChars <= 0) return []
  const language = options.language ?? 'auto'
  const sentenceSegmenter = createSegmenter(language, 'sentence')
  const content = Array.from(snapshot.content)
  const text = (start: number, end: number): string => content.slice(start, end).join('')
  const segments = snapshot.segments.filter(
    (segment) =>
      segment.start_char >= 0 &&
      segment.end_char > segment.start_char &&
      segment.end_char <= content.length &&
      text(segment.start_char, segment.end_char) === segment.text,
  )
  const units: ContextUnit[] = []
  for (const segment of segments) {
    const ranges =
      segment.end_char - segment.start_char <= options.maxChars
        ? [{ start: segment.start_char, end: segment.end_char }]
        : sentenceUnits(segment, sentenceSegmenter)
    for (const range of ranges) {
      const value = text(range.start, range.end)
      units.push({
        ...range,
        heading: ranges.length === 1 && isHeading(value),
        terms: scoreRelevance(query, value, 'quote', language).matched_terms,
      })
    }
  }
  const frequency = new Map<string, number>()
  for (const unit of units) {
    for (const term of unit.terms) frequency.set(term, (frequency.get(term) ?? 0) + 1)
  }
  const windows: Window[] = []
  for (const [index, unit] of units.entries()) {
    if (unit.terms.length === 0 || unit.end - unit.start > options.maxChars) continue
    let start = unit.start
    let end = unit.end
    const previous = units[index - 1]
    // One immediately preceding paragraph retains conditions, negation and heading context.
    // Never cross a metadata gap: a skipped invalid segment must not become quoted indirectly.
    if (
      previous &&
      previous.end === start &&
      (previous.heading ||
        (!unit.heading &&
          (previous.terms.length > 0 || qualifiesContext(text(previous.start, previous.end))))) &&
      end - previous.start <= options.maxChars
    ) {
      start = previous.start
    }
    // Follow explanatory paragraphs within this section. A new heading starts another section;
    // allow at most two neighbours so a short match cannot vacuum up unrelated article text.
    for (let offset = 1; offset <= 2; offset += 1) {
      const next = units[index + offset]
      if (
        !next ||
        next.heading ||
        next.start !== end ||
        (!unit.heading &&
          next.terms.length === 0 &&
          !qualifiesContext(text(next.start, next.end))) ||
        next.end - start > options.maxChars
      )
        break
      end = next.end
    }
    // A matching label alone is navigation, not evidence. Drop it before merging so a
    // dangling heading cannot manufacture another page or hitchhike on prior evidence.
    const hasBody = units.some(
      (context) =>
        !context.heading &&
        context.start >= start &&
        context.end <= end &&
        text(context.start, context.end).trim().length > 0,
    )
    if (hasBody) windows.push({ start, end })
  }

  // Coalesce matching contexts when their union fits, retaining one exact contiguous quote.
  windows.sort((left, right) => left.start - right.start || left.end - right.end)
  const merged: Window[] = []
  for (const window of windows) {
    const previous = merged.at(-1)
    if (
      previous &&
      window.start <= previous.end &&
      Math.max(previous.end, window.end) - previous.start <= options.maxChars
    ) {
      previous.end = Math.max(previous.end, window.end)
    } else {
      merged.push({ ...window })
    }
  }
  const candidates: Passage[] = []
  for (const window of merged) {
    const covering = segments.filter(
      (segment) => segment.start_char < window.end && segment.end_char > window.start,
    )
    const first = covering[0]
    if (!first) continue
    const quote = text(window.start, window.end)
    candidates.push({
      quote,
      start_char: window.start,
      end_char: window.end,
      segment_id: first.id,
      segment_ids: covering.map((segment) => segment.id),
      relevance: scoreRelevance(query, quote, 'quote', language),
    })
  }
  const selected: Passage[] = []
  const covered = new Set<string>()
  // Rarity affects selection only. The public relevance remains unique lexical query coverage.
  const priority = (candidate: Passage): number =>
    candidate.relevance.matched_terms.reduce(
      (sum, term) => sum + (covered.has(term) ? 1 : 2) / (frequency.get(term) ?? 1),
      0,
    )
  while (candidates.length > 0 && selected.length < options.maxPassages) {
    candidates.sort(
      (left, right) =>
        priority(right) - priority(left) ||
        (right.relevance.score ?? 0) - (left.relevance.score ?? 0) ||
        left.start_char - right.start_char,
    )
    const candidate = candidates.shift()
    if (!candidate) break
    if (
      selected.some(
        (item) => candidate.start_char < item.end_char && candidate.end_char > item.start_char,
      )
    )
      continue
    selected.push(candidate)
    for (const term of candidate.relevance.matched_terms) covered.add(term)
  }
  return selected
}
