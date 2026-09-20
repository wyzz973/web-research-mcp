/** Lexical passage ranking for evidence mode. No model is called; scores only order passages. */
import { partCost, type Budget } from './budget.ts'
import { headingPath, type PageDocument } from './document.ts'

export interface Candidate {
  /** Index of the page in the request, used to keep selection order deterministic. */
  page: number
  /** The block that was scored. */
  block: number
  /** First block shown: the section heading when `block` directly follows it, else `block`. */
  from: number
  start: number
  end: number
  score: number
  cost: Budget
  /** Whitespace-insensitive text key; equal keys on different pages are the same passage. */
  key: string | undefined
  alsoIn: number[]
}

const UNSEGMENTED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}\p{Script=Khmer}\p{Script=Lao}]/u
const WORD = /[\p{L}\p{N}][\p{L}\p{N}\p{M}_'-]*/gu
const STOPWORDS = new Set(
  'a an and are as at be by can do does for from how i in is it its of on or that the this to was what when where which who why will with you 的 了 和 是 在 有 与 及 或 吗 呢 什么 如何 怎么 怎样'.split(
    ' ',
  ),
)
const K1 = 1.2
/** Mild: long blocks are penalized a little, and short ones never rewarded (see `bodyScore`). */
const B = 0.5
const HEADING_WEIGHTS = [0.6, 0.3, 0.15]
const MIN_DEDUPE_CHARS = 40
/**
 * Passages scoring below this share of the best one are padding, not evidence. Unused budget is
 * spent on context around the good passages (see select.ts), not on lowering this bar: on a real
 * API reference, 0.25 let in an unrelated history table and an option that only shared "default".
 */
const RELEVANCE_FLOOR = 0.35

let segmenter: Intl.Segmenter | undefined

function segmentWords(text: string): string[] {
  segmenter ??= new Intl.Segmenter(undefined, { granularity: 'word' })
  const words: string[] = []
  for (const part of segmenter.segment(text)) if (part.isWordLike) words.push(part.segment)
  return words
}

/** Plural "s" only: enough to join "timeout" with "timeouts" without a stemmer's false merges. */
function singular(word: string): string {
  if (word.length < 4 || !word.endsWith('s') || /(?:ss|us|is)$/u.test(word)) return word
  return word.slice(0, -1)
}

/** Dictionary segmentation is slow, so it is used only for scripts that do not put spaces between words. */
export function tokenize(text: string): string[] {
  const folded = text.normalize('NFKC').toLowerCase()
  const words = UNSEGMENTED.test(folded) ? segmentWords(folded) : (folded.match(WORD) ?? [])
  return words.map(singular)
}

export function goalTerms(goal: string): string[] {
  const all = [...new Set(tokenize(goal))]
  const content = all.filter((term) => !STOPWORDS.has(term))
  return content.length > 0 ? content : all
}

interface Scored {
  page: number
  block: number
  length: number
  counts: Map<string, number>
  headingTerms: Set<string>[]
}

function countTerms(tokens: string[], terms: Set<string>): Map<string, number> {
  const counts = new Map<string, number>()
  for (const token of tokens) if (terms.has(token)) counts.set(token, (counts.get(token) ?? 0) + 1)
  return counts
}

function scanPage(document: PageDocument, page: number, terms: Set<string>): Scored[] {
  const headingCache = new Map<number, Set<string>>()
  const termsOf = (start: number, title: string): Set<string> => {
    const cached = headingCache.get(start)
    if (cached) return cached
    const found = new Set(tokenize(title).filter((token) => terms.has(token)))
    headingCache.set(start, found)
    return found
  }
  const scored: Scored[] = []
  document.blocks.forEach((block, index) => {
    if (block.kind === 'heading') return
    const tokens = tokenize(document.markdown.slice(block.start, block.end))
    const path = headingPath(document, block.start).slice(0, HEADING_WEIGHTS.length)
    scored.push({
      page,
      block: index,
      length: Math.max(1, tokens.length),
      counts: countTerms(tokens, terms),
      headingTerms: path.map((entry) => termsOf(entry.start, `${entry.id} ${entry.title}`)),
    })
  })
  return scored
}

function inverseFrequencies(scored: Scored[], terms: string[]): Map<string, number> {
  const idf = new Map<string, number>()
  for (const term of terms) {
    const containing = scored.filter((item) => item.counts.has(term)).length
    idf.set(term, Math.log(1 + (scored.length - containing + 0.5) / (containing + 0.5)))
  }
  return idf
}

/**
 * BM25 with one change: a block shorter than average is scored as if it were average. Plain
 * length normalization lets a two-line table that mentions one goal word outrank the paragraph
 * that answers the question, only because it is short.
 */
function bodyScore(item: Scored, idf: Map<string, number>, average: number): number {
  const relativeLength = Math.max(item.length, average) / average
  let score = 0
  for (const [term, count] of item.counts) {
    const saturation = (count * (K1 + 1)) / (count + K1 * (1 - B + B * relativeLength))
    score += (idf.get(term) ?? 0) * saturation
  }
  return score
}

function headingScore(item: Scored, idf: Map<string, number>): number {
  let score = 0
  item.headingTerms.forEach((found, depth) => {
    for (const term of found) score += (idf.get(term) ?? 1) * (HEADING_WEIGHTS[depth] ?? 0)
  })
  return score
}

/**
 * Share of the goal a passage covers, weighted by rarity, as a multiplier in (0, 1]. A passage
 * that touches most of the distinctive goal words beats one that repeats a single word.
 */
function coverage(item: Scored, idf: Map<string, number>): number {
  const matched = new Set([...item.counts.keys(), ...item.headingTerms.flatMap((set) => [...set])])
  let total = 0
  let covered = 0
  for (const [term, weight] of idf) {
    total += weight
    if (matched.has(term)) covered += weight
  }
  return total > 0 ? Math.sqrt(covered / total) : 1
}

/** A block counts as a hit when it mentions a goal term, or sits directly under a heading that does. */
function isHit(item: Scored): boolean {
  return item.counts.size > 0 || (item.headingTerms[0]?.size ?? 0) > 0
}

function passageKey(text: string): string | undefined {
  const key = text.replace(/\s+/gu, ' ').trim()
  return key.length >= MIN_DEDUPE_CHARS ? key : undefined
}

function toCandidate(document: PageDocument, item: Scored, score: number): Candidate {
  const block = document.blocks[item.block]
  const before = document.blocks[item.block - 1]
  // The first block of a section carries its heading, so the passage explains itself.
  const start = before?.kind === 'heading' ? before.start : (block?.start ?? 0)
  const end = block?.end ?? start
  const own = document.markdown.slice(block?.start ?? start, end)
  return {
    page: item.page,
    block: item.block,
    from: before?.kind === 'heading' ? item.block - 1 : item.block,
    start,
    end,
    score,
    cost: partCost(document.markdown.slice(start, end)),
    key: passageKey(own),
    alsoIn: [],
  }
}

/**
 * Candidates per page. Term rarity is measured over every page of the request together, so
 * scores are comparable when one budget is shared between pages.
 */
export function rankPassages(documents: PageDocument[], goal: string): Candidate[][] {
  const terms = goalTerms(goal)
  const termSet = new Set(terms)
  const scanned = documents.map((document, page) => scanPage(document, page, termSet))
  const everything = scanned.flat()
  const idf = inverseFrequencies(everything, terms)
  const average =
    everything.reduce((sum, item) => sum + item.length, 0) / Math.max(1, everything.length)
  return scanned.map((items, page) => {
    const document = documents[page]
    if (!document) return []
    return items.filter(isHit).map((item) => {
      const score = (bodyScore(item, idf, average) + headingScore(item, idf)) * coverage(item, idf)
      return toCandidate(document, item, score)
    })
  })
}

/** Every passage of a page that is shown whole, so that reposts of it elsewhere are recognized. */
export function wholePagePassages(document: PageDocument, page: number): Candidate[] {
  return document.blocks.flatMap((block, index) => {
    if (block.kind === 'heading') return []
    const key = passageKey(document.markdown.slice(block.start, block.end))
    const cost = { tokens: 0, chars: 0 }
    return [
      {
        page,
        block: index,
        from: index,
        start: block.start,
        end: block.end,
        score: 0,
        cost,
        key,
        alsoIn: [],
      },
    ]
  })
}

/**
 * Drops the long tail of weak matches instead of filling the budget with it. Every page keeps
 * its single best passage, so a page is never reported as irrelevant only because another page
 * scored higher.
 */
export function keepRelevant(candidates: Candidate[][]): Candidate[][] {
  const best = candidates.flat().reduce((top, candidate) => Math.max(top, candidate.score), 0)
  return candidates.map((list) => {
    const pageBest = list.reduce((top, candidate) => Math.max(top, candidate.score), 0)
    return list.filter(
      (candidate) => candidate.score >= best * RELEVANCE_FLOOR || candidate.score === pageBest,
    )
  })
}

/** The same passage on a later page is dropped; the first carrier records where else it appeared. */
export function dropReposts(candidates: Candidate[][], pageNumbers: number[]): Candidate[][] {
  const firstSeen = new Map<string, Candidate>()
  return candidates.map((list, page) =>
    list.filter((candidate) => {
      if (candidate.key === undefined) return true
      const original = firstSeen.get(candidate.key)
      if (!original) {
        firstSeen.set(candidate.key, candidate)
        return true
      }
      if (original.page === page) return true
      const n = pageNumbers[page]
      if (n !== undefined && !original.alsoIn.includes(n)) original.alsoIn.push(n)
      return false
    }),
  )
}
