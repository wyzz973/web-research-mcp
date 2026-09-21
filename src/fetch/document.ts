import type { OutlineEntry } from '../contract.ts'
import { estimateTokens } from '../tokens.ts'
import { throwIfAborted } from '../errors.ts'
import { splitBlockSteps, type Block } from './blocks.ts'
import { buildOutlineSteps } from './outline.ts'
import { runSliced, runToEnd } from './slices.ts'

/** Everything the readers need to know about one immutable snapshot. */
export interface PageDocument {
  markdown: string
  blocks: Block[]
  outline: OutlineEntry[]
  /** parents[i] is the outline index of the heading that encloses outline[i], or -1. */
  parents: number[]
  /** The page has more headings than the outline holds; `outline` covers the first of them. */
  headingsCapped: boolean
  /** prefix[i] is the estimated size of all tiles before block i. */
  prefix: number[]
  totalTokens: number
}

/** A tile larger than this is measured piece by piece, with a pause between pieces. */
const MEASURE_CHARS = 1 << 16
const BLOCKS_PER_STEP = 1024

/** Estimated size of one tile. A page that is one enormous line must not be measured in one go. */
function* measureTile(markdown: string, from: number, to: number): Generator<void, number> {
  if (to - from <= MEASURE_CHARS) return estimateTokens(markdown.slice(from, to))
  let tokens = 0
  let at = from
  while (at < to) {
    let end = Math.min(to, at + MEASURE_CHARS)
    // A piece never ends between the two halves of a surrogate pair.
    const code = markdown.charCodeAt(end - 1)
    if (code >= 0xd800 && code <= 0xdbff && end < to) end += 1
    tokens += estimateTokens(markdown.slice(at, end))
    at = end
    yield
  }
  return tokens
}

function* tokenPrefix(markdown: string, blocks: Block[]): Generator<void, number[]> {
  const prefix = [0]
  let tileStart = 0
  let pending = 0
  for (const [index, block] of blocks.entries()) {
    // By size as well as by count: a thousand blocks can be a few bytes or several megabytes.
    pending += block.tileEnd - tileStart
    if (index % BLOCKS_PER_STEP === BLOCKS_PER_STEP - 1 || pending >= MEASURE_CHARS) {
      pending = 0
      yield
    }
    const tokens = yield* measureTile(markdown, tileStart, block.tileEnd)
    prefix.push((prefix.at(-1) ?? 0) + tokens)
    tileStart = block.tileEnd
  }
  return prefix
}

function outlineParents(outline: OutlineEntry[]): number[] {
  const open: number[] = []
  return outline.map((entry, index) => {
    while (open.length > 0 && (outline[open.at(-1) ?? 0]?.level ?? 0) >= entry.level) open.pop()
    const parent = open.at(-1) ?? -1
    open.push(index)
    return parent
  })
}

/** Blocks, sizes, and outline of a snapshot, in steps that a driver may pause between. */
export function* analyzeSteps(markdown: string): Generator<void, PageDocument> {
  const blocks = yield* splitBlockSteps(markdown)
  const prefix = yield* tokenPrefix(markdown, blocks)
  const { entries: outline, capped } = yield* buildOutlineSteps(markdown, blocks, prefix)
  return {
    markdown,
    blocks,
    outline,
    headingsCapped: capped,
    parents: outlineParents(outline),
    prefix,
    totalTokens: prefix.at(-1) ?? 0,
  }
}

/** For tests and small texts. Snapshots are analyzed through the cache, which can pause and cancel. */
export function analyze(markdown: string): PageDocument {
  return runToEnd(analyzeSteps(markdown))
}

/** Estimated size of blocks `from` to `to` with the white space after each, as measured once. */
export function tilesTokens(document: PageDocument, from: number, to: number): number {
  return (document.prefix[to + 1] ?? document.totalTokens) - (document.prefix[from] ?? 0)
}

/** Index of the last item whose `start` is at or before the offset, or -1. */
function lastAtOrBefore(items: readonly { start: number }[], offset: number): number {
  let low = 0
  let high = items.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >> 1
    if ((items[middle]?.start ?? Infinity) <= offset) {
      found = middle
      low = middle + 1
    } else high = middle - 1
  }
  return found
}

/** The nearest heading above an offset; headings partition the document, so that is its section. */
export function sectionAt(document: PageDocument, offset: number): OutlineEntry | undefined {
  return document.outline[lastAtOrBefore(document.outline, offset)]
}

/** Index of the block whose tile contains the offset. */
export function blockAt(document: PageDocument, offset: number): number {
  return Math.max(0, lastAtOrBefore(document.blocks, offset))
}

/** Enclosing headings from the nearest outwards. */
export function headingPath(document: PageDocument, offset: number): OutlineEntry[] {
  const path: OutlineEntry[] = []
  let index = lastAtOrBefore(document.outline, offset)
  while (index >= 0) {
    const entry = document.outline[index]
    if (entry) path.push(entry)
    index = document.parents[index] ?? -1
  }
  return path
}

/** Analyses are dropped, oldest first, beyond this many snapshots or this much source text. */
const CACHE_ENTRIES = 8
const CACHE_CHARS = 8_000_000

export type DocumentCache = (
  id: string,
  markdown: string,
  signal: AbortSignal,
) => Promise<PageDocument>

type Analyze = (markdown: string, signal: AbortSignal) => Promise<PageDocument>

/**
 * Snapshots never change, so their analysis is reused across calls. Bounded by count and by
 * size: a block list costs memory in proportion to the page, and pages can be megabytes.
 * Callers that ask for the same snapshot at the same time share one analysis; if its owner is
 * cancelled, the others start their own.
 */
export function createDocumentCache(
  analyzeSnapshot: Analyze = (markdown, signal) => runSliced(analyzeSteps(markdown), signal),
): DocumentCache {
  const ready = new Map<string, PageDocument>()
  const pending = new Map<string, Promise<PageDocument>>()

  function remember(id: string, document: PageDocument): void {
    ready.set(id, document)
    let chars = [...ready.values()].reduce((sum, entry) => sum + entry.markdown.length, 0)
    for (const [oldest, entry] of ready) {
      if (ready.size <= CACHE_ENTRIES && (chars <= CACHE_CHARS || ready.size === 1)) break
      ready.delete(oldest)
      chars -= entry.markdown.length
    }
  }

  function recall(id: string): PageDocument | undefined {
    const hit = ready.get(id)
    if (!hit) return undefined
    ready.delete(id)
    ready.set(id, hit)
    return hit
  }

  return async (id, markdown, signal) => {
    for (;;) {
      const known = recall(id)
      if (known) return known
      const shared = pending.get(id)
      if (!shared) break
      try {
        return await shared
      } catch {
        // The analysis belonged to a caller that was cancelled; carry on with our own.
        throwIfAborted(signal)
      }
    }
    const task = analyzeSnapshot(markdown, signal).finally(() => pending.delete(id))
    pending.set(id, task)
    const document = await task
    remember(id, document)
    return document
  }
}
