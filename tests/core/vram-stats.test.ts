import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { estimateMemory, type ModelFacts } from '../../server/core/memory-estimate'
import { loadDelta, preferMeasured, statsKey, VramStats } from '../../server/core/vram-stats'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lw-stats-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

const key = statsKey(['model-a', 'profile-1', 'MTL0', 'ctx=8192'])

test('the key is an opaque hash of the parts; same parts, same key', () => {
  expect(key).toMatch(/^[0-9a-f]{16}$/)
  expect(statsKey(['model-a', 'profile-1', 'MTL0', 'ctx=8192'])).toBe(key)
  expect(statsKey(['model-a', 'profile-1', 'MTL0', 'ctx=4096'])).not.toBe(key)
  expect(key).not.toContain('model')
})

test('load delta: used memory after minus before; no growth or a missing reading is no measurement', () => {
  expect(loadDelta([1000, 500, null, 10], [2500, 500, 3, null])).toEqual([1500, null, null, null])
  expect(loadDelta([1000], [900])).toEqual([null])
})

test('records numbers only, atomically, with a version, and reads them back', () => {
  const s = new VramStats(dir, () => 1_700_000_000_000)
  const r = s.record(key, { estimateMiB: [1000], measuredMiB: [1100], exclusive: true })
  expect(r).toMatchObject({ recorded: true, significant: false })
  expect(r.deviation).toBeCloseTo(0.1, 6)
  const raw = readFileSync(join(dir, 'vram-stats.json'), 'utf8')
  expect(JSON.parse(raw)).toEqual({ version: 1, entries: { [key]: { at: 1_700_000_000_000, estimateMiB: [1000], measuredMiB: [1100] } } })
  expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([])
  expect(new VramStats(dir).lookup(key)).toEqual({ at: 1_700_000_000_000, estimateMiB: [1000], measuredMiB: [1100] })
  expect(raw).not.toMatch(/[A-Za-z]:\\|\/Users|\.gguf/)
})

test('records one measurement per pool (one per device) and keeps the estimate for a pool that was not measured', () => {
  const s = new VramStats(dir)
  const r = s.record(key, { estimateMiB: [4000, 3000, 500], measuredMiB: [4600, null, 520], exclusive: true })
  expect(r.recorded).toBe(true)
  expect(s.lookup(key)!.measuredMiB).toEqual([4600, 3000, 520])
  expect(r.deviation).toBeCloseTo(0.15, 6)
  expect(r.significant).toBe(true)
})

test('not recorded while another load ran at the same time, without any measurement, or with misaligned data', () => {
  const s = new VramStats(dir)
  expect(s.record(key, { estimateMiB: [1000], measuredMiB: [1200], exclusive: false })).toMatchObject({ recorded: false, reason: 'concurrent-load' })
  expect(s.record(key, { estimateMiB: [1000], measuredMiB: [null], exclusive: true })).toMatchObject({ recorded: false, reason: 'no-measurement' })
  expect(s.record(key, { estimateMiB: [1000, 1], measuredMiB: [1], exclusive: true })).toMatchObject({ recorded: false, reason: 'invalid' })
  expect(s.record('/path/to/model.gguf', { estimateMiB: [1], measuredMiB: [1], exclusive: true })).toMatchObject({ recorded: false, reason: 'invalid' })
  expect(existsSync(join(dir, 'vram-stats.json'))).toBe(false)
  expect(s.size).toBe(0)
})

test('significant: estimate more than 10% too low or more than twice too high', () => {
  const s = new VramStats(dir)
  const dev = (est: number, real: number) => s.record(key, { estimateMiB: [est], measuredMiB: [real], exclusive: true })
  expect(dev(1000, 1090).significant).toBe(false)
  expect(dev(1000, 1110).significant).toBe(true)
  expect(dev(1000, 600).significant).toBe(false) // too high, but only by 1.7x
  expect(dev(1000, 400).significant).toBe(true)
})

test('a damaged file starts empty; bad entries are dropped; a newer version is never overwritten', () => {
  const f = join(dir, 'vram-stats.json')
  writeFileSync(f, '{not json')
  expect(new VramStats(dir).size).toBe(0)
  writeFileSync(f, JSON.stringify({ version: 1, entries: { [key]: { at: 1, estimateMiB: [1], measuredMiB: [2] }, bad: { at: 1 }, [statsKey(['x'])]: { at: 1, estimateMiB: [1, 2], measuredMiB: [1] } } }))
  const s = new VramStats(dir)
  expect(s.size).toBe(1)
  const future = JSON.stringify({ version: 99, entries: { anything: true } })
  writeFileSync(f, future)
  const n = new VramStats(dir)
  expect(n.record(key, { estimateMiB: [1], measuredMiB: [2], exclusive: true }).recorded).toBe(true)
  expect(n.lookup(key)).not.toBeNull() // kept in memory
  expect(readFileSync(f, 'utf8')).toBe(future) // the file of the newer version stays as it was
})

