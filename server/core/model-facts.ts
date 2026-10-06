// What the memory estimate needs to know about the files of one model: the header facts of the first shard plus the
// size of all shards together. Results are cached by path + size + modification time (a check runs on every edit).
import { stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { readGguf, type GgufLayout } from './gguf'
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

/** The layouts of all shards as one: every shard holds some of the tensors, so the sums over the shards are the whole model. */
export function mergeLayouts(parts: GgufLayout[]): GgufLayout {
  const out: GgufLayout = { layerBytes: [], embedBytes: 0, outputBytes: 0, tiedOutput: true, otherBytes: 0, tensorBytes: 0 }
  for (const l of parts) {
    for (let n = 0; n < l.layerBytes.length; n++) out.layerBytes[n] = (out.layerBytes[n] ?? 0) + (l.layerBytes[n] ?? 0)
    out.embedBytes += l.embedBytes
    out.outputBytes += l.outputBytes
    out.otherBytes += l.otherBytes
    out.tensorBytes += l.tensorBytes
    if (!l.tiedOutput) out.tiedOutput = false
  }
  for (let n = 0; n < out.layerBytes.length; n++) out.layerBytes[n] ??= 0
  return out
}

const cache = new Map<string, { stamp: string, facts: ModelFacts }>()

/**
 * Facts of one model file (for a split model, pass the first shard). Throws when the first file cannot be read. The
 * tensor layout is the sum over all shards; when a later shard is missing or unreadable the layout covers only part
 * of the model (`sharded: true`) and the estimate falls back to a guess from the file size instead of trusting it.
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
  const { meta, layout: first } = await readGguf(abs)
  let layout = first
  let partial = false
  if (paths.length > 1) {
    const layouts = [first]
    for (const p of paths.slice(1)) {
      try { layouts.push((await readGguf(p)).layout) } catch { partial = true }
    }
    layout = mergeLayouts(layouts)
    if (sizes.length < paths.length) partial = true
  }
  const facts: ModelFacts = { meta, layout, totalBytes: sizes.reduce((a, b) => a + b, 0), sharded: partial }
  cache.set(abs, { stamp, facts })
  if (cache.size > 64) cache.delete(cache.keys().next().value!)
  return facts
}

/** Size of one plain file in bytes, 0 when it cannot be read. */
export async function fileBytes(abs: string): Promise<number> {
  try { return (await stat(abs)).size } catch { return 0 }
}

/** Size and modification time of a file and all its shards (empty for no file): changes when the content is replaced. */
export async function fileStamp(abs: string | null): Promise<string> {
  if (!abs) return ''
  let out = ''
  for (const p of shardPaths(abs)) {
    try { const st = await stat(p); out += `${st.size}:${st.mtimeMs};` } catch { out += 'x;' }
  }
  return out
}
