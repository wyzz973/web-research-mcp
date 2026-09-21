/**
 * The model-facing text view. Lines outside an `untrusted` block are written by this server.
 * Everything that originates on the web stays inside a block that only ends at a closing tag
 * carrying the same random nonce, and text that imitates our tags or our header and footer lines
 * is neutralized. The number of neutralized spots is reported, never hidden.
 *
 * The rule, checked by tests/render/outside-the-block.spec.ts: outside a block there are only
 * this server's own words, ids, and numbers. A page address is site text (a redirect chooses it),
 * a goal and a ref are caller text that is often copied from a page, so none of them is printed
 * outside.
 */
import type { FetchResult, PagePart, PageResult, SearchResult, ToolError } from '../contract.ts'
import { neutralize } from '../envelope.ts'
import { randomId } from '../ids.ts'
import { charsWithinTokens, estimateTokens } from '../tokens.ts'

function oneLine(text: string): string {
  return neutralize(text).text.replace(/\s+/gu, ' ').trim()
}

/** Counts what was changed across one response, so the header can say so. */
interface Tally {
  count: number
}

/**
 * Web text that shares a line with our own fields. " | " separates those fields, so a title such
 * as "Docs | 9 sources | published 2020-01-01" would otherwise read as fields we wrote.
 */
function field(text: string, tally: Tally): string {
  const safe = neutralize(text)
  tally.count += safe.count
  return safe.text
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/\|/gu, () => {
      tally.count += 1
      return '\u2223'
    })
}

/** A URL inside one of our lines keeps working when its separator lookalike is percent-encoded. */
function urlField(text: string): string {
  return oneLine(text).replace(/\|/gu, '%7C')
}

/** Notes and errors are ours, but they sit outside the block: one of them never spans lines. */
function flat(text: string): string {
  // Written by this server, so this changes nothing today. It is the last line of defence if a
  // producer ever lets foreign text into a note: no tag of ours, and no field separator.
  return neutralize(text.replace(/\s+/gu, ' ').trim()).text.replace(/\|/gu, '\u2223')
}

function errorLine(error: ToolError): string {
  const retry = error.retry_after_s === undefined ? '' : ` (retry after ${error.retry_after_s}s)`
  return `${error.code}: ${flat(error.message)}${retry}`
}

function age(seconds: number | undefined): string {
  if (seconds === undefined) return ''
  if (seconds < 90) return ` ${Math.round(seconds)}s`
  if (seconds < 5400) return ` ${Math.round(seconds / 60)}m`
  return ` ${Math.round(seconds / 3600)}h`
}

/** Minute precision is enough to judge freshness; the JSON view keeps the full timestamp. */
function minute(timestamp: string): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2}(?:\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/u.exec(
    timestamp,
  )
  // Ours, but it has been through the store and a library caller can build a result by hand:
  // what does not parse as a timestamp is left out, like an id that does not look like ours.
  return match ? `${match[1]}${match[2]}` : undefined
}

/**
 * Refs, snapshot ids, and cursors are ours, but a ref is echoed from the caller's input. Our ids
 * are drawn from digits and consonants, so that they never spell a word; anything else, such as
 * "ignore_previous_instructions", is left out rather than printed.
 */
function ownId(value: string | undefined): string | undefined {
  const shaped = /^(?:[sc]_)?[b-df-hj-np-tv-z0-9]{3,16}(?::r\d{1,4})?$/u
  return value !== undefined && shaped.test(value) ? value : undefined
}

function joined(parts: (string | undefined)[]): string {
  return parts.filter(Boolean).join(' | ')
}

/** The block of results, and how many spots of web text had to be changed to keep it honest. */
function renderHits(result: SearchResult): { lines: string[]; neutralized: number } {
  const tally: Tally = { count: 0 }
  const lines: string[] = []
  result.results.forEach((hit, index) => {
    if (index > 0) lines.push('')
    // Our own fields never share a line with web text, so a title cannot add a field of its own
    // ("Docs | 9 sources") and titles do not have to be altered to prevent it.
    const ours = joined([
      hit.published && /^\d{4}(-\d{2}(-\d{2})?)?$/u.test(hit.published)
        ? `published ${hit.published}`
        : undefined,
      hit.found_by.length > 1 ? `${hit.found_by.length} sources` : undefined,
    ])
    lines.push(`[${ownId(hit.ref) ?? '?'}]${ours ? ` ${ours}` : ''}`)
    const heading = neutralize(
      `${hit.title.trim() || '(untitled)'} - ${hit.site}`.replace(/\s+/gu, ' '),
    )
    tally.count += heading.count
    lines.push(heading.text)
    lines.push(oneLine(hit.url))
    if (!hit.excerpt.trim()) return
    const excerpt = neutralize(hit.excerpt.trim())
    tally.count += excerpt.count
    lines.push(excerpt.text)
  })
  return { lines, neutralized: tally.count }
}

