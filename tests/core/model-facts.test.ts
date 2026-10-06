// Facts of a split model: the layout is the sum over every shard, not the first shard scaled up (CR-010).
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadModelFacts, mergeLayouts } from '../../server/core/model-facts'
import { writeGguf, type FakeGguf, type KvValue } from '../fixtures/gguf-builder'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lw-facts-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const u32 = (v: number): KvValue => ({ t: 'u32', v })
const shard = (names: string[], first: boolean): FakeGguf => ({
  kvs: first
    ? [['general.architecture', { t: 'str', v: 'llama' }], ['llama.block_count', u32(4)], ['llama.embedding_length', u32(64)]]
    : [['general.architecture', { t: 'str', v: 'llama' }]],
  tensors: names.map(name => ({ dims: [64, 64], type: 0, name })),
})

test('layers that live in later shards are counted with their own size', async () => {
  const a = join(dir, 'm-00001-of-00002.gguf')
  writeGguf(a, shard(['token_embd.weight', 'blk.0.w', 'blk.1.w'], true))
  writeGguf(join(dir, 'm-00002-of-00002.gguf'), shard(['blk.2.w', 'blk.3.w', 'output.weight'], false))
  const f = await loadModelFacts(a)
  expect(f.sharded).toBe(false)
  const per = 64 * 64 * 4
  expect(f.layout!.layerBytes).toEqual([per, per, per, per])
  expect(f.layout!.outputBytes).toBe(per)
  expect(f.layout!.tiedOutput).toBe(false)
  expect(f.layout!.tensorBytes).toBe(6 * per)
})

test('a missing later shard: the layout covers only part, so it is flagged and not trusted', async () => {
  const a = join(dir, 'p-00001-of-00002.gguf')
  writeGguf(a, shard(['token_embd.weight', 'blk.0.w'], true))
  const f = await loadModelFacts(a)
  expect(f.sharded).toBe(true)
})

test('mergeLayouts sums every field and keeps holes at 0', () => {
  const m = mergeLayouts([
    { layerBytes: [1, 2], embedBytes: 3, outputBytes: 0, tiedOutput: true, otherBytes: 1, tensorBytes: 7 },
    { layerBytes: [0, 0, 5], embedBytes: 0, outputBytes: 4, tiedOutput: false, otherBytes: 0, tensorBytes: 9 },
  ])
  expect(m).toEqual({ layerBytes: [1, 2, 5], embedBytes: 3, outputBytes: 4, tiedOutput: false, otherBytes: 1, tensorBytes: 16 })
})
