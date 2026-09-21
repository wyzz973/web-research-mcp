/**
 * The text a reader sees in a Markdown snapshot, folded for comparison, with a map back to
 * snapshot offsets. Models quote what they read, not the markup around it: a sentence with a
 * link in the middle, or an identifier that the converter escaped, must still be found.
 * The same projection is applied to the text being searched for, so both sides always agree.
 *
 * Page text is hostile input and this runs on the main thread, so the work is strictly linear:
 * one pass pairs brackets with bounded stacks, a second pass emits text and consults the pairs.
 * Both passes advance in slices, which lets the caller yield to the event loop and cancel.
 */
import { runSliced, runToEnd } from './slices.ts'

export interface Folded {
  text: string
  /** For each UTF-16 unit of `text`, the UTF-16 span of the snapshot it came from. */
  starts: Int32Array
  ends: Int32Array
}

/**
 * A map is built for at most this many characters of snapshot and holds at most this many of
 * visible text, about ten bytes each while it is cached (20 MB). No ordinary page comes close: a
 * 150,000-token RFC is 0.45 million characters, and converted HTML is capped at 3 MB of source.
 * The second half is there because folding expands: one Arabic ligature (U+FDFA) stands for 18
 * characters, so a page made of it would turn 2 million characters into 36 million and the map
 * into more than a gigabyte. A text over either limit gets no map and is searched literally only.
 */
export const MAX_FOLD_CHARS = 2_000_000

const MAX_LINK_TEXT = 1000
const MAX_DESTINATION = 2000
/** Characters handled before the driver looks at the clock again. */
const SLICE_CHARS = 1 << 16
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u00AB\u00BB\u300C\u300D\u300E\u300F\uFF02]/u
const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032\uFF07]/u
const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/u
const AUTOLINK = /<(?:https?|ftp|mailto):[^\s<>]{1,2000}>/uy

const TAB = 9
const NEWLINE = 10
const SPACE = 32
const BANG = 33
const HASH = 35
const ROUND_OPEN = 40
const ROUND_CLOSE = 41
const STAR = 42
const PLUS = 43
const MINUS = 45
const DOT = 46
const COLON = 58
const LESS = 60
const GREATER = 62
const SQUARE_OPEN = 91
const BACKSLASH = 92
const SQUARE_CLOSE = 93
const UNDERSCORE = 95
const BACKTICK = 96
const PIPE = 124
const TILDE = 126

function isAsciiPunctuation(code: number): boolean {
  return (
    (code >= 33 && code <= 47) ||
    (code >= 58 && code <= 64) ||
    (code >= 91 && code <= 96) ||
    (code >= 123 && code <= 126)
  )
}

/** Emphasis, strikethrough, and code markers carry no text; escaped or not, both sides drop them. */
function isMarker(code: number): boolean {
  return code === STAR || code === UNDERSCORE || code === BACKTICK
}

function isAsciiSpace(code: number): boolean {
  return code === SPACE || (code >= TAB && code <= 13)
}

function isDigit(code: number): boolean {
  return code >= 48 && code <= 57
}

/** Joiners and variation selectors change how text is drawn, not what it says. */
function isShaping(point: number): boolean {
  return (
    point === 0x200c ||
    point === 0x200d ||
    (point >= 0xfe00 && point <= 0xfe0f) ||
    (point >= 0xe0100 && point <= 0xe01ef)
  )
}

function foldWide(char: string): string {
  if (/\s/u.test(char)) return ' '
  if (DOUBLE_QUOTES.test(char)) return '"'
  if (SINGLE_QUOTES.test(char)) return "'"
  if (DASHES.test(char)) return '-'
  // Decomposed, not composed: composition needs the neighbours, decomposition does not, and
  // this way a precomposed letter and the same letter typed as base plus accent fold alike.
  return char.normalize('NFKD').toLowerCase()
}

/** CJK ideographs: no case and no decomposition, so they need no folding at all. */
function isPlainWide(code: number): boolean {
  return code >= 0x4e00 && code <= 0x9fff
}

const WIDE_CACHE_LIMIT = 4096
/** UTF-16 units turned into a string at a time; also the most arguments passed to one call. */
const TEXT_CHUNK = 8192

