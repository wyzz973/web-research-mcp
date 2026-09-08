import type { DocumentSnapshot, Passage } from '../shared/types.ts'
import { createSegmenter, scoreRelevance } from './lexical.ts'

/** Select complete sentences with adjacent context. Offsets refer to Unicode code points in the snapshot. */
export function selectPassages(
  query: string,
  snapshot: DocumentSnapshot,
  options: { maxPassages: number; maxChars: number; language?: string },
): Passage[] {
  if (options.maxPassages <= 0 || options.maxChars <= 0) return []
  const language = options.language ?? 'auto'
  const sentenceSegmenter = createSegmenter(language, 'sentence')
  const content = Array.from(snapshot.content)
  const candidates: Passage[] = []
  for (const segment of snapshot.segments) {
    // Stale or malformed segment metadata must never yield a falsely located quote.
    if (content.slice(segment.start_char, segment.end_char).join('') !== segment.text) continue
    let sentenceOffset = segment.start_char
    const sentences = [...sentenceSegmenter.segment(segment.text)].map((part) => {
      const size = Array.from(part.segment).length
      const sentence = { text: part.segment, start: sentenceOffset, size }
      sentenceOffset += size
      return sentence
    })
    for (let index = 0; index < sentences.length; index += 1) {
      const sentence = sentences[index]
      if (!sentence || sentence.size > options.maxChars) continue
      const relevance = scoreRelevance(query, sentence.text, 'quote', language)
      if (relevance.score === null || relevance.score === 0) continue
      let start = sentence.start
      let end = start + sentence.size
      // Include preceding context first: pronouns, quotations, and negation can qualify the next sentence.
      const previous = sentences[index - 1]
      if (previous && end - previous.start <= options.maxChars) start = previous.start
      const next = sentences[index + 1]
      if (next && next.start + next.size - start <= options.maxChars) end = next.start + next.size
      const quote = content.slice(start, end).join('')
      candidates.push({
        quote,
        start_char: start,
        end_char: end,
        segment_id: segment.id,
        relevance: scoreRelevance(query, quote, 'quote', language),
      })
    }
  }
  candidates.sort(
    (left, right) =>
      (right.relevance.score ?? 0) - (left.relevance.score ?? 0) ||
      left.start_char - right.start_char,
  )
  const selected: Passage[] = []
  for (const candidate of candidates) {
    if (
      selected.some(
        (item) => candidate.start_char < item.end_char && candidate.end_char > item.start_char,
      )
    )
      continue
    selected.push(candidate)
    if (selected.length >= options.maxPassages) break
  }
  return selected
}
