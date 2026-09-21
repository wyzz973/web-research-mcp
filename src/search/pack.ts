/**
 * Fits one page of results into the output budget. Two ceilings apply together, tokens and
 * characters, because harnesses truncate by either. The smallest unit of a result is fixed: its
 * title line and its address line. Every result gets that first; what is left is split evenly
 * between the excerpts; only when the smallest units do not fit does the page carry fewer results.
 */
import type { SearchHit } from '../contract.ts'
import { stripInvisible } from '../invisible.ts'
import { estimateTokens } from '../tokens.ts'
import { PASSAGE_GAP, pickExcerpt, type ExcerptLimit } from './excerpt.ts'
import type { Term } from './terms.ts'

/**
 * What the text view (render/text.ts) puts around the results, measured on its output: the header
 * line with every field it can carry (about 53 tokens), the two block markers (24), and the two
 * footer lines (49). Notes and the source line vary; they come in as `extraLines`.
 * tests/search/text-budget.spec.ts holds these numbers against the real renderer.
 */
export const RESERVED_TOKENS = 130
export const RESERVED_CHARS = 450
/** Below this an excerpt is a few stray words; the share is better left unspent. */
const MIN_USEFUL_EXCERPT: ExcerptLimit = { tokens: 12, chars: 40 }

export interface PageRequest {
  /** Pool entries in rank order; `excerpt` holds the full source text. */
  pool: readonly SearchHit[]
  offset: number
  count: number
  maxTokens: number
  maxChars: number
  /** The lines that vary per response, as the text view prints them: notes and source status. */
  extraLines?: readonly string[]
  terms: readonly Term[]
}

export interface Page {
  results: SearchHit[]
  /** Estimated size of the rendered response, reserve included. */
  tokens: number
  /** Invisible characters taken out of the titles and excerpts of `results`, and of nothing else. */
  hiddenRemoved: number
}

/**
 * The text view defuses web text that imitates its own markup: "<results", "</page" and the like
 * become "&lt;..." (three characters longer), and a line that begins like one of the view's own
 * lines gets "| " in front. Shown text is therefore longer than the text we picked, and a size
 * that ignores it understates. The line test is deliberately a little wider than the view's.
 */
