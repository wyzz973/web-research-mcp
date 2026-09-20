import type { PagePart } from '../contract.ts'
import { estimateTokens } from '../tokens.ts'
import { minus, PART_OVERHEAD, prefixWithin, type Budget } from './budget.ts'
import { blockAt, sectionAt, type PageDocument } from './document.ts'

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

/**
 * Last resort for a single block larger than the whole budget: cut after a line, else after a
 * space, else between characters. Callers flag the part as clipped.
 */
export function clipEnd(markdown: string, from: number, limit: number, budget: Budget): number {
  const text = markdown.slice(from, limit)
  const room = prefixWithin(text, budget)
  if (room <= 0) return from
  if (room >= text.length) return limit
  const line = text.lastIndexOf('\n', room - 1)
  if (line > 0) return from + line + 1
  const space = text.lastIndexOf(' ', room - 1)
  if (space > 0) return from + space + 1
  return from + (isHighSurrogate(text.charCodeAt(room - 1)) ? room - 1 : room)
}

function tileStart(document: PageDocument, index: number): number {
  return index === 0 ? 0 : (document.blocks[index]?.start ?? 0)
}

function tileTokens(document: PageDocument, index: number, from: number, to: number): number {
  const block = document.blocks[index]
  const whole = block && from === tileStart(document, index) && to === block.tileEnd
  if (whole) return (document.prefix[index + 1] ?? 0) - (document.prefix[index] ?? 0)
  return estimateTokens(document.markdown.slice(from, to))
}

interface Reach {
  end: number
  room: Budget
}

/** Takes whole tiles from `from` while they fit. `end` equals `from` when not even the first does. */
function takeWholeTiles(document: PageDocument, from: number, to: number, budget: Budget): Reach {
  let room = minus(budget, PART_OVERHEAD)
  let end = from
  for (
    let index = blockAt(document, from);
    index < document.blocks.length && end < to;
    index += 1
  ) {
    const stop = Math.min(document.blocks[index]?.tileEnd ?? to, to)
    if (stop <= end) continue
    const cost = { tokens: tileTokens(document, index, end, stop), chars: stop - end }
    if (cost.tokens > room.tokens || cost.chars > room.chars) break
    room = minus(room, cost)
    end = stop
  }
  return { end, room }
}

function startsMidBlock(document: PageDocument, offset: number): boolean {
  return offset !== tileStart(document, blockAt(document, offset))
}

export function makePart(document: PageDocument, start: number, end: number): PagePart {
  const part: PagePart = { start, end, text: document.markdown.slice(start, end) }
  const section = sectionAt(document, start)
  if (section) {
    part.section = section.id
    part.heading = section.title
  }
  return part
}

/**
 * One contiguous verbatim span starting at `from`, ending on a block boundary at or before `to`.
 * Consecutive calls tile the range exactly, so concatenating their text reproduces the source.
 * A block is only cut when it cannot fit in a whole response: either nothing else fits, or the
 * block that comes next is so large that stopping before it would waste most of the budget.
 */
export function readRange(
  document: PageDocument,
  from: number,
  to: number,
  budget: Budget,
): PagePart | undefined {
  if (from >= to) return undefined
  const whole = takeWholeTiles(document, from, to, budget)
  const mostlyUnused =
    whole.room.tokens * 2 >= budget.tokens && whole.room.chars * 2 >= budget.chars
  let end = whole.end
  if (end < to && mostlyUnused) {
    const nextTileEnd = Math.min(document.blocks[blockAt(document, end)]?.tileEnd ?? to, to)
    end = clipEnd(document.markdown, end, nextTileEnd, addBack(whole.room))
  }
  if (end <= from) return undefined
  const part = makePart(document, from, end)
  if (end > whole.end || startsMidBlock(document, from)) part.clipped = true
  return part
}

/** `clipEnd` charges the part label itself; the label was already paid for when tiles were taken. */
function addBack(room: Budget): Budget {
  return { tokens: room.tokens + PART_OVERHEAD.tokens, chars: room.chars + PART_OVERHEAD.chars }
}
