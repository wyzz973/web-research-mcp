/** Lexical passage ranking for evidence mode. No model is called; scores only order passages. */
import { headingPath, type PageDocument } from './document.ts'
import { runSliced, runToEnd } from './slices.ts'

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
  /** Numbers of other pages that carry the same passage. */
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

/** Blocks tokenized before the driver looks at the clock again. */
const SLICE_BLOCKS = 64

/** What ranking needs from one page: its hits, and the size of the corpus they were found in. */
interface Scan {
  hits: Scored[]
  blocks: number
  length: number
}

/**
 * Only blocks that match are kept. A long page has tens of thousands of blocks and a handful of
 * hits; an object per block would cost memory, and the collector's pauses, for nothing.
 */
function* scanPage(
  document: PageDocument,
  page: number,
  terms: Set<string>,
): Generator<void, Scan> {
  const headingCache = new Map<number, Set<string>>()
  const termsOf = (start: number, title: string): Set<string> => {
    const cached = headingCache.get(start)
    if (cached) return cached
    const found = new Set(tokenize(title).filter((token) => terms.has(token)))
    headingCache.set(start, found)
    return found
  }
  const scan: Scan = { hits: [], blocks: 0, length: 0 }
  for (const [index, block] of document.blocks.entries()) {
    if (index % SLICE_BLOCKS === SLICE_BLOCKS - 1) yield
    if (block.kind === 'heading') continue
    const tokens = tokenize(document.markdown.slice(block.start, block.end))
    const length = Math.max(1, tokens.length)
    scan.blocks += 1
    scan.length += length
    const item: Scored = {
      page,
      block: index,
      length,
      counts: countTerms(tokens, terms),
      headingTerms: headingPath(document, block.start)
        .slice(0, HEADING_WEIGHTS.length)
        .map((entry) => termsOf(entry.start, `${entry.id} ${entry.title}`)),
    }
    if (isHit(item)) scan.hits.push(item)
  }
  return scan
}

/** Items handled between two yields of the loops below. */
const ITEMS_PER_STEP = 4096

/** One pass over the hits, whatever the number of goal terms. */
function* inverseFrequencies(scans: Scan[], terms: string[]): Generator<void, Map<string, number>> {
  const containing = new Map<string, number>(terms.map((term) => [term, 0]))
  let seen = 0
  for (const scan of scans) {
    for (const item of scan.hits) {
      for (const term of item.counts.keys()) containing.set(term, (containing.get(term) ?? 0) + 1)
      seen += 1
      if (seen % ITEMS_PER_STEP === 0) yield
    }
  }
  const total = scans.reduce((sum, scan) => sum + scan.blocks, 0)
  const idf = new Map<string, number>()
  for (const [term, count] of containing)
    idf.set(term, Math.log(1 + (total - count + 0.5) / (count + 0.5)))
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
  let total = 0
  let covered = 0
  for (const [term, weight] of idf) {
    total += weight
    const matched = item.counts.has(term) || item.headingTerms.some((found) => found.has(term))
    if (matched) covered += weight
  }
  return total > 0 ? Math.sqrt(covered / total) : 1
}

/** A block counts as a hit when it mentions a goal term, or sits directly under a heading that does. */
function isHit(item: Scored): boolean {
  return item.counts.size > 0 || (item.headingTerms[0]?.size ?? 0) > 0
}

function toCandidate(document: PageDocument, item: Scored, score: number): Candidate {
  const block = document.blocks[item.block]
  const before = document.blocks[item.block - 1]
  // The first block of a section carries its heading, so the passage explains itself.
  const withHeading = before?.kind === 'heading'
  const start = withHeading ? before.start : (block?.start ?? 0)
  return {
    page: item.page,
    block: item.block,
    from: withHeading ? item.block - 1 : item.block,
    start,
    end: block?.end ?? start,
    score,
    alsoIn: [],
  }
}

/**
 * Candidates per page. Term rarity is measured over every page of the request together, so
 * scores are comparable when one budget is shared between pages. Costs and duplicate keys are
 * not computed here: most candidates are dropped before anyone needs them.
 */
