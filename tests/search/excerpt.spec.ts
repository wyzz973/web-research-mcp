import { describe, expect, it } from 'vitest'
import { pickExcerpt } from '../../src/search/excerpt.ts'
import { buildTerms, queryCoverage } from '../../src/search/terms.ts'
import { estimateTokens } from '../../src/tokens.ts'

const roomy = { tokens: 10_000, chars: 100_000 }

const article = [
  'Cooking pasta takes about ten minutes.',
  'Salt the water generously before it boils.',
  'AbortSignal.timeout() returns a signal that aborts after the given time.',
  'Pass it as the signal option of fetch() to cancel a slow request.',
  'The weather was pleasant that day.',
  'Nobody remembers who won the match.',
].join(' ')

/** Every character we return must come from the source, apart from the markers we document. */
function expectVerbatim(excerpt: string, passages: string[]): void {
  const pieces = excerpt
    .split(/\s*…\s*/u)
    .map((piece) => piece.replace(/\n```$/u, '').trim())
    .filter(Boolean)
  for (const piece of pieces) expect(passages.some((passage) => passage.includes(piece))).toBe(true)
}

describe('pickExcerpt', () => {
  it('returns the whole text when it fits', () => {
    const terms = buildTerms(['fetch timeout'], undefined)
    expect(pickExcerpt([article], terms, roomy)).toBe(article)
  })

  it('picks the consecutive sentences that match the query best', () => {
    const terms = buildTerms(['abort fetch request timeout'], undefined)
    const excerpt = pickExcerpt([article], terms, { tokens: 45, chars: 1000 })
    expect(excerpt).toBe(
      '… AbortSignal.timeout() returns a signal that aborts after the given time. Pass it as the signal option of fetch() to cancel a slow request. …',
    )
    expectVerbatim(excerpt, [article])
  })

  it('lets the goal steer the choice when the query words are everywhere', () => {
    const text =
      'Fetch is a browser API. Fetch supports streaming bodies. Fetch can be cancelled with AbortController. Fetch follows redirects by default.'
    const terms = buildTerms(['fetch'], 'how to cancel a request')
    expect(pickExcerpt([text], terms, { tokens: 20, chars: 1000 })).toBe(
      '… Fetch can be cancelled with AbortController. …',
    )
  })

  it('falls back to the opening when nothing matches', () => {
    const terms = buildTerms(['zebra'], undefined)
    const excerpt = pickExcerpt([article], terms, { tokens: 30, chars: 1000 })
    expect(excerpt.startsWith('Cooking pasta takes about ten minutes.')).toBe(true)
    expect(excerpt.endsWith(' …')).toBe(true)
  })

  it('cuts a single sentence that is larger than the budget at a word boundary', () => {
    const sentence = `${'word '.repeat(200).trim()}.`
    const excerpt = pickExcerpt([sentence], [], { tokens: 25, chars: 1000 })
    expect(excerpt.endsWith('word…')).toBe(true)
    expect(estimateTokens(excerpt)).toBeLessThanOrEqual(25)
  })

  it('respects the character ceiling as well as the token ceiling', () => {
    const excerpt = pickExcerpt([article], buildTerms(['fetch'], undefined), {
      tokens: 5000,
      chars: 120,
    })
    expect(excerpt.length).toBeLessThanOrEqual(120)
    expectVerbatim(excerpt, [article])
  })

  it('marks the gap between passages that are not contiguous in the source', () => {
    const passages = ['First fragment about fetch.', 'Second fragment about abort.']
    expect(pickExcerpt(passages, [], roomy)).toBe(
      'First fragment about fetch. … Second fragment about abort.',
    )
    const withCode = ['Intro line.', '```\nconst a = 1\n```']
    expect(pickExcerpt(withCode, [], roomy)).toBe('Intro line.\n…\n```\nconst a = 1\n```')
  })

  it('never cuts inside a code block that fits, and closes one it has to cut', () => {
    const code =
      '```\nconst controller = new AbortController()\nfetch(url, { signal: controller.signal })\n```'
    const text = `Some unrelated opening sentence here. Another unrelated sentence follows it.\n${code}\nClosing remarks that do not matter.`
    const terms = buildTerms(['AbortController fetch signal'], undefined)

    const whole = pickExcerpt([text], terms, { tokens: 45, chars: 1000 })
    expect(whole).toContain(code)

    const cut = pickExcerpt([code], terms, { tokens: 18, chars: 1000 })
    expect(cut.startsWith('```\nconst controller')).toBe(true)
    expect(cut.endsWith('…\n```')).toBe(true)
    expect(cut.split('\n').filter((line) => line.startsWith('```'))).toHaveLength(2)
  })

  it('closes a fence that the source itself left open', () => {
    const passage = 'Example:\n```\nconst x = 1'
    expect(pickExcerpt([passage], [], roomy)).toBe('Example:\n```\nconst x = 1\n```')
  })

  it('handles Chinese: sentence boundaries, bigram matching, and the token weight of CJK', () => {
    const text =
      '今天天气很好。我们去公园散步。使用 AbortController 可以取消请求。超时之后请求会被中止。晚饭吃了面条。'
    const terms = buildTerms(['取消请求 超时'], undefined)
    const excerpt = pickExcerpt([text], terms, { tokens: 34, chars: 1000 })
    expect(excerpt).toBe('… 使用 AbortController 可以取消请求。超时之后请求会被中止。 …')
    expect(estimateTokens(excerpt)).toBeLessThanOrEqual(34)
  })

  it('cuts unpunctuated CJK text by characters without splitting a surrogate pair', () => {
    const text = '𠮷'.repeat(60)
    const excerpt = pickExcerpt([text], [], { tokens: 20, chars: 1000 })
    expect(excerpt.endsWith('…')).toBe(true)
    expect(Array.from(excerpt.slice(0, -1)).every((char) => char === '𠮷')).toBe(true)
  })

  it('returns nothing for no text or no budget', () => {
    expect(pickExcerpt([], [], roomy)).toBe('')
    expect(pickExcerpt(['  '], [], roomy)).toBe('')
    expect(pickExcerpt([article], [], { tokens: 0, chars: 100 })).toBe('')
  })

  it('stays within the budget even when every passage needs a fence closed', () => {
    const openCode = (name: string) => `Example ${name}:\n\`\`\`\nconst ${name} = await fetch(url)`
    const passages = ['a', 'b', 'c', 'd', 'e', 'f'].map(openCode)
    const terms = buildTerms(['fetch example'], undefined)
    for (const tokens of [20, 40, 60, 90, 400]) {
      const excerpt = pickExcerpt(passages, terms, { tokens, chars: 10_000 })
      expect(estimateTokens(excerpt)).toBeLessThanOrEqual(tokens)
      const fences = excerpt.split('\n').filter((line) => line.startsWith('```')).length
      expect(fences % 2).toBe(0)
    }
  })

  it('stays within the budget for any budget', () => {
    const terms = buildTerms(['signal fetch'], undefined)
    for (const tokens of [8, 15, 25, 40, 80, 200]) {
      const excerpt = pickExcerpt([article, article], terms, { tokens, chars: 10_000 })
      expect(estimateTokens(excerpt)).toBeLessThanOrEqual(tokens)
      expectVerbatim(excerpt, [article])
    }
  })
})