test('the file stays small: the oldest entries go first', () => {
  let t = 0
  const s = new VramStats(dir, () => ++t)
  for (let i = 0; i < 510; i++) s.record(statsKey([i]), { estimateMiB: [1], measuredMiB: [2], exclusive: true })
  expect(s.size).toBe(500)
  expect(s.lookup(statsKey([0]))).toBeNull()
  expect(s.lookup(statsKey([509]))).not.toBeNull()
})

const MiB = 1024 * 1024
const facts: ModelFacts = {
  meta: {
    version: 3, fileSize: 1000 * MiB, architecture: 'llama', contextLength: 4096,
    arch: { blockCount: 10, embeddingLength: 64, feedForwardLength: 128, headCount: 4, headCountKv: 2, keyLength: null, valueLength: null, slidingWindow: null, slidingWindowPattern: null, fullAttentionInterval: null, ssm: null, expertCount: null, vocabSize: 100 },
  } as ModelFacts['meta'],
  layout: { layerBytes: Array.from({ length: 10 }, () => 90 * MiB), embedBytes: 100 * MiB, outputBytes: 0, tiedOutput: true, otherBytes: 0, tensorBytes: 1000 * MiB },
  totalBytes: 1000 * MiB,
}
const estimate = (freeMiB: number) => estimateMemory({ model: facts, params: { ctxSize: 4096, parallel: 1 }, devices: [{ id: 'MTL0', name: 'M', memory: 'shared', freeMiB }], system: { totalMiB: 16384, availableMiB: 12000 } })

test('the estimate prefers the measurement of an identical launch, but never goes below the exactly known parts', () => {
  const e = estimate(2000)
  const p = e.pools[0]!
  const exact = p.weightsMiB + p.kvMiB + p.stateMiB
  // measured higher than the formula: it wins, and the tier follows (1900 of 2000 is above 85%)
  const higher = preferMeasured(e, { at: 1, estimateMiB: [p.totalMiB], measuredMiB: [1900] })
  expect(higher.basis).toBe('measured')
  expect(higher.pools[0]!.totalMiB).toBe(1900)
  expect(higher.pools[0]!.ratio).toBeCloseTo(0.95, 6)
  expect(higher.tier).toBe('risky')
  expect(higher.total.totalMiB).toBe(1900)
  // a low (noisy) reading cannot go below what is known exactly
  const low = preferMeasured(e, { at: 1, estimateMiB: [p.totalMiB], measuredMiB: [10] })
  expect(low.pools[0]!.totalMiB).toBeCloseTo(exact, 6)
  // a measurement that does not fit this launch's pools (different device set) is ignored
  const other = preferMeasured(e, { at: 1, estimateMiB: [1, 2], measuredMiB: [1, 2] })
  expect(other.basis).toBe('formula')
  expect(other.pools[0]!.totalMiB).toBe(p.totalMiB)
  expect(preferMeasured(e, null).basis).toBe('formula')
  // the measured number makes a launch that the formula called fine "does not fit" when the device is smaller
  expect(preferMeasured(estimate(1500), { at: 1, estimateMiB: [p.totalMiB], measuredMiB: [1600] }).tier).toBe('nofit')
})

test('a measurement does not turn an unknown current budget into ok', () => {
  // shared memory whose device limit could not be read: the formula tier is unknown
  const e = estimateMemory({ model: facts, params: { ctxSize: 4096, parallel: 1 }, devices: [{ id: 'MTL0', name: 'M', memory: 'shared', freeMiB: null }], system: { totalMiB: 16384, availableMiB: 12000 } })
  expect(e.tier).toBe('unknown')
  const p = e.pools[0]!
  const m = preferMeasured(e, { at: 1, estimateMiB: [p.totalMiB], measuredMiB: [p.totalMiB] })
  expect(m.basis).toBe('measured')
  expect(m.tier).toBe('unknown')
  // a measurement that exceeds what is known of the budget is still a definite "does not fit"
  const big = preferMeasured(e, { at: 1, estimateMiB: [p.totalMiB], measuredMiB: [1e6] })
  expect(big.tier).toBe('nofit')
})
