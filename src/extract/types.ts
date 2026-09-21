/** Messages that cross the extraction worker boundary. Both directions are validated. */

export interface ExtractInput {
  html: Uint8Array
  url: string
  contentType: string
}

/** Facts about the page that failure classification needs. Never copied into messages. */
export interface PageSignals {
  title: string
  /** Visible text length after scripts, styles, and hidden content were removed. */
  textChars: number
  /** Leading slice of the visible text, lower-cased, for phrase checks. */
  textSample: string
  scriptCount: number
  passwordField: boolean
  /** An empty framework mount point, or a <noscript> that asks for JavaScript. */
  scriptShell: boolean
}

export interface Extracted {
  title: string
  markdown: string
  hiddenRemoved: number
  /** True when main-content detection failed and the whole body was converted instead. */
  usedFallback: boolean
  signals: PageSignals
}

export type ExtractReply =
  | { ok: true; value: Extracted }
  | { ok: false; reason: 'empty' | 'failed' | 'too_deep'; signals?: PageSignals }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

export function isExtractInput(value: unknown): value is ExtractInput {
  return (
    isRecord(value) &&
    value.html instanceof Uint8Array &&
    typeof value.url === 'string' &&
    typeof value.contentType === 'string'
  )
}

function isSignals(value: unknown): value is PageSignals {
  return (
    isRecord(value) &&
    typeof value.title === 'string' &&
    typeof value.textChars === 'number' &&
    typeof value.textSample === 'string' &&
    typeof value.scriptCount === 'number' &&
    typeof value.passwordField === 'boolean' &&
    typeof value.scriptShell === 'boolean'
  )
}

function isExtracted(value: unknown): value is Extracted {
  return (
    isRecord(value) &&
    typeof value.title === 'string' &&
    typeof value.markdown === 'string' &&
    typeof value.hiddenRemoved === 'number' &&
    typeof value.usedFallback === 'boolean' &&
    isSignals(value.signals)
  )
}

export function isExtractReply(value: unknown): value is ExtractReply {
  if (!isRecord(value)) return false
  if (value.ok === true) return isExtracted(value.value)
  if (value.ok !== false) return false
  const reasons = new Set(['empty', 'failed', 'too_deep'])
  if (typeof value.reason !== 'string' || !reasons.has(value.reason)) return false
  return value.signals === undefined || isSignals(value.signals)
}
