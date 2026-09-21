import TurndownService from 'turndown'
import { gfm } from '@joplin/turndown-plugin-gfm'
import { withoutTrailing } from './markdown.ts'

const LANGUAGE_CLASS =
  /(?:^|\s)(?:language-|lang-|highlight-source-|highlight-text-|brush:\s*)([\w#+.-]+)/iu
const LANGUAGE_NAME = /^[\w#+.-]{1,24}$/u

function attribute(node: Element | null | undefined, name: string): string {
  return node?.getAttribute(name) ?? ''
}

/** The language label is page-controlled, so only a short identifier is accepted. */
function codeLanguage(pre: Element): string {
  const code = pre.querySelector('code')
  const holders = [code, pre, pre.parentElement]
  for (const holder of holders) {
    const match = LANGUAGE_CLASS.exec(attribute(holder, 'class'))
    if (match?.[1]) return match[1].toLowerCase()
  }
  const declared = holders
    .flatMap((holder) => [attribute(holder, 'data-language'), attribute(holder, 'data-lang')])
    .find((value) => LANGUAGE_NAME.test(value))
  return declared?.toLowerCase() ?? ''
}

function fenceFor(code: string): string {
  let longest = 0
  for (const run of code.match(/`+/gu) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(3, longest + 1))
}

function fencedBlock(pre: Element): string {
  const text = (pre.textContent ?? '').replace(/\r\n?/gu, '\n')
  const code = withoutTrailing(text, (unit) => unit === 10)
  if (code.trim() === '') return ''
  const fence = fenceFor(code)
  return `\n\n${fence}${codeLanguage(pre)}\n${code}\n${fence}\n\n`
}

function isElement(node: TurndownService.Node): node is HTMLElement {
  return node.nodeType === 1
}

/** GFM Markdown with fenced code that keeps its language, and images reduced to their alt text. */
export function createConverter(): TurndownService {
  const converter = new TurndownService({
    headingStyle: 'atx',
    hr: '---',
    codeBlockStyle: 'fenced',
    bulletListMarker: '-',
    emDelimiter: '*',
  })
  converter.use(gfm)
  converter.addRule('preformatted', {
    filter: 'pre',
    replacement: (_content, node) => (isElement(node) ? fencedBlock(node) : ''),
  })
  converter.addRule('imageAltOnly', {
    filter: 'img',
    replacement: (_content, node) => {
      const alt = isElement(node) ? attribute(node, 'alt').replace(/\s+/gu, ' ').trim() : ''
      return alt ? `![${alt.replace(/[[\]]/gu, '')}]` : ''
    },
  })
  converter.addRule('emptyLink', {
    filter: (node) => node.nodeName === 'A' && (node.textContent ?? '').trim() === '',
    replacement: (content) => content,
  })
  return converter
}
