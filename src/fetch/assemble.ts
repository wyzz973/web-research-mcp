/** Builds the public result objects. Nothing here reads the network or decides what to show. */
import type { FetchResult, PageResult, Snapshot, ToolError } from '../contract.ts'
import { estimateTokens } from '../tokens.ts'
import { CALL_OVERHEAD, ERROR_PAGE_OVERHEAD, PAGE_OVERHEAD, PART_OVERHEAD } from './budget.ts'
import type { PageDocument } from './document.ts'
import type { PageRead } from './read.ts'

export interface PageSource {
  n: number
  ref?: string
  snapshot: Snapshot
  cache: 'miss' | 'hit'
  cacheAgeS?: number
  document: PageDocument
}

const MAX_NOTES = 3

const MAX_URL_CHARS = 300

/**
 * The address of a failed page is the caller's text. It is echoed only in its parsed, percent-
 * encoded form, which cannot carry spaces, line breaks, quotes, or angle brackets; text that is
 * not a URL at all is dropped, and the page is identified by its number.
 */
function echoUrl(raw: string): string {
  try {
    return new URL(raw).href.slice(0, MAX_URL_CHARS)
  } catch {
    return ''
  }
}

export function failedPage(
  n: number,
  url: string,
  ref: string | undefined,
  error: ToolError,
): PageResult {
  const page: PageResult = {
    n,
    status: 'error',
    url: echoUrl(url),
    parts: [],
    truncated: false,
    error,
  }
  if (ref !== undefined) page.ref = ref
  return page
}

export function okPage(
  source: PageSource,
  read: PageRead,
  nextCursor: string | undefined,
): PageResult {
  const { snapshot, document } = source
  const page: PageResult = {
    n: source.n,
    status: 'ok',
    url: snapshot.url,
    snapshot: snapshot.id,
    sha256: snapshot.sha256,
    retrieved: snapshot.retrieved_at,
    cache: source.cache,
    title: snapshot.title,
    total_chars: document.markdown.length,
    total_tokens: document.totalTokens,
    mode: read.mode,
    parts: read.parts,
    shown_chars: read.parts.reduce((sum, part) => sum + part.text.length, 0),
    truncated: read.truncated,
    hidden_removed: snapshot.hidden_removed,
  }
  if (source.ref !== undefined) page.ref = source.ref
  if (snapshot.final_url !== snapshot.url) page.final_url = snapshot.final_url
  if (source.cacheAgeS !== undefined) page.cache_age_s = source.cacheAgeS
  if (nextCursor !== undefined) page.next_cursor = nextCursor
  if (read.outline) page.outline = read.outline
  if (read.findTotal !== undefined) page.find_total = read.findTotal
  return page
}

function pageTokens(page: PageResult): number {
  if (page.status === 'error') return ERROR_PAGE_OVERHEAD.tokens
  const parts = page.parts.reduce(
    (sum, part) => sum + estimateTokens(part.text) + PART_OVERHEAD.tokens,
    0,
  )
  const outline = (page.outline ?? []).reduce(
    (sum, entry) => sum + estimateTokens(`${entry.id} ${entry.title} ~${entry.tokens}t | `),
    0,
  )
  return PAGE_OVERHEAD.tokens + parts + outline
}

function overallError(pages: PageResult[]): ToolError | undefined {
  const first = pages[0]?.error
  if (!first) return undefined
  if (pages.length === 1) return first
  return {
    code: first.code,
    message: `None of the ${pages.length} pages could be read; each page line gives its reason.`,
  }
}

/** Reading notes come first: they change what the model does next more than input repairs do. */
export function capNotes(notes: string[]): string[] {
  const unique = [...new Set(notes)]
  if (unique.length <= MAX_NOTES) return unique
  return [
    ...unique.slice(0, MAX_NOTES - 1),
    `${unique.length - MAX_NOTES + 1} more adjustments were made to the request`,
  ]
}

export function buildResult(
  pages: PageResult[],
  goal: string | undefined,
  notes: string[],
): FetchResult {
  const ok = pages.filter((page) => page.status === 'ok').length
  const result: FetchResult = {
    status: ok === pages.length ? 'ok' : ok > 0 ? 'partial' : 'error',
    tokens: CALL_OVERHEAD.tokens + pages.reduce((sum, page) => sum + pageTokens(page), 0),
    pages,
    notes: capNotes(notes),
  }
  if (goal !== undefined) result.goal = goal
  const error = ok === 0 ? overallError(pages) : undefined
  if (error) result.error = error
  return result
}

export function failedResult(error: ToolError, notes: string[] = []): FetchResult {
  return { status: 'error', tokens: CALL_OVERHEAD.tokens, pages: [], notes: capNotes(notes), error }
}
