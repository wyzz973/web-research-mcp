import { charsWithinTokens, estimateTokens } from '../tokens.ts'

/** Output is capped twice: harnesses truncate by tokens or by characters, whichever they count. */
export interface Budget {
  tokens: number
  chars: number
}

/**
 * What the text view adds around the content, measured against render/text.ts and checked by
 * tests/fetch/budget.spec.ts against the real rendering. Lines whose length depends on the page
 * (address, title, error message, notes) are priced by their text; the rest is a fixed base.
 */
export const PART_OVERHEAD: Budget = { tokens: 30, chars: 90 }
/** Status line, size line, block tags, and the "read more" line of a readable page. */
const PAGE_BASE: Budget = { tokens: 165, chars: 520 }
/** Status line and the three-line block that carries the address of a page that failed. */
const FAILED_PAGE_BASE: Budget = { tokens: 60, chars: 150 }
/** The first line of the response. */
const CALL_BASE: Budget = { tokens: 35, chars: 110 }
/** Room kept for up to three notes, which are only known after reading. */
const NOTES_ALLOWANCE: Budget = { tokens: 105, chars: 360 }

export function plus(left: Budget, right: Budget): Budget {
  return { tokens: left.tokens + right.tokens, chars: left.chars + right.chars }
}

/** One line of the text view: a label we print, the text after it, and the line break. */
function lineCost(label: string, text: string): Budget {
  if (text === '') return { tokens: 0, chars: 0 }
  const line = `${label}${text}\n`
  return { tokens: estimateTokens(line), chars: line.length }
}

/** A readable page, without its parts and outline: those are priced by what is shown. */
export function pageOverhead(address: string, title: string): Budget {
  return plus(PAGE_BASE, plus(lineCost('url: ', address), lineCost('title: ', title)))
}

export function failedPageOverhead(address: string, message: string): Budget {
  return plus(FAILED_PAGE_BASE, plus(lineCost('url: ', address), lineCost('', message)))
}

/** The response line plus its notes. Before reading, the notes are not known yet: pass none. */
export function callOverhead(notes?: readonly string[]): Budget {
  if (!notes) return plus(CALL_BASE, NOTES_ALLOWANCE)
  return notes.reduce((sum, note) => plus(sum, lineCost('note: ', note)), CALL_BASE)
}

/** The smallest useful unit is one paragraph; budgets never shrink below room for it. */
export const MIN_CONTENT: Budget = { tokens: 150, chars: 500 }

export function minus(budget: Budget, cost: Budget): Budget {
  return { tokens: budget.tokens - cost.tokens, chars: budget.chars - cost.chars }
}

export function fits(budget: Budget, cost: Budget): boolean {
  return cost.tokens <= budget.tokens && cost.chars <= budget.chars
}

export function share(budget: Budget, parts: number): Budget {
  const divisor = Math.max(1, parts)
  return { tokens: Math.floor(budget.tokens / divisor), chars: Math.floor(budget.chars / divisor) }
}

export function atLeast(budget: Budget, floor: Budget): Budget {
  return {
    tokens: Math.max(budget.tokens, floor.tokens),
    chars: Math.max(budget.chars, floor.chars),
  }
}

/** Cost of showing one part: its text plus the label line the renderer puts above it. */
export function partCost(text: string): Budget {
  return {
    tokens: estimateTokens(text) + PART_OVERHEAD.tokens,
    chars: text.length + PART_OVERHEAD.chars,
  }
}

/** Longest prefix of `text` (in UTF-16 units) that one part may show under the budget. */
export function prefixWithin(text: string, budget: Budget): number {
  const room = minus(budget, PART_OVERHEAD)
  if (room.tokens <= 0 || room.chars <= 0) return 0
  return Math.min(charsWithinTokens(text, room.tokens), room.chars, text.length)
}
