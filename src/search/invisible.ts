/**
 * Characters a reader cannot see: control characters, zero-width spaces, and the bidirectional
 * embeddings, overrides and isolates. Pages use them to hide text from people or to reorder what
 * people see. They are removed from what a response shows, and every removal is counted, so that
 * nothing disappears silently (docs/design/conventions.md, section 8).
 *
 * The removal happens where a title or an excerpt is put into a response, not where the source
 * text comes in: only then is it known which text is shown, and the count is about exactly that.
 *
 * Joiners (U+200C, U+200D) stay: Persian and Indic scripts need them to spell words, and emoji
 * sequences are built with them.
 */
const INVISIBLE = /(?![\n\t])\p{Cc}|[\u200B\u2060\uFEFF\u202A-\u202E\u2066-\u2069]/gu

export interface Visible {
  text: string
  /** How many invisible characters were taken out. */
  removed: number
}

export function stripInvisible(text: string): Visible {
  let removed = 0
  const visible = text.replace(INVISIBLE, () => {
    removed += 1
    return ''
  })
  return { text: visible, removed }
}

/** For comparing and classifying text; use `stripInvisible` when the result is shown. */
export function withoutInvisible(text: string): string {
  return text.replace(INVISIBLE, '')
}
