// Result fusion for knowledge base search (decision 65 ④). Pure.

export const RRF_K = 60

/**
 * Reciprocal rank fusion: each list is best-first; an item's score is the sum over lists of 1 / (k + rank), rank from 1.
 * Returns the keys best-first.
 */
export function fuseRrf(lists: ReadonlyArray<readonly string[]>, k = RRF_K): Array<{ key: string, score: number }> {
  const score = new Map<string, number>()
  for (const list of lists) list.forEach((key, i) => score.set(key, (score.get(key) ?? 0) + 1 / (k + i + 1)))
  return [...score].map(([key, s]) => ({ key, score: s })).sort((a, b) => b.score - a.score || (a.key < b.key ? -1 : 1))
}