describe('buildTerms', () => {
  it('drops stop words, splits compounds, and weighs quoted phrases highest', () => {
    const terms = buildTerms(['how to use "abort signal" in node.js'], 'the timeout option')
    const byText = new Map(terms.map((term) => [term.text, term.weight]))
    expect(byText.get('abort signal')).toBe(3)
    expect(byText.get('node.js')).toBe(2)
    expect(byText.get('node')).toBe(2)
    expect(byText.get('timeout')).toBe(1)
    expect(byText.has('how')).toBe(false)
    expect(byText.has('the')).toBe(false)
  })

  it('matches at word starts, so "js" does not hit "nodejs" but "fetch" hits "fetching"', () => {
    const [js] = buildTerms(['js'], undefined)
    const [fetch] = buildTerms(['fetch'], undefined)
    expect(js?.matches('we use nodejs here')).toBe(false)
    expect(js?.matches('plain js here')).toBe(true)
    expect(fetch?.matches('fetching data')).toBe(true)
  })

  it('measures how much of the query shows up in a set of texts', () => {
    const terms = buildTerms(['abort fetch timeout'], 'irrelevant goal words')
    expect(queryCoverage(terms, ['Abort a FETCH call'])).toBeCloseTo(2 / 3)
    expect(queryCoverage(terms, ['nothing relevant'])).toBe(0)
    expect(queryCoverage([], ['anything'])).toBe(1)
  })
})
