/**
 * Turns the ranked lists of every upstream call into one candidate pool: URL normalization,
 * merging of duplicates, folding of translated mirrors, and reciprocal rank fusion.
 */
import type { SourceHit } from '../sources/types.ts'
import { informativeLength } from './low-information.ts'
import {
  canonicalUrl,
  dedupeKey,
  displayRank,
  hostMatchesSites,
  mirrorIdentity,
  siteOf,
  type MirrorIdentity,
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

/**
 * Later sightings of the same page add provenance; they replace content only when they know more.
 * "More" is measured in content: a source's metadata card about a page is long and says nothing.
 */
function absorb(target: Candidate, hit: SourceHit, url: string): void {
  if (!target.title && hit.title) target.title = hit.title
  target.published ??= hit.published
  if (informativeLength(hit.passages) > informativeLength(target.passages))
    target.passages = hit.passages
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

/** Lower is better: the query's language, then the untranslated host, then English, then the rest. */
function mirrorPreference(language: string, languages: ReadonlySet<string>): number {
  // A host without a language label is the original, which these sites write in English.
  if (languages.has(language || 'en')) return 0
  if (!language) return 1
  return language === 'en' ? 2 : 3
}

function mergeMirror(kept: Candidate, folded: Candidate): void {
  for (const source of folded.foundBy) kept.foundBy.add(source)
  for (const query of folded.queries) kept.queries.add(query)
  for (const [list, rank] of folded.ranks)
    kept.ranks.set(list, Math.min(kept.ranks.get(list) ?? rank, rank))
  kept.order = Math.min(kept.order, folded.order)
}

interface MirrorMember {
  candidate: Candidate
  identity: MirrorIdentity
}

/**
 * Which members of one key are the same page in different languages.
 *
 * Labelled hosts fold among themselves. The unlabelled host joins them only when the labels prove
 * that the site really publishes translations under language subdomains: one label that can
 * hardly be anything else ("fr", "zh-cn"), or two different labels at once. A single ambiguous
 * label does not: eu.example.com/pricing next to example.com/pricing may be a different page, and
 * claiming otherwise would hide a result and forge a "2 sources" signal. Two ambiguous labels on
 * the same path ("eu." and "it." next to the bare host) are taken as a locale scheme: two unrelated
 * functional subdomains that both mirror a path of the main site are far less likely than that.
 */
function mirrorsToFold(members: readonly MirrorMember[]): MirrorMember[] {
  const labelled = members.filter((member) => member.identity.language !== '')
  const labels = new Set(labelled.map((member) => member.identity.language))
  const proven = labelled.some((member) => member.identity.certain) || labels.size >= 2
  const folding = proven ? members : labelled
  return folding.length >= 2 ? [...folding] : []
}

function foldMirrors(candidates: Candidate[], languages: ReadonlySet<string>): Candidate[] {
  const groups = new Map<string, MirrorMember[]>()
  for (const candidate of candidates) {
    const identity = mirrorIdentity(candidate.url)
    if (identity)
      groups.set(identity.key, [...(groups.get(identity.key) ?? []), { candidate, identity }])
  }
  const folded = new Set<Candidate>()
  for (const members of groups.values()) {
    const [best, ...rest] = mirrorsToFold(members).toSorted(
      (a, b) =>
        mirrorPreference(a.identity.language, languages) -
          mirrorPreference(b.identity.language, languages) || a.candidate.order - b.candidate.order,
    )
    if (!best) continue
    for (const other of rest) {
      mergeMirror(best.candidate, other.candidate)
      folded.add(other.candidate)
    }
  }
  return candidates.filter((candidate) => !folded.has(candidate))
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
