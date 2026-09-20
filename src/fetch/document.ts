import type { OutlineEntry } from '../contract.ts'
import { estimateTokens } from '../tokens.ts'
import { splitBlocks, type Block } from './blocks.ts'
import { buildOutline } from './outline.ts'

/** Everything the readers need to know about one immutable snapshot. */
export interface PageDocument {
  markdown: string
  blocks: Block[]
  outline: OutlineEntry[]
  /** parents[i] is the outline index of the heading that encloses outline[i], or -1. */
  parents: number[]
  /** prefix[i] is the estimated size of all tiles before block i. */
  prefix: number[]
  totalTokens: number
}

function tokenPrefix(markdown: string, blocks: Block[]): number[] {
  const prefix = [0]
  let tileStart = 0
  for (const block of blocks) {
    prefix.push((prefix.at(-1) ?? 0) + estimateTokens(markdown.slice(tileStart, block.tileEnd)))
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

export function analyze(markdown: string): PageDocument {
  const blocks = splitBlocks(markdown)
  const prefix = tokenPrefix(markdown, blocks)
  const outline = buildOutline(markdown, blocks, prefix)
  return {
    markdown,
    blocks,
    outline,
    parents: outlineParents(outline),
    prefix,
    totalTokens: prefix.at(-1) ?? 0,
  }
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

/**
 * Snapshots never change, so their analysis can be reused across calls. Bounded by count and by
 * size: a block list costs memory in proportion to the page, and pages can be megabytes.
 */
export function createDocumentCache(): (id: string, markdown: string) => PageDocument {
  const cache = new Map<string, PageDocument>()
  return (id, markdown) => {
    const hit = cache.get(id)
    if (hit) {
      cache.delete(id)
      cache.set(id, hit)
      return hit
    }
    const document = analyze(markdown)
    cache.set(id, document)
    let chars = [...cache.values()].reduce((sum, entry) => sum + entry.markdown.length, 0)
    for (const [oldest, entry] of cache) {
      if (cache.size <= CACHE_ENTRIES && (chars <= CACHE_CHARS || cache.size === 1)) break
      cache.delete(oldest)
      chars -= entry.markdown.length
    }
    return document
  }
}
