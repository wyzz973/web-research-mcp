/**
 * The text a reader sees in a Markdown snapshot, folded for comparison, with a map back to
 * snapshot offsets. Models quote what they read, not the markup around it: a sentence with a
 * link in the middle, or an identifier that the converter escaped, must still be found.
 * The same projection is applied to the text being searched for, so both sides always agree.
 */

export interface Folded {
  text: string
  /** For each UTF-16 unit of `text`, the UTF-16 span of the snapshot it came from. */
  starts: Int32Array
  ends: Int32Array
}

const MAX_LINK_TEXT = 1000
const MAX_DESTINATION = 2000
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u00AB\u00BB\u300C\u300D\u300E\u300F\uFF02]/u
const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032\uFF07]/u
const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/u
const ASCII_PUNCTUATION = /[!-/:-@[-`{-~]/u
const FENCE_LINE = /^[ \t]*(?:`{3,}|~{3,})[^`\n]*$/u
const RULE_CHARS = /^[ \t:|-]*$/u
const BLOCK_MARKER = /(?:#{1,6}|[-*+]|\d{1,9}[.)])(?=[ \t]|$)/uy
const AUTOLINK = /<(?:https?|ftp|mailto):[^\s<>]{1,2000}>/uy

/** Emphasis, strikethrough, and code markers carry no text; escaped or not, both sides drop them. */
function isMarker(char: string): boolean {
  return char === '*' || char === '_' || char === '`'
}

function foldChar(char: string): string {
  if (DOUBLE_QUOTES.test(char)) return '"'
  if (SINGLE_QUOTES.test(char)) return "'"
  if (DASHES.test(char)) return '-'
  return char.charCodeAt(0) < 128 ? char.toLowerCase() : char.normalize('NFKC').toLowerCase()
}

/** Index of the bracket that closes the one at `open`, within one paragraph and a sane distance. */
function closingBracket(source: string, open: number, pair: '[]' | '()', limit: number): number {
  let depth = 0
  const stop = Math.min(source.length, open + limit)
  for (let index = open; index < stop; index += 1) {
    const char = source[index]
    if (char === '\\') index += 1
    else if (char === '\n' && source[index + 1] === '\n') return -1
    else if (char === pair[0]) depth += 1
    else if (char === pair[1] && (depth -= 1) === 0) return index
  }
  return -1
}

/** Where the destination that follows a link text ends: `(url "title")`, `[ref]`, or nothing. */
function destinationEnd(source: string, after: number): number {
  const opener = source[after]
  if (opener !== '(' && opener !== '[') return -1
  const close = closingBracket(source, after, opener === '(' ? '()' : '[]', MAX_DESTINATION)
  return close === -1 ? -1 : close + 1
}

class Projection {
  readonly pieces: string[] = []
  readonly starts: number[] = []
  readonly ends: number[] = []
  /** Index of a link's closing "]" (or an autolink's ">") to the index just past what it hides. */
  readonly hiddenFrom = new Map<number, number>()
  private lastWasSpace = true

  emit(text: string, start: number, end: number): void {
    this.pieces.push(text)
    for (let unit = 0; unit < text.length; unit += 1) {
      this.starts.push(start)
      this.ends.push(end)
    }
    this.lastWasSpace = false
  }

  space(start: number, end: number): void {
    if (this.lastWasSpace) return
    this.emit(' ', start, end)
    this.lastWasSpace = true
  }
}

/** A code fence, a table delimiter row, or a rule: nothing on such a line is text. */
function isLayoutLine(line: string): boolean {
  return FENCE_LINE.test(line) || (line.includes('---') && RULE_CHARS.test(line))
}

/** Skips what only lays a line out: indentation, quote marks, a heading, bullet, or number. */
function lineLayoutEnd(source: string, from: number): number {
  const newline = source.indexOf('\n', from)
  const lineEnd = newline === -1 ? source.length : newline
  if (isLayoutLine(source.slice(from, lineEnd))) return lineEnd
  let index = from
  while (index < lineEnd && /[ \t>]/u.test(source[index] ?? '')) index += 1
  BLOCK_MARKER.lastIndex = index
  return BLOCK_MARKER.test(source) ? BLOCK_MARKER.lastIndex : index
}

/** A "[" or "![" that starts a link or image: hides the opener and remembers what its "]" hides. */
function openLink(source: string, at: number, projection: Projection): number {
  const bracket = source[at] === '!' ? at + 1 : at
  const close = closingBracket(source, bracket, '[]', MAX_LINK_TEXT)
  if (close === -1) return -1
  const end = destinationEnd(source, close + 1)
  if (end === -1 && bracket === at) return -1
  projection.hiddenFrom.set(close, end === -1 ? close + 1 : end)
  return bracket + 1
}

/** Handles the character at `at` and returns the index to continue from. */
function step(source: string, at: number, projection: Projection): number {
  const hiddenUntil = projection.hiddenFrom.get(at)
  if (hiddenUntil !== undefined) return hiddenUntil
  const char = String.fromCodePoint(source.codePointAt(at) ?? 0)
  const next = source[at + 1]
  if (char === '\\' && next !== undefined && ASCII_PUNCTUATION.test(next)) {
    if (next === '|') projection.space(at, at + 2)
    else if (!isMarker(next)) projection.emit(foldChar(next), at, at + 2)
    return at + 2
  }
  if (char === '[' || (char === '!' && next === '[')) {
    const inside = openLink(source, at, projection)
    if (inside !== -1) return inside
  }
  if (char === ']' && next === '(') {
    // The tail of a link whose opener lies outside the text, as in a quote that starts mid-link.
    const end = destinationEnd(source, at + 1)
    if (end !== -1) return end
  }
  if (char === '<') {
    AUTOLINK.lastIndex = at
    if (AUTOLINK.test(source)) {
      projection.hiddenFrom.set(AUTOLINK.lastIndex - 1, AUTOLINK.lastIndex)
      return at + 1
    }
  }
  if (isMarker(char) || (char === '~' && (next === '~' || source[at - 1] === '~'))) return at + 1
  if (char === '|' || /\s/u.test(char)) projection.space(at, at + char.length)
  else projection.emit(foldChar(char), at, at + char.length)
  return at + char.length
}

/** Walks code points but records UTF-16 offsets, the unit every snapshot offset is expressed in. */
export function foldText(source: string): Folded {
  const projection = new Projection()
  let index = 0
  let lineStart = true
  while (index < source.length) {
    if (lineStart) {
      const content = lineLayoutEnd(source, index)
      if (content > index) projection.space(index, content)
      index = content
      lineStart = false
      continue
    }
    lineStart = source[index] === '\n'
    index = step(source, index, projection)
  }
  return {
    text: projection.pieces.join(''),
    starts: Int32Array.from(projection.starts),
    ends: Int32Array.from(projection.ends),
  }
}
