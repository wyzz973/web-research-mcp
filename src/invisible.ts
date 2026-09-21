/**
 * One definition, for search text and for page text, of the characters a reader cannot see.
 *
 * Pages use them to hide text from people, to reorder what people see, and to smuggle text to a
 * model: a sentence spelled in Unicode tag characters (U+E0000-E007F) is invisible on screen and
 * still readable by some models, and variation selectors can carry arbitrary bytes. Everything
 * listed here is removed from what a response shows, and every removal is counted, so that
 * nothing disappears silently.
 *
 * A few invisible characters have honest uses, and removing them would change how real text is
 * spelled or drawn. They stay only where that use is the plausible one. The first version of
 * this file kept them wherever they were merely well formed, and the sixth audit round showed
 * that this was the hole: a selector after every visible character carried a byte each, and any
 * tag sequence shaped like a flag passed whole. So the exceptions are narrow on purpose:
 * - joiners (U+200C, U+200D): one, inside an emoji sequence, or between two characters of the
 *   same script when that script spells with joiners (Arabic-script languages, the Indic scripts,
 *   Mongolian, and a few more). Between Latin letters a joiner joins nothing.
 * - emoji presentation selectors (U+FE0E, U+FE0F): one, behind a pictograph or inside a keycap.
 * - Mongolian free variation selectors: one, behind a Mongolian letter.
 * - tag characters: only the three emoji flags that exist (England, Scotland, Wales).
 * The other variation selectors, including the ideographic ones (U+E0100-E01EF), are removed:
 * a variant glyph of a rare kanji falls back to its base character, which is the same text, and
 * in exchange Chinese and Japanese pages cannot carry a byte behind every character.
 */

export interface Visible {
  text: string
  /** How many invisible code points were taken out. */
  removed: number
}

/**
 * Never shown and never needed. The base is two Unicode properties, not a list of their members.
 * The seventh audit round smuggled a sentence through 29 format characters that a hand-written
 * list had missed; the eighth smuggled one through 159 code points that the format class does
 * not contain because Unicode has not assigned them yet, in blocks that are reserved for
 * characters a reader will never see. "Default ignorable" is the property for exactly that:
 * what a renderer is told to draw as nothing, assigned or not, which is why it covers the
 * variation selectors as well. What is added here by hand is only what neither property holds:
 * controls, the fillers that are letters, the selectors that are marks, and the unassigned tail
 * of the shorthand format block.
 */
const ALWAYS =
  '(?![\\n\\t])\\p{Cc}|\\p{Cf}|\\p{Default_Ignorable_Code_Point}' +
  '|[\\u034F\\u115F\\u1160\\u17B4\\u17B5\\u3164\\uFE00-\\uFE0D\\uFFA0]' +
  '|[\\u{1BCA4}-\\u{1BCAF}]'
/** The subdivision flags in the emoji set: a black flag, the region in tag letters, a cancel tag. */
const FLAG =
  '\\u{1F3F4}(?:\\u{E0067}\\u{E0062}\\u{E0065}\\u{E006E}\\u{E0067}|\\u{E0067}\\u{E0062}\\u{E0073}\\u{E0063}\\u{E0074}|\\u{E0067}\\u{E0062}\\u{E0077}\\u{E006C}\\u{E0073})\\u{E007F}'
const JOINERS = '[\\u200C\\u200D]+'
const EMOJI_SELECTORS = '[\\uFE0E\\uFE0F]+'
const MONGOLIAN_SELECTORS = '[\\u180B-\\u180D\\u180F]+'

/** Runs are matched whole, so a page made of nothing else costs one callback, not millions. */
const INVISIBLE = new RegExp(
  // The exceptions come first: joiners are format characters too, and the run that `always`
  // matches would otherwise swallow them before they are judged in their context.
  `(?<flag>${FLAG})|(?<joiners>${JOINERS})|(?<emoji>${EMOJI_SELECTORS})` +
    `|(?<mongolian>${MONGOLIAN_SELECTORS})|(?<always>(?:${ALWAYS})+)`,
  'gu',
)

/** Inside an emoji sequence: behind a pictograph with its modifiers, in front of a pictograph. */
const PICTOGRAPH_BEFORE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\uFE0F]$/u
const PICTOGRAPH_AFTER = /^\p{Extended_Pictographic}/u
const KEYCAP_BASE = /[0-9#*]$/u
const KEYCAP_MARK = /^\u20E3/u
const MONGOLIAN_LETTER = /\p{Script=Mongolian}$/u

/** Scripts that spell with joiners. Script extensions, so that shared marks such as a virama count. */
const JOINING_SCRIPTS = [
  'Arabic',
  'Syriac',
  'Nko',
  'Mongolian',
  'Devanagari',
  'Bengali',
  'Gurmukhi',
  'Gujarati',
  'Oriya',
  'Tamil',
  'Telugu',
  'Kannada',
  'Malayalam',
  'Sinhala',
  'Khmer',
  'Myanmar',
  'Tibetan',
].map((script) => ({
  before: new RegExp(`\\p{Script_Extensions=${script}}$`, 'u'),
  after: new RegExp(`^\\p{Script_Extensions=${script}}`, 'u'),
}))

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

function joins(left: string, right: string): boolean {
  if (PICTOGRAPH_BEFORE.test(left) && PICTOGRAPH_AFTER.test(right)) return true
  return JOINING_SCRIPTS.some((script) => script.before.test(left) && script.after.test(right))
}

function presents(left: string, right: string): boolean {
  return PICTOGRAPH_BEFORE.test(left) || (KEYCAP_BASE.test(left) && KEYCAP_MARK.test(right))
}

export function stripInvisible(text: string): Visible {
  let removed = 0
  const visible = text.replace(INVISIBLE, (match: string, ...rest: unknown[]) => {
    const groups = rest.at(-1) as Record<string, string | undefined>
    const offset = rest.at(-3) as number
    if (groups.flag !== undefined) return match
    const length = codePoints(match)
    const left = before(text, offset)
    const right = after(text, offset + match.length)
    const keeps =
      groups.always !== undefined
        ? false
        : groups.joiners !== undefined
          ? joins(left, right)
          : groups.emoji !== undefined
            ? presents(left, right)
            : MONGOLIAN_LETTER.test(left)
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
