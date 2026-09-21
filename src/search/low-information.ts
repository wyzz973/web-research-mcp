/**
 * Lines that tell a reader nothing about whether a page is worth opening: bare addresses, link
 * reference definitions, breadcrumb trails, rules and table separators. Source text often carries
 * them along, and their URLs happen to repeat the query's words.
 *
 * The rules are deliberately narrow. A line counts as low-information only when one of them says
 * so; anything else, however short, is treated as content. Code is content: a lone "}" or a call
 * with a URL in it never matches.
 *
 *  1. Link reference definition: `[label]: target`, optionally with a title, optionally behind a
 *     diff, quote or list marker. The target is one token, so a footnote with a sentence is not one.
 *  2. Mostly address: the line contains a URL, what is left without the URLs has fewer than
 *     MIN_LETTERS_BESIDE_URL letters and digits, and none of it looks like code.
 *  3. Decoration only: nothing but rule and separator characters (- _ * = ~ # . · • | : + < >),
 *     optionally around a bare list number such as "1.".
 *  4. Breadcrumb trail: at least MIN_TRAIL_SEGMENTS short segments separated by one and the same
 *     separator (" > ", " › ", " » ", " → " or " / "), none of them ending like a sentence.
 *  5. Metadata card (`lowInformationLines` only, because it takes neighbours to see one): at
 *     least MIN_CARD_LINES consecutive lines of the form "Key: value", optionally bulleted, one of
 *     which has an address as its value. Sources put such cards in front of GitHub pages
 *     ("* Page: GitHub code file / * URL: ... / * Repository: ... / * Ref: master"). The key is one
 *     to three capitalized words without hyphens and the value does not end like a sentence, so
 *     "Note: read this first." and HTTP header dumps are not cards.
 *
 * A CJK character counts as two letters: three of them can already be a sentence.
 */

import { withoutInvisible } from '../invisible.ts'

const MIN_LETTERS_BESIDE_URL = 8
const MIN_TRAIL_SEGMENTS = 3
const MAX_TRAIL_CHARS = 160
const MAX_SEGMENT_CHARS = 30
const MAX_SEGMENT_WORDS = 4
const MIN_CARD_LINES = 3

const ADDRESS = /(?:https?:\/\/|www\.)[^\s<>()[\]"']+/giu
/** Not global: a global pattern would carry its position from one `test` to the next. */
const HAS_ADDRESS = /(?:https?:\/\/|www\.)\S/iu
const LINK_DEFINITION =
  /^[\s>+*-]*\[[^\]\n]+\]:\s*<?\S+>?(?:\s+(?:"[^"\n]*"|'[^'\n]*'|\([^)\n]*\)))?\s*$/u
const CODE_PUNCTUATION = /[(){}=;"'`]/u
const DECORATION = /^[\s\-–—_*=~#.·•|:+<>]*(?:\d{1,3}[.)]?)?[\s\-–—_*=~#.·•|:+<>]*$/u
const TRAIL_SEPARATOR = /\s(>|›|»|→|\/)\s/gu
const LETTER = /[\p{L}\p{N}]/gu
const WIDE_LETTER = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/gu
const SENTENCE_LIKE_END = /[.!?。！？:;]$/u
const METADATA_LINE = /^[\s*+-]*\p{Lu}[\p{L} ]{0,23}:[ \t]+(\S.{0,79})$/u
const ONLY_ADDRESS = /^<?(?:https?:\/\/|www\.)\S+>?$/iu

/** Letters and digits, with a CJK character counted twice. */
export function contentWeight(text: string): number {
  return (text.match(LETTER)?.length ?? 0) + (text.match(WIDE_LETTER)?.length ?? 0)
}

function isMostlyAddress(line: string): boolean {
  const beside = line.replace(ADDRESS, ' ')
  if (beside === line || CODE_PUNCTUATION.test(beside)) return false
  return contentWeight(beside) < MIN_LETTERS_BESIDE_URL
}

function isTrailSegment(segment: string): boolean {
  const text = segment.trim()
  return (
    contentWeight(text) > 0 &&
    text.length <= MAX_SEGMENT_CHARS &&
    text.split(/\s+/u).length <= MAX_SEGMENT_WORDS &&
    !SENTENCE_LIKE_END.test(text)
  )
}

function isTrail(line: string): boolean {
  if (line.includes('\n') || line.length > MAX_TRAIL_CHARS || HAS_ADDRESS.test(line)) return false
  const separators = new Set([...line.matchAll(TRAIL_SEPARATOR)].map((match) => match[1]))
  if (separators.size !== 1) return false
  // `split` with a capturing group interleaves the separators; the segments sit at even positions.
  const segments = line.split(TRAIL_SEPARATOR).filter((_, index) => index % 2 === 0)
  return segments.length >= MIN_TRAIL_SEGMENTS && segments.every(isTrailSegment)
}

export function isLowInformation(text: string): boolean {
  const line = text.trim()
  if (line.length === 0) return true
  return (
    LINK_DEFINITION.test(line) || isMostlyAddress(line) || DECORATION.test(line) || isTrail(line)
  )
}

/** The value of a "Key: value" line, or undefined when the line is not one. */
function metadataValue(line: string): string | undefined {
  const value = METADATA_LINE.exec(line.trim())?.[1]?.trim()
  return value !== undefined && !SENTENCE_LIKE_END.test(value) ? value : undefined
}

/**
 * Which of these consecutive lines are low-information. Beyond the per-line rules this sees
 * metadata cards, which only show as a run of lines.
 */
export function lowInformationLines(lines: readonly string[]): boolean[] {
  const low = lines.map(isLowInformation)
  let start = 0
  while (start < lines.length) {
    let end = start
    let hasAddress = false
    for (let value = metadataValue(lines[end] ?? ''); value !== undefined;) {
      hasAddress ||= ONLY_ADDRESS.test(value)
      end += 1
      value = end < lines.length ? metadataValue(lines[end] ?? '') : undefined
    }
    if (end - start >= MIN_CARD_LINES && hasAddress) low.fill(true, start, end)
    start = Math.max(end, start + 1)
  }
  return low
}

/** How much of these passages is content: the length of their lines that are not low-information. */
export function informativeLength(passages: readonly string[]): number {
  return passages.reduce((total, passage) => {
    const lines = withoutInvisible(passage)
      .split('\n')
      .filter((line) => line.trim().length > 0)
    const low = lowInformationLines(lines)
    return (
      total + lines.reduce((sum, line, index) => sum + (low[index] ? 0 : line.trim().length), 0)
    )
  }, 0)
}
