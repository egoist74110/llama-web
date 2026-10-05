// What the memory estimate needs to know about the files of one model: the header facts of the first shard plus the
// size of all shards together. Results are cached by path + size + modification time (a check runs on every edit).
import { stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { readGguf } from './gguf'
import type { ModelFacts } from './memory-estimate'
import { SHARD_RE } from './scanner'

/** Paths of every shard of a split model (`name-00001-of-00003.gguf`), or just the file itself. */
export function shardPaths(abs: string): string[] {
  const m = SHARD_RE.exec(basename(abs))
  if (!m) return [abs]
  const total = Number(m[3])
  if (!Number.isInteger(total) || total < 1 || total > 9999) return [abs]
  const width = m[2]!.length
  return Array.from({ length: total }, (_, i) => join(dirname(abs), `${m[1]}-${String(i + 1).padStart(width, '0')}-of-${m[3]}.gguf`))
}

const cache = new Map<string, { stamp: string, facts: ModelFacts }>()

/**
 * Facts of one model file (for a split model, pass the first shard). Throws when the file cannot be read; a missing
 * later shard only makes the total smaller (the estimate then errs low, and the scan already marks such a model incomplete).
 */
export async function loadModelFacts(abs: string): Promise<ModelFacts> {
  const paths = shardPaths(abs)
  const sizes: number[] = []
  let stamp = ''
  for (const p of paths) {
    try {
      const st = await stat(p)
      sizes.push(st.size)
      stamp += `${st.size}:${st.mtimeMs};`
    } catch {
      if (p === abs) throw new Error(`cannot read ${abs}`)
    }
  }
  const hit = cache.get(abs)
  if (hit && hit.stamp === stamp) return hit.facts
  const { meta, layout } = await readGguf(abs)
  const facts: ModelFacts = { meta, layout, totalBytes: sizes.reduce((a, b) => a + b, 0), sharded: paths.length > 1 }
  cache.set(abs, { stamp, facts })
  if (cache.size > 64) cache.delete(cache.keys().next().value!)
  return facts
}

/** Size of one plain file in bytes, 0 when it cannot be read. */
export async function fileBytes(abs: string): Promise<number> {
  try { return (await stat(abs)).size } catch { return 0 }
}
