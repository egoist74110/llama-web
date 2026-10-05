// Memory estimate. The "real" numbers below are what llama-server b11146 logged on an Apple M4 (`-v`: KV / RS / compute
// buffer sizes) for three real models, kept here as golden values: SmolLM2-135M (dense), Gemma 3 270M (sliding window)
// and Qwen3.5-2B (linear-attention hybrid with a vision projector). Models themselves are never in the repository.
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readGguf, tensorBytes, TENSOR_BLOCK, type GgufArch, type GgufLayout, type GgufMeta } from '../../server/core/gguf'
import {
  assignLayers, CACHE_BYTES, estimateMemory, kvCells, layerKinds, recurrentStateBytes, systemReserveMiB, tierOf, worstTier,
  type DeviceInput, type ModelFacts,
} from '../../server/core/memory-estimate'
import { modelSpec, writeGguf } from '../fixtures/gguf-builder'

const MiB = 1024 * 1024
let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lw-mem-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const noArch: GgufArch = {
  blockCount: null, embeddingLength: null, feedForwardLength: null, headCount: null, headCountKv: null, keyLength: null,
  valueLength: null, slidingWindow: null, slidingWindowPattern: null, fullAttentionInterval: null, ssm: null, expertCount: null, vocabSize: null,
}

function facts(arch: Partial<GgufArch>, o: { architecture?: string, layerBytes?: number[], embed?: number, output?: number, tied?: boolean, ctx?: number } = {}): ModelFacts {
  const a = { ...noArch, ...arch }
  const layers = o.layerBytes ?? Array.from({ length: a.blockCount ?? 0 }, () => 10 * MiB)
  const layout: GgufLayout = {
    layerBytes: layers, embedBytes: o.embed ?? 20 * MiB, outputBytes: o.output ?? 0, tiedOutput: o.tied ?? true, otherBytes: 0,
    tensorBytes: layers.reduce((n, b) => n + b, 0) + (o.embed ?? 20 * MiB) + (o.output ?? 0),
  }
  const meta = { version: 3, fileSize: layout.tensorBytes, architecture: o.architecture ?? 'llama', contextLength: o.ctx ?? 8192, arch: a } as GgufMeta
  return { meta, layout, totalBytes: layout.tensorBytes }
}

// Real models (hyper-parameters from the GGUF, per-layer bytes from the tensor infos; only totals matter here).
const SMOL: Partial<GgufArch> = { blockCount: 30, embeddingLength: 576, feedForwardLength: 1536, headCount: 9, headCountKv: 3, vocabSize: 49152 }
const GEMMA: Partial<GgufArch> = { blockCount: 18, embeddingLength: 640, feedForwardLength: 2048, headCount: 4, headCountKv: 1, keyLength: 256, valueLength: 256, slidingWindow: 512, vocabSize: 262144 }
const QWEN: Partial<GgufArch> = {
  blockCount: 24, embeddingLength: 2048, feedForwardLength: 6144, headCount: 8, headCountKv: 2, keyLength: 256, valueLength: 256,
  fullAttentionInterval: 4, ssm: { convKernel: 4, stateSize: 128, groupCount: 16, innerSize: 2048 }, vocabSize: 248320,
}
const smol = () => facts(SMOL, { embed: 30081024, layerBytes: Array.from({ length: 30 }, () => 3764736), architecture: 'llama' })
const gemma = () => facts(GEMMA, { embed: 178257920, layerBytes: Array.from({ length: 18 }, () => 3796000), architecture: 'gemma3' })
const qwen = () => facts(QWEN, { embed: 417177600, layerBytes: Array.from({ length: 24 }, () => 35528672), architecture: 'qwen35' })

const mac: DeviceInput = { id: 'MTL0', name: 'Apple M4', memory: 'shared', freeMiB: 12123 }
const sys = { totalMiB: 16384, availableMiB: 9000 }
const est = (f: ModelFacts, params: object = {}, extra: object = {}) => estimateMemory({ model: f, params, devices: [mac], system: sys, ...extra })

// ---- KV cache: exact against the logged buffers -------------------------------------------------------------------

