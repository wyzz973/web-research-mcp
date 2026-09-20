/**
 * One definition, for search text and for page text, of the characters a reader cannot see.
 *
 * Pages use them to hide text from people, to reorder what people see, and to smuggle text to a
 * model: a sentence spelled in Unicode tag characters (U+E0000-E007F) is invisible on screen and
 * still readable by some models, and a long run of variation selectors can carry arbitrary bytes.
 * Everything listed here is removed from what a response shows, and every removal is counted, so
 * that nothing disappears silently.
 *
 * Three kinds of invisible character also have honest uses, and removing them would change how
 * real text is spelled or drawn, so they stay where that use is plausible and only there:
 * - joiners (U+200C, U+200D): one, between two visible characters. Persian and Indic scripts spell
 *   words with them and emoji sequences are built with them. Runs and stray ones go.
 * - variation selectors: one, directly after a visible character. Emoji presentation, keycaps,
 *   ideographic variants, and Mongolian letters use them. Runs go.
 * - tag characters: only the emoji flag form, a black flag followed by up to six tag letters or
 *   digits and the cancel tag (England, Scotland, Wales).
 */

export interface Visible {
  text: string
  /** How many invisible code points were taken out. */
  removed: number
}

/** Never shown and never needed: controls, format characters, fillers, and the tag block. */
const ALWAYS =
  '(?![\\n\\t])\\p{Cc}' +
  '|[\\u00AD\\u034F\\u061C\\u115F\\u1160\\u17B4\\u17B5\\u180E\\u200B\\u200E\\u200F' +
  '\\u202A-\\u202E\\u2060-\\u2064\\u2066-\\u2069\\u3164\\uFEFF\\uFFA0\\uFFF9-\\uFFFB]' +
  '|[\\u{1D173}-\\u{1D17A}\\u{E0000}-\\u{E007F}]'
const FLAG = '\\u{1F3F4}[\\u{E0030}-\\u{E0039}\\u{E0061}-\\u{E007A}]{1,6}\\u{E007F}'
const JOINERS = '[\\u200C\\u200D]+'
const SELECTORS = '[\\uFE00-\\uFE0F\\u180B-\\u180D\\u180F\\u{E0100}-\\u{E01EF}]+'

/** Runs are matched whole, so a page made of nothing else costs one callback, not millions. */
const INVISIBLE = new RegExp(
  `(?<flag>${FLAG})|(?<always>(?:${ALWAYS})+)|(?<joiners>${JOINERS})|(?<selectors>${SELECTORS})`,
  'gu',
)

/** What a joiner may follow: a letter, a mark, a digit, or a pictograph with its modifiers. */
const BEFORE_JOINER = /[\p{L}\p{M}\p{N}\p{Extended_Pictographic}\p{Emoji_Modifier}️]$/u
const AFTER_JOINER = /^[\p{L}\p{M}\p{N}\p{Extended_Pictographic}]/u
/** What a variation selector may follow: anything visible that is not a space. */
const BEFORE_SELECTOR = /[\p{L}\p{N}\p{S}\p{P}]$/u

function codePoints(text: string): number {
  let count = 0
  for (const _point of text) count += 1
  return count
}

/** The one or two UTF-16 units before `offset`: enough to see the code point that ends there. */
function before(text: string, offset: number): string {
  return text.slice(Math.max(0, offset - 2), offset)
}

function after(text: string, offset: number): string {
  return text.slice(offset, offset + 2)
}

export function stripInvisible(text: string): Visible {
  let removed = 0
  const visible = text.replace(INVISIBLE, (match: string, ...rest: unknown[]) => {
    const groups = rest.at(-1) as Record<string, string | undefined>
    const offset = rest.at(-3) as number
    if (groups.flag !== undefined) return match
    const length = codePoints(match)
    if (groups.always !== undefined) {
      removed += length
      return ''
    }
    const keeps =
      groups.joiners !== undefined
        ? BEFORE_JOINER.test(before(text, offset)) &&
          AFTER_JOINER.test(after(text, offset + match.length))
        : BEFORE_SELECTOR.test(before(text, offset))
    if (!keeps) {
      removed += length
      return ''
    }
    // The first of a run is the honest one; whatever follows it carries nothing a reader sees.
    removed += length - 1
    return String.fromCodePoint(match.codePointAt(0) ?? 0)
  })
  return { text: visible, removed }
}

/** For comparing and classifying text; use `stripInvisible` when the result is shown. */
export function withoutInvisible(text: string): string {
  return stripInvisible(text).text
}
