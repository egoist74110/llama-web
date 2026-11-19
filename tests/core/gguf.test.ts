import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { GgufError, readGguf, readGgufMeta, tensorBytes } from '../../server/core/gguf'
import { buildGguf, modelSpec, mmprojSpec, writeGguf } from '../fixtures/gguf-builder'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lw-gguf-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

test('reads architecture, quantization, context, template, declared params', async () => {
  const f = join(dir, 'm.gguf')
  writeGguf(f, modelSpec({ arch: 'qwen3', name: 'Demo', fileType: 15, ctx: 40960, template: true, params: 27_000_000_000 }))
  const m = await readGgufMeta(f)
  expect(m.version).toBe(3)
  expect(m.architecture).toBe('qwen3')
  expect(m.name).toBe('Demo')
  expect(m.quantization).toBe('Q4_K_M')
  expect(m.contextLength).toBe(40960)
  expect(m.hasChatTemplate).toBe(true)
  expect(m.parameterCount).toBe(27_000_000_000)
  expect(m.parameterCountFromTensors).toBe(false)
  expect(m.tensorCount).toBe(2)
})

test('sums tensor elements when parameter_count is absent; no template flag', async () => {
  const f = join(dir, 'm.gguf')
  writeGguf(f, modelSpec({ params: null }))
  const m = await readGgufMeta(f)
  expect(m.parameterCount).toBe(4 * 8 + 16)
  expect(m.parameterCountFromTensors).toBe(true)
  expect(m.hasChatTemplate).toBe(false)
})

test('falls back to the dominant tensor type when file_type is missing', async () => {
  const f = join(dir, 'm.gguf')
  writeGguf(f, {
    kvs: [['general.architecture', { t: 'str', v: 'llama' }]],
    tensors: [{ dims: [1000], type: 12 }, { dims: [10], type: 0 }],
  })
  expect((await readGgufMeta(f)).quantization).toBe('Q4_K')
})

test.each([
  [39, 40, 'NVFP4', 64, 36],
  [40, 41, 'Q1_0', 128, 18],
  [41, 42, 'Q2_0', 64, 18],
  [42, 43, 'F8_E4M3', 1, 1],
] as const)('file type %i and tensor type %i report %s', async (fileType, type, name, block, bytes) => {
  const f = join(dir, 'new-type.gguf')
  expect(tensorBytes(type, block + 1)).toBe(2 * bytes)
  writeGguf(f, modelSpec({ fileType }))
  expect((await readGgufMeta(f)).quantization).toBe(name)
  writeGguf(f, { tensors: [{ dims: [block], type }] })
  const { meta, layout } = await readGguf(f)
  expect(meta.quantization).toBe(name)
  expect(layout.tensorBytes).toBe(bytes)
})

test('expert tensors are also counted in layer totals and shared experts stay in the layer', async () => {
  const f = join(dir, 'experts.gguf')
  writeGguf(f, { tensors: [
    { name: 'blk.0.ffn_gate_exps.weight', dims: [64], type: 40 },
    { name: 'blk.2.ffn_up_exps.weight', dims: [1], type: 0 },
    { name: 'blk.2.ffn_down_exps.scales', dims: [1], type: 0 },
    { name: 'blk.2.ffn_gate_up_exps.weight', dims: [1], type: 0 },
    { name: 'blk.2.ffn_down_shexp.weight', dims: [2], type: 0 },
  ] })
  const { layout } = await readGguf(f)
  expect(layout.layerBytes).toEqual([36, 0, 20])
  expect(layout.layerExpertBytes).toEqual([36, 0, 12])
})

test('skips large arrays and reads keys that follow them', async () => {
  const f = join(dir, 'm.gguf')
  const tokens = Array.from({ length: 20000 }, (_, i) => `token-${i}`)
  writeGguf(f, {
    kvs: [
      ['tokenizer.ggml.tokens', { t: 'strarr', v: tokens }],
      ['tokenizer.ggml.scores', { t: 'u32arr', v: tokens.map((_, i) => i) }],
      ['general.architecture', { t: 'str', v: 'llama' }],
      ['llama.context_length', { t: 'u32', v: 4096 }],
    ],
  })
  const m = await readGgufMeta(f)
  expect(m.architecture).toBe('llama')
  expect(m.contextLength).toBe(4096)
})

test('identifies mmproj files and split info', async () => {
  const f = join(dir, 'p.gguf')
  writeGguf(f, mmprojSpec())
  const m = await readGgufMeta(f)
  expect(m.architecture).toBe('clip')
  expect(m.type).toBe('mmproj')

  const s = join(dir, 's.gguf')
  writeGguf(s, {
    kvs: [
      ['general.architecture', { t: 'str', v: 'llama' }],
      ['split.no', { t: 'u32', v: 0 }],
      ['split.count', { t: 'u32', v: 3 }],
    ],
  })
  const sm = await readGgufMeta(s)
  expect(sm.splitNo).toBe(0)
  expect(sm.splitCount).toBe(3)
})

async function code(file: string) {
  try { await readGgufMeta(file) } catch (e) { return (e as GgufError).code }
  return null
}

test('rejects bad magic, unsupported versions and truncated files', async () => {
  const bad = join(dir, 'bad.gguf')
  writeFileSync(bad, Buffer.from('NOPE'.repeat(16)))
  expect(await code(bad)).toBe('not-gguf')

  const v1 = join(dir, 'v1.gguf')
  writeFileSync(v1, buildGguf({ version: 1 }))
  expect(await code(v1)).toBe('unsupported')

  const full = buildGguf(modelSpec())
  const cut = join(dir, 'cut.gguf')
  writeFileSync(cut, full.subarray(0, full.length - 20))
  expect(await code(cut)).toBe('truncated')

  const tiny = join(dir, 'tiny.gguf')
  writeFileSync(tiny, Buffer.from('GG'))
  expect(await code(tiny)).toBe('not-gguf')
})

test('rejects implausible counts without hanging', async () => {
  const b = buildGguf(modelSpec())
  b.writeBigUInt64LE(9_000_000_000n, 8) // tensor count
  const f = join(dir, 'huge.gguf')
  writeFileSync(f, b)
  expect(await code(f)).toBe('corrupt')
})