test('dense model: KV = layers x cells x kv heads x head size x (K + V) bytes (SmolLM2 ctx 8192: 180 MiB)', () => {
  const e = est(smol(), { ctxSize: 8192, parallel: 1 })
  expect(e.pools[0]!.kvMiB).toBeCloseTo(180, 5)
  expect(e.kv).toMatchObject({ fullCells: 8192, slots: 1, unified: false })
})

test('K / V cache types: bytes per element match the logged sizes (q8_0 95.62, q4_0 50.62 MiB)', () => {
  expect(est(smol(), { ctxSize: 8192, parallel: 1, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' }).pools[0]!.kvMiB).toBeCloseTo(95.625, 2)
  expect(est(smol(), { ctxSize: 8192, parallel: 1, cacheTypeK: 'q4_0', cacheTypeV: 'q4_0' }).pools[0]!.kvMiB).toBeCloseTo(50.625, 2)
  expect(est(smol(), { ctxSize: 8192, parallel: 1, cacheTypeK: 'q8_0', cacheTypeV: 'f16' }).pools[0]!.kvMiB).toBeCloseTo((95.625 + 180) / 2, 2)
  expect(CACHE_BYTES.f32).toBe(4)
  expect(CACHE_BYTES.bf16).toBe(2)
  for (const t of ['q4_1', 'q5_0', 'q5_1', 'iq4_nl']) expect(CACHE_BYTES[t]).toBeGreaterThan(0.5)
})

test('--parallel: an explicit N splits the context per slot but keeps the total; automatic means 4 slots with one shared cache', () => {
  expect(est(smol(), { ctxSize: 8192, parallel: 4 }).pools[0]!.kvMiB).toBeCloseTo(180, 5)
  const auto = est(smol(), { ctxSize: 8192 })
  expect(auto.kv).toMatchObject({ slots: 4, unified: true, fullCells: 8192 })
  expect(auto.pools[0]!.kvMiB).toBeCloseTo(180, 5)
  expect(kvCells(8192, null, 4, false, 512, false)).toEqual({ full: 8192, swa: 8192 })
})

test('sliding-window layers: cells = window x slots + micro-batch rounded to 256; the window layers grow with the slots (Gemma)', () => {
  // Logged: ctx 8192 np1 -> 24 + 15 MiB; defaults (4 slots, unified) -> 24 + 37.5; np4 explicit -> 24 + 60; ub 2048 -> 24 + 37.5; ub 128 -> 24 + 11.25
  const kv = (p: object) => est(gemma(), { ctxSize: 8192, ...p }).pools[0]!.kvMiB
  expect(kv({ parallel: 1 })).toBeCloseTo(39, 5)
  expect(kv({})).toBeCloseTo(24 + 37.5, 5)
  expect(kv({ parallel: 4 })).toBeCloseTo(24 + 60, 5)
  expect(kv({ parallel: 1, ubatchSize: 2048 })).toBeCloseTo(24 + 37.5, 5)
  expect(kv({ parallel: 1, ubatchSize: 128 })).toBeCloseTo(24 + 11.25, 5)
  expect(kv({ parallel: 1, swaFull: true })).toBeCloseTo(24 + 120, 5)
  expect(kv({ parallel: 1, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' })).toBeCloseTo(12.75 + 7.97, 1)
  expect(kvCells(8192, 512, 1, true, 512, false)).toEqual({ full: 8192, swa: 1024 })
  expect(kvCells(512, 512, 1, true, 512, false)).toEqual({ full: 512, swa: 512 }) // never more than the context
})

test('hybrid linear-attention model: KV only for the full-attention layers, recurrent state per slot (Qwen3.5: 96 MiB + 19.27 / 77.06 MiB)', () => {
  const one = est(qwen(), { ctxSize: 8192, parallel: 1 }).pools[0]!
  expect(one.kvMiB).toBeCloseTo(96, 5)
  expect(one.stateMiB).toBeCloseTo(19.27, 1)
  expect(est(qwen(), { ctxSize: 8192 }).pools[0]!.stateMiB).toBeCloseTo(77.06, 1)
  expect(est(qwen(), { ctxSize: 8192, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' }).pools[0]!.kvMiB).toBeCloseTo(51, 5)
  const kinds = layerKinds({ ...noArch, ...QWEN }, 'qwen35')!.kinds
  expect(kinds.filter(k => k === 'full')).toHaveLength(6)
  expect(kinds.filter(k => k === 'recurrent')).toHaveLength(18)
  expect(recurrentStateBytes({ ...noArch, ...QWEN }) * 18 / MiB).toBeCloseTo(19.27, 1)
})

test('layer kinds: built-in window patterns, explicit pattern, per-layer arrays, unknown pattern is treated as full attention', () => {
  const g = layerKinds({ ...noArch, ...GEMMA }, 'gemma3')!
  expect(g.kinds.filter(k => k === 'swa')).toHaveLength(15)
  expect(g.kinds[5]).toBe('full')
  expect(layerKinds({ ...noArch, blockCount: 4, slidingWindow: 128, slidingWindowPattern: [1, 0, 1, 0] }, 'x')!.kinds).toEqual(['swa', 'full', 'swa', 'full'])
  const gpt = layerKinds({ ...noArch, blockCount: 4, slidingWindow: 128 }, 'gpt-oss')!
  expect(gpt.kinds).toEqual(['swa', 'full', 'swa', 'full'])
  const unknown = layerKinds({ ...noArch, blockCount: 4, slidingWindow: 128 }, 'brand-new')!
  expect(unknown.kinds.every(k => k === 'full')).toBe(true)
  expect(unknown.guessedWindow).toBe(true)
  // per-layer KV heads: 0 means no attention (a state-space layer of a hybrid)
  const hybrid = layerKinds({ ...noArch, blockCount: 3, headCountKv: [0, 4, 0], ssm: { convKernel: 4, stateSize: 16, groupCount: 1, innerSize: 64 } }, 'jamba')!
  expect(hybrid.kinds).toEqual(['recurrent', 'full', 'recurrent'])
  expect(layerKinds(noArch, 'llama')).toBeNull()
})

test('a pure state-space model has state but no KV', () => {
  const f = facts({ blockCount: 4, embeddingLength: 64, feedForwardLength: 0, ssm: { convKernel: 4, stateSize: 16, groupCount: 0, innerSize: 128 }, vocabSize: 100 })
  const p = est(f, { ctxSize: 4096, parallel: 1 }).pools[0]!
  expect(p.kvMiB).toBe(0)
  expect(p.stateMiB).toBeCloseTo(4 * ((3 * 128 + 16 * 128) * 4) / MiB, 6)
})

// ---- compute buffers ----------------------------------------------------------------------------------------------

test('compute buffer is never below the logged one and grows with the micro-batch and without flash attention', () => {
  const logged: Array<[ModelFacts, object, number]> = [
    [smol(), { ctxSize: 8192, parallel: 1 }, 30 + 0.2], [smol(), { ctxSize: 8192, parallel: 1, ubatchSize: 2048, batchSize: 2048 }, 118],
    [smol(), { ctxSize: 8192, parallel: 1, ubatchSize: 128 }, 14], [smol(), { ctxSize: 8192, parallel: 1, flashAttn: 'off' }, 182],
    [gemma(), { ctxSize: 8192, parallel: 1 }, 43], [gemma(), { ctxSize: 8192, parallel: 1, ubatchSize: 128 }, 21],
    [qwen(), { ctxSize: 8192, parallel: 1 }, 73], [qwen(), { ctxSize: 8192, parallel: 1, ubatchSize: 128 }, 36], [qwen(), { ctxSize: 8192, parallel: 1, ubatchSize: 2048, batchSize: 2048 }, 289],
  ]
  for (const [f, p, real] of logged) expect(est(f, p).pools[0]!.computeMiB).toBeGreaterThanOrEqual(real)
  const base = est(smol(), { ctxSize: 8192, parallel: 1 }).pools[0]!.computeMiB
  expect(est(smol(), { ctxSize: 8192, parallel: 1, ubatchSize: 2048, batchSize: 2048 }).pools[0]!.computeMiB).toBeGreaterThan(base * 2)
  expect(est(smol(), { ctxSize: 8192, parallel: 1, flashAttn: 'off' }).pools[0]!.computeMiB).toBeGreaterThan(base + 100)
  // the micro-batch cannot exceed the batch
  expect(est(smol(), { ctxSize: 8192, parallel: 1, ubatchSize: 4096, batchSize: 512 }).pools[0]!.computeMiB).toBeCloseTo(base, 6)
})

test('total against what llama-server logged for the three real models is never lower and at most 10% higher', () => {
  const real = (kv: number, rs: number, compute: number, tensors: number) => kv + rs + compute + tensors
  const cases: Array<[ModelFacts, object, number]> = [
    [smol(), { ctxSize: 8192, parallel: 1 }, real(180, 0, 19.92 + 10.26 + 0.19, 143025408 / MiB)],
    [gemma(), { ctxSize: 8192 }, real(24 + 37.5, 0, 32.18 + 13.02 + 4, 246587904 / MiB)],
    [qwen(), { ctxSize: 8192 }, real(96, 77.06, 56.3 + 16.02 + 3.79, 1269873920 / MiB)],
  ]
  for (const [f, p, logged] of cases) {
    const total = est(f, p).pools[0]!.totalMiB
    expect(total).toBeGreaterThanOrEqual(logged * 0.995)
    expect(total).toBeLessThanOrEqual(logged * 1.1)
  }
})

// ---- weights, devices, offload ------------------------------------------------------------------------------------

test('shared memory counts every tensor once; a device with its own memory also holds the tied output copy of the embedding', () => {
  const f = facts({ ...SMOL, blockCount: 4 }, { embed: 40 * MiB, layerBytes: [10 * MiB, 10 * MiB, 10 * MiB, 10 * MiB] })
  expect(est(f, { ctxSize: 256, parallel: 1 }).pools[0]!.weightsMiB).toBeCloseTo(80, 6)
  const card: DeviceInput = { id: 'CUDA0', name: 'Card', memory: 'separate', freeMiB: 8000 }
  const e = estimateMemory({ model: f, params: { ctxSize: 256, parallel: 1 }, devices: [card], system: sys })
  const dev = e.pools.find(p => p.id === 'CUDA0')!
  const host = e.pools.find(p => p.id === 'host')!
  expect(dev.weightsMiB).toBeCloseTo(40 + 40, 6) // four layers + the output copy of the embedding
  expect(host.weightsMiB).toBeCloseTo(40, 6) // the input embedding stays on the CPU
  expect(dev.fixedMiB).toBe(512)
})

test('an untied output projection is counted with the output layer, not the host', () => {
  const f = facts({ ...SMOL, blockCount: 2 }, { embed: 30 * MiB, output: 25 * MiB, tied: false, layerBytes: [10 * MiB, 10 * MiB] })
  const e = estimateMemory({ model: f, params: { ctxSize: 256, parallel: 1 }, devices: [{ id: 'C0', name: 'c', memory: 'separate', freeMiB: 9999 }], system: sys })
  expect(e.pools.find(p => p.id === 'C0')!.weightsMiB).toBeCloseTo(20 + 25, 6)
  expect(e.pools.find(p => p.id === 'host')!.weightsMiB).toBeCloseTo(30, 6)
})

test('partial offload: the first layers stay on the host with their KV; the device gets the rest', () => {
  expect(assignLayers(4, 3, [1])).toEqual([-1, 0, 0, -1].map((_, i) => (i >= 2 ? 0 : -1))) // 3 = 2 layers + the output layer
  expect(assignLayers(4, 999, [1])).toEqual([0, 0, 0, 0])
  expect(assignLayers(4, null, [1])).toEqual([0, 0, 0, 0])
  expect(assignLayers(4, 0, [1])).toEqual([-1, -1, -1, -1])
  expect(assignLayers(4, 1, [1])).toEqual([-1, -1, -1, -1]) // only the output layer
  expect(assignLayers(4, 5, [1])).toEqual([0, 0, 0, 0])
  const f = facts({ ...SMOL, blockCount: 4 }, { embed: 10 * MiB, layerBytes: [10 * MiB, 10 * MiB, 10 * MiB, 10 * MiB] })
  const card: DeviceInput = { id: 'C0', name: 'c', memory: 'separate', freeMiB: 9999, fixedMiB: 0 }
  const half = estimateMemory({ model: f, params: { ctxSize: 1024, parallel: 1, gpuLayers: 3 }, devices: [card], system: sys })
  const dev = half.pools.find(p => p.id === 'C0')!
  const host = half.pools.find(p => p.id === 'host')!
  expect(dev.weightsMiB).toBeCloseTo(20 + 10, 6)
  expect(host.weightsMiB).toBeCloseTo(20 + 10, 6)
  const perLayerKv = (1024 * 3 * 64 * 2 * 2) / MiB
  expect(dev.kvMiB).toBeCloseTo(perLayerKv * 2, 6)
  expect(host.kvMiB).toBeCloseTo(perLayerKv * 2, 6)
  // --no-kv-offload moves every KV to the host
  const nk = estimateMemory({ model: f, params: { ctxSize: 1024, parallel: 1, kvOnHost: true }, devices: [card], system: sys })
  expect(nk.pools.find(p => p.id === 'C0')!.kvMiB).toBe(0)
  expect(nk.pools.find(p => p.id === 'host')!.kvMiB).toBeCloseTo(perLayerKv * 4, 6)
})

test('several devices: layers follow the share, each device gets its own fixed overhead and compute buffer; a device without layers is left out', () => {
  const f = facts({ ...SMOL, blockCount: 8 }, { layerBytes: Array.from({ length: 8 }, () => 10 * MiB) })
  const a: DeviceInput = { id: 'C0', name: 'a', memory: 'separate', freeMiB: 20000, share: 3 }
  const b: DeviceInput = { id: 'C1', name: 'b', memory: 'separate', freeMiB: 20000, share: 1 }
  const e = estimateMemory({ model: f, params: { ctxSize: 512, parallel: 1 }, devices: [a, b], system: sys })
  const pa = e.pools.find(p => p.id === 'C0')!
  const pb = e.pools.find(p => p.id === 'C1')!
  expect(pa.kvMiB).toBeCloseTo(pb.kvMiB * 3, 6) // 6 layers against 2
  expect(pa.computeMiB).toBeGreaterThan(0)
  expect(pb.computeMiB).toBeGreaterThan(0)
  expect(e.notes).toContain('unverified-multi-device')
  const idle = estimateMemory({ model: f, params: { ctxSize: 512, parallel: 1, gpuLayers: 0 }, devices: [a, b], system: sys })
  expect(idle.pools.map(p => p.id)).toEqual(['host'])
})

test('sharded model: the first shard\'s numbers are scaled to the whole size', () => {
  const f = facts({ ...SMOL, blockCount: 2 }, { embed: 10 * MiB, layerBytes: [10 * MiB, 10 * MiB] })
  const sharded: ModelFacts = { ...f, sharded: true, totalBytes: f.totalBytes * 3 }
  expect(est(sharded, { ctxSize: 256, parallel: 1 }).pools[0]!.weightsMiB).toBeCloseTo(90, 6)
})

test('no tensor infos: weights come from the file size and the layout note is set', () => {
  const f = facts({ ...SMOL, blockCount: 10 })
  const e = est({ ...f, layout: null, totalBytes: 1000 * MiB }, { ctxSize: 256, parallel: 1 })
  expect(e.pools[0]!.weightsMiB).toBeCloseTo(1000, 6)
  expect(e.notes).toContain('layout-unknown')
})

test('mmproj and draft model are added with their own lines', () => {
  const base = est(smol(), { ctxSize: 8192, parallel: 1 }).pools[0]!
  const withMm = est(smol(), { ctxSize: 8192, parallel: 1 }, { mmprojBytes: 640 * MiB }).pools[0]!
  // measured on Qwen3.5-2B + its projector: 640 MiB of weights + 256 MiB image compute buffer
  expect(withMm.mmprojMiB).toBeCloseTo(640 + 256, 0)
  expect(withMm.totalMiB - base.totalMiB).toBeCloseTo(withMm.mmprojMiB, 6)
  expect(est(smol(), { ctxSize: 8192, parallel: 1 }, { mmprojBytes: 10 * MiB }).pools[0]!.mmprojMiB).toBeCloseTo(10 + 128, 6)
  const withDraft = est(smol(), { ctxSize: 8192, parallel: 1 }, { draft: { facts: gemma(), params: { ctxSize: 2048 } } }).pools[0]!
  expect(withDraft.draftMiB).toBeGreaterThan(200)
  expect(withDraft.weightsMiB).toBeCloseTo(base.weightsMiB, 6)
  expect(withDraft.kvMiB).toBeCloseTo(base.kvMiB, 6)
})

test('context from the model when unset; missing architecture fields are reported, not guessed', () => {
  const e = est(smol(), {})
  expect(e.notes).toContain('ctx-from-model')
  expect(e.kv.ctx).toBe(8192)
  const bare = est(facts({}, { layerBytes: [10 * MiB] }), { ctxSize: 4096, parallel: 1 })
  expect(bare.notes).toContain('arch-incomplete')
  expect(bare.pools[0]!.kvMiB).toBe(0)
})

// ---- tiers, system memory, no GPU wording ------------------------------------------------------------------------

test('tiers: up to 85% of the budget is ok, up to 100% risky, above that does not fit; no budget is unknown', () => {
  expect(tierOf(85, 100).tier).toBe('ok')
  expect(tierOf(85.01, 100).tier).toBe('risky')
  expect(tierOf(100, 100).tier).toBe('risky')
  expect(tierOf(100.01, 100).tier).toBe('nofit')
  expect(tierOf(1, 0).tier).toBe('nofit')
  expect(tierOf(1, null)).toEqual({ ratio: null, tier: 'unknown' })
  expect(worstTier(['ok', 'unknown', 'risky'])).toBe('risky')
  expect(worstTier(['ok', 'unknown'])).toBe('unknown')
  expect(worstTier(['risky', 'nofit', 'unknown'])).toBe('nofit')
  expect(worstTier([])).toBe('ok')
})

test('the shared pool is limited by the device cap and by the system memory minus its reserve', () => {
  expect(systemReserveMiB(16384)).toBeCloseTo(2457.6, 6)
  expect(systemReserveMiB(8192)).toBe(2048)
  const f = smol()
  const total = est(f, { ctxSize: 8192, parallel: 1 }).pools[0]!.totalMiB
  // plenty of device memory, little RAM: the RAM side decides
  const tight = estimateMemory({ model: f, params: { ctxSize: 8192, parallel: 1 }, devices: [{ ...mac, freeMiB: 12000 }], system: { totalMiB: 16384, availableMiB: 2457.6 + total / 0.9 } })
  expect(tight.pools[0]!.budgetMiB).toBeCloseTo(total / 0.9, 3)
  expect(tight.tier).toBe('risky')
  const small = estimateMemory({ model: f, params: { ctxSize: 8192, parallel: 1 }, devices: [{ ...mac, freeMiB: total - 1 }], system: sys })
  expect(small.tier).toBe('nofit')
  const roomy = estimateMemory({ model: f, params: { ctxSize: 8192, parallel: 1 }, devices: [mac], system: { totalMiB: 16384, availableMiB: 10000 } })
  expect(roomy.tier).toBe('ok')
})

test('unknown free memory is unknown, never "fits" (decision 44)', () => {
  const a = estimateMemory({ model: smol(), params: { ctxSize: 8192, parallel: 1 }, devices: [{ ...mac, freeMiB: null }], system: sys })
  expect(a.tier).toBe('unknown')
  const b = estimateMemory({ model: smol(), params: { ctxSize: 8192, parallel: 1 }, devices: [mac], system: { totalMiB: 16384, availableMiB: null } })
  expect(b.tier).toBe('unknown')
  expect(b.notes).toContain('budget-unknown')
  const c = estimateMemory({ model: smol(), params: { ctxSize: 8192, parallel: 1 }, devices: [], system: { totalMiB: null, availableMiB: null } })
  expect(c.tier).toBe('unknown')
})

test('CPU only: one host pool with everything; a tight system makes it not fit', () => {
  const f = smol()
  const e = estimateMemory({ model: f, params: { ctxSize: 8192, parallel: 1 }, devices: [], system: sys })
  expect(e.pools).toHaveLength(1)
  expect(e.pools[0]).toMatchObject({ id: 'host', kind: 'host' })
  expect(e.pools[0]!.weightsMiB).toBeCloseTo(143023104 / MiB, 3)
  expect(e.pools[0]!.kvMiB).toBeCloseTo(180, 5)
  const low = estimateMemory({ model: f, params: { ctxSize: 8192, parallel: 1 }, devices: [], system: { totalMiB: 16384, availableMiB: 2600 } })
  expect(low.tier).toBe('nofit')
})

test('mlock: the locked weights are reported (CPU layers on a device with its own memory, everything on shared memory)', () => {
  const f = smol()
  expect(est(f, { ctxSize: 256, parallel: 1 }).mlockMiB).toBe(0)
  const shared = est(f, { ctxSize: 256, parallel: 1, mlock: true })
  expect(shared.mlockMiB).toBeCloseTo(143023104 / MiB, 3)
  const card: DeviceInput = { id: 'C0', name: 'c', memory: 'separate', freeMiB: 9999 }
  const dev = estimateMemory({ model: f, params: { ctxSize: 256, parallel: 1, mlock: true }, devices: [card], system: sys })
  expect(dev.mlockMiB).toBeCloseTo(30081024 / MiB, 3) // only the embedding stays in RAM
})

test('the result structure never carries a GPU wording (decision 38)', () => {
  for (const devices of [[mac], []]) {
    const e = estimateMemory({ model: qwen(), params: { ctxSize: 8192 }, devices, system: sys, mmprojBytes: 640 * MiB })
    expect(JSON.stringify(e)).not.toMatch(/gpu|vram|cuda|nvidia/i)
  }
})

// ---- GGUF reading feeds the estimate ------------------------------------------------------------------------------

test('tensor byte sizes of every quantisation type', () => {
  expect(tensorBytes(0, 100)).toBe(400)
  expect(tensorBytes(1, 100)).toBe(200)
  expect(tensorBytes(8, 64)).toBe(68) // Q8_0: 34 bytes per 32
  expect(tensorBytes(2, 64)).toBe(36) // Q4_0
  expect(tensorBytes(12, 512)).toBe(288) // Q4_K: 144 per 256
  expect(tensorBytes(14, 256)).toBe(210) // Q6_K
  expect(tensorBytes(39, 32)).toBe(17) // MXFP4
  expect(tensorBytes(30, 10)).toBe(20) // BF16
  expect(tensorBytes(999, 10)).toBe(20) // unknown type: 2 bytes per element, on the safe side
  for (const [type, [blck, size]] of Object.entries(TENSOR_BLOCK)) expect(tensorBytes(Number(type), blck) ).toBe(size)
})

test('reads hyper-parameters, vocabulary size and per-layer bytes from a file', async () => {
  const f = join(dir, 'm.gguf')
  writeGguf(f, {
    kvs: [
      ['general.architecture', { t: 'str', v: 'qwen35' }],
      ['qwen35.block_count', { t: 'u32', v: 2 }],
      ['qwen35.embedding_length', { t: 'u32', v: 64 }],
      ['qwen35.feed_forward_length', { t: 'u32', v: 128 }],
      ['qwen35.attention.head_count', { t: 'u32', v: 4 }],
      ['qwen35.attention.head_count_kv', { t: 'u32arr', v: [0, 2] }],
      ['qwen35.attention.key_length', { t: 'u32', v: 16 }],
      ['qwen35.attention.sliding_window', { t: 'u32', v: 32 }],
      ['qwen35.full_attention_interval', { t: 'u32', v: 2 }],
      ['qwen35.ssm.state_size', { t: 'u32', v: 8 }],
      ['qwen35.ssm.conv_kernel', { t: 'u32', v: 4 }],
      ['qwen35.ssm.inner_size', { t: 'u32', v: 32 }],
      ['qwen35.context_length', { t: 'u32', v: 4096 }],
      ['tokenizer.ggml.tokens', { t: 'strarr', v: ['a', 'b', 'c', 'd', 'e'] }],
    ],
    tensors: [
      { name: 'token_embd.weight', dims: [64, 5], type: 8 },
      { name: 'blk.0.attn_q.weight', dims: [64, 64], type: 12 },
      { name: 'blk.0.ffn_down.weight', dims: [128, 64], type: 14 },
      { name: 'blk.1.attn_q.weight', dims: [64, 64], type: 0 },
      { name: 'output_norm.weight', dims: [64], type: 0 },
    ],
  })
  const { meta, layout } = await readGguf(f)
  expect(meta.arch).toMatchObject({
    blockCount: 2, embeddingLength: 64, feedForwardLength: 128, headCount: 4, headCountKv: [0, 2], keyLength: 16, slidingWindow: 32,
    fullAttentionInterval: 2, vocabSize: 5, ssm: { stateSize: 8, convKernel: 4, innerSize: 32, groupCount: null },
  })
  expect(meta.contextLength).toBe(4096)
  expect(layout.layerBytes).toEqual([tensorBytes(12, 4096) + tensorBytes(14, 8192), tensorBytes(0, 4096)])
  expect(layout.embedBytes).toBe(tensorBytes(8, 320))
  expect(layout.outputBytes).toBe(tensorBytes(0, 64))
  expect(layout.tiedOutput).toBe(true)
  expect(layout.tensorBytes).toBe(layout.layerBytes[0]! + layout.layerBytes[1]! + layout.embedBytes + layout.outputBytes)
})

test('an older / smaller file still reads: every hyper-parameter is null, the old fields are unchanged', async () => {
  const f = join(dir, 'old.gguf')
  writeGguf(f, modelSpec({ arch: 'llama', ctx: 2048 }))
  const { meta, layout } = await readGguf(f)
  expect(meta.contextLength).toBe(2048)
  expect(meta.arch.blockCount).toBeNull()
  expect(meta.arch.headCountKv).toBeNull()
  expect(meta.arch.vocabSize).toBe(3)
  expect(layout.layerBytes).toEqual([])
  expect(layout.tiedOutput).toBe(true)
})

test('a file read from disk goes through the whole estimate', async () => {
  const f = join(dir, 'dense.gguf')
  writeGguf(f, {
    kvs: [
      ['general.architecture', { t: 'str', v: 'llama' }],
      ['llama.block_count', { t: 'u32', v: 4 }],
      ['llama.embedding_length', { t: 'u32', v: 64 }],
      ['llama.feed_forward_length', { t: 'u32', v: 128 }],
      ['llama.attention.head_count', { t: 'u32', v: 4 }],
      ['llama.attention.head_count_kv', { t: 'u32', v: 2 }],
      ['tokenizer.ggml.tokens', { t: 'strarr', v: ['a', 'b'] }],
    ],
    tensors: [{ name: 'token_embd.weight', dims: [64, 2], type: 1 }, ...[0, 1, 2, 3].map(i => ({ name: `blk.${i}.ffn_up.weight`, dims: [64, 128], type: 1 }))],
  })
  const { meta, layout } = await readGguf(f)
  const e = estimateMemory({ model: { meta, layout, totalBytes: meta.fileSize }, params: { ctxSize: 1024, parallel: 1 }, devices: [mac], system: sys })
  // KV: 4 layers x 1024 cells x 2 heads x 16 (= 64 / 4) x (2 + 2) bytes
  expect(e.pools[0]!.kvMiB).toBeCloseTo((4 * 1024 * 2 * 16 * 4) / MiB, 8)
  expect(e.pools[0]!.weightsMiB).toBeCloseTo((4 * 64 * 128 * 2 + 64 * 2 * 2) / MiB, 8)
})
