// Result fusion for knowledge base search (decision 65 ④) and the filters of a search request. Pure.
import { KbError } from './errors'
import { cleanTags } from './tags'

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

/**
 * `tags` and `minSimilarity` of a search request body (decision 65 ⑭), checked strictly: `tags` an array of strings
 * (absent / null = no filter), `minSimilarity` a number from 0 to 1 (absent / null = off). Anything else is a KbError.
 */
export function parseSearchFilters(body: Record<string, unknown>): { tags: string[], minSimilarity: number | null } {
  const rawTags = body.tags
  if (rawTags !== undefined && rawTags !== null && (!Array.isArray(rawTags) || !rawTags.every(x => typeof x === 'string'))) throw new KbError('bad-tags')
  const sim = body.minSimilarity
  if (sim !== undefined && sim !== null && (typeof sim !== 'number' || !Number.isFinite(sim) || sim < 0 || sim > 1)) throw new KbError('bad-similarity')
  return { tags: cleanTags(rawTags), minSimilarity: typeof sim === 'number' ? sim : null }
}