const ENVELOPE_TAG = /<\/?\s*(?:results|page)\b/giu
const PROTOCOL_LIKE_LINE =
  /^\s*(?:web_search |web_fetch |page \d|sources:|note:|error |more:|read|outline |size ~|title: |url: |\[|\d+\. )/u
const TOKENS_PER_ESCAPED_TAG = 1.07
const TOKENS_PER_PREFIXED_LINE = 0.67

/** The size of `text` once the text view has shown it. */
function shownSize(text: string): ExcerptLimit {
  if (!text) return { tokens: 0, chars: 0 }
  const tags = text.match(ENVELOPE_TAG)?.length ?? 0
  const lines = text.split('\n').filter((line) => PROTOCOL_LIKE_LINE.test(line)).length
  return {
    tokens:
      estimateTokens(text) +
      Math.ceil(tags * TOKENS_PER_ESCAPED_TAG + lines * TOKENS_PER_PREFIXED_LINE),
    chars: text.length + tags * 3 + lines * 2,
  }
}

/**
 * The lines the text view prints for a result before its excerpt: our own fields, the title with
 * the site, the address; and the line breaks around the excerpt, the blank separator included.
 */
function fixedSize(hit: SearchHit): ExcerptLimit {
  const ours = [
    hit.published ? `published ${hit.published}` : undefined,
    hit.found_by.length > 1 ? `${hit.found_by.length} sources` : undefined,
  ].filter(Boolean)
  const fields = `[${hit.ref}]${ours.length ? ` ${ours.join(' | ')}` : ''}`
  const heading = shownSize(`${hit.title.trim() || '(untitled)'} - ${hit.site}`)
  const rest = `${fields}\n\n${hit.url}\n\n\n`
  return { tokens: estimateTokens(rest) + heading.tokens, chars: rest.length + heading.chars }
}

interface Slot {
  hit: SearchHit
  passages: string[]
  /** Everything of the result but its excerpt. */
  fixed: ExcerptLimit
}

function slotFor(hit: SearchHit): Slot {
  return {
    hit,
    passages: hit.excerpt ? hit.excerpt.split(PASSAGE_GAP) : [],
    fixed: fixedSize(hit),
  }
}

function sum(slots: readonly Slot[], pick: (slot: Slot) => number): number {
  return slots.reduce((total, slot) => total + pick(slot), 0)
}

function smallestUnitsFit(slots: readonly Slot[], room: ExcerptLimit): boolean {
  return (
    sum(slots, (slot) => slot.fixed.tokens) <= room.tokens &&
    sum(slots, (slot) => slot.fixed.chars) <= room.chars
  )
}

/** The longest prefix whose smallest units fit; never less than one result. */
function fittingPrefix(slots: readonly Slot[], room: ExcerptLimit): Slot[] {
  let count = slots.length
  while (count > 1 && !smallestUnitsFit(slots.slice(0, count), room)) count -= 1
  return slots.slice(0, count)
}

/** What each excerpt may use: an even share of whatever the smallest units left over. */
function evenShare(slots: readonly Slot[], room: ExcerptLimit): ExcerptLimit {
  const share = (total: number, used: number) =>
    Math.max(0, Math.floor((total - used) / slots.length))
  const tokens = share(
    room.tokens,
    sum(slots, (slot) => slot.fixed.tokens),
  )
  const chars = share(
    room.chars,
    sum(slots, (slot) => slot.fixed.chars),
  )
  const useful = tokens >= MIN_USEFUL_EXCERPT.tokens && chars >= MIN_USEFUL_EXCERPT.chars
  return useful ? { tokens, chars } : { tokens: 0, chars: 0 }
}

/**
 * The excerpt for one result, cleaned for display. When defusing makes it longer than its share,
 * a smaller one is picked: the share is a promise about what is shown, not about what was chosen.
 */
function shownExcerpt(slot: Slot, terms: readonly Term[], share: ExcerptLimit) {
  let limit = share
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const excerpt = stripInvisible(pickExcerpt(slot.passages, terms, limit))
    const size = shownSize(excerpt.text)
    const over = { tokens: size.tokens - share.tokens, chars: size.chars - share.chars }
    if (over.tokens <= 0 && over.chars <= 0) return { ...excerpt, size }
    limit = {
      tokens: limit.tokens - Math.max(over.tokens, 0) - 1,
      chars: limit.chars - Math.max(over.chars, 0) - 1,
    }
  }
  return { text: '', removed: 0, size: shownSize('') }
}

export function packPage(request: PageRequest): Page {
  const extra = (request.extraLines ?? []).join('\n')
  const reserved = {
    tokens: RESERVED_TOKENS + estimateTokens(extra),
    chars: RESERVED_CHARS + extra.length,
  }
  const wanted = request.pool.slice(request.offset, request.offset + request.count).map(slotFor)
  if (wanted.length === 0) return { results: [], tokens: reserved.tokens, hiddenRemoved: 0 }
  const room = {
    tokens: request.maxTokens - reserved.tokens,
    chars: request.maxChars - reserved.chars,
  }
  const slots = fittingPrefix(wanted, room)
  const share = evenShare(slots, room)
  // The pool keeps the text as the source gave it. What is shown is cleaned here, so the count
  // covers exactly this page, whether it comes from a fresh search, the cache, or a cursor.
  let hiddenRemoved = 0
  let tokens = reserved.tokens
  const results = slots.map((slot) => {
    const title = stripInvisible(slot.hit.title)
    const excerpt = shownExcerpt(slot, request.terms, share)
    hiddenRemoved += title.removed + excerpt.removed
    tokens += slot.fixed.tokens + excerpt.size.tokens
    return { ...slot.hit, title: title.text, excerpt: excerpt.text }
  })
  return { results, tokens, hiddenRemoved }
}
