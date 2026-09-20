import { WebError } from '../errors.ts'
import { stripInvisible } from '../invisible.ts'
import { bomCharset, headerCharset, isValidUtf8 } from './charset.ts'
import { ATX_HEADING, cleanTitle, neutralizeEnvelope, scanLines } from './markdown.ts'

export interface TextExtraction {
  title: string
  markdown: string
  hiddenRemoved: number
}

function undecodable(): WebError {
  return new WebError(
    'parse_failed',
    'The response is not valid text in its declared encoding, so it cannot be read verbatim.',
  )
}

/**
 * A declared encoding is taken at its word, and bytes that contradict it are an error. Without
 * one, a byte order mark decides; then UTF-8 when the bytes are valid UTF-8; then windows-1252,
 * which can read anything and is what the undeclared web was written in.
 */
function decode(body: Uint8Array, contentType: string): string {
  const declared = headerCharset(contentType)
  if (declared === undefined) {
    const sniffed = bomCharset(body) ?? (isValidUtf8(body) ? 'utf-8' : 'windows-1252')
    return new TextDecoder(sniffed).decode(body)
  }
  try {
    return new TextDecoder(declared, { fatal: true }).decode(body)
  } catch {
    throw undecodable()
  }
}

/** A title is at the top. Looking further would mean scanning megabytes of lines for nothing. */
const TITLE_SEARCH_CHARS = 1 << 16

function firstHeading(markdown: string): string {
  for (const line of scanLines(markdown.slice(0, TITLE_SEARCH_CHARS))) {
    const match = line.code ? null : ATX_HEADING.exec(line.text)
    if (match?.[1] === '#') return match[2] ?? ''
  }
  return ''
}

/** Markdown and plain text are served as they are: no conversion, only the safety passes. */
export function extractFromText(body: Uint8Array, contentType: string): TextExtraction {
  const decoded = decode(body, contentType).replace(/\r\n?/gu, '\n')
  if (decoded.includes('\u0000'))
    throw new WebError('parse_failed', 'The response is binary data labelled as text.')
  const visible = stripInvisible(decoded)
  const safe = neutralizeEnvelope(visible.text.trim())
  if (safe.text === '') throw new WebError('parse_failed', 'The response body is empty.')
  return {
    title: cleanTitle(firstHeading(safe.text)),
    markdown: safe.text,
    hiddenRemoved: visible.removed + safe.neutralized,
  }
}
