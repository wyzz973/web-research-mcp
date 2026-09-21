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

/** Up to this many children of one parent are changed one by one; more, and the parent is rebuilt. */
const REBUILD_FROM = 64

/** What takes the place of a node: nothing, its own children, or new nodes. */
type Replacement = (node: Node) => Node[]

const nothing: Replacement = () => []

/** Always handles the first child, whose position among its siblings costs nothing to find. */
function rebuild(
  owner: Document,
  parent: Node,
  changed: Set<Node>,
  replacement: Replacement,
): void {
  const kept = owner.createDocumentFragment()
  while (parent.firstChild) {
    const child = parent.firstChild
    if (changed.has(child)) {
      for (const node of replacement(child)) kept.appendChild(node)
      if (child.parentNode === parent) parent.removeChild(child)
    } else kept.appendChild(child)
  }
  parent.appendChild(kept)
}

/**
 * Takes nodes out of the document, putting `replacement` in their place. jsdom looks up a
 * node's position among its siblings on every removal and insertion, so changing many children
 * of one parent one at a time is quadratic: 50,000 <br> in one <pre> took five minutes, 10,000
 * links in one paragraph four seconds. A parent with many changes is rebuilt once instead.
 */
function replaceNodes(nodes: Iterable<Node>, replacement: Replacement = nothing): void {
  const byParent = new Map<Node, Set<Node>>()
  for (const node of nodes) {
    const parent = node.parentNode
    if (!parent) continue
    const changed = byParent.get(parent)
    if (changed) changed.add(node)
    else byParent.set(parent, new Set([node]))
  }
  for (const [parent, changed] of byParent) {
    // The document itself has no owner and is never rebuilt: its doctype cannot pass through a
    // fragment, and what changes there (comments around <html>) stands at the front, where a
    // position is cheap to find.
    const owner = parent.ownerDocument
    if (owner && changed.size > REBUILD_FROM) rebuild(owner, parent, changed, replacement)
    else for (const node of changed) (node as ChildNode).replaceWith(...replacement(node))
  }
}

/**
 * The elements that are not inside an earlier one of the list. Expects document order, where a
 * descendant follows its ancestor before anything outside that ancestor does.
 */
function outermost(elements: Iterable<Element>, wanted: (element: Element) => boolean): Element[] {
  const kept: Element[] = []
  for (const element of elements) {
    if (kept.at(-1)?.contains(element) || !wanted(element)) continue
    kept.push(element)
  }
  return kept
}

function removeComments(document: Document): number {
  const walker = document.createTreeWalker(document, 128 /* NodeFilter.SHOW_COMMENT */)
  const comments: Node[] = []
  while (walker.nextNode()) comments.push(walker.currentNode)
  replaceNodes(comments)
  return comments.filter((comment) => (comment.nodeValue ?? '').trim() !== '').length
}

/**
 * Removes what a browser would not show and returns how many pieces carried text. Decorative
 * hidden nodes (icons, spacers) are removed too but not counted: the number is reported to the
 * model as "hidden text was stripped", and empty nodes would only make it noise.
 */
export function removeHidden(document: Document): number {
  const comments = removeComments(document)
  // Pages that reveal <body> from script would otherwise lose everything.
  const hidden = outermost(
    document.querySelectorAll(HIDDEN),
    (element) => !STRUCTURAL.has(element.tagName) && isHidden(element),
  )
  const counted = hidden.filter(hasText).length
  replaceNodes(hidden)
  return comments + counted
}

export function removeNoise(document: Document): void {
  replaceNodes(outermost(document.querySelectorAll(NOISE), () => true))
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
  // A class named "toc" on a wrapper around the whole article must not take the article with it.
  const isArticle = (element: Element): boolean =>
    bodyText > 0 && textLength(element) > bodyText * 0.5 && linkDensity(element) < 0.7
  replaceNodes(
    outermost(
      document.querySelectorAll(OWN_TOC),
      (element) => !STRUCTURAL.has(element.tagName) && !isArticle(element),
    ),
  )
}

/** Page chrome. Only used on the whole-body fallback path; main-content detection drops it itself. */
export function removeChrome(document: Document): void {
  replaceNodes(
    outermost(document.querySelectorAll(CHROME), (element) => !STRUCTURAL.has(element.tagName)),
  )
}

/** Permalink markers ("#", a pilcrow) are navigation, and would end up in every outline title. */
export function removePermalinks(document: Document): void {
  const isPermalink = (anchor: Element): boolean => {
    const text = (anchor.textContent ?? '').trim()
    if (PERMALINK_SYMBOL.test(text)) return true
    if (text !== '' && !PERMALINK_WORD.test(text)) return false
    return anchor.closest('h1,h2,h3,h4,h5,h6') !== null
  }
  replaceNodes([...document.querySelectorAll('a[href^="#"]')].filter(isPermalink))
}

const ownChildren: Replacement = (node) => [...node.childNodes]

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
  const unwrapped: Element[] = []
  for (const anchor of document.querySelectorAll('a')) {
    const href = anchor.getAttribute('href')
    const target = href === null ? undefined : cleanTarget(href, base)
    if (!target || withoutHash(target) === page) unwrapped.push(anchor)
    else anchor.setAttribute('href', target.href)
    // Tooltips are not page text, and Markdown would print them inside every link.
    anchor.removeAttribute('title')
  }
  replaceNodes(unwrapped, ownChildren)
}

const LEVEL_ATTRIBUTE = 'data-wr-level'

/** Main-content detection demotes every h1 to h2, which would flatten the outline. Record the truth first. */
export function markHeadingLevels(document: Document): void {
  for (const heading of document.querySelectorAll('h1,h2,h3,h4,h5,h6'))
    heading.setAttribute(LEVEL_ATTRIBUTE, heading.tagName.slice(1))
}

export function restoreHeadingLevels(root: Element): void {
  const levelOf = (heading: Node): string =>
    (heading as Element).getAttribute(LEVEL_ATTRIBUTE) ?? ''
  const demoted = [...root.querySelectorAll(`[${LEVEL_ATTRIBUTE}]`)].filter(
    (heading) => /^[1-6]$/u.test(levelOf(heading)) && heading.tagName !== `H${levelOf(heading)}`,
  )
  replaceNodes(demoted, (heading) => {
    const restored = root.ownerDocument.createElement(`h${levelOf(heading)}`)
    restored.append(...heading.childNodes)
    return [restored]
  })
}

/** Highlighters often put line breaks in <br> or per-line blocks, which textContent would lose. */
export function normalizeCodeBlocks(document: Document): void {
  replaceNodes(document.querySelectorAll('pre br'), () => [document.createTextNode('\n')])
}
