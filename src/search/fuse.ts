/**
 * Turns the ranked lists of every upstream call into one candidate pool: URL normalization,
 * merging of duplicates, folding of translated mirrors, and reciprocal rank fusion.
 */
import type { SourceHit } from '../sources/types.ts'
import { headOf } from './cut.ts'
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
    kept.push(passage.length <= room ? passage : `${headOf(passage, room).trimEnd()}…`)
    used += passage.length
  }
  return kept
}

function limitTitle(title: string): string {
  return title.length <= MAX_TITLE_CHARS
    ? title
    : `${headOf(title, MAX_TITLE_CHARS - 1).trimEnd()}…`
}

/**
 * The adapter contract says YYYY-MM-DD. Anything else is text from the source, not a date: it is
 * neither compared with `since` nor passed on, so this field cannot carry words into a response.
 */
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/u

function publishedDay(hit: SourceHit): string | undefined {
  return hit.published !== undefined && ISO_DAY.test(hit.published) ? hit.published : undefined
}

function keeps(published: string | undefined, url: string, options: FuseOptions): boolean {
  if (options.sites.length && !hostMatchesSites(siteOf(url), options.sites)) return false
  return !(options.since && published && published < options.since)
}

/**
 * Later sightings of the same page add provenance; they replace content only when they know more.
 * "More" is measured in content: a source's metadata card about a page is long and says nothing.
 */
function absorb(target: Candidate, hit: SourceHit, url: string): void {
  if (!target.title && hit.title) target.title = hit.title
  target.published ??= publishedDay(hit)
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
      const published = publishedDay(hit)
      if (!url || !keeps(published, url, options)) continue
      rank += 1
      const key = dedupeKey(url)
      let candidate = byKey.get(key)
      if (candidate) absorb(candidate, hit, url)
      else {
        candidate = {
          url,
          title: hit.title,
          published,
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
 * Only a label that can hardly be anything but a language ("fr", "zh-cn", "it-it") proves that a
 * site publishes this path per language. With such a label in the group, everything that shares
 * the key folds: the other labels and the unlabelled host. Same site, same remaining subdomain,
 * same path and query, and one proven translation: "da." next to "fa." and "ko." in a recorded
 * answer is Danish, and "it." next to "fr." is Italian.
 *
 * Without one, nothing folds. Codes that are just as often a region, a department, or a product
 * ("eu", "uk", "it", "hr", "id") prove nothing, alone or together: eu.example.com/pricing and
 * it.example.com/pricing are the EU site and the IT department far more often than Basque and
 * Italian, with or without example.com/pricing beside them. Folding them would hide a result and
 * forge a "2 sources" signal; leaving a real translation unfolded only costs a place in the list.
 */
function mirrorsToFold(members: readonly MirrorMember[]): MirrorMember[] {
  const proven = members.some((member) => member.identity.certain)
  return proven && members.length >= 2 ? [...members] : []
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