/** Results are ranked across the whole stored pool, so the last rank shown says what is left. */
function remaining(result: SearchResult): number {
  const shownUpTo = result.results.reduce((last, hit) => Math.max(last, hit.rank), 0)
  return Math.max(result.available - shownUpTo, 0)
}

export function renderSearch(result: SearchResult): string {
  const lines: string[] = []
  const used = result.sources.filter((source) => source.status === 'ok').map((source) => source.id)
  const hits = renderHits(result)
  lines.push(
    joined([
      `web_search ${result.status}`,
      `today ${result.today}`,
      `${result.returned} of ${result.available} results`,
      `~${result.tokens} tokens`,
      used.length ? `sources ${used.join('+')}` : undefined,
      `cache ${result.cache}${age(result.cache_age_s)}`,
      result.id ? `id ${result.id}` : undefined,
      result.hidden_removed ? `hidden_removed ${result.hidden_removed}` : undefined,
      hits.neutralized ? `neutralized ${hits.neutralized}` : undefined,
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
  for (const note of result.notes) lines.push(`note: ${flat(note)}`)
  if (result.results.length) {
    const nonce = randomId(8)
    lines.push(`<results untrusted="true" nonce="${nonce}">`, ...hits.lines)
    lines.push(`</results nonce="${nonce}">`)
  }
  if (result.next_cursor)
    lines.push(
      `more: ${remaining(result)} further stored results, call web_search(cursor="${result.next_cursor}")`,
    )
  const first = result.results.slice(0, 2).map((hit) => `"${hit.ref}"`)
  if (first.length)
    lines.push(`read: web_fetch(refs=[${first.join(',')}], goal="what you want to find")`)
  return lines.join('\n')
}

function location(page: PageResult, start: number, end: number): string {
  return page.snapshot ? `${page.snapshot}:${start}-${end}` : `${start}-${end}`
}

/** Find mode: the quote itself is what gets cited, so its own span is printed, not only the context. */
function matchNote(page: PageResult, part: PagePart): string | undefined {
  if (part.match_start === undefined || part.match_end === undefined) return undefined
  const more = (part.match_count ?? 1) - 1
  return `match ${location(page, part.match_start, part.match_end)}${more > 0 ? ` (+${more} more in this passage)` : ''}`
}

function partHeader(page: PageResult, part: PagePart, index: number, tally: Tally): string {
  const where = [part.section, part.heading]
    .filter((value): value is string => Boolean(value))
    .map((value) => field(value, tally))
    .join(' ')
  return joined([
    // A find passage without a match is only the closest wording, and must not read as a hit.
    page.mode === 'find' ? `${index + 1}. ${part.match ?? 'closest (not a match)'}` : undefined,
    `[${location(page, part.start, part.end)}]`,
    page.mode === 'find' ? matchNote(page, part) : undefined,
    where ? `section ${where}` : undefined,
    part.clipped ? 'clipped at a line, the rest follows at the cursor' : undefined,
    part.also_in?.length ? `same passage on page ${part.also_in.join(', ')}` : undefined,
  ])
}

function coveredMatches(page: PageResult): number {
  return page.parts.reduce((sum, part) => sum + (part.match ? (part.match_count ?? 1) : 0), 0)
}

/** Returns the body lines and how many spots of page text had to be neutralized. */
/**
 * Headings are page text, so the outline belongs inside the block like everything else the page
 * wrote; " | " separates entries, so a heading may not contain it.
 */
function renderOutline(page: PageResult, tally: Tally): string | undefined {
  if (!page.outline?.length) return undefined
  const levels = page.outline.map((entry) => entry.level)
  const entries = page.outline.map(
    (entry) => `${field(entry.id, tally)} ${field(entry.title, tally)} ~${entry.tokens}t`,
  )
  return `outline (levels ${Math.min(...levels)}-${Math.max(...levels)}): ${entries.join(' | ')}`
}

/** Returns the lines of the block and how many spots of page text had to be neutralized. */
function renderParts(page: PageResult): { lines: string[]; neutralized: number } {
  const lines: string[] = []
  const tally: Tally = { count: 0 }
  let previousEnd: number | undefined
  lines.push(`url: ${urlField(page.final_url ?? page.url)}`)
  if (page.title) {
    // A line of its own: "Page | Site" titles stay as they are, only imitation is neutralized.
    const title = neutralize(page.title.replace(/\s+/gu, ' ').trim())
    tally.count += title.count
    lines.push(`title: ${title.text}`)
  }
  page.parts.forEach((part, index) => {
    if (previousEnd !== undefined && part.start > previousEnd && page.mode !== 'find')
      lines.push('', `[... skipped ${part.start - previousEnd} chars ...]`, '')
    else if (index > 0) lines.push('')
    const body = neutralize(part.text)
    tally.count += body.count
    lines.push(partHeader(page, part, index, tally), body.text)
    previousEnd = part.end
  })
  if (page.parts.length === 0)
    lines.push(page.mode === 'find' ? '(no match)' : '(no passage shown; see the notes above)')
  const outline = renderOutline(page, tally)
  if (outline) lines.push('', outline)
  return { lines, neutralized: tally.count }
}

function renderPage(page: PageResult, lines: string[]): void {
  if (page.status === 'error' || !page.snapshot) {
    const reason = page.error ? errorLine(page.error) : 'internal: no content'
    lines.push(joined([`page ${page.n} error`, ownId(page.ref), reason]))
    // Which address failed is worth three lines: the caller may have sent several.
    const address = urlField(page.url)
    if (address) {
      const nonce = randomId(8)
      lines.push(`<page untrusted="true" nonce="${nonce}">`, `url: ${address}`)
      lines.push(`</page nonce="${nonce}">`)
    }
    return
  }
  const body = renderParts(page)
  const total = page.total_chars ?? 0
  const shown = page.shown_chars ?? 0
  const percent = total > 0 ? Math.min(100, Math.round((shown / total) * 1000) / 10) : 100
  lines.push(
    joined([
      `page ${page.n} ok`,
      ownId(page.ref),
      `snapshot ${ownId(page.snapshot) ?? '?'}`,
      page.retrieved && minute(page.retrieved) ? `retrieved ${minute(page.retrieved)}` : undefined,
      page.cache ? `cache ${page.cache}${age(page.cache_age_s)}` : undefined,
    ]),
  )
  lines.push(
    joined([
      `size ~${page.total_tokens ?? 0} tokens, ${total} chars`,
      page.mode === 'find'
        ? `${page.find_total ?? coveredMatches(page)} matches, showing ${coveredMatches(page)} in ${page.parts.length} passages`
        : `showing ${shown} chars (${percent}%) as ${page.mode ?? 'full'}`,
      `truncated ${page.truncated ? 'yes' : 'no'}`,
      `hidden_removed ${page.hidden_removed ?? 0}`,
      body.neutralized ? `neutralized ${body.neutralized}` : undefined,
      ownId(page.next_cursor) ? `next cursor ${page.next_cursor}` : undefined,
    ]),
  )
  const nonce = randomId(8)
  lines.push(`<page untrusted="true" nonce="${nonce}">`, ...body.lines)
  lines.push(`</page nonce="${nonce}">`)
  if ((page.truncated || page.outline?.length) && ownId(page.snapshot))
    lines.push(
      `read more: web_fetch(ref="${page.snapshot}", ...) with ${joined([
        page.outline?.length ? `section="<id from outline>"` : undefined,
        `find="exact text"`,
        ownId(page.next_cursor) ? `cursor="${page.next_cursor}"` : undefined,
      ])}`,
    )
}

export function renderFetch(result: FetchResult): string {
  const lines: string[] = []
  const ok = result.pages.filter((page) => page.status === 'ok').length
  lines.push(
    joined([
      `web_fetch ${result.status}`,
      // Evidence mode is visible from each page's "as goal"; the goal's words are the caller's.
      result.goal ? 'goal given' : undefined,
      result.pages.length > 1
        ? `${result.pages.length} pages: ${ok} ok, ${result.pages.length - ok} failed`
        : undefined,
      `~${result.tokens} tokens`,
    ]),
  )
  if (result.error) lines.push(`error ${errorLine(result.error)}`)
  for (const note of result.notes) lines.push(`note: ${flat(note)}`)
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
