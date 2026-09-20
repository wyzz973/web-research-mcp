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

export function extractFromHtml(input: ExtractInput): ExtractReply {
  // An unconnected virtual console keeps page-controlled diagnostics away from stdout and stderr.
  const dom = new JSDOM(Buffer.from(input.html), {
    url: input.url,
    contentType: parserContentType(input.contentType, input.html),
    virtualConsole: new VirtualConsole(),
  })
  try {
    return extract(dom.window.document, input.url)
  } finally {
    dom.window.close()
  }
}
