/** Text-level helpers shared by extraction and by the snapshot readers. */
import { stripInvisible } from '../invisible.ts'

export interface MarkdownLine {
  /** UTF-16 offset of the first character of the line. */
  start: number
  /** Offset just past the last character, excluding the line break. */
  end: number
  text: string
  /** True for fence lines and everything between them. */
  code: boolean
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/u
export const ATX_HEADING = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/u

function closesFence(text: string, open: { char: string; size: number }): boolean {
  const match = FENCE.exec(text)
  if (!match?.[1]) return false
  return match[1][0] === open.char && match[1].length >= open.size && (match[2] ?? '').trim() === ''
}

function opensFence(text: string): { char: string; size: number } | undefined {
  const match = FENCE.exec(text)
  if (!match?.[1]) return undefined
  const char = match[1][0] ?? '`'
  // A backtick fence cannot carry backticks in its info string; that is inline code instead.
  if (char === '`' && (match[2] ?? '').includes('`')) return undefined
  return { char, size: match[1].length }
}

/** Lines scanned between two yields of `scanLineSteps`. */
const LINES_PER_STEP = 4096

/**
 * Splits into lines with offsets and marks fenced code, so `#` inside code is never a heading.
 * A generator, so that a caller on the main thread can pause between steps on megabytes of text.
 */
export function* scanLineSteps(markdown: string): Generator<void, MarkdownLine[]> {
  const lines: MarkdownLine[] = []
  let open: { char: string; size: number } | undefined
  let start = 0
  while (start <= markdown.length) {
    const next = markdown.indexOf('\n', start)
    const end = next === -1 ? markdown.length : next
    const text = markdown.slice(start, end)
    if (open) {
      lines.push({ start, end, text, code: true })
      if (closesFence(text, open)) open = undefined
    } else {
      open = opensFence(text)
      lines.push({ start, end, text, code: open !== undefined })
    }
    if (next === -1) break
    start = next + 1
    if (lines.length % LINES_PER_STEP === 0) yield
  }
  return lines
}

export function scanLines(markdown: string): MarkdownLine[] {
  const steps = scanLineSteps(markdown)
  for (;;) {
    const step = steps.next()
    if (step.done) return step.value
  }
}

/** The `<` that opens anything a reader could take for our untrusted-block tags, in any case. */
const ENVELOPE_OPENER = /<(?=\s*\/?\s*(?:results|page)\b)/giu

/**
 * Page text is offset-addressed, so it cannot be escaped at render time. Anything that could
 * close or reopen the untrusted block is defused before the snapshot is frozen and hashed; only
 * the `<` changes, and the count is reported with the other removed content.
 */
export function neutralizeEnvelope(markdown: string): { text: string; neutralized: number } {
  let neutralized = 0
  const text = markdown.replace(ENVELOPE_OPENER, () => {
    neutralized += 1
    return '&lt;'
  })
  return { text, neutralized }
}

const ESCAPED_PUNCTUATION = /\\([!-/:-@[-`{-~])/gu

/** Turndown escapes "1." and similar at line starts; inside a heading that is only noise. */
function tidyLine(line: MarkdownLine): string {
  if (line.code) return line.text
  if (ATX_HEADING.test(line.text)) return line.text.replace(ESCAPED_PUNCTUATION, '$1')
  return line.text.replace(/[ \t]+$/u, (spaces) => (spaces === '  ' ? spaces : ''))
}

/** Heading cleanup, trailing-space trim, and blank-run collapse, all outside fenced code. */
export function tidyMarkdown(markdown: string): string {
  const output: string[] = []
  let blanks = 0
  for (const line of scanLines(markdown.replace(/\r\n?/gu, '\n'))) {
    const text = tidyLine(line)
    blanks = !line.code && text === '' ? blanks + 1 : 0
    if (blanks <= 1) output.push(text)
  }
  return output.join('\n').trim()
}

/** Titles are page-controlled: one line, bounded, no invisible characters. */
export function cleanTitle(raw: string): string {
  const title = stripInvisible(raw).text.replace(/\s+/gu, ' ').trim()
  const chars = Array.from(title)
  return chars.length > 200 ? `${chars.slice(0, 199).join('')}…` : title
}
