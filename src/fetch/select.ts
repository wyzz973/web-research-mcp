import type { PagePart } from '../contract.ts'
import { fits, minus, partCost, share, type Budget } from './budget.ts'
import type { PageDocument } from './document.ts'
import type { Candidate } from './goal.ts'
import { clipEnd, makePart } from './range.ts'

interface Pick {
  candidate: Candidate
  end: number
  clipped: boolean
}

export interface PageSelection {
  parts: PagePart[]
  /** Relevant passages exist that the budget did not admit. */
  more: boolean
}

const MIN_USEFUL_TOKENS = 40

function byScore(left: Candidate, right: Candidate): number {
  return right.score - left.score || left.page - right.page || left.start - right.start
}

function smaller(left: Budget, right: Budget): Budget {
  return { tokens: Math.min(left.tokens, right.tokens), chars: Math.min(left.chars, right.chars) }
}

/** Best passage that fits the page's fair share; an oversized best passage is cut at a line instead. */
function firstPick(document: PageDocument, ranked: Candidate[], room: Budget): Pick | undefined {
  const fitting = ranked.find((candidate) => fits(room, candidate.cost))
  if (fitting) return { candidate: fitting, end: fitting.end, clipped: false }
  const best = ranked[0]
  if (!best) return undefined
  const end = clipEnd(document.markdown, best.start, best.end, room)
  return end > best.start ? { candidate: best, end, clipped: true } : undefined
}

function pickCost(document: PageDocument, pick: Pick): Budget {
  if (!pick.clipped) return pick.candidate.cost
  return partCost(document.markdown.slice(pick.candidate.start, pick.end))
}

function mergeAdjacent(document: PageDocument, picks: Pick[]): PagePart[] {
  const parts: PagePart[] = []
  let lastBlock = -2
  for (const pick of [...picks].sort(
    (left, right) => left.candidate.start - right.candidate.start,
  )) {
    const previous = parts.at(-1)
    const joins = previous && !previous.clipped && pick.candidate.block === lastBlock + 1
    const start = joins ? previous.start : pick.candidate.start
    const part = makePart(document, start, pick.end)
    const alsoIn = [
      ...new Set([...(joins ? (previous.also_in ?? []) : []), ...pick.candidate.alsoIn]),
    ]
    if (alsoIn.length > 0) part.also_in = alsoIn.sort((left, right) => left - right)
    if (pick.clipped) part.clipped = true
    if (joins) parts.pop()
    parts.push(part)
    lastBlock = pick.candidate.block
  }
  return parts
}

/**
 * One budget for all pages: every page with a relevant passage gets its best one first, then the
 * remaining room goes to the highest-scoring passages wherever they are.
 */
export function selectPassages(
  documents: PageDocument[],
  candidates: Candidate[][],
  budget: Budget,
): PageSelection[] {
  const picks: Pick[][] = documents.map(() => [])
  const taken = new Set<Candidate>()
  let room = budget
  const contenders = candidates.filter((list) => list.length > 0).length
  const fair = share(budget, contenders)
  documents.forEach((document, page) => {
    const ranked = [...(candidates[page] ?? [])].sort(byScore)
    const pick = firstPick(document, ranked, smaller(fair, room))
    if (!pick) return
    picks[page]?.push(pick)
    taken.add(pick.candidate)
    room = minus(room, pickCost(document, pick))
  })
  for (const candidate of candidates.flat().sort(byScore)) {
    if (room.tokens < MIN_USEFUL_TOKENS) break
    if (taken.has(candidate) || !fits(room, candidate.cost)) continue
    picks[candidate.page]?.push({ candidate, end: candidate.end, clipped: false })
    taken.add(candidate)
    room = minus(room, candidate.cost)
  }
  return documents.map((document, page) => ({
    parts: mergeAdjacent(document, picks[page] ?? []),
    more:
      (candidates[page] ?? []).some((candidate) => !taken.has(candidate)) ||
      (picks[page] ?? []).some((pick) => pick.clipped),
  }))
}
