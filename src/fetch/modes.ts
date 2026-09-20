/** Chooses the way of reading (cursor aside): find, then section, then goal, then the default. */
import type { ResolvedFetch } from '../contract.ts'
import type { Budget } from './budget.ts'
import { MAX_FOLD_CHARS, MAX_MATCHES, type FoldCache, type Folded } from './find.ts'
import {
  readClosest,
  readFind,
  readGoal,
  readLead,
  readSection,
  type GoalOptions,
  type PageRead,
  type ReadablePage,
} from './read.ts'

export interface ModeOutcome {
  reads: PageRead[]
  /** The goal that shaped the result, echoed to the caller. */
  goal: string | undefined
  notes: string[]
}

const QUOTED_CHARS = 80

/** What reading needs besides the pages: the shared visible-text cache and the caller's signal. */
export interface ModeContext {
  fold: FoldCache
  signal: AbortSignal
}

/** The caller's own words, shortened; never page text. */
function quoted(text: string): string {
  const flat = text.replace(/\s+/gu, ' ').replaceAll('"', "'").trim()
  return flat.length > QUOTED_CHARS ? `${flat.slice(0, QUOTED_CHARS - 1)}\u2026` : flat
}

function goalOptions(
  goal: string,
  plan: ResolvedFetch,
  budget: Budget,
  context: ModeContext,
): GoalOptions {
  return { goal, budget, maxTokens: plan.maxTokens, signal: context.signal }
}

/**
 * A find without a match must not be a dead end. With a goal, the goal is read instead; without
 * one, the passages sharing the most words with the text are shown, clearly marked as not a match.
 */
async function readFound(
  pages: ReadablePage[],
  plan: ResolvedFetch,
  needle: string,
  budget: Budget,
  context: ModeContext,
): Promise<ModeOutcome> {
  const folds: (Folded | undefined)[] = []
  for (const page of pages)
    folds.push(await context.fold(page.snapshot, page.document.markdown, context.signal))
  const found = readFind(pages, needle, 0, budget, folds)
  if (found.some((read) => (read.findTotal ?? 0) > 0))
    return { reads: found, goal: undefined, notes: [] }
  if (plan.goal !== undefined)
    return {
      reads: await readGoal(pages, goalOptions(plan.goal, plan, budget, context)),
      goal: plan.goal,
      notes: [`find had 0 matches for "${quoted(needle)}"; showing passages for the goal instead`],
    }
  const closest = await readClosest(pages, needle, budget, context.signal)
  const any = closest.some((read) => read.parts.length > 0)
  closest.forEach((read, index) => {
    if (folds[index] === undefined) read.literalOnly = true
  })
  return {
    reads: closest,
    goal: undefined,
    notes: [
      any
        ? '0 exact or normalized matches; the closest passages by words are shown - they are NOT a match'
        : '0 exact or normalized matches, and none of the words of the find text occur on the page',
    ],
  }
}

export async function readByMode(
  pages: ReadablePage[],
  plan: ResolvedFetch,
  goal: string | undefined,
  budget: Budget,
  context: ModeContext,
): Promise<ModeOutcome> {
  const first = pages[0]
  if (!first) return { reads: [], goal, notes: [] }
  if (plan.find !== undefined) return readFound(pages, plan, plan.find, budget, context)
  if (plan.section !== undefined)
    return {
      reads: [readSection(first, plan.section, budget, plan.maxTokens)],
      goal: undefined,
      notes: [],
    }
  if (goal !== undefined)
    return {
      reads: await readGoal(pages, goalOptions(goal, plan, budget, context)),
      goal,
      notes: [],
    }
  return { reads: [readLead(first, budget, plan.maxTokens)], goal: undefined, notes: [] }
}

function pageList(numbers: number[]): string {
  return `page ${numbers.join(', ')}`
}

/** What the reads did that the caller should know about. Page numbers only, never page text. */
export function describeReads(numbers: number[], reads: PageRead[]): string[] {
  const notes: string[] = []
  const where = (flag: (read: PageRead) => boolean | undefined): number[] =>
    numbers.filter((_, index) => {
      const read = reads[index]
      return read !== undefined && flag(read) === true
    })
  const unmatched = where((read) => read.nothingRelevant)
  if (unmatched.length > 0)
    notes.push(
      `no passage on ${pageList(unmatched)} matched the goal terms; showing the beginning and the outline instead`,
    )
  const reposts = where((read) => read.onlyReposts)
  if (reposts.length > 0)
    notes.push(`${pageList(reposts)} only repeats passages that are shown from another page`)
  const literal = where((read) => read.literalOnly)
  if (literal.length > 0)
    notes.push(
      `${pageList(literal)} is larger than ${MAX_FOLD_CHARS} characters, so only exact (literal) matches were looked for; normalized matching was skipped`,
    )
  if (reads.some((read) => read.findCapped))
    notes.push(
      `counting stopped at ${MAX_MATCHES} matches; search for a longer, more specific text`,
    )
  if (reads.some((read) => read.parts.some((part) => part.clipped)))
    notes.push(
      'a block larger than the budget was cut at a line boundary; continue with the cursor',
    )
  const dropped = reads.reduce((sum, read) => sum + (read.outlineDropped ?? 0), 0)
  if (dropped > 0) notes.push(`the outline was shortened by ${dropped} entries to fit the budget`)
  return notes
}
