/** Query and goal words used to pick excerpts and to judge whether results match the query. */

export interface Term {
  text: string
  /** Quoted phrase 3, query word 2, goal word 1. */
  weight: number
  /** Expects lower-cased text. */
  matches(lowerText: string): boolean
}

const MAX_TERMS = 48
const PHRASE = /"([^"]{3,80})"/gu
const CJK_RUN = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu
const WORD = /[\p{L}\p{N}]+(?:[.+#'’_-][\p{L}\p{N}]+)*[+#]*/gu

const STOPWORDS = new Set(
  (
    'a an and are as at be but by can do does for from how i if in into is it its me my of on or ' +
    'our that the their them then there these this to us was we were what when where which who ' +
    'why will with you your vs via about not no'
  ).split(' '),
)

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')
}

/** Left boundary only, so "fetch" also finds "fetching" but "js" does not find "nodejs". */
function wordMatcher(word: string): (lowerText: string) => boolean {
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(word)}`, 'u')
  return (lowerText) => pattern.test(lowerText)
}

function phraseMatcher(phrase: string): (lowerText: string) => boolean {
  const pattern = new RegExp(phrase.split(' ').map(escapeRegExp).join('\\s+'), 'u')
  return (lowerText) => pattern.test(lowerText)
}

/** "node.js" yields the compound and its parts, so either spelling in the text counts. */
function wordsOf(text: string): string[] {
  const words: string[] = []
  for (const match of text.replace(CJK_RUN, ' ').matchAll(WORD)) {
    const compound = match[0]
    const parts = compound.split(/[.+#'’_-]+/u).filter(Boolean)
    words.push(...(parts.length > 1 ? [compound, ...parts] : [compound]))
  }
  return words.filter((word) => word.length > 1 && !STOPWORDS.has(word))
}

/** Unsegmented scripts are matched by overlapping character pairs. */
function bigramsOf(text: string): string[] {
  const grams: string[] = []
  for (const match of text.matchAll(CJK_RUN)) {
    const chars = [...match[0]]
    if (chars.length === 1) grams.push(match[0])
    for (let index = 0; index + 1 < chars.length; index += 1)
      grams.push(`${chars[index]}${chars[index + 1]}`)
  }
  return grams
}

function collect(terms: Map<string, Term>, text: string, weight: number): void {
  const lower = text.toLowerCase()
  const add = (key: string, term: Term) => {
    const known = terms.get(key)
    if (!known || known.weight < term.weight) terms.set(key, term)
  }
  for (const match of lower.matchAll(PHRASE)) {
    const phrase = (match[1] ?? '').replace(/\s+/gu, ' ').trim()
    // Only a phrase quoted in a query outranks single words; a goal stays at weight 1 throughout.
    const phraseWeight = weight >= 2 ? weight + 1 : weight
    if (phrase.includes(' '))
      add(`"${phrase}"`, { text: phrase, weight: phraseWeight, matches: phraseMatcher(phrase) })
  }
  for (const word of wordsOf(lower)) add(word, { text: word, weight, matches: wordMatcher(word) })
  for (const gram of bigramsOf(lower))
    add(gram, { text: gram, weight, matches: (lowerText) => lowerText.includes(gram) })
}

export function buildTerms(queries: readonly string[], goal: string | undefined): Term[] {
  const terms = new Map<string, Term>()
  for (const query of queries) collect(terms, query, 2)
  if (goal) collect(terms, goal, 1)
  return [...terms.values()].slice(0, MAX_TERMS)
}

/** Share of the query's own words (not the goal's) that occur anywhere in `texts`. */
export function queryCoverage(terms: readonly Term[], texts: readonly string[]): number {
  const own = terms.filter((term) => term.weight >= 2)
  if (own.length === 0) return 1
  const haystack = texts.join('\n').toLowerCase()
  return own.filter((term) => term.matches(haystack)).length / own.length
}
