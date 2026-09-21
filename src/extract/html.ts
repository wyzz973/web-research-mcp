/** HTML to verbatim Markdown. Runs inside the extraction worker; never touches the network. */
import { Readability } from '@mozilla/readability'
import { JSDOM, VirtualConsole } from 'jsdom'
import {
  markHeadingLevels,
  normalizeCodeBlocks,
  removeChrome,
  removeHidden,
  removeNoise,
  removeOwnToc,
  removePermalinks,
  restoreHeadingLevels,
  rewriteLinks,
} from './clean.ts'
import { createConverter } from './convert.ts'
import { stripInvisible } from '../invisible.ts'
import { htmlCharset } from './charset.ts'
import { cleanTitle, neutralizeEnvelope, tidyMarkdown } from './markdown.ts'
import type { ExtractInput, ExtractReply, PageSignals } from './types.ts'

const MIN_ARTICLE_CHARS = 200
/** Below this share of a long page, main-content detection most likely latched onto a fragment. */
const MIN_ARTICLE_SHARE = 0.2
const LONG_PAGE_CHARS = 5000
const SAMPLE_CHARS = 3000

function collapse(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/gu, ' ').trim()
}

/** jsdom only needs the charset; any other parameter of a hostile header is dropped. */
function parserContentType(header: string, bytes: Uint8Array): string {
  const charset = htmlCharset(header, bytes)
  return charset ? `text/html; charset=${charset}` : 'text/html'
}

interface RawCounts {
  scripts: number
  password: boolean
  shell: boolean
}

const MOUNT_POINTS = '#root,#app,#__next,#__nuxt,#svelte,[data-reactroot],[ng-app],[ng-version]'

/** Taken before cleaning, because cleaning removes exactly the elements these facts are about. */
function countRaw(document: Document): RawCounts {
  const mounts = [...document.querySelectorAll(MOUNT_POINTS)]
  const asksForScript = [...document.querySelectorAll('noscript')].some((element) =>
    /javascript/iu.test(element.textContent ?? ''),
  )
  return {
    scripts: document.querySelectorAll('script').length,
    password: document.querySelector('input[type="password" i]') !== null,
    shell: asksForScript || mounts.some((mount) => collapse(mount.textContent) === ''),
  }
}

function readSignals(document: Document, counts: RawCounts): PageSignals {
  const text = collapse(document.body?.textContent)
  return {
    title: cleanTitle(document.title),
    textChars: text.length,
    textSample: text.slice(0, SAMPLE_CHARS).toLowerCase(),
    scriptCount: counts.scripts,
    passwordField: counts.password,
    scriptShell: counts.shell,
  }
}

interface Article {
  title: string
  html: string
  chars: number
}

function readArticle(document: Document): Article | undefined {
  // Readability rewrites the tree it is given; the original must survive for the fallback.
  const copy = document.cloneNode(true) as Document
  const parsed = new Readability(copy, {
    charThreshold: MIN_ARTICLE_CHARS,
    keepClasses: true,
  }).parse()
  if (!parsed?.content) return undefined
  return {
    title: parsed.title ?? '',
    html: parsed.content,
    chars: collapse(parsed.textContent).length,
  }
}

function isTrustworthy(article: Article | undefined, bodyChars: number): article is Article {
  if (!article || article.chars < MIN_ARTICLE_CHARS) return false
  return bodyChars < LONG_PAGE_CHARS || article.chars >= bodyChars * MIN_ARTICLE_SHARE
}

function words(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])
}

/**
 * Main-content detection deletes the heading that repeats the page title. That heading is the
 * root of the outline, so it is put back when it really was the title and is now missing.
 */
function restoreTitleHeading(holder: Element, document: Document, title: string): void {
  const heading = document.querySelector('h1')
  const text = collapse(heading?.textContent)
  if (!heading || text === '') return
  const own = words(text)
  const shared = [...own].filter((word) => words(title).has(word)).length
  if (own.size === 0 || shared / own.size < 0.5) return
  const kept = [...holder.querySelectorAll('h1,h2,h3,h4,h5,h6')]
  if (!kept.some((candidate) => collapse(candidate.textContent) === text))
    holder.prepend(heading.cloneNode(true))
}

function convert(document: Document, article: Article | undefined): string {
  const converter = createConverter()
  if (article) {
    const holder = document.createElement('div')
    holder.innerHTML = article.html
    restoreHeadingLevels(holder)
    restoreTitleHeading(holder, document, article.title)
    return converter.turndown(holder)
  }
  removeChrome(document)
  return document.body ? converter.turndown(document.body) : ''
}

