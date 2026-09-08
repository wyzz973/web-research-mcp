import { makeSourceId, makeSnapshotId } from '../src/shared/ids.ts'
import { describe, expect, it } from 'vitest'
import { scoreRelevance } from '../src/ranking/lexical.ts'
import { selectPassages } from '../src/ranking/passages.ts'
import type { DocumentSnapshot } from '../src/shared/types.ts'

function snapshot(content: string): DocumentSnapshot {
  return {
    sourceId: makeSourceId('https://example.com/'),
    snapshotId: makeSnapshotId('00000000-0000-0000-0000-000000000001', 'text'),
    url: 'https://example.com/',
    finalUrl: 'https://example.com/',
    title: '',
    fetchedAt: '',
    expiresAt: '',
    contentType: 'text/plain',
    format: 'text',
    content,
    contentSha256: '',
    extractorVersion: 'fixture',
    warnings: [],
    segments: [
      { id: 'segment-1', text: content, start_char: 0, end_char: Array.from(content).length },
    ],
  }
}

describe('lexical relevance', () => {
  it('scores unique normalized tokens and ignores site operators', () => {
    const result = scoreRelevance(
      'ＭＣＰ MCP tools site:example.com',
      'MCP protocol',
      'title_snippet',
    )
    expect(result.score).toBe(0.5)
    expect(result.matched_terms).toEqual(['mcp'])
    expect(result.version).toContain('icu=')
    expect(result.basis).toBe('title_snippet')
  })
  it('distinguishes no evidence for scoring from zero lexical matches', () => {
    expect(scoreRelevance('site:example.com', 'content', 'quote').score).toBeNull()
    expect(scoreRelevance('tools', '', 'quote').method).toBe('none')
    expect(scoreRelevance('tools', 'nothing matching', 'quote').score).toBe(0)
  })
  it('segments Chinese and produces repeatable versioned results', () => {
    const result = scoreRelevance('搜索 算法', '搜索算法的解释', 'quote', 'zh-CN')
    expect(result.score).toBe(1)
    expect(scoreRelevance('搜索 算法', '搜索算法的解释', 'quote', 'zh-CN')).toEqual(result)
  })
})

describe('passages', () => {
  it('retains negation and Unicode offsets with emoji and combining characters', () => {
    const document = snapshot(
      '😀 Café context. This study does not show that MCP tools are secure. More evidence is required.',
    )
    const passages = selectPassages('MCP tools secure', document, { maxPassages: 2, maxChars: 120 })
    expect(passages).toHaveLength(1)
    expect(passages[0]?.quote).toContain('does not show')
    for (const passage of passages) {
      expect(
        Array.from(document.content).slice(passage.start_char, passage.end_char).join(''),
      ).toBe(passage.quote)
      expect(Array.from(passage.quote).length).toBeLessThanOrEqual(120)
    }
  })
  it('does not invent excerpts without matches or cut an overlong sentence', () => {
    expect(
      selectPassages('missing', snapshot('A simple article.'), { maxPassages: 2, maxChars: 100 }),
    ).toEqual([])
    expect(
      selectPassages('secure', snapshot('Not '.repeat(100) + 'secure.'), {
        maxPassages: 2,
        maxChars: 80,
      }),
    ).toEqual([])
  })
  it('selects bounded nonoverlapping excerpts in deterministic score order', () => {
    const document = snapshot(
      'Alpha is first. Unrelated sentence. Beta is second. Another distraction. Alpha and beta are mentioned together.',
    )
    const result = selectPassages('alpha beta', document, { maxPassages: 2, maxChars: 48 })
    expect(result[0]?.quote).toContain('Alpha and beta')
    expect(result).toEqual(selectPassages('alpha beta', document, { maxPassages: 2, maxChars: 48 }))
    expect(result.length).toBeLessThanOrEqual(2)
  })
})