export function* rankSteps(
  documents: PageDocument[],
  goal: string,
): Generator<void, Candidate[][]> {
  const terms = goalTerms(goal)
  const termSet = new Set(terms)
  const scans: Scan[] = []
  for (const [page, document] of documents.entries())
    scans.push(yield* scanPage(document, page, termSet))
  const idf = yield* inverseFrequencies(scans, terms)
  const blocks = scans.reduce((sum, scan) => sum + scan.blocks, 0)
  const average = scans.reduce((sum, scan) => sum + scan.length, 0) / Math.max(1, blocks)
  const ranked: Candidate[][] = []
  for (const [page, scan] of scans.entries()) {
    const document = documents[page]
    const list: Candidate[] = []
    for (const [index, item] of scan.hits.entries()) {
      if (index % ITEMS_PER_STEP === ITEMS_PER_STEP - 1) yield
      if (!document) continue
      const score = (bodyScore(item, idf, average) + headingScore(item, idf)) * coverage(item, idf)
      list.push(toCandidate(document, item, score))
    }
    ranked.push(list)
  }
  return ranked
}

export function rankPassages(documents: PageDocument[], goal: string): Candidate[][] {
  return runToEnd(rankSteps(documents, goal))
}

/** The same ranking for real snapshots: tokenizing megabytes must not stall the event loop. */
export function rankPassagesSliced(
  documents: PageDocument[],
  goal: string,
  signal: AbortSignal,
): Promise<Candidate[][]> {
  return runSliced(rankSteps(documents, goal), signal)
}

/** Every passage of a page that is shown whole, so that reposts of it elsewhere are recognized. */
export function* wholePagePassages(
  document: PageDocument,
  page: number,
): Generator<void, Candidate[]> {
  const passages: Candidate[] = []
  for (const [index, block] of document.blocks.entries()) {
    if (index % ITEMS_PER_STEP === ITEMS_PER_STEP - 1) yield
    if (block.kind === 'heading') continue
    const { start, end } = block
    passages.push({ page, block: index, from: index, start, end, score: 0, alsoIn: [] })
  }
  return passages
}

function* highestScore(list: Candidate[]): Generator<void, number> {
  let best = 0
  for (const [index, candidate] of list.entries()) {
    best = Math.max(best, candidate.score)
    if (index % ITEMS_PER_STEP === ITEMS_PER_STEP - 1) yield
  }
  return best
}

/**
 * Drops the long tail of weak matches instead of filling the budget with it. Every page keeps
 * its single best passage, so a page is never reported as irrelevant only because another page
 * scored higher.
 */
export function* relevantSteps(candidates: Candidate[][]): Generator<void, Candidate[][]> {
  const pageBest: number[] = []
  for (const list of candidates) pageBest.push(yield* highestScore(list))
  const floor = Math.max(0, ...pageBest) * RELEVANCE_FLOOR
  const kept: Candidate[][] = []
  for (const [page, list] of candidates.entries()) {
    const relevant: Candidate[] = []
    for (const [index, candidate] of list.entries()) {
      if (index % ITEMS_PER_STEP === ITEMS_PER_STEP - 1) yield
      if (candidate.score >= floor || candidate.score === pageBest[page]) relevant.push(candidate)
    }
    kept.push(relevant)
  }
  return kept
}

export function keepRelevant(candidates: Candidate[][]): Candidate[][] {
  return runToEnd(relevantSteps(candidates))
}

/** Whitespace-insensitive text of a passage; short passages are too common to call reposts. */
function passageKey(document: PageDocument, candidate: Candidate): string | undefined {
  const block = document.blocks[candidate.block]
  if (!block || block.end - block.start < MIN_DEDUPE_CHARS) return undefined
  const key = document.markdown.slice(block.start, block.end).replace(/\s+/gu, ' ').trim()
  return key.length >= MIN_DEDUPE_CHARS ? key : undefined
}

/** The same passage on a later page is dropped; the first carrier records where else it appeared. */
export function* dropRepostSteps(
  documents: PageDocument[],
  candidates: Candidate[][],
  pageNumbers: number[],
): Generator<void, Candidate[][]> {
  const firstSeen = new Map<string, Candidate>()
  const kept: Candidate[][] = []
  for (const [page, list] of candidates.entries()) {
    const document = documents[page]
    const unique: Candidate[] = []
    for (const [index, candidate] of list.entries()) {
      if (index % ITEMS_PER_STEP === ITEMS_PER_STEP - 1) yield
      const key = document ? passageKey(document, candidate) : undefined
      const original = key === undefined ? undefined : firstSeen.get(key)
      if (key !== undefined && !original) firstSeen.set(key, candidate)
      if (!original || original.page === page) unique.push(candidate)
      else {
        const n = pageNumbers[page]
        if (n !== undefined && !original.alsoIn.includes(n)) original.alsoIn.push(n)
      }
    }
    kept.push(unique)
  }
  return kept
}