/** Openers further back than the longest construct can never pair, so the oldest are overwritten. */
class BoundedStack {
  private readonly slots: Int32Array
  private head = 0
  private size = 0

  constructor(capacity: number) {
    this.slots = new Int32Array(capacity)
  }

  push(value: number): void {
    const capacity = this.slots.length
    if (this.size === capacity) {
      this.head = (this.head + 1) % capacity
      this.size -= 1
    }
    this.slots[(this.head + this.size) % capacity] = value
    this.size += 1
  }

  pop(): number {
    if (this.size === 0) return -1
    this.size -= 1
    return this.slots[(this.head + this.size) % this.slots.length] ?? -1
  }

  clear(): void {
    this.size = 0
  }
}

/**
 * First pass. `partner[i]` is the index of the bracket that closes the "[" or "(" at `i`, or 0.
 * Pairs never span a blank line and never exceed the length limits, as in any sane document.
 */
class Pairing {
  readonly partner: Int32Array
  private readonly squares = new BoundedStack(MAX_LINK_TEXT)
  private readonly rounds = new BoundedStack(MAX_DESTINATION)
  private readonly source: string
  private index = 0

  constructor(source: string) {
    this.source = source
    this.partner = new Int32Array(source.length)
  }

  private close(stack: BoundedStack, at: number, limit: number): void {
    const open = stack.pop()
    if (open !== -1 && at - open <= limit) this.partner[open] = at
  }

  /** Returns true when the whole source has been paired. */
  advance(budget: number): boolean {
    const { source } = this
    const stop = Math.min(source.length, this.index + budget)
    let index = this.index
    for (; index < stop; index += 1) {
      const code = source.charCodeAt(index)
      if (code === BACKSLASH) index += 1
      else if (code === SQUARE_OPEN) this.squares.push(index)
      else if (code === ROUND_OPEN) this.rounds.push(index)
      else if (code === SQUARE_CLOSE) this.close(this.squares, index, MAX_LINK_TEXT)
      else if (code === ROUND_CLOSE) this.close(this.rounds, index, MAX_DESTINATION)
      else if (code === NEWLINE && source.charCodeAt(index + 1) === NEWLINE) {
        this.squares.clear()
        this.rounds.clear()
      }
    }
    this.index = index
    return index >= source.length
  }
}

/** Folded text and its offset map, in typed buffers that grow by doubling. */
class Output {
  private units = new Uint16Array(1 << 12)
  private starts = new Int32Array(1 << 12)
  private ends = new Int32Array(1 << 12)
  private length = 0
  private lastWasSpace = true
  private readonly limit: number
  /** Set once the text would outgrow the limit; from then on nothing more is taken. */
  overflowed = false

  constructor(limit: number) {
    this.limit = limit
  }

  get size(): number {
    return this.length
  }

  private grow(): void {
    const units = new Uint16Array(this.units.length * 2)
    const starts = new Int32Array(units.length)
    const ends = new Int32Array(units.length)
    units.set(this.units)
    starts.set(this.starts)
    ends.set(this.ends)
    this.units = units
    this.starts = starts
    this.ends = ends
  }

  unit(code: number, start: number, end: number): void {
    if (this.length >= this.limit) {
      this.overflowed = true
      return
    }
    if (this.length === this.units.length) this.grow()
    this.units[this.length] = code
    this.starts[this.length] = start
    this.ends[this.length] = end
    this.length += 1
    this.lastWasSpace = false
  }

  text(text: string, start: number, end: number): void {
    for (let at = 0; at < text.length; at += 1) this.unit(text.charCodeAt(at), start, end)
  }

  space(start: number, end: number): void {
    if (this.lastWasSpace) return
    this.unit(SPACE, start, end)
    this.lastWasSpace = true
  }

  /** Builds the string piece by piece: a few million units in one call would be a stall of its own. */
  *finish(): Generator<void, Folded | undefined> {
    if (this.overflowed) return undefined
    const chunks: string[] = []
    for (let at = 0; at < this.length; at += TEXT_CHUNK) {
      chunks.push(
        String.fromCharCode(...this.units.subarray(at, Math.min(this.length, at + TEXT_CHUNK))),
      )
      if ((at / TEXT_CHUNK) % 16 === 15) yield
    }
    yield
    return {
      text: chunks.join(''),
      starts: this.starts.slice(0, this.length),
      ends: this.ends.slice(0, this.length),
    }
  }
}

