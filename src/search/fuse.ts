/**
 * Turns the ranked lists of every upstream call into one candidate pool: URL normalization,
 * merging of duplicates, folding of translated mirrors, and reciprocal rank fusion.
 */
import type { SourceHit } from '../sources/types.ts'
import {
  canonicalUrl,
  dedupeKey,
  displayRank,
  hostMatchesSites,
  mirrorIdentity,
  siteOf,
} from './url.ts'

/** The result list of one upstream call. */
export interface RankedList {
  source: string
  /** 1-based indexes of the queries this call carried. */
  queries: number[]
  hits: SourceHit[]
}

export interface FusedHit {
  url: string
  title: string
  site: string
  published?: string
  passages: string[]
  foundBy: string[]
  q: number[]
}

export interface FuseOptions {
  /** Hosts to keep; empty keeps everything. Applied here so the restriction never depends on a source. */
  sites: readonly string[]
  /** Hits with a known date before this day (YYYY-MM-DD) are dropped; undated hits stay. */
  since: string | undefined
  /** Languages the query is plausibly written in; decides which translated mirror is kept. */
  languages: ReadonlySet<string>
}

/** Standard RRF constant: large enough that one list's top ranks do not drown agreement. */
const RRF_K = 60
const MAX_TITLE_CHARS = 200
/** About 1,100 tokens of prose, the longest excerpt the design promises. */
const MAX_TEXT_CHARS = 4000

interface Candidate {
  url: string
  title: string
  published: string | undefined
  passages: string[]
  foundBy: Set<string>
  queries: Set<number>
  /** Best rank per list. One list counts once, even after mirrors were folded together. */
  ranks: Map<number, number>
  /** Position of first appearance; the final, deterministic tie-breaker. */
  order: number
}

function textLength(passages: readonly string[]): number {
  return passages.reduce((sum, passage) => sum + passage.length, 0)
}

function limitText(passages: readonly string[]): string[] {
  const kept: string[] = []
  let used = 0
  for (const passage of passages) {
    const room = MAX_TEXT_CHARS - used
    if (room <= 0) break
    kept.push(passage.length <= room ? passage : `${passage.slice(0, room).trimEnd()}…`)
    used += passage.length
  }
  return kept
}

function limitTitle(title: string): string {
  return title.length <= MAX_TITLE_CHARS
    ? title
    : `${title.slice(0, MAX_TITLE_CHARS - 1).trimEnd()}…`
}

function keeps(hit: SourceHit, url: string, options: FuseOptions): boolean {
  if (options.sites.length && !hostMatchesSites(siteOf(url), options.sites)) return false
  return !(options.since && hit.published && hit.published < options.since)
}

/** Later sightings of the same page add provenance; they replace content only when they know more. */
function absorb(target: Candidate, hit: SourceHit, url: string): void {
  if (!target.title && hit.title) target.title = hit.title
  target.published ??= hit.published
  if (textLength(hit.passages) > textLength(target.passages)) target.passages = hit.passages
  if (displayRank(url) < displayRank(target.url)) target.url = url
}

function collect(lists: readonly RankedList[], options: FuseOptions): Candidate[] {
  const byKey = new Map<string, Candidate>()
  lists.forEach((list, listIndex) => {
    let rank = 0
    for (const hit of list.hits) {
      const url = canonicalUrl(hit.url)
      if (!url || !keeps(hit, url, options)) continue
      rank += 1
      const key = dedupeKey(url)
      let candidate = byKey.get(key)
      if (candidate) absorb(candidate, hit, url)
      else {
        candidate = {
          url,
          title: hit.title,
          published: hit.published,
          passages: hit.passages,
          foundBy: new Set(),
          queries: new Set(),
          ranks: new Map(),
          order: byKey.size,
        }
        byKey.set(key, candidate)
      }
      candidate.foundBy.add(list.source)
      for (const query of list.queries) candidate.queries.add(query)
      candidate.ranks.set(listIndex, Math.min(candidate.ranks.get(listIndex) ?? rank, rank))
    }
  })
  return [...byKey.values()]
}

/** Lower is better: the query's language, then English, then whichever ranked first. */
function mirrorPreference(language: string, languages: ReadonlySet<string>): number {
  if (languages.has(language)) return 0
  return language === 'en' ? 1 : 2
}

function mergeMirror(kept: Candidate, folded: Candidate): void {
  for (const source of folded.foundBy) kept.foundBy.add(source)
  for (const query of folded.queries) kept.queries.add(query)
  for (const [list, rank] of folded.ranks)
    kept.ranks.set(list, Math.min(kept.ranks.get(list) ?? rank, rank))
  kept.order = Math.min(kept.order, folded.order)
}

function foldMirrors(candidates: Candidate[], languages: ReadonlySet<string>): Candidate[] {
  const groups = new Map<string, Array<{ candidate: Candidate; preference: number }>>()
  const singles: Candidate[] = []
  for (const candidate of candidates) {
    const identity = mirrorIdentity(candidate.url)
    if (!identity) {
      singles.push(candidate)
      continue
    }
    const group = groups.get(identity.key) ?? []
    group.push({ candidate, preference: mirrorPreference(identity.language, languages) })
    groups.set(identity.key, group)
  }
  for (const group of groups.values()) {
    const [best, ...rest] = group.toSorted(
      (a, b) => a.preference - b.preference || a.candidate.order - b.candidate.order,
    )
    if (!best) continue
    for (const other of rest) mergeMirror(best.candidate, other.candidate)
    singles.push(best.candidate)
  }
  return singles
}

function score(candidate: Candidate): number {
  let total = 0
  for (const rank of candidate.ranks.values()) total += 1 / (RRF_K + rank)
  return total
}

function bestRank(candidate: Candidate): number {
  return Math.min(...candidate.ranks.values())
}

/**
 * With a single list RRF is the identity, so one source keeps its own order; with several
 * lists, pages that more than one call found rise.
 */
export function fuse(lists: readonly RankedList[], options: FuseOptions): FusedHit[] {
  const sourceOrder = [...new Set(lists.map((list) => list.source))]
  return foldMirrors(collect(lists, options), options.languages)
    .map((candidate) => ({ candidate, score: score(candidate) }))
    .toSorted(
      (a, b) =>
        b.score - a.score ||
        bestRank(a.candidate) - bestRank(b.candidate) ||
        a.candidate.order - b.candidate.order,
    )
    .map(({ candidate }) => ({
      url: candidate.url,
      title: limitTitle(candidate.title),
      site: siteOf(candidate.url),
      ...(candidate.published ? { published: candidate.published } : {}),
      passages: limitText(candidate.passages),
      foundBy: sourceOrder.filter((source) => candidate.foundBy.has(source)),
      q: [...candidate.queries].toSorted((a, b) => a - b),
    }))
}
