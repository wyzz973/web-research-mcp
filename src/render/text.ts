/**
 * The model-facing text view. Lines outside an `untrusted` block are written by this server;
 * everything that originates on the web stays inside a block closed by a per-response nonce,
 * so page-controlled text cannot end the block or forge our header and footer.
 */
import type { FetchResult, PagePart, PageResult, SearchResult, ToolError } from '../contract.ts'
import { estimateTokens } from '../tokens.ts'
import { randomId } from '../ids.ts'

const ENVELOPE_TAG = /<(\/?)\s*(results|page)\b/giu
const PROTOCOL_LINE =
  /^(web_search |web_fetch |page \d+ |sources:|note:|more:|read:|read more:|outline )/u

/** Provider text is not offset-addressed, so it may be neutralized at render time. */
function untrusted(text: string): string {
  return text
    .replace(ENVELOPE_TAG, '&lt;$1$2')
    .split('\n')
    .map((line) => (PROTOCOL_LINE.test(line) ? `| ${line}` : line))
    .join('\n')
}

function oneLine(text: string): string {
  return untrusted(text).replace(/\s+/gu, ' ').trim()
}

function errorLine(error: ToolError): string {
  const retry = error.retry_after_s === undefined ? '' : ` (retry after ${error.retry_after_s}s)`
  return `${error.code}: ${error.message}${retry}`
}

function age(seconds: number | undefined): string {
  if (seconds === undefined) return ''
  if (seconds < 90) return ` ${Math.round(seconds)}s`
  if (seconds < 5400) return ` ${Math.round(seconds / 60)}m`
  return ` ${Math.round(seconds / 3600)}h`
}

export function renderSearch(result: SearchResult): string {
  const lines: string[] = []
  const used = result.sources.filter((source) => source.status === 'ok').map((source) => source.id)
  const header = [
    `web_search ${result.status}`,
    `today ${result.today}`,
    `${result.returned} of ${result.available} results`,
    `~${result.tokens} tokens`,
    used.length ? `sources ${used.join('+')}` : undefined,
    `cache ${result.cache}${age(result.cache_age_s)}`,
    result.id ? `id ${result.id}` : undefined,
  ]
  lines.push(header.filter(Boolean).join(' | '))
  if (result.error) lines.push(`error ${errorLine(result.error)}`)
  if (result.sources.some((source) => source.status !== 'ok' && source.status !== 'empty'))
    lines.push(
      `sources: ${result.sources
        .map((source) =>
          [
            source.id,
            source.status,
            source.retry_after_s === undefined ? undefined : `retry ${source.retry_after_s}s`,
          ]
            .filter(Boolean)
            .join(' '),
        )
        .join(' | ')}`,
    )
  for (const note of result.notes) lines.push(`note: ${note}`)
  if (result.results.length) {
    const nonce = result.id ?? randomId(4)
    lines.push(`<results untrusted="true" nonce="${nonce}">`)
    result.results.forEach((hit, index) => {
      if (index > 0) lines.push('')
      const facts = [
        `[${hit.ref}] ${oneLine(hit.title) || '(untitled)'} - ${oneLine(hit.site)}`,
        hit.published ? `published ${hit.published}` : undefined,
        hit.found_by.length > 1 ? `${hit.found_by.length} sources` : undefined,
      ]
      lines.push(facts.filter(Boolean).join(' | '))
      lines.push(oneLine(hit.url))
      if (hit.excerpt.trim()) lines.push(untrusted(hit.excerpt.trim()))
    })
    lines.push(`</results nonce="${nonce}">`)
  }
  if (result.next_cursor)
    lines.push(
      `more: ${Math.max(result.available - result.returned, 0)} further stored results, call web_search(cursor="${result.next_cursor}")`,
    )
  const first = result.results.slice(0, 2).map((hit) => `"${hit.ref}"`)
  if (first.length)
    lines.push(`read: web_fetch(refs=[${first.join(',')}], goal="what you want to find")`)
  return lines.join('\n')
}

function location(page: PageResult, part: PagePart): string {
  return page.snapshot ? `${page.snapshot}:${part.start}-${part.end}` : `${part.start}-${part.end}`
}

function partHeader(page: PageResult, part: PagePart, index: number): string {
  const where = [part.section, part.heading ? oneLine(part.heading) : undefined]
    .filter(Boolean)
    .join(' ')
  const facts = [
    page.mode === 'find' ? `${index + 1}. ${part.match ?? 'exact'}` : undefined,
    `[${location(page, part)}]`,
    where ? `section ${where}` : undefined,
  ]
  return facts.filter(Boolean).join(' | ')
}

