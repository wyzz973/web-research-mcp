/** Graded relevance in a frozen candidate pool; judgments must cover the entire pool. */
export interface Judgment {
  readonly id: string
  readonly grade: 0 | 1 | 2
}
export interface RetrievalMetrics {
  readonly ndcg: number | null
  readonly mrr: number | null
  readonly pooledRecall: number | null
  readonly relevantInPool: number
  readonly poolSize: number
  readonly k: number
}
/** Null metrics distinguish an unanswerable/no-relevant pool from measured poor ordering.
 * Recall is relative to this judged pool, never a claim about the entire web.
 */
export function evaluateRanking(
  order: readonly string[],
  judgments: readonly Judgment[],
  k: number,
): RetrievalMetrics {
  if (!Number.isInteger(k) || k < 1 || k > 200)
    throw new Error('k must be an integer from 1 to 200.')
  const grades = new Map(judgments.map((item) => [item.id, item.grade]))
  if (
    grades.size !== judgments.length ||
    new Set(order).size !== order.length ||
    order.length !== grades.size ||
    order.some((id) => !grades.has(id))
  ) {
    throw new Error('Ranking and uniquely judged pool must contain exactly the same IDs.')
  }
  const relevantInPool = judgments.filter((item) => item.grade > 0).length
  const base = { relevantInPool, poolSize: judgments.length, k }
  if (!relevantInPool) return { ...base, ndcg: null, mrr: null, pooledRecall: null }
  const top = order.slice(0, k).map((id) => grades.get(id) ?? 0)
  const dcg = (values: readonly number[]): number =>
    values.reduce((sum, grade, index) => sum + (2 ** grade - 1) / Math.log2(index + 2), 0)
  const ideal = judgments
    .map((item) => item.grade)
    .sort((a, b) => b - a)
    .slice(0, k)
  const first = top.findIndex((grade) => grade > 0)
  return {
    ...base,
    ndcg: dcg(top) / dcg(ideal),
    mrr: first < 0 ? 0 : 1 / (first + 1),
    pooledRecall: top.filter((grade) => grade > 0).length / relevantInPool,
  }
}
