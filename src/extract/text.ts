import { WebError } from '../errors.ts'
import {
  ATX_HEADING,
  cleanTitle,
  neutralizeEnvelope,
  scanLines,
  stripInvisible,
} from './markdown.ts'

export interface TextExtraction {
  title: string
  markdown: string
  hiddenRemoved: number
}

function charsetOf(contentType: string): string {
  return /charset\s*=\s*["']?([\w.:-]{1,40})/iu.exec(contentType)?.[1] ?? 'utf-8'
}

function decode(body: Uint8Array, contentType: string): string {
  try {
    return new TextDecoder(charsetOf(contentType), { fatal: true }).decode(body)
  } catch {
    throw new WebError(
      'parse_failed',
      'The response is not valid text in its declared encoding, so it cannot be read verbatim.',
    )
  }
}

function firstHeading(markdown: string): string {
  for (const line of scanLines(markdown)) {
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
