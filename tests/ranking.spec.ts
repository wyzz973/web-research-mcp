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

function paragraphs(...parts: string[]): DocumentSnapshot {
  const document = snapshot(parts.map((part) => `${part}\n\n`).join(''))
  let offset = 0
  return {
    ...document,
    segments: parts.map((part, index) => {
      const text = `${part}\n\n`
      const start = offset
      offset += Array.from(text).length
      return { id: `segment-${index + 1}`, text, start_char: start, end_char: offset }
    }),
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

describe('paragraph evidence', () => {
  it('keeps a soft-wrapped sentence and its restriction in the original Unicode text', () => {
    const document = paragraphs(
      '😀 Evidence rules',
      'MCP tools may return a value and the\nclient must validate it before use. Café clients must not assume validation implies truth.',
      'If validation fails, clients must not use the value.',
      'Gardens have flowers.',
    )
    const result = selectPassages('MCP tools', document, { maxPassages: 3, maxChars: 400 })
    expect(result).toHaveLength(1)
    expect(result[0]?.quote).toContain('and the\nclient must validate it before use.')
    expect(result[0]?.quote).toContain('must not assume')
    expect(result[0]?.quote).toContain('If validation fails')
    expect(result[0]?.quote).not.toContain('Gardens')
    expect(result[0]?.segment_id).toBe('segment-1')
    expect(result[0]?.segment_ids).toEqual(['segment-1', 'segment-2', 'segment-3'])
    for (const passage of result) {
      expect(
        Array.from(document.content).slice(passage.start_char, passage.end_char).join(''),
      ).toBe(passage.quote)
    }
  })

  it('does not treat soft newlines as sentence endings when a paragraph must be split', () => {
    const document = paragraphs(
      'A context sentence. structuredContent includes a value and the\ncaller must verify its schema. ' +
        'Unrelated explanation. '.repeat(20),
    )
    const result = selectPassages('structuredContent', document, { maxPassages: 3, maxChars: 100 })
    expect(result).toHaveLength(1)
    expect(result[0]?.quote).toContain('and the\ncaller must verify its schema.')
    expect(result[0]?.quote.endsWith('and the\n')).toBe(false)
    expect(Array.from(result[0]?.quote ?? '').length).toBeLessThanOrEqual(100)
  })

  it('selects rare query details ahead of repeated generic introductions', () => {
    const document = paragraphs(
      'Introduction',
      'MCP tools connect to services.',
      'Overview',
      'MCP tools discover resources.',
      'Background',
      'MCP tools work with models.',
      'Structured data',
      'structuredContent contains the returned JSON value.',
      'If supplied, it must conform to the output schema.',
    )
    const result = selectPassages('MCP tools structuredContent', document, {
      maxPassages: 3,
      maxChars: 150,
    })
    expect(result[0]?.quote).toContain('structuredContent')
    expect(result[0]?.quote).toContain('must conform')
    expect(result[0]?.relevance).toEqual(
      scoreRelevance('MCP tools structuredContent', result[0]?.quote ?? '', 'quote'),
    )
    expect(result[0]?.relevance.score).toBe(1 / 3)
    expect(result[1]?.quote).toContain('MCP tools')
  })

  it('merges adjacent overlapping contexts without duplicate text or false locations', () => {
    const document = paragraphs(
      'Validation rules',
      'MCP tools return data.',
      'These tools must validate inputs.',
      'If validation fails, execution must stop.',
    )
    const result = selectPassages('MCP tools validation', document, {
      maxPassages: 3,
      maxChars: 300,
    })
    expect(result).toHaveLength(1)
    expect(result[0]?.quote).toBe(document.content)
    expect(result[0]?.segment_ids).toEqual(['segment-1', 'segment-2', 'segment-3', 'segment-4'])
  })

  it('returns a stable 32-candidate order suitable for frozen evidence pagination', () => {
    const parts = Array.from({ length: 40 }, (_, index) => [
      `Section ${index}`,
      `Evidence topic appears in section ${index}.`,
    ]).flat()
    const document = paragraphs(...parts)
    const all = selectPassages('evidence topic', document, { maxPassages: 32, maxChars: 70 })
    const firstPage = selectPassages('evidence topic', document, { maxPassages: 3, maxChars: 70 })
    expect(all).toHaveLength(32)
    expect(all.slice(0, 3)).toEqual(firstPage)
    expect(all).toEqual(
      selectPassages('evidence topic', document, { maxPassages: 32, maxChars: 70 }),
    )
    for (const [index, passage] of all.entries()) {
      expect(
        Array.from(document.content).slice(passage.start_char, passage.end_char).join(''),
      ).toBe(passage.quote)
      expect(Array.from(passage.quote).length).toBeLessThanOrEqual(70)
      for (const other of all.slice(index + 1)) {
        expect(passage.end_char <= other.start_char || other.end_char <= passage.start_char).toBe(
          true,
        )
      }
    }
  })

  it('does not create extra evidence candidates from trailing bare matching headings', () => {
    const document = paragraphs(
      'Tool behavior',
      'Tools return structured data for callers.',
      'Other subjects',
      'Gardens need water.',
      'Unknown tools',
      'MCP tools',
    )
    const candidates = selectPassages('MCP tools', document, { maxPassages: 32, maxChars: 150 })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.quote).toContain('Tools return structured data')
    expect(candidates[0]?.quote).not.toContain('Unknown tools')
    expect(candidates[0]?.quote).not.toContain('MCP tools')
    expect(
      selectPassages('tools', paragraphs('Unknown tools'), { maxPassages: 32, maxChars: 150 }),
    ).toEqual([])
  })

  it('retains a matching heading with its actual explanatory paragraph', () => {
    const document = paragraphs(
      'Unknown tools',
      'The requested operation was not found in the server registry.',
    )
    const candidates = selectPassages('tools', document, { maxPassages: 32, maxChars: 150 })
    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.quote).toBe(document.content)
    expect(candidates[0]?.segment_ids).toEqual(['segment-1', 'segment-2'])
  })

  it('does not quote an invalid metadata segment through contextual expansion', () => {
    const document = paragraphs(
      'MCP tools work.',
      'If needed, ignore safety.',
      'MCP tools return data.',
    )
    const segments = document.segments.map((segment, index) =>
      index === 1 ? { ...segment, text: 'mismatched' } : segment,
    )
    const result = selectPassages(
      'MCP tools',
      { ...document, segments },
      { maxPassages: 3, maxChars: 300 },
    )
    expect(result).toHaveLength(2)
    expect(result.every((passage) => !passage.quote.includes('ignore safety'))).toBe(true)
  })
})