/** "```js" or "~~~": three or more fence characters, and no backtick after a backtick fence. */
function isFenceLine(source: string, first: number, lineEnd: number): boolean {
  const fence = source.charCodeAt(first)
  if (fence !== BACKTICK && fence !== TILDE) return false
  let end = first
  while (source.charCodeAt(end) === fence) end += 1
  if (end - first < 3) return false
  if (fence === TILDE) return true
  for (let index = end; index < lineEnd; index += 1)
    if (source.charCodeAt(index) === BACKTICK) return false
  return true
}

/** "| --- | :---: |" or "---": only rule characters, with three dashes in a row somewhere. */
function isRuleLine(source: string, first: number, lineEnd: number): boolean {
  let dashes = 0
  let longest = 0
  for (let index = first; index < lineEnd; index += 1) {
    const code = source.charCodeAt(index)
    if (code !== MINUS && code !== PIPE && code !== COLON && code !== SPACE && code !== TAB)
      return false
    dashes = code === MINUS ? dashes + 1 : 0
    longest = Math.max(longest, dashes)
  }
  return longest >= 3
}

/** End of a heading, bullet, or list number at `at`, or `at` itself when there is none. */
function blockMarkerEnd(source: string, at: number): number {
  let end = at
  const code = source.charCodeAt(at)
  if (code === HASH) while (source.charCodeAt(end) === HASH && end - at < 6) end += 1
  else if (code === MINUS || code === STAR || code === PLUS) end += 1
  else if (isDigit(code)) {
    while (isDigit(source.charCodeAt(end)) && end - at < 9) end += 1
    const after = source.charCodeAt(end)
    end = after === DOT || after === ROUND_CLOSE ? end + 1 : at
  }
  const next = source.charCodeAt(end)
  const closed = Number.isNaN(next) || next === SPACE || next === TAB || next === NEWLINE
  return end > at && closed ? end : at
}

/** Skips what only lays a line out: indentation, quote marks, a heading, bullet, or number. */
function lineLayoutEnd(source: string, from: number): number {
  let index = from
  for (;;) {
    const code = source.charCodeAt(index)
    if (code !== SPACE && code !== TAB && code !== GREATER) break
    index += 1
  }
  if (index >= source.length || source.charCodeAt(index) === NEWLINE) return index
  const newline = source.indexOf('\n', index)
  const lineEnd = newline === -1 ? source.length : newline
  // A code fence, a table delimiter row, or a rule: nothing on such a line is text.
  if (isFenceLine(source, index, lineEnd) || isRuleLine(source, index, lineEnd)) return lineEnd
  return blockMarkerEnd(source, index)
}

/** Second pass: emits the visible text, using the pairs to hide link syntax in constant time. */
class Projection {
  private readonly output: Output
  private readonly wideCache = new Map<number, string>()
  private readonly source: string
  /** Openers map to their closers; this pass stores jump targets at the closers it hides. */
  private readonly partner: Int32Array
  private index = 0
  private lineStart = true

  constructor(source: string, partner: Int32Array, limit: number) {
    this.source = source
    this.partner = partner
    this.output = new Output(limit)
  }

  /**
   * Returns true when the whole source has been projected, or its text has outgrown the limit.
   * The budget counts what is read and what is written: one character can fold into eighteen.
   */
  advance(budget: number): boolean {
    const stop = Math.min(this.source.length, this.index + budget)
    const full = this.output.size + budget
    while (this.index < stop && this.output.size < full && !this.output.overflowed) {
      if (this.lineStart) this.layout()
      else this.step()
    }
    return this.index >= this.source.length || this.output.overflowed
  }

  finish(): Generator<void, Folded | undefined> {
    return this.output.finish()
  }

  private layout(): void {
    const content = lineLayoutEnd(this.source, this.index)
    if (content > this.index) this.output.space(this.index, content)
    this.index = content
    this.lineStart = false
  }

