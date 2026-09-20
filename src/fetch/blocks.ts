import { ATX_HEADING, scanLines, type MarkdownLine } from '../extract/markdown.ts'

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

function isBlank(line: MarkdownLine | undefined): boolean {
  return line !== undefined && !line.code && line.text.trim() === ''
}

function isHeading(line: MarkdownLine): boolean {
  return !line.code && ATX_HEADING.test(line.text)
}

function kindOf(line: MarkdownLine): BlockKind {
  if (line.code) return 'code'
  if (isHeading(line)) return 'heading'
  if (TABLE_ROW.test(line.text)) return 'table'
  return LIST_ITEM.test(line.text) ? 'list' : 'paragraph'
}

/** A blank line ends a list only when what follows is neither another item nor indented content. */
function listContinues(lines: MarkdownLine[], index: number): boolean {
  let next = index
  while (isBlank(lines[next])) next += 1
  const line = lines[next]
  if (!line || isHeading(line)) return false
  if (next === index) return true
  return line.code
    ? INDENTED.test(line.text)
    : LIST_ITEM.test(line.text) || INDENTED.test(line.text)
}

function continues(kind: BlockKind, lines: MarkdownLine[], index: number): boolean {
  const line = lines[index]
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
 * Fences nested in an item are indented too far for `scanLines` to see them, so they are
 * tracked here: a "- name: x" line inside nested YAML is code, not an item.
 */
function itemStarts(
  lines: MarkdownLine[],
  from: number,
  to: number,
  above: number,
  upTo: number,
): number[] {
  const starts: number[] = []
  let fence: string | undefined
  for (let index = from + 1; index < to; index += 1) {
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

/** An oversized item becomes its own lead lines plus one piece per nested item, recursively. */
function itemRanges(
  lines: MarkdownLine[],
  from: number,
  to: number,
  indent: number,
): [number, number][] {
  if (spanChars(lines, from, to) <= LONG_LIST_CHARS) return [[from, to]]
  const nested = itemStarts(lines, from, to, indent, Number.POSITIVE_INFINITY)
  if (nested.length === 0) return [[from, to]]
  const childIndent = Math.min(...nested.map((index) => indentOf(lines[index] ?? lines[from]!)))
  const children = itemStarts(lines, from, to, indent, childIndent)
  return [
    [from, children[0] ?? to],
    ...children.flatMap((start, position) =>
      itemRanges(lines, start, children[position + 1] ?? to, childIndent),
    ),
  ]
}

/**
 * A short list is one unit. A long one (an options reference, a changelog) would be a single
 * block of thousands of characters that no budget can place and no ranking can see into, so it
 * is divided at item boundaries: each item keeps its continuation lines, nested items, and code.
 */
function listRanges(lines: MarkdownLine[], from: number, to: number): [number, number][] {
  const first = lines[from]
  if (!first || spanChars(lines, from, to) <= LONG_LIST_CHARS) return [[from, to]]
  const indent = indentOf(first)
  const starts = [from, ...itemStarts(lines, from, to, -1, indent)]
  return starts.flatMap((start, position) =>
    itemRanges(lines, start, starts[position + 1] ?? to, indent),
  )
}

function toBlock(
  markdown: string,
  lines: MarkdownLine[],
  kind: BlockKind,
  from: number,
  to: number,
): Block | undefined {
  const first = lines[from]
  if (!first) return undefined
  const last = lastContentLine(lines, from, to) ?? first
  const block: Block = { kind, start: first.start, end: last.end, tileEnd: markdown.length }
  if (kind === 'heading') block.level = ATX_HEADING.exec(first.text)?.[1]?.length ?? 1
  return block
}

/** Fenced code, tables, and short lists stay whole; everything else splits at blank lines. */
export function splitBlocks(markdown: string): Block[] {
  const lines = scanLines(markdown)
  const blocks: Block[] = []
  let index = 0
  while (index < lines.length) {
    const first = lines[index]
    if (!first || isBlank(first)) {
      index += 1
      continue
    }
    const kind = kindOf(first)
    let next = index + 1
    if (kind !== 'heading') while (continues(kind, lines, next)) next += 1
    const ranges: [number, number][] =
      kind === 'list' ? listRanges(lines, index, next) : [[index, next]]
    for (const [from, to] of ranges) {
      const block = toBlock(markdown, lines, kind, from, to)
      if (block) blocks.push(block)
    }
    index = next
  }
  blocks.forEach((block, position) => {
    block.tileEnd = blocks[position + 1]?.start ?? markdown.length
  })
  return blocks
}
