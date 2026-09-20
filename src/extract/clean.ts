/** DOM passes that run before main-content detection. Each pass mutates the document in place. */

const NOISE =
  'script,style,noscript,template,iframe,frame,object,embed,svg,canvas,input,button,select,textarea,link[rel="stylesheet"]'
const HIDDEN = '[hidden],[aria-hidden="true"],dialog:not([open]),[style]'
const HIDDEN_STYLE = /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/iu
const OWN_TOC = 'nav,[role="navigation"],#toc,.toc,#table-of-contents,.table-of-contents'
const CHROME =
  'header,footer,aside,[role="banner"],[role="contentinfo"],[role="complementary"],[role="search"],[id*="cookie-consent"],[class*="cookie-consent"],[id*="cookie-banner"],[class*="cookie-banner"]'
const PERMALINK_SYMBOL = /^[#¶§🔗]$/u
const PERMALINK_WORD = /^(?:link|permalink|anchor)$/iu
const TRACKING_PARAMETER =
  /^(?:utm_\w+|fbclid|gclid|dclid|gbraid|wbraid|msclkid|yclid|igshid|mc_cid|mc_eid|_hsenc|_hsmi|ref_src)$/iu
const STRUCTURAL = new Set(['HTML', 'HEAD', 'BODY', 'MAIN', 'ARTICLE'])

function hasText(element: Element): boolean {
  return (element.textContent ?? '').trim() !== ''
}

function isHidden(element: Element): boolean {
  if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') return true
  if (element.tagName === 'DIALOG' && !element.hasAttribute('open')) return true
  return HIDDEN_STYLE.test(element.getAttribute('style') ?? '')
}

function removeComments(document: Document): number {
  const walker = document.createTreeWalker(document, 128 /* NodeFilter.SHOW_COMMENT */)
  const comments: Node[] = []
  while (walker.nextNode()) comments.push(walker.currentNode)
  for (const comment of comments) comment.parentNode?.removeChild(comment)
  return comments.filter((comment) => (comment.nodeValue ?? '').trim() !== '').length
}

/**
 * Removes what a browser would not show and returns how many pieces carried text. Decorative
 * hidden nodes (icons, spacers) are removed too but not counted: the number is reported to the
 * model as "hidden text was stripped", and empty nodes would only make it noise.
 */
export function removeHidden(document: Document): number {
  let counted = removeComments(document)
  for (const element of document.querySelectorAll(HIDDEN)) {
    // Pages that reveal <body> from script would otherwise lose everything.
    if (!element.isConnected || STRUCTURAL.has(element.tagName) || !isHidden(element)) continue
    if (hasText(element)) counted += 1
    element.remove()
  }
  return counted
}

export function removeNoise(document: Document): void {
  for (const element of document.querySelectorAll(NOISE)) element.remove()
}

function textLength(node: Element | null): number {
  return (node?.textContent ?? '').replace(/\s+/gu, ' ').trim().length
}

function linkDensity(element: Element): number {
  const total = textLength(element)
  if (total === 0) return 1
  let linked = 0
  for (const anchor of element.querySelectorAll('a')) linked += textLength(anchor)
  return linked / total
}

/**
 * The page's own navigation and table of contents are replaced by the outline we generate. Only
 * explicit markup is trusted: guessing from a "Contents" heading could delete real content.
 */
export function removeOwnToc(document: Document): void {
  const bodyText = textLength(document.body)
  for (const element of document.querySelectorAll(OWN_TOC)) {
    if (!element.isConnected || STRUCTURAL.has(element.tagName)) continue
    // A class named "toc" on a wrapper around the whole article must not take the article with it.
    if (bodyText > 0 && textLength(element) > bodyText * 0.5 && linkDensity(element) < 0.7) continue
    element.remove()
  }
}

/** Page chrome. Only used on the whole-body fallback path; main-content detection drops it itself. */
export function removeChrome(document: Document): void {
  for (const element of document.querySelectorAll(CHROME)) {
    if (element.isConnected && !STRUCTURAL.has(element.tagName)) element.remove()
  }
}

/** Permalink markers ("#", a pilcrow) are navigation, and would end up in every outline title. */
export function removePermalinks(document: Document): void {
  for (const anchor of document.querySelectorAll('a[href^="#"]')) {
    const text = (anchor.textContent ?? '').trim()
    const inHeading = anchor.closest('h1,h2,h3,h4,h5,h6') !== null
    if (PERMALINK_SYMBOL.test(text) || (inHeading && (text === '' || PERMALINK_WORD.test(text))))
      anchor.remove()
  }
}

function unwrap(element: Element): void {
  element.replaceWith(...element.childNodes)
}

function withoutHash(url: URL): string {
  return `${url.origin}${url.pathname}${url.search}`
}

function cleanTarget(raw: string, base: URL): URL | undefined {
  let target: URL
  try {
    target = new URL(raw, base)
  } catch {
    return undefined
  }
  if (target.protocol !== 'https:' && target.protocol !== 'http:') return undefined
  if (target.username || target.password) return undefined
  // Copied first: deleting while iterating the live key list would skip entries.
  for (const name of Array.from(target.searchParams.keys()))
    if (TRACKING_PARAMETER.test(name)) target.searchParams.delete(name)
  return target
}

/**
 * Links become absolute and lose tracking parameters; script and data schemes are dropped.
 * Links into the same document are unwrapped: as absolute URLs they would cost more tokens
 * than the text they decorate, and the outline already covers in-page navigation.
 */
export function rewriteLinks(document: Document, pageUrl: string): void {
  const base = new URL(document.baseURI || pageUrl)
  const page = withoutHash(new URL(pageUrl))
  for (const anchor of document.querySelectorAll('a')) {
    const href = anchor.getAttribute('href')
    const target = href === null ? undefined : cleanTarget(href, base)
    if (!target || withoutHash(target) === page) unwrap(anchor)
    else anchor.setAttribute('href', target.href)
    // Tooltips are not page text, and Markdown would print them inside every link.
    anchor.removeAttribute('title')
  }
}

const LEVEL_ATTRIBUTE = 'data-wr-level'

/** Main-content detection demotes every h1 to h2, which would flatten the outline. Record the truth first. */
export function markHeadingLevels(document: Document): void {
  for (const heading of document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
    heading.setAttribute(LEVEL_ATTRIBUTE, heading.tagName.slice(1))
}

export function restoreHeadingLevels(root: Element): void {
  for (const heading of root.querySelectorAll(`[${LEVEL_ATTRIBUTE}]`)) {
    const level = heading.getAttribute(LEVEL_ATTRIBUTE) ?? ''
    if (!/^[1-6]$/u.test(level) || heading.tagName === `H${level}`) continue
    const restored = root.ownerDocument.createElement(`h${level}`)
    restored.append(...heading.childNodes)
    heading.replaceWith(restored)
  }
}

/** Highlighters often put line breaks in <br> or per-line blocks, which textContent would lose. */
export function normalizeCodeBlocks(document: Document): void {
  for (const pre of document.querySelectorAll('pre')) {
    for (const lineBreak of pre.querySelectorAll('br')) lineBreak.replaceWith('\n')
  }
}
