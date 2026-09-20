/**
 * Script-based language guess for queries. It only decides which translated mirror of a page to
 * keep, so a coarse answer is enough; Latin-script queries are treated as English.
 */

const SCRIPTS: ReadonlyArray<{ pattern: RegExp; minimum: number; languages: readonly string[] }> = [
  { pattern: /[\p{Script=Hiragana}\p{Script=Katakana}]/gu, minimum: 1, languages: ['ja'] },
  { pattern: /\p{Script=Hangul}/gu, minimum: 1, languages: ['ko'] },
  { pattern: /\p{Script=Han}/gu, minimum: 2, languages: ['zh'] },
  {
    pattern: /\p{Script=Cyrillic}/gu,
    minimum: 3,
    languages: ['ru', 'uk', 'bg', 'sr', 'mk', 'be', 'kk', 'mn'],
  },
  { pattern: /\p{Script=Arabic}/gu, minimum: 3, languages: ['ar', 'fa', 'ur'] },
  { pattern: /\p{Script=Devanagari}/gu, minimum: 3, languages: ['hi', 'mr', 'ne'] },
  { pattern: /\p{Script=Thai}/gu, minimum: 3, languages: ['th'] },
  { pattern: /\p{Script=Hebrew}/gu, minimum: 3, languages: ['he'] },
  { pattern: /\p{Script=Greek}/gu, minimum: 3, languages: ['el'] },
]

/** Primary language subtags the queries are plausibly written in. Never empty. */
export function queryLanguages(queries: readonly string[]): Set<string> {
  const text = queries.join(' ')
  for (const script of SCRIPTS) {
    const count = text.match(script.pattern)?.length ?? 0
    if (count >= script.minimum) return new Set(script.languages)
  }
  return new Set(['en'])
}