function renderParts(page: PageResult, lines: string[]): void {
  let previousEnd: number | undefined
  page.parts.forEach((part, index) => {
    if (previousEnd !== undefined && part.start > previousEnd && page.mode !== 'find') {
      lines.push('', `[... skipped ${part.start - previousEnd} chars ...]`, '')
    } else if (index > 0) lines.push('')
    lines.push(partHeader(page, part, index))
    lines.push(part.text)
    previousEnd = part.end
  })
}

function renderOutline(page: PageResult): string | undefined {
  if (!page.outline?.length) return undefined
  const deepest = Math.max(...page.outline.map((entry) => entry.level))
  const shallowest = Math.min(...page.outline.map((entry) => entry.level))
  const entries = page.outline.map(
    (entry) => `${entry.id} ${oneLine(entry.title)} ~${entry.tokens}t`,
  )
  return `outline (levels ${shallowest}-${deepest}): ${entries.join(' | ')}`
}

function renderPage(page: PageResult, lines: string[]): void {
  const address = page.final_url ?? page.url
  if (page.status === 'error' || !page.snapshot) {
    const reason = page.error ? errorLine(page.error) : 'internal: no content'
    lines.push(
      [`page ${page.n} error`, page.ref, oneLine(address), reason].filter(Boolean).join(' | '),
    )
    return
  }
  lines.push(
    [
      `page ${page.n} ok`,
      page.ref,
      oneLine(address),
      `snapshot ${page.snapshot}`,
      page.retrieved ? `retrieved ${page.retrieved}` : undefined,
      page.cache ? `cache ${page.cache}${age(page.cache_age_s)}` : undefined,
    ]
      .filter(Boolean)
      .join(' | '),
  )
  const total = page.total_chars ?? 0
  const shown = page.shown_chars ?? 0
  const percent = total > 0 ? Math.min(100, Math.round((shown / total) * 1000) / 10) : 100
  lines.push(
    [
      `size ~${page.total_tokens ?? 0} tokens, ${total} chars`,
      page.mode === 'find'
        ? `${page.find_total ?? page.parts.length} matches, showing ${page.parts.length}`
        : `showing ${shown} chars (${percent}%) as ${page.mode ?? 'full'}`,
      `truncated ${page.truncated ? 'yes' : 'no'}`,
      `hidden_removed ${page.hidden_removed ?? 0}`,
      page.next_cursor ? `next cursor ${page.next_cursor}` : undefined,
    ]
      .filter(Boolean)
      .join(' | '),
  )
  lines.push(`<page untrusted="true" nonce="${page.snapshot}">`)
  if (page.title) lines.push(`title: ${oneLine(page.title)}`)
  if (page.parts.length) renderParts(page, lines)
  else lines.push('(no relevant passage)')
  lines.push(`</page nonce="${page.snapshot}">`)
  const outline = renderOutline(page)
  if (outline) lines.push(outline)
  if (page.truncated || page.outline?.length) {
    const hints = [
      page.outline?.length ? `section="<id from outline>"` : undefined,
      `find="exact text"`,
      page.next_cursor ? `cursor="${page.next_cursor}"` : undefined,
    ]
    lines.push(
      `read more: web_fetch(ref="${page.snapshot}", ...) with ${hints.filter(Boolean).join(' | ')}`,
    )
  }
}

export function renderFetch(result: FetchResult): string {
  const lines: string[] = []
  const ok = result.pages.filter((page) => page.status === 'ok').length
  const header = [
    `web_fetch ${result.status}`,
    result.goal ? `goal "${oneLine(result.goal)}"` : undefined,
    result.pages.length > 1
      ? `${result.pages.length} pages: ${ok} ok, ${result.pages.length - ok} failed`
      : undefined,
    `~${result.tokens} tokens`,
  ]
  lines.push(header.filter(Boolean).join(' | '))
  if (result.error) lines.push(`error ${errorLine(result.error)}`)
  for (const note of result.notes) lines.push(`note: ${note}`)
  for (const page of result.pages) renderPage(page, lines)
  return lines.join('\n')
}

/**
 * Last line of defence: the cores budget their content, but no response may exceed the
 * deployment ceiling, and any cut made here is announced rather than silent.
 */
export function clampOutput(text: string, maxChars: number, maxTokens: number): string {
  if (text.length <= maxChars && estimateTokens(text) <= maxTokens * 1.15) return text
  const notice = '\n[output clamped by the server limit; ask for less or continue with a cursor]'
  let cut = Math.min(text.length, maxChars) - notice.length
  while (cut > 0 && estimateTokens(text.slice(0, cut)) > maxTokens * 1.15)
    cut = Math.floor(cut * 0.9)
  const boundary = text.lastIndexOf('\n', cut)
  return text.slice(0, boundary > 0 ? boundary : cut) + notice
}
