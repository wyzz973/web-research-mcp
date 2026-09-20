/**
 * Tokenizer-free size estimates. No model tokenizer is bundled, so budgets are approximate; the
 * weights err on the high side, because under-counting is what lets a harness truncate our output.
 */

const WIDE = /[⺀-鿿ꀀ-꓏가-힯豈-﫿＀-￯]/u

/** Prose is about four characters per token; URLs, code, and JSON are far denser. */
function weight(char: string): number {
  const code = char.codePointAt(0) ?? 0
  if (code > 0xffff) return 2
  if (WIDE.test(char)) return 1
  if (code > 0x7f) return 0.5
  if ((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a)) return 0.26
  if (code >= 0x30 && code <= 0x39) return 0.45
  if (code === 0x20 || code === 0x0a || code === 0x09 || code === 0x0d) return 0.12
  return 0.55
}

export function estimateTokens(text: string): number {
  let total = 0
  for (const char of text) total += weight(char)
  return Math.ceil(total)
}

/** Largest prefix length (in UTF-16 units) whose estimate fits the budget. */
export function charsWithinTokens(text: string, budget: number): number {
  if (budget <= 0) return 0
  let spent = 0
  let index = 0
  for (const char of text) {
    spent += weight(char)
    if (spent > budget) return index
    index += char.length
  }
  return text.length
}
