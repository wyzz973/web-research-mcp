/**
 * Fits one page of results into the output budget. Two ceilings apply together, tokens and
 * characters, because harnesses truncate by either. The smallest unit of a result is fixed: its
 * title line and its address line. Every result gets that first; what is left is split evenly
 * between the excerpts; only when the smallest units do not fit does the page carry fewer results.
 */
import type { SearchHit } from '../contract.ts'
import { estimateTokens } from '../tokens.ts'
import { PASSAGE_GAP, pickExcerpt, type ExcerptLimit } from './excerpt.ts'
import type { Term } from './terms.ts'

/** Header, the block markers, and the two footer lines of the text view. */
export const RESERVED_TOKENS = 120
export const RESERVED_CHARS = 600
/** Below this an excerpt is a few stray words; the share is better left unspent. */
const MIN_USEFUL_EXCERPT: ExcerptLimit = { tokens: 12, chars: 40 }

export interface PageRequest {
  /** Pool entries in rank order; `excerpt` holds the full source text. */
  pool: readonly SearchHit[]
  offset: number
  count: number
  maxTokens: number
  maxChars: number
  /** Size of the lines that vary per response (notes, source status); they count against the budget too. */
  extraTokens?: number
  terms: readonly Term[]
}

export interface Page {
  results: SearchHit[]
  /** Estimated size of the rendered response, reserve included. */
  tokens: number
}

/** Mirrors the two lines render/text.ts prints above an excerpt, plus the blank separator line. */
function headingOf(hit: SearchHit): string {
  const facts = [
    `[${hit.ref}] ${hit.title || '(untitled)'} - ${hit.site}`,
    hit.published ? `published ${hit.published}` : undefined,
    hit.found_by.length > 1 ? `${hit.found_by.length} sources` : undefined,
  ]
  return `${facts.filter(Boolean).join(' | ')}\n${hit.url}\n\n`
}

interface Slot {
  hit: SearchHit
  passages: string[]
  /** Size of the title line, the address line, and the blank line after the result. */
  fixed: ExcerptLimit
}

function slotFor(hit: SearchHit): Slot {
  const heading = headingOf(hit)
  return {
    hit,
    passages: hit.excerpt ? hit.excerpt.split(PASSAGE_GAP) : [],
    fixed: { tokens: estimateTokens(heading), chars: heading.length },
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

export function packPage(request: PageRequest): Page {
  const reserved = RESERVED_TOKENS + (request.extraTokens ?? 0)
  const wanted = request.pool.slice(request.offset, request.offset + request.count).map(slotFor)
  if (wanted.length === 0) return { results: [], tokens: reserved }
  const room = {
    tokens: request.maxTokens - reserved,
    chars: request.maxChars - RESERVED_CHARS,
  }
  const slots = fittingPrefix(wanted, room)
  const share = evenShare(slots, room)
  const results = slots.map((slot) => ({
    ...slot.hit,
    excerpt: pickExcerpt(slot.passages, request.terms, share),
  }))
  const used = results.reduce(
    (total, hit, index) => total + (slots[index]?.fixed.tokens ?? 0) + estimateTokens(hit.excerpt),
    reserved,
  )
  return { results, tokens: used }
}
