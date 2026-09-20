import type { OutlineEntry } from '../contract.ts'
import { ATX_HEADING } from '../extract/markdown.ts'
import { estimateTokens } from '../tokens.ts'
import type { Block } from './blocks.ts'

interface Heading {
  block: number
  level: number
  text: string
}

const MULTIPART_NUMBER = /^(\d+(?:\.\d+)+)\.?(?=\s|$)/u
/** A lone integer only counts with a dot or bracket, so "3 ways to…" and "2024 roadmap" are not numbered. */
const DOTTED_INTEGER = /^(\d{1,3})[.)](?=\s|$)/u
const APPENDIX = /^(?:appendix|annex)\s+([A-Z])(?=[.:\s]|$)[.:]?/iu
const LETTERED_NUMBER = /^([A-Z](?:\.\d+)+)\.?(?=\s|$)/u

function plainTitle(raw: string): string {
  return raw
    .replace(/!?\[([^\]]*)\]\([^)]*\)/gu, '$1')
    .replace(/[*`]|(?<![\w\\])_|_(?!\w)/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/** Returns the heading's own section number and the title without it. */
function ownNumber(title: string): { id: string; rest: string } | undefined {
  for (const pattern of [MULTIPART_NUMBER, DOTTED_INTEGER, APPENDIX, LETTERED_NUMBER]) {
    const match = pattern.exec(title)
    if (!match?.[1]) continue
    const rest = title.slice(match[0].length).trim()
    return { id: match[1].toUpperCase(), rest: rest === '' ? title : rest }
  }
  return undefined
}

/**
 * No real document has this many headings (a 150,000-token RFC has 300). A page that does is
 * hostile or generated, and an outline object per heading would cost memory for nothing.
 */
export const MAX_HEADINGS = 20_000

function readHeadings(markdown: string, blocks: Block[]): Heading[] {
  const headings: Heading[] = []
  for (const [index, block] of blocks.entries()) {
    if (block.kind !== 'heading') continue
    if (headings.length === MAX_HEADINGS) break
    const match = ATX_HEADING.exec(markdown.slice(block.start, block.end))
    const text = plainTitle(match?.[2] ?? '')
    if (text !== '') headings.push({ block: index, level: block.level ?? 1, text })
  }
  return headings
}

/** "2.4" is the fourth heading under the second top-level heading, whatever their HTML levels were. */
function ordinalPaths(headings: Heading[]): string[] {
  const open: { level: number; index: number; children: number }[] = []
  let roots = 0
  return headings.map((heading) => {
    while (open.length > 0 && (open.at(-1)?.level ?? 0) >= heading.level) open.pop()
    const parent = open.at(-1)
    const index = parent ? (parent.children += 1) : (roots += 1)
    open.push({ level: heading.level, index, children: 0 })
    return open.map((entry) => entry.index).join('.')
  })
}

function unique(candidate: string, taken: Set<string>): string {
  let id = candidate
  for (let copy = 2; taken.has(id); copy += 1) id = `${candidate}-${copy}`
  taken.add(id)
  return id
}

/**
 * Numbers printed in the document win. Headings without one get their position; in a document
 * that numbers its own sections the position is prefixed with "p", so "p1.3" is never mistaken
 * for the document's section 1.3.
 */
function assignIds(headings: Heading[]): { id: string; title: string }[] {
  const taken = new Set<string>()
  const numbered = headings.map((heading) => ownNumber(heading.text))
  const prefix = numbered.some((own) => own !== undefined) ? 'p' : ''
  const ids = numbered.map((own) => (own ? unique(own.id, taken) : undefined))
  const paths = ordinalPaths(headings)
  return headings.map((heading, index) => {
    const own = numbered[index]
    const id = ids[index] ?? unique(`${prefix}${paths[index] ?? index + 1}`, taken)
    return { id, title: own ? own.rest : heading.text }
  })
}

function sectionEndBlock(headings: Heading[], index: number, blockCount: number): number {
  const level = headings[index]?.level ?? 1
  for (let next = index + 1; next < headings.length; next += 1) {
    const candidate = headings[next]
    if (candidate && candidate.level <= level) return candidate.block
  }
  return blockCount
}

/**
 * One entry per heading. A section runs to the next heading of the same or a higher level, and
 * its size is the sum of per-block estimates so a long document is measured once, not per level.
 */
export function buildOutline(markdown: string, blocks: Block[], prefix: number[]): OutlineEntry[] {
  const headings = readHeadings(markdown, blocks)
  const labels = assignIds(headings)
  return headings.map((heading, index) => {
    const endBlock = sectionEndBlock(headings, index, blocks.length)
    return {
      id: labels[index]?.id ?? String(index + 1),
      level: heading.level,
      title: labels[index]?.title ?? heading.text,
      start: blocks[heading.block]?.start ?? 0,
      end: blocks[endBlock]?.start ?? markdown.length,
      tokens: (prefix[endBlock] ?? 0) - (prefix[heading.block] ?? 0),
    }
  })
}

function label(entry: OutlineEntry): string {
  return `${entry.id} ${entry.title} ~${entry.tokens}t | `
}

export interface FittedOutline {
  entries: OutlineEntry[]
  tokens: number
  chars: number
  /** Entries left out after every deeper level had already been dropped. */
  dropped: number
}

/** A level is only dropped while something useful is left above it; one title line is not a map. */
const MIN_USEFUL_ENTRIES = 3

/** Drops the deepest level until the outline fits; an outline that is still too big is cut short. */
export function fitOutline(outline: OutlineEntry[], maxTokens: number): FittedOutline {
  let priced = outline.map((entry) => ({ entry, cost: estimateTokens(label(entry)) }))
  const total = (): number => priced.reduce((sum, item) => sum + item.cost, 0)
  while (total() > maxTokens) {
    const deepest = Math.max(...priced.map((item) => item.entry.level))
    const shallower = priced.filter((item) => item.entry.level < deepest)
    if (shallower.length < MIN_USEFUL_ENTRIES) break
    priced = shallower
  }
  const entries: OutlineEntry[] = []
  let tokens = 0
  for (const item of priced) {
    if (tokens + item.cost > maxTokens) break
    tokens += item.cost
    entries.push(item.entry)
  }
  const chars = entries.reduce((sum, entry) => sum + label(entry).length, 0)
  return { entries, tokens, chars, dropped: priced.length - entries.length }
}
