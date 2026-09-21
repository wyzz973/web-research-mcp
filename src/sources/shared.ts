/** Parsing helpers shared by the source adapters. Upstream payloads are untyped until checked here. */
import type { Recency } from '../contract.ts'
import { WebError } from '../errors.ts'

export type JsonRecord = Record<string, unknown>

export function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function parseJson(text: string, source: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new WebError('parse_failed', `${source} returned a body that is not JSON.`)
  }
}

/**
 * Whitespace hygiene only; words and their order are never changed. Invisible characters are
 * deliberately left in: the search core removes them where text is shown, because only there
 * can the removal be counted against what the reader actually gets (src/invisible.ts).
 */
export function cleanText(value: unknown): string {
  if (typeof value !== 'string') return ''
  return value
    .replace(/\r\n?/gu, '\n')
    .replace(/[ \t]+\n/gu, '\n')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

export function cleanTitle(value: unknown): string {
  return cleanText(value).replace(/\s+/gu, ' ')
}

export function cleanPassages(values: readonly unknown[]): string[] {
  return values.map(cleanText).filter((passage) => passage.length > 0)
}

const EARLIEST_PLAUSIBLE_YEAR = 1990

/** "Tue, 14 Jan 2025 17:15:24 GMT", as Tavily reports news dates. */
const HTTP_DATE = /^[A-Za-z]{3}, \d{1,2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/u

function isoDay(value: string): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})(?:$|[T\s])/u.exec(value)
  if (match?.[1]) return Number.isNaN(Date.parse(`${match[1]}T00:00:00Z`)) ? undefined : match[1]
  const parsed = HTTP_DATE.test(value) ? Date.parse(value) : Number.NaN
  return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString().slice(0, 10)
}

/** Sources report dates as `2026-02-02`, ISO timestamps, HTTP dates, or placeholders like `N/A`. */
export function toIsoDate(value: unknown): string | undefined {
  const day = typeof value === 'string' ? isoDay(value.trim()) : undefined
  // Epoch placeholders (1970-01-01) are artifacts, not publication dates.
  return day && Number(day.slice(0, 4)) >= EARLIEST_PLAUSIBLE_YEAR ? day : undefined
}

const RECENCY_DAYS: Record<Recency, number> = { day: 1, week: 7, month: 31, year: 366 }

/** Start of the recency window. */
export function recencyStart(recency: Recency, now: Date): Date {
  return new Date(now.getTime() - RECENCY_DAYS[recency] * 24 * 3600 * 1000)
}

/**
 * The anonymous tiers take no domain or date filters, only a free-text objective. The hint asks
 * for the restriction; the searcher still filters the results, so the contract never depends on it.
 */
export function objectiveWithHints(
  base: string,
  hints: { sites: string[]; recency: Recency | undefined; now: Date },
): string {
  const parts = [base]
  if (hints.sites.length) parts.push(`Only include results from: ${hints.sites.join(', ')}.`)
  if (hints.recency) {
    const since = recencyStart(hints.recency, hints.now).toISOString().slice(0, 10)
    parts.push(`Only include content published or updated since ${since}.`)
  }
  return parts.join(' ')
}

/**
 * Vendor error text is used for classification only and never echoed: it is outside our control
 * and tends to contain instructions ("create an API key at ...") aimed at whoever reads it.
 */
export function vendorFailure(vendorText: string, source: string): WebError {
  if (
    /rate.?limit|too many requests|quota|\b429\b|usage limit|free (?:mcp |tier )?limit/iu.test(
      vendorText,
    )
  )
    return new WebError('rate_limited', `${source} reported that its rate limit is reached.`)
  if (/unauthori[sz]ed|forbidden|invalid api key|\b401\b|\b403\b/iu.test(vendorText))
    return new WebError('blocked', `${source} refused the request.`)
  return new WebError('upstream_error', `${source} reported an error.`)
}
