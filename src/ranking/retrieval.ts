import { AppError } from '../shared/errors.ts'
import { contentQuery, createSegmenter } from './lexical.ts'

export type RankingMode = 'upstream' | 'bm25' | 'bm25_mmr'
export interface RankableCandidate {
  readonly title: string
  readonly snippet: string
  readonly url: string
}
export interface RankingSpec {
  readonly mode: RankingMode
  readonly language: string
}
export interface RankedCandidate<T> {
  readonly candidate: T
  /** Raw BM25 relevance; null for unchanged upstream ordering. Never a probability. */
  readonly score: number | null
  readonly originalIndex: number
}
export const RETRIEVAL_VERSION = 'bm25-v1;k1=1.2;b=0.75;mmr-lambda=0.75;jaccard-v1'
export const RETRIEVAL_LIMITS = { candidates: 200, textChars: 12_000, queryChars: 2_000 } as const

function tokenize(text: string, segmenter: Intl.Segmenter): string[] {
  return [...segmenter.segment(text.normalize('NFKC').toLowerCase())]
    .filter((part) => part.isWordLike)
    .map((part) => part.segment)
}
function similarity(left: Set<string>, right: Set<string>): number {
  const intersection = [...left].filter((term) => right.has(term)).length
  const union = left.size + right.size - intersection
  return union ? intersection / union : 0
}

/** Bounded, deterministic in-pool reranking. Does not retrieve documents or assess truth.
 * Ties retain upstream order. MMR only reorders; it never drops candidates or invents engine ranks.
 */
export function rankCandidates<T extends RankableCandidate>(
  query: string,
  candidates: readonly T[],
  spec: RankingSpec,
): RankedCandidate<T>[] {
  if (
    candidates.length > RETRIEVAL_LIMITS.candidates ||
    Array.from(query).length > RETRIEVAL_LIMITS.queryChars ||
    candidates.some(
      (item) => Array.from(`${item.title}\n${item.snippet}`).length > RETRIEVAL_LIMITS.textChars,
    )
  )
    throw new AppError('INVALID_ARGUMENT', 'Candidate ranking resource budget exceeded.')
  if (spec.mode === 'upstream') {
    return candidates.map((candidate, originalIndex) => ({ candidate, originalIndex, score: null }))
  }
  const segmenter = createSegmenter(spec.language, 'word')
  const terms = new Set(tokenize(contentQuery(query), segmenter))
  const documents = candidates.map((candidate) =>
    tokenize(`${candidate.title}\n${candidate.snippet}`, segmenter),
  )
  const sets = documents.map((document) => new Set(document))
  const averageLength =
    documents.reduce((sum, document) => sum + document.length, 0) / (documents.length || 1)
  const idf = new Map(
    [...terms].map((term) => {
      const frequency = sets.filter((set) => set.has(term)).length
      return [term, Math.log(1 + (documents.length - frequency + 0.5) / (frequency + 0.5))]
    }),
  )
  const ranked = candidates
    .map((candidate, originalIndex) => {
      const document = documents[originalIndex] ?? []
      const frequencies = new Map<string, number>()
      for (const term of document) frequencies.set(term, (frequencies.get(term) ?? 0) + 1)
      let score = 0
      for (const term of terms) {
        const frequency = frequencies.get(term) ?? 0
        if (frequency)
          score +=
            ((idf.get(term) ?? 0) * (frequency * 2.2)) /
            (frequency + 1.2 * (0.25 + (0.75 * document.length) / (averageLength || 1)))
      }
      return { candidate, originalIndex, score }
    })
    .sort((a, b) => b.score - a.score || a.originalIndex - b.originalIndex)
  if (spec.mode === 'bm25' || (ranked[0]?.score ?? 0) === 0) return ranked
  const maximum = ranked[0]?.score ?? 1
  const selected: typeof ranked = []
  const remaining = [...ranked]
  const redundancy = new Map<number, number>()
  while (remaining.length) {
    let bestIndex = 0
    let bestUtility = -Infinity
    remaining.forEach((item, index) => {
      const utility =
        (0.75 * item.score) / maximum - 0.25 * (redundancy.get(item.originalIndex) ?? 0)
      if (utility > bestUtility) {
        bestUtility = utility
        bestIndex = index
      }
    })
    const chosen = remaining.splice(bestIndex, 1)[0]
    if (!chosen) break
    selected.push(chosen)
    const chosenTerms = sets[chosen.originalIndex] ?? new Set<string>()
    for (const item of remaining) {
      redundancy.set(
        item.originalIndex,
        Math.max(
          redundancy.get(item.originalIndex) ?? 0,
          similarity(chosenTerms, sets[item.originalIndex] ?? new Set<string>()),
        ),
      )
    }
  }
  return selected
}

/** Only call with actual independent engine result lists; aggregated SearXNG positions are insufficient. */
export function reciprocalRankFusion(
  lists: readonly (readonly string[])[],
  k = 60,
): Array<{ id: string; score: number }> {
  if (
    !Number.isFinite(k) ||
    k <= 0 ||
    lists.length > 20 ||
    lists.some((list) => list.length > 200)
  ) {
    throw new AppError('INVALID_ARGUMENT', 'Invalid RRF budget or rank constant.')
  }
  const scores = new Map<string, number>()
  for (const list of lists) {
    const seen = new Set<string>()
    list.forEach((id, index) => {
      if (!seen.has(id)) scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1))
      seen.add(id)
    })
  }
  return [...scores].map(([id, score]) => ({ id, score })).sort((a, b) => b.score - a.score)
}