  /** Hides "[" (and "!") when it opens a link or image, and marks what its "]" will hide. */
  private openLink(at: number): boolean {
    const bracket = this.source.charCodeAt(at) === BANG ? at + 1 : at
    const close = this.partner[bracket] ?? 0
    if (close === 0) return false
    const after = this.source.charCodeAt(close + 1)
    const hasDestination = after === ROUND_OPEN || after === SQUARE_OPEN
    const destination = hasDestination ? (this.partner[close + 1] ?? 0) : 0
    if (destination === 0 && bracket === at) return false
    this.partner[close] = destination === 0 ? close + 1 : destination + 1
    this.index = bracket + 1
    return true
  }

  private autolink(at: number): boolean {
    AUTOLINK.lastIndex = at
    if (!AUTOLINK.test(this.source)) return false
    this.partner[AUTOLINK.lastIndex - 1] = AUTOLINK.lastIndex
    this.index = at + 1
    return true
  }

  private escape(at: number, next: number): void {
    if (next === PIPE) this.output.space(at, at + 2)
    else if (!isMarker(next)) this.output.unit(next, at, at + 2)
    this.index = at + 2
  }

  /** Alphabets repeat a few dozen characters, so each is folded once and then looked up. */
  private foldedWide(point: number): string {
    const known = this.wideCache.get(point)
    if (known !== undefined) return known
    const folded = foldWide(String.fromCodePoint(point))
    if (this.wideCache.size < WIDE_CACHE_LIMIT) this.wideCache.set(point, folded)
    return folded
  }

  private wide(at: number): void {
    const point = this.source.codePointAt(at) ?? 0
    const end = at + (point > 0xffff ? 2 : 1)
    this.index = end
    if (isShaping(point)) return
    if (isPlainWide(point)) return this.output.unit(point, at, end)
    const folded = this.foldedWide(point)
    if (folded === ' ') this.output.space(at, end)
    else this.output.text(folded, at, end)
  }

  private step(): void {
    const { source, partner } = this
    const at = this.index
    const code = source.charCodeAt(at)
    const next = source.charCodeAt(at + 1)
    if (code >= 128) return this.wide(at)
    this.lineStart = code === NEWLINE
    if ((code === SQUARE_CLOSE || code === GREATER) && (partner[at] ?? 0) > 0) {
      this.index = partner[at] ?? at + 1
      return
    }
    if (code === BACKSLASH && isAsciiPunctuation(next)) return this.escape(at, next)
    if (code === SQUARE_OPEN || (code === BANG && next === SQUARE_OPEN)) {
      if (this.openLink(at)) return
    }
    // The tail of a link whose opener lies outside the text, as in a quote that starts mid-link.
    if (code === SQUARE_CLOSE && next === ROUND_OPEN && (partner[at + 1] ?? 0) > 0) {
      this.index = (partner[at + 1] ?? at) + 1
      return
    }
    if (code === LESS && this.autolink(at)) return
    this.index = at + 1
    if (isMarker(code)) return
    if (code === TILDE && (next === TILDE || source.charCodeAt(at - 1) === TILDE)) return
    if (code === PIPE || isAsciiSpace(code)) this.output.space(at, at + 1)
    else this.output.unit(code >= 65 && code <= 90 ? code + 32 : code, at, at + 1)
  }
}

/**
 * Both passes, yielding after every slice of characters. Undefined when the visible text would
 * be longer than `limit`: the work stops there, and what was gathered is dropped.
 */
export function* foldSteps(
  source: string,
  limit = MAX_FOLD_CHARS,
): Generator<void, Folded | undefined> {
  const pairing = new Pairing(source)
  while (!pairing.advance(SLICE_CHARS)) yield
  const projection = new Projection(source, pairing.partner, limit)
  while (!projection.advance(SLICE_CHARS)) yield
  return yield* projection.finish()
}

/** For short texts such as the quote being searched for. Snapshots use `foldTextSliced`. */
export function foldText(source: string, limit = MAX_FOLD_CHARS): Folded | undefined {
  return runToEnd(foldSteps(source, limit))
}

/** The same result, but the event loop runs between slices and a cancellation stops the work. */
export function foldTextSliced(
  source: string,
  signal: AbortSignal,
  limit = MAX_FOLD_CHARS,
): Promise<Folded | undefined> {
  return runSliced(foldSteps(source, limit), signal)
}
