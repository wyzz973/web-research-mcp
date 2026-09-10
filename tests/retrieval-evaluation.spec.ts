import { describe, expect, it } from 'vitest'
import { rankCandidates, reciprocalRankFusion } from '../src/ranking/retrieval.ts'
import { evaluateRanking } from '../src/ranking/evaluation.ts'

const candidate = (title: string, snippet = '') => ({
  title,
  snippet,
  url: `https://example.com/${encodeURIComponent(title)}`,
})

describe('bounded candidate ranking', () => {
  it('preserves upstream order without pretending to calculate a local score', () => {
    const items = [candidate('unrelated'), candidate('structuredContent')]
    expect(
      rankCandidates('structuredContent', items, { mode: 'upstream', language: 'en' }).map(
        (item) => [item.candidate.title, item.score],
      ),
    ).toEqual([
      ['unrelated', null],
      ['structuredContent', null],
    ])
  })
  it('promotes rare exact query terms and retains upstream tie order', () => {
    const items = [
      candidate('MCP overview'),
      candidate('structuredContent MCP'),
      candidate('structuredContent MCP'),
    ]
    const ranked = rankCandidates('MCP structuredContent', items, { mode: 'bm25', language: 'en' })
    expect(ranked.map((item) => item.originalIndex)).toEqual([1, 2, 0])
    expect(ranked[0]?.score).toBeGreaterThan(ranked[2]?.score ?? 0)
  })
  it('normalizes width/case and excludes site operators from content scores', () => {
    const items = [candidate('ＳＱＬＩＴＥ ＢＵＳＹ'), candidate('sqlite.org')]
    expect(
      rankCandidates('sqlite busy site:sqlite.org', items, { mode: 'bm25', language: 'en' })[0]
        ?.originalIndex,
    ).toBe(0)
  })
  it('segments Chinese and falls back to stable order for no matching terms', () => {
    const items = [candidate('天气预报'), candidate('向量数据库 检索')]
    expect(
      rankCandidates('向量数据库', items, { mode: 'bm25', language: 'zh' })[0]?.originalIndex,
    ).toBe(1)
    expect(
      rankCandidates('nonexistent', items, { mode: 'bm25_mmr', language: 'zh' }).map(
        (item) => item.originalIndex,
      ),
    ).toEqual([0, 1])
  })
  it('MMR delays duplicated text while preserving every candidate and raw relevance score', () => {
    const items = [
      candidate('search retrieval apple'),
      candidate('search retrieval apple'),
      candidate('search retrieval pear'),
    ]
    const baseline = rankCandidates('search retrieval', items, { mode: 'bm25', language: 'en' })
    const diverse = rankCandidates('search retrieval', items, { mode: 'bm25_mmr', language: 'en' })
    expect(baseline.map((item) => item.originalIndex)).toEqual([0, 1, 2])
    expect(diverse.map((item) => item.originalIndex)).toEqual([0, 2, 1])
    expect(diverse[1]?.score).toBe(baseline[2]?.score)
  })
  it('rejects excess candidate, text, and query budgets before tokenization', () => {
    expect(() =>
      rankCandidates(
        'a',
        Array.from({ length: 201 }, () => candidate('a')),
        { mode: 'bm25', language: 'en' },
      ),
    ).toThrow('budget')
    expect(() =>
      rankCandidates('a', [candidate('😀'.repeat(12001))], { mode: 'bm25', language: 'en' }),
    ).toThrow('budget')
    expect(() => rankCandidates('a'.repeat(2001), [], { mode: 'bm25', language: 'en' })).toThrow(
      'budget',
    )
  })
  it('fuses independent lists without counting a duplicate ID twice per list', () => {
    const result = reciprocalRankFusion([
      ['a', 'b', 'a'],
      ['b', 'c'],
    ])
    expect(result.map((item) => item.id)).toEqual(['b', 'a', 'c'])
    expect(result.find((item) => item.id === 'a')?.score).toBeCloseTo(1 / 61)
    expect(() => reciprocalRankFusion([['a']], 0)).toThrow()
  })
})

describe('frozen-pool metrics', () => {
  const judgments = [
    { id: 'a', grade: 2 },
    { id: 'b', grade: 1 },
    { id: 'c', grade: 0 },
  ] as const
  it('reports graded nDCG, reciprocal rank and recall against the judged pool', () => {
    const result = evaluateRanking(['c', 'b', 'a'], judgments, 2)
    expect(result.ndcg).toBeCloseTo(1 / Math.log2(3) / (3 + 1 / Math.log2(3)))
    expect(result.mrr).toBe(0.5)
    expect(result.pooledRecall).toBe(0.5)
    expect(evaluateRanking(['a', 'b', 'c'], judgments, 10).ndcg).toBe(1)
  })
  it('keeps absent relevant labels distinct from an unsuccessful ordering', () => {
    expect(evaluateRanking(['a'], [{ id: 'a', grade: 0 }], 10).ndcg).toBeNull()
    expect(evaluateRanking(['c', 'a', 'b'], judgments, 1).mrr).toBe(0)
  })
  it('refuses incomplete or duplicate labels and rankings instead of silently treating unjudged as irrelevant', () => {
    expect(() => evaluateRanking(['a', 'b'], judgments, 10)).toThrow('same IDs')
    expect(() => evaluateRanking(['a', 'a', 'c'], judgments, 10)).toThrow('same IDs')
    expect(() =>
      evaluateRanking(
        ['a', 'b'],
        [
          { id: 'a', grade: 2 },
          { id: 'a', grade: 0 },
        ],
        10,
      ),
    ).toThrow('same IDs')
    expect(() => evaluateRanking([], [], 0)).toThrow('k must')
  })
})
