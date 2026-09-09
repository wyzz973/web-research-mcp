import { parentPort, workerData } from 'node:worker_threads'
import { JSDOM, VirtualConsole } from 'jsdom'
import { Readability } from '@mozilla/readability'
import TurndownService from 'turndown'
import { gfm } from '@joplin/turndown-plugin-gfm'
import { extractSourceMetadata } from './metadata.ts'

interface Input {
  html: Uint8Array
  url: string
  contentType: string
}
function isInput(value: unknown): value is Input {
  return (
    typeof value === 'object' &&
    value !== null &&
    'html' in value &&
    value.html instanceof Uint8Array &&
    'url' in value &&
    typeof value.url === 'string' &&
    'contentType' in value &&
    typeof value.contentType === 'string'
  )
}

function extract(input: Input) {
  const warnings = new Set<string>()
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error: unknown) => {
    const type =
      typeof error === 'object' && error !== null && 'type' in error ? error.type : undefined
    // Styles are removed before article extraction. CSS syntax errors do not
    // affect this text-only path and must not write page-controlled data to stderr.
    if (type === 'css-parsing') return
    if (type === 'unhandled-exception' || type === 'resource-loading')
      throw new Error('Unexpected script or resource activity during isolated DOM parsing.')
    warnings.add(
      type === 'not-implemented'
        ? 'The DOM parser reported unsupported functionality during static extraction.'
        : 'The DOM parser reported a non-CSS diagnostic during static extraction.',
    )
  })
  const dom = new JSDOM(Buffer.from(input.html), {
    url: input.url,
    contentType: input.contentType,
    virtualConsole,
  })
  try {
    const document = dom.window.document
    const all = document.querySelectorAll('*')
    if (all.length > 50_000) throw new Error('Document exceeds the 50000 element parsing limit.')
    for (const element of all) {
      let depth = 0
      let parent = element.parentElement
      while (parent) {
        if (++depth > 512) throw new Error('Document exceeds the 512 element depth limit.')
        parent = parent.parentElement
      }
    }
    const sourceMetadata = extractSourceMetadata(document, input.url)
    document
      .querySelectorAll('script,style,noscript,iframe,object,embed,form,input,button,svg,canvas')
      .forEach((element) => element.remove())
    for (const element of document.querySelectorAll('[href],[src]')) {
      for (const name of ['href', 'src']) {
        const value = element.getAttribute(name)
        if (!value) continue
        try {
          const target = new URL(value, input.url)
          if (!['https:', 'http:'].includes(target.protocol) || target.username || target.password)
            element.removeAttribute(name)
          else element.setAttribute(name, target.href)
        } catch {
          element.removeAttribute(name)
        }
      }
    }
    const article = new Readability(document, {
      charThreshold: 80,
      maxElemsToParse: 50_000,
    }).parse()
    if (!article?.content || !article.textContent || article.textContent.trim().length < 40)
      throw new Error('No readable article content was found.')
    const content = document.createElement('div')
    content.innerHTML = article.content
    const textParts: string[] = []
    const blocks = new Set([
      'P',
      'DIV',
      'SECTION',
      'ARTICLE',
      'H1',
      'H2',
      'H3',
      'H4',
      'H5',
      'H6',
      'LI',
      'PRE',
      'TR',
      'BLOCKQUOTE',
    ])
    function walk(node: Node): void {
      if (node.nodeType === 3) {
        textParts.push(node.textContent ?? '')
        return
      }
      if (node.nodeType !== 1) return
      const element = node as Element
      if (element.tagName === 'BR') textParts.push('\n')
      if (blocks.has(element.tagName)) textParts.push('\n')
      for (const child of element.childNodes) walk(child)
      if (element.tagName === 'TD' || element.tagName === 'TH') textParts.push('\t')
      if (blocks.has(element.tagName)) textParts.push('\n')
    }
    walk(content)
    const text = textParts
      .join('')
      .replace(/[\t ]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
    const turndown = new TurndownService({
      headingStyle: 'atx',
      codeBlockStyle: 'fenced',
      bulletListMarker: '-',
    })
    turndown.use(gfm)
    turndown.remove(['script', 'style', 'iframe'])
    const markdown = turndown.turndown(content.innerHTML).trim()
    if (!markdown || !text) throw new Error('Article extraction produced empty content.')
    return { title: article.title ?? '', text, markdown, warnings: [...warnings], sourceMetadata }
  } finally {
    dom.window.close()
  }
}

try {
  const input: unknown = workerData
  if (!isInput(input)) throw new Error('Invalid extraction worker input.')
  parentPort?.postMessage({ ok: true, value: extract(input) })
} catch (error) {
  parentPort?.postMessage({
    ok: false,
    message: error instanceof Error ? error.message : 'Article extraction failed.',
  })
}