function extract(document: Document, url: string): ExtractReply {
  const counts = countRaw(document)
  const hiddenElements = removeHidden(document)
  removeNoise(document)
  removeOwnToc(document)
  removePermalinks(document)
  rewriteLinks(document, url)
  normalizeCodeBlocks(document)
  markHeadingLevels(document)
  const signals = readSignals(document, counts)
  const candidate = readArticle(document)
  const article = isTrustworthy(candidate, signals.textChars) ? candidate : undefined
  const visible = stripInvisible(tidyMarkdown(convert(document, article)))
  const safe = neutralizeEnvelope(visible.text.trim())
  const markdown = safe.text
  if (markdown === '') return { ok: false, reason: 'empty', signals }
  return {
    ok: true,
    value: {
      title: cleanTitle(article?.title || signals.title),
      markdown,
      hiddenRemoved: hiddenElements + visible.removed + safe.neutralized,
      usedFallback: article === undefined,
      signals,
    },
  }
}

/** Elements that never hold anything, so an opening tag of one is not a level of nesting. */
const VOID_TAGS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
])
const LESS_THAN = 0x3c
const GREATER_THAN = 0x3e
const SLASH = 0x2f

function tagNameAt(html: Uint8Array, start: number): string {
  let end = start
  while (end < html.length && end - start < 16) {
    const byte = html[end] as number
    const letter = (byte >= 0x41 && byte <= 0x5a) || (byte >= 0x61 && byte <= 0x7a)
    if (!letter && !(byte >= 0x30 && byte <= 0x39)) break
    end += 1
  }
  return String.fromCharCode(...html.subarray(start, end)).toLowerCase()
}

/**
 * How deeply the source nests, read from the bytes before a parser sees them. The parser itself
 * recurses, so a document nested tens of thousands deep costs a worker its whole deadline before
 * the measured tree exists (seventh audit round); 400 KB of `div` took more than 30 seconds. This
 * is an estimate, since a parser closes and inserts tags of its own, which is why the limit it
 * is held to is far above any real page rather than the one the tree is held to.
 */
function sourceNestedDeeperThan(html: Uint8Array, limit: number): boolean {
  let depth = 0
  for (let at = 0; at < html.length; at += 1) {
    if (html[at] !== LESS_THAN) continue
    const next = html[at + 1] as number | undefined
    if (next === undefined) return false
    if (next === SLASH) {
      if (depth > 0) depth -= 1
      continue
    }
    const name = tagNameAt(html, at + 1)
    if (name === '' || VOID_TAGS.has(name)) continue
    // `<foo/>` closes itself; scanning to the end of the tag is bounded by the tag's own length.
    let end = at + 1
    while (end < html.length && html[end] !== GREATER_THAN) end += 1
    if (html[end - 1] === SLASH) continue
    depth += 1
    if (depth > limit) return true
  }
  return false
}

/**
 * Deepest chain of elements, counted iteratively and abandoned as soon as the limit is passed:
 * a recursive walk would overflow on exactly the documents this guards against.
 */
function deeperThan(document: Document, limit: number): boolean {
  const stack: [Element, number][] = [...(document.body?.children ?? [])].map((child) => [child, 1])
  while (stack.length > 0) {
    const [element, depth] = stack.pop() as [Element, number]
    if (depth > limit) return true
    for (const child of element.children) stack.push([child, depth + 1])
  }
  return false
}

/**
 * Main-content detection and the Markdown conversion both walk up from every node, so their cost
 * grows with the square of the nesting, and neither the byte limit nor the timeout is a useful
 * guard: 13 KB of tables nested 400 deep took 16.6 seconds of a worker slot and produced one
 * character (seventh audit round). Measured on real pages: GitHub 39 levels, the Node
 * documentation 19, RFC 9110 13. At this limit the same shape costs about 0.8 seconds.
 */
const MAX_NESTING = 100
/** Far above any real page, because reading the source cannot know what the parser will do. */
const MAX_SOURCE_NESTING = 1000

export function extractFromHtml(input: ExtractInput): ExtractReply {
  if (sourceNestedDeeperThan(input.html, MAX_SOURCE_NESTING))
    return { ok: false, reason: 'too_deep' }
  // An unconnected virtual console keeps page-controlled diagnostics away from stdout and stderr.
  const dom = new JSDOM(Buffer.from(input.html), {
    url: input.url,
    contentType: parserContentType(input.contentType, input.html),
    virtualConsole: new VirtualConsole(),
  })
  try {
    if (deeperThan(dom.window.document, MAX_NESTING)) return { ok: false, reason: 'too_deep' }
    return extract(dom.window.document, input.url)
  } finally {
    try {
      dom.window.close()
    } catch {
      // Tearing a document down walks it recursively, so one nested thousands deep overflows the
      // stack here. The worker is terminated after every conversion anyway; what matters is that
      // this does not replace the answer above with a parser error.
    }
  }
}
