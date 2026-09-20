import { charsWithinTokens, estimateTokens } from '../tokens.ts'

/** Output is capped twice: harnesses truncate by tokens or by characters, whichever they count. */
export interface Budget {
  tokens: number
  chars: number
}

/** Measured against render/text.ts: location label line, page header lines, first and last lines. */
export const PART_OVERHEAD: Budget = { tokens: 30, chars: 90 }
export const PAGE_OVERHEAD: Budget = { tokens: 200, chars: 700 }
export const ERROR_PAGE_OVERHEAD: Budget = { tokens: 90, chars: 300 }
export const CALL_OVERHEAD: Budget = { tokens: 60, chars: 220 }
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
