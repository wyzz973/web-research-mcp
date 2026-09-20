/**
 * The model-facing text view. Lines outside an `untrusted` block are written by this server.
 * Everything that originates on the web stays inside a block that only ends at a closing tag
 * carrying the same random nonce, and text that imitates our tags or our header and footer lines
 * is neutralized. The number of neutralized spots is reported, never hidden.
 */
import type { FetchResult, PagePart, PageResult, SearchResult, ToolError } from '../contract.ts'
import { randomId } from '../ids.ts'
import { charsWithinTokens, estimateTokens } from '../tokens.ts'

const ENVELOPE_TAG = /<(\/?)\s*(results|page)\b/giu
const PROTOCOL_LINE =
  /^\s*(web_search |web_fetch |page \d+ |sources:|note:|error |more:|read:|read more:|outline |size ~|\[output clamped)/u

interface Neutralized {
  text: string
  count: number
}

/** Shown text differs from the stored snapshot only at the spots counted here. */
function neutralize(text: string): Neutralized {
  let count = 0
  const escaped = text.replace(ENVELOPE_TAG, (_match, slash: string, tag: string) => {
    count += 1
    return `&lt;${slash}${tag}`
  })
  const lines = escaped.split('\n').map((line) => {
    if (!PROTOCOL_LINE.test(line)) return line
    count += 1
    return `| ${line}`
  })
  return { text: lines.join('\n'), count }
}

function oneLine(text: string): string {
  return neutralize(text).text.replace(/\s+/gu, ' ').trim()
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

function joined(parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join(' | ')
}

export function renderSearch(result: SearchResult): string {
  const lines: string[] = []
  const used = result.sources.filter((source) => source.status === 'ok').map((source) => source.id)
  lines.push(
    joined([
      `web_search ${result.status}`,
      `today ${result.today}`,
      `${result.returned} of ${result.available} results`,
      `~${result.tokens} tokens`,
      used.length ? `sources ${used.join('+')}` : undefined,
      `cache ${result.cache}${age(result.cache_age_s)}`,
      result.id ? `id ${result.id}` : undefined,
    ]),
  )
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
    const nonce = randomId(8)
    lines.push(`<results untrusted="true" nonce="${nonce}">`)
    result.results.forEach((hit, index) => {
      if (index > 0) lines.push('')
      lines.push(
        joined([
          `[${hit.ref}] ${oneLine(hit.title) || '(untitled)'} - ${oneLine(hit.site)}`,
          hit.published ? `published ${oneLine(hit.published)}` : undefined,
          hit.found_by.length > 1 ? `${hit.found_by.length} sources` : undefined,
        ]),
      )
      lines.push(oneLine(hit.url))
      if (hit.excerpt.trim()) lines.push(neutralize(hit.excerpt.trim()).text)
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
  const where = [part.section, part.heading]
    .filter((value): value is string => Boolean(value))
    .map(oneLine)
    .join(' ')
  return joined([
    page.mode === 'find' ? `${index + 1}. ${part.match ?? 'exact'}` : undefined,
    `[${location(page, part)}]`,
    where ? `section ${where}` : undefined,
  ])
}

/** Returns the body lines and how many spots of page text had to be neutralized. */
function renderParts(page: PageResult): { lines: string[]; neutralized: number } {
  const lines: string[] = []
  let neutralized = 0
  let previousEnd: number | undefined
  page.parts.forEach((part, index) => {
    if (previousEnd !== undefined && part.start > previousEnd && page.mode !== 'find')
      lines.push('', `[... skipped ${part.start - previousEnd} chars ...]`, '')
    else if (index > 0) lines.push('')
    const body = neutralize(part.text)
    neutralized += body.count
    lines.push(partHeader(page, part, index), body.text)
    previousEnd = part.end
  })
  return { lines, neutralized }
}

function renderOutline(page: PageResult): string | undefined {
  if (!page.outline?.length) return undefined
  const levels = page.outline.map((entry) => entry.level)
  const entries = page.outline.map(
    (entry) => `${oneLine(entry.id)} ${oneLine(entry.title)} ~${entry.tokens}t`,
  )
  return `outline (levels ${Math.min(...levels)}-${Math.max(...levels)}): ${entries.join(' | ')}`
}

function renderPage(page: PageResult, lines: string[]): void {
  const address = page.final_url ?? page.url
  if (page.status === 'error' || !page.snapshot) {
    const reason = page.error ? errorLine(page.error) : 'internal: no content'
    lines.push(joined([`page ${page.n} error`, page.ref, oneLine(address), reason]))
    return
  }
  const body = renderParts(page)
  const total = page.total_chars ?? 0
  const shown = page.shown_chars ?? 0
  const percent = total > 0 ? Math.min(100, Math.round((shown / total) * 1000) / 10) : 100
  lines.push(
    joined([
      `page ${page.n} ok`,
      page.ref,
      oneLine(address),
      `snapshot ${page.snapshot}`,
      page.retrieved ? `retrieved ${page.retrieved}` : undefined,
      page.cache ? `cache ${page.cache}${age(page.cache_age_s)}` : undefined,
    ]),
  )
  lines.push(
    joined([
      `size ~${page.total_tokens ?? 0} tokens, ${total} chars`,
      page.mode === 'find'
        ? `${page.find_total ?? page.parts.length} matches, showing ${page.parts.length}`
        : `showing ${shown} chars (${percent}%) as ${page.mode ?? 'full'}`,
      `truncated ${page.truncated ? 'yes' : 'no'}`,
      `hidden_removed ${page.hidden_removed ?? 0}`,
      body.neutralized ? `neutralized ${body.neutralized}` : undefined,
      page.next_cursor ? `next cursor ${page.next_cursor}` : undefined,
    ]),
  )
  const nonce = randomId(8)
  lines.push(`<page untrusted="true" nonce="${nonce}">`)
  if (page.title) lines.push(`title: ${oneLine(page.title)}`)
  if (body.lines.length) lines.push(...body.lines)
  else lines.push('(no relevant passage)')
  lines.push(`</page nonce="${nonce}">`)
  const outline = renderOutline(page)
  if (outline) lines.push(outline)
  if (page.truncated || page.outline?.length)
    lines.push(
      `read more: web_fetch(ref="${page.snapshot}", ...) with ${joined([
        page.outline?.length ? `section="<id from outline>"` : undefined,
        `find="exact text"`,
        page.next_cursor ? `cursor="${page.next_cursor}"` : undefined,
      ])}`,
    )
}

export function renderFetch(result: FetchResult): string {
  const lines: string[] = []
  const ok = result.pages.filter((page) => page.status === 'ok').length
  lines.push(
    joined([
      `web_fetch ${result.status}`,
      result.goal ? `goal "${oneLine(result.goal)}"` : undefined,
      result.pages.length > 1
        ? `${result.pages.length} pages: ${ok} ok, ${result.pages.length - ok} failed`
        : undefined,
      `~${result.tokens} tokens`,
    ]),
  )
  if (result.error) lines.push(`error ${errorLine(result.error)}`)
  for (const note of result.notes) lines.push(`note: ${note}`)
  for (const page of result.pages) renderPage(page, lines)
  return lines.join('\n')
}

const OPENER = /^<(results|page) untrusted="true" nonce="([a-z0-9]+)">$/u
const CLAMP_NOTICE = '[output clamped by the server limit; ask for less or continue with a cursor]'

/** The untrusted block that is still open after these lines, if any. */
function openBlock(lines: string[]): { tag: string; nonce: string } | undefined {
  let open: { tag: string; nonce: string } | undefined
  for (const line of lines) {
    const opener = OPENER.exec(line)
    if (opener?.[1] && opener[2]) open = { tag: opener[1], nonce: opener[2] }
    else if (open && line === `</${open.tag} nonce="${open.nonce}">`) open = undefined
  }
  return open
}

/**
 * Last line of defence: the cores budget their content, but no response may exceed the
 * deployment ceiling. The limits are exact, a cut never leaves an untrusted block open, and the
 * cut is announced rather than silent.
 */
export function clampOutput(text: string, maxChars: number, maxTokens: number): string {
  if (text.length <= maxChars && estimateTokens(text) <= maxTokens) return text
  const reserve = CLAMP_NOTICE.length + 40
  const roomChars = Math.max(0, maxChars - reserve)
  const roomTokens = Math.max(0, maxTokens - estimateTokens(CLAMP_NOTICE) - 12)
  const limit = Math.min(roomChars, charsWithinTokens(text, roomTokens))
  const kept: string[] = []
  let used = 0
  for (const line of text.split('\n')) {
    if (used + line.length + 1 > limit) break
    kept.push(line)
    used += line.length + 1
  }
  const open = openBlock(kept)
  if (open) kept.push(`</${open.tag} nonce="${open.nonce}">`)
  kept.push(CLAMP_NOTICE)
  const output = kept.join('\n')
  // A ceiling smaller than the notice itself leaves room for nothing else.
  return output.length <= maxChars ? output : output.slice(0, Math.max(0, maxChars))
}
