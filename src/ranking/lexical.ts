import { AppError } from '../shared/errors.ts'
import type { Relevance } from '../shared/types.ts'

/** Structured site restrictions are scored separately; inline site operators are not content terms. */
export function contentQuery(query: string): string {
  return query.replace(/(^|\s)-?site:(?:"[^"]*"|'[^']*'|[^\s]+)/giu, '$1').trim()
}

export function createSegmenter(
  language: string,
  granularity: 'word' | 'sentence',
): Intl.Segmenter {
  try {
    return new Intl.Segmenter(language === 'auto' || language === 'all' ? 'en' : language, {
      granularity,
    })
  } catch {
    throw new AppError('INVALID_ARGUMENT', 'Unsupported language locale.')
  }
}

function tokens(text: string, segmenter: Intl.Segmenter): Set<string> {
  return new Set(
    [...segmenter.segment(text.normalize('NFKC').toLowerCase())]
      .filter((part) => part.isWordLike)
      .map((part) => part.segment),
  )
}

/** Query token coverage is a lexical relevance score, never a probability of factual correctness. */
export function scoreRelevance(
  query: string,
  text: string,
  basis: Relevance['basis'],
  language = 'auto',
): Relevance {
  const segmenter = createSegmenter(language, 'word')
  const queryTerms = tokens(contentQuery(query), segmenter)
  const textTerms = tokens(text, segmenter)
  if (queryTerms.size === 0 || textTerms.size === 0) {
    return {
      score: null,
      method: 'none',
      version: null,
      basis,
      matched_terms: [],
      reasons: [queryTerms.size === 0 ? 'no_query_terms' : 'no_evaluable_text'],
    }
  }
  const matched = [...queryTerms].filter((term) => textTerms.has(term))
  return {
    score: matched.length / queryTerms.size,
    method: 'lexical_coverage_v1',
    version: `lexical_coverage_v1;node=${process.versions.node};icu=${process.versions.icu};locale=${segmenter.resolvedOptions().locale}`,
    basis,
    matched_terms: matched,
    reasons: [`matched_unique_terms=${matched.length}/${queryTerms.size}`, 'not_fact_probability'],
  }
}
