import { headingLevel, scanLineSteps, type MarkdownLine } from '../extract/markdown.ts'
import { runToEnd } from './slices.ts'

export type BlockKind = 'heading' | 'code' | 'table' | 'list' | 'paragraph'

/**
 * The unit that is never cut. `start`/`end` bound the block's own text; `tileEnd` is where the
 * next block starts, so consecutive tiles cover the document without gaps.
 */
export interface Block {
  kind: BlockKind
  start: number
  end: number
  tileEnd: number
  /** Heading blocks only. */
  level?: number
}

const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+\S/u
const TABLE_ROW = /^\s*\|/u
const INDENTED = /^(?: {2,}|\t)/u
const NESTED_FENCE = /^\s*(`{3,}|~{3,})/u
/** Lists and list items longer than this are divided at item boundaries. */
const LONG_LIST_CHARS = 600
/**
 * Items are divided this many levels deep; pages that nest deeper are not written by people.
 * Nothing is lost beyond this depth: a deeper item simply stays inside the block of its parent,
 * so blocks get coarser there, and every character is still covered by exactly one tile.
 */
const MAX_LIST_DEPTH = 8
/** Lines handled between two yields. */
const LINES_PER_STEP = 2048

/** Everything the splitter asks about lines, with the look-ahead answered in constant time. */
interface Lines {
  all: MarkdownLine[]
  /** nextContent[i] is the index of the first line at or after i that is not blank. */
  nextContent: Int32Array
}

function isBlank(line: MarkdownLine | undefined): boolean {
  return line !== undefined && !line.code && line.text.trim() === ''
}

function isHeading(line: MarkdownLine): boolean {
  return !line.code && headingLevel(line.text) !== undefined
}

function kindOf(line: MarkdownLine): BlockKind {
  if (line.code) return 'code'
  if (isHeading(line)) return 'heading'
  if (TABLE_ROW.test(line.text)) return 'table'
  return LIST_ITEM.test(line.text) ? 'list' : 'paragraph'
}

/**
 * One backward pass. Without it, every blank line of a long blank run would scan the rest of
 * the run to learn whether its list goes on, which is quadratic in the length of the run.
 */
function* indexLines(all: MarkdownLine[]): Generator<void, Lines> {
  const nextContent = new Int32Array(all.length + 1)
  nextContent[all.length] = all.length
  for (let index = all.length - 1; index >= 0; index -= 1) {
    nextContent[index] = isBlank(all[index]) ? (nextContent[index + 1] ?? all.length) : index
    if (index % LINES_PER_STEP === 0) yield
  }
  return { all, nextContent }
}

/** A blank line ends a list only when what follows is neither another item nor indented content. */
function listContinues(lines: Lines, index: number): boolean {
  const next = lines.nextContent[index] ?? lines.all.length
  const line = lines.all[next]
  if (!line || isHeading(line)) return false
  if (next === index) return true
  return line.code
    ? INDENTED.test(line.text)
    : LIST_ITEM.test(line.text) || INDENTED.test(line.text)
}

function continues(kind: BlockKind, lines: Lines, index: number): boolean {
  const line = lines.all[index]
  if (!line) return false
  if (kind === 'code') return line.code
  if (kind === 'list') return listContinues(lines, index)
  if (isBlank(line) || line.code || isHeading(line)) return false
  return kind === 'table' ? TABLE_ROW.test(line.text) : kindOf(line) === 'paragraph'
}

function lastContentLine(
  lines: MarkdownLine[],
  from: number,
  to: number,
): MarkdownLine | undefined {
  for (let index = to - 1; index >= from; index -= 1)
    if (!isBlank(lines[index])) return lines[index]
  return lines[from]
}

function spanChars(lines: MarkdownLine[], from: number, to: number): number {
  const first = lines[from]
  const last = lastContentLine(lines, from, to) ?? first
  return first && last ? last.end - first.start : 0
}

function indentOf(line: MarkdownLine): number {
  return line.text.length - line.text.trimStart().length
}

/**
 * Line indexes in (from, to) where a list item starts with an indentation in (above, upTo].
 * Fences nested in an item are indented too far for the line scanner to see them, so they are
 * tracked here: a "- name: x" line inside nested YAML is code, not an item.
 */
function* itemStarts(
  lines: MarkdownLine[],
  from: number,
  to: number,
  above: number,
  upTo: number,
): Generator<void, number[]> {
  const starts: number[] = []
  let fence: string | undefined
  for (let index = from + 1; index < to; index += 1) {
    if (index % LINES_PER_STEP === 0) yield
    const line = lines[index]
    if (!line || line.code) continue
    const marker = NESTED_FENCE.exec(line.text)?.[1]
    if (fence !== undefined) {
      if (marker?.startsWith(fence) && line.text.trim() === marker) fence = undefined
      continue
    }
    if (marker !== undefined) fence = marker
    else if (LIST_ITEM.test(line.text) && indentOf(line) > above && indentOf(line) <= upTo)
      starts.push(index)
  }
  return starts
}

type Range = [from: number, to: number]

/** An oversized item becomes its own lead lines plus one piece per nested item, recursively. */
function* itemRanges(
  lines: MarkdownLine[],
  range: Range,
  indent: number,
  depth: number,
): Generator<void, Range[]> {
  const [from, to] = range
  if (depth >= MAX_LIST_DEPTH || spanChars(lines, from, to) <= LONG_LIST_CHARS) return [range]
  const nested = yield* itemStarts(lines, from, to, indent, Number.POSITIVE_INFINITY)
  if (nested.length === 0) return [range]
  let childIndent = Number.POSITIVE_INFINITY
  for (const index of nested) {
    const line = lines[index]
    if (line) childIndent = Math.min(childIndent, indentOf(line))
  }
  const children = nested.filter((index) => {
    const line = lines[index]
    return line !== undefined && indentOf(line) <= childIndent
  })
  const ranges: Range[] = [[from, children[0] ?? to]]
  for (const [position, start] of children.entries()) {
    if (position % LINES_PER_STEP === LINES_PER_STEP - 1) yield
    const child: Range = [start, children[position + 1] ?? to]
    ranges.push(...(yield* itemRanges(lines, child, childIndent, depth + 1)))
  }
  return ranges
}

/**
 * A short list is one unit. A long one (an options reference, a changelog) would be a single
 * block of thousands of characters that no budget can place and no ranking can see into, so it
 * is divided at item boundaries: each item keeps its continuation lines, nested items, and code.
 */
function* listRanges(lines: MarkdownLine[], from: number, to: number): Generator<void, Range[]> {
  const first = lines[from]
  if (!first || spanChars(lines, from, to) <= LONG_LIST_CHARS) return [[from, to]]
  const indent = indentOf(first)
  const starts = [from, ...(yield* itemStarts(lines, from, to, -1, indent))]
  const ranges: Range[] = []
  for (const [position, start] of starts.entries()) {
    if (position % LINES_PER_STEP === LINES_PER_STEP - 1) yield
    const item: Range = [start, starts[position + 1] ?? to]
    ranges.push(...(yield* itemRanges(lines, item, indent, 1)))
  }
  return ranges
}

function toBlock(
  markdown: string,
  lines: MarkdownLine[],
  kind: BlockKind,
  range: Range,
): Block | undefined {
  const [from, to] = range
  const first = lines[from]
  if (!first) return undefined
  const last = lastContentLine(lines, from, to) ?? first
  const block: Block = { kind, start: first.start, end: last.end, tileEnd: markdown.length }
  if (kind === 'heading') block.level = headingLevel(first.text) ?? 1
  return block
}

/** Index just past the last line of the block that starts at `index`. */
function* blockEnd(lines: Lines, kind: BlockKind, index: number): Generator<void, number> {
  let next = index + 1
  if (kind === 'heading') return next
  while (continues(kind, lines, next)) {
    next += 1
    if (next % LINES_PER_STEP === 0) yield
  }
  return next
}

function* linkTiles(blocks: Block[], length: number): Generator<void, void> {
  for (const [position, block] of blocks.entries()) {
    block.tileEnd = blocks[position + 1]?.start ?? length
    if (position % LINES_PER_STEP === 0) yield
  }
}

/** Fenced code, tables, and short lists stay whole; everything else splits at blank lines. */
export function* splitBlockSteps(markdown: string): Generator<void, Block[]> {
  const lines = yield* indexLines(yield* scanLineSteps(markdown))
  const blocks: Block[] = []
  let index = 0
  for (let turn = 1; index < lines.all.length; turn += 1) {
    if (turn % LINES_PER_STEP === 0) yield
    const first = lines.all[index]
    if (!first || isBlank(first)) {
      index = Math.max(index + 1, lines.nextContent[index] ?? index + 1)
      continue
    }
    const kind = kindOf(first)
    const next = yield* blockEnd(lines, kind, index)
    const ranges: Range[] =
      kind === 'list' ? yield* listRanges(lines.all, index, next) : [[index, next]]
    for (const [position, range] of ranges.entries()) {
      if (position % LINES_PER_STEP === LINES_PER_STEP - 1) yield
      const block = toBlock(markdown, lines.all, kind, range)
      if (block) blocks.push(block)
    }
    index = next
  }
  yield* linkTiles(blocks, markdown.length)
  return blocks
}

export function splitBlocks(markdown: string): Block[] {
  return runToEnd(splitBlockSteps(markdown))
}
