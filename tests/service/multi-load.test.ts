// Several models online, wired to the real context (decisions 41-44): the manual-start answer (limit / does not fit /
// needs confirmation), the check the scheduler makes before a load, a measured record replacing the formula, and
// `mlock` being dropped when it would lock more than is free. The device list and the system memory are stubbed; the
// model file is a constructed header, no llama-server runs (a refused load never gets as far as starting one).
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultSettings } from '../../server/core/config'
import { DeviceProbe, type DeviceList } from '../../server/core/devices'
import { SchedulerError, type NoRoomDetail } from '../../server/core/scheduler'
import { writeGguf, type FakeGguf, type KvValue } from '../fixtures/gguf-builder'

const win = process.platform === 'win32'
const gpuId = win ? 'CUDA0' : 'MTL0'
let dir = ''
let ctx: ReturnType<typeof import('../../server/service/context').getContext> | undefined
let adm: typeof import('../../server/service/admission') | undefined
let svc: typeof import('../../server/service/model-check') | undefined
const realList = DeviceProbe.prototype.list
let devices: DeviceList = { source: 'list-devices', gpus: [{ id: gpuId, name: 'Fake card', totalMiB: 24000, freeMiB: 22000 }] }

const u32 = (v: number): KvValue => ({ t: 'u32', v })
function spec(): FakeGguf {
  return {
    kvs: [
      ['general.architecture', { t: 'str', v: 'llama' }], ['general.file_type', u32(15)], ['llama.context_length', u32(8192)],
      ['llama.block_count', u32(8)], ['llama.embedding_length', u32(256)], ['llama.feed_forward_length', u32(512)],
      ['llama.attention.head_count', u32(4)], ['llama.attention.head_count_kv', u32(2)], ['tokenizer.ggml.tokens', { t: 'strarr', v: ['a', 'b'] }],
    ],
    tensors: [{ dims: [256, 1024], type: 12, name: 'token_embd.weight' }, ...Array.from({ length: 8 }, (_, i) => ({ dims: [256, 256], type: 12, name: `blk.${i}.attn_q.weight` }))],
  }
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lw-multi-'))
  const models = join(dir, 'models')
  writeGguf(join(models, 'm.gguf'), spec())
  const s = defaultSettings()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    ...s, llamacpp: { ...s.llamacpp, autoUpdate: false },
    modelDirs: [{ id: 'd', path: models, enabled: true, maxDepth: 0 }],
  }))
  const profiles = { 默认: { overrides: {}, extraArgs: '' }, 锁定: { overrides: {}, extraArgs: '--load-mode mlock' } }
  const entry = { backend: 'llama-server', file: { dirId: 'd', rel: 'm.gguf' }, mmproj: null, draft: null, activeProfile: '默认', profiles }
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ version: 1, models: [{ id: 'm', name: 'M', ...entry }, { id: 'n', name: 'N', ...entry }] }))
  process.env.LLAMA_WEB_DATA = dir
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('llama-web.context')]
  DeviceProbe.prototype.list = async () => devices
  const { getContext } = await import('../../server/service/context')
  ctx = getContext()
  adm = await import('../../server/service/admission')
  svc = await import('../../server/service/model-check')
  ctx.getMemoryProbe = async (_r, _o) => ({ list: devices, fallbackGpus: [], system: { totalMiB: 64000, availableMiB: 60000 } })
})
afterAll(async () => {
  DeviceProbe.prototype.list = realList
  await ctx?.shutdown()
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('llama-web.context')] // the next test file makes its own
  delete process.env.LLAMA_WEB_DATA
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const M = { modelId: 'm', profile: '默认' }
const N = { modelId: 'n', profile: '默认' }
const multi = (on: boolean, extra: Partial<{ maxLoaded: number, onNoRoom: 'unload' | 'error' }> = {}) =>
  ctx!.updateSettings((s) => { s.scheduler.multiLoad = on; Object.assign(s.scheduler, extra) })
const freeOf = (miB: number) => { devices = { source: 'list-devices', gpus: [{ id: gpuId, name: 'Fake card', totalMiB: 24000, freeMiB: miB }] } }
const code = async (p: Promise<unknown>) => (await p.then(() => null, e => e) as { reason?: string, data?: Record<string, unknown> } | null)
const model = (id = 'm') => ctx!.getModels().models.find(m => m.id === id)!

test('with the switch off a manual start is never held back', async () => {
  multi(false)
  freeOf(1)
  expect(await code(adm!.precheckStart(M, false))).toBeNull()
})

test('does not fit: 409 nofit, even with confirm (there is no forced start)', async () => {
  multi(true)
  freeOf(1)
  const e = await code(adm!.precheckStart(M, true))
  expect(e?.reason).toBe('nofit')
  expect(e?.data).toMatchObject({ tier: 'nofit', pool: win ? 'CUDA0' : 'system' })
})

test('risky needs confirm: 409 without it, passes with it', async () => {
  multi(true)
  freeOf(22000)
  const c = await svc!.checkProfile(model(), '默认')
  const mem = c.estimate!.pools[0]!.totalMiB
  freeOf(Math.ceil(mem * 1.05)) // 95% of what is free: risky
  const e = await code(adm!.precheckStart(M, false))
  expect(e?.reason).toBe('risky')
  expect(await code(adm!.precheckStart(M, true))).toBeNull()
})

test('fits: no answer needed', async () => {
  multi(true)
  freeOf(22000)
  expect(await code(adm!.precheckStart(M, false))).toBeNull()
})

test('the online limit: 409 limit while the limit is reached by other models; the model itself being online is fine', async () => {
  multi(true, { maxLoaded: 1 })
  freeOf(22000)
  const real = ctx!.scheduler.snapshot
  ctx!.scheduler.snapshot = () => ({ models: [{ modelId: 'n', profile: '默认', state: 'ready', port: 7100, inflight: 0, lastUsedAt: null, error: null }], queue: [] })
  try {
    expect((await code(adm!.precheckStart(M, true)))?.reason).toBe('limit')
    expect(await code(adm!.precheckStart(N, false))).toBeNull() // already online: nothing to start
  } finally {
    ctx!.scheduler.snapshot = real
    multi(true, { maxLoaded: 4 })
  }
})

test('the scheduler checks before it loads: a refused request starts nothing, the answer carries the numbers', async () => {
  multi(true, { onNoRoom: 'error' })
  freeOf(1)
  const e = await ctx!.scheduler.acquire(M).catch(x => x)
  expect(e).toBeInstanceOf(SchedulerError)
  expect((e as SchedulerError).code).toBe('no-room')
  const d = (e as SchedulerError).cause as NoRoomDetail
  expect(d.reason).toBe('memory')
  expect(d.estimateMiB).toBeGreaterThan(0)
  expect(d.availableMiB).not.toBeNull()
  expect(ctx!.runner.list()).toEqual([])
  expect(ctx!.scheduler.stateOf(M)).toBe('stopped')
})

test('with the switch off the same request goes on to start a process (here: no runtime installed, not a memory refusal)', async () => {
  multi(false)
  freeOf(1)
  const e = await ctx!.scheduler.acquire(M).catch(x => x)
  expect((e as SchedulerError).code).not.toBe('no-room')
})

test('admitTarget: tier, pools and the opaque launch data (measurement key, no mlock change)', async () => {
  multi(true)
  freeOf(22000)
  const a = await adm!.admitTarget(M, [])
  expect(a.tier).toBe('ok')
  expect(a.pools).toContain(win ? 'CUDA0' : 'system')
  expect(a.data).toMatchObject({ dropMlock: false, basis: 'formula' })
  expect((a.data as { statsKey: string }).statsKey).toMatch(/^[0-9a-f]{16}$/)
})

test('a measured record replaces the formula for the same launch shape', async () => {
  freeOf(22000)
  const c = await svc!.checkProfile(model(), '默认')
  expect(c.basis).toBe('formula')
  const est = c.estimate!.pools.map(p => p.totalMiB)
  const big = est.map(n => n + 5000)
  const r = ctx!.vramStats.record(c.statsKey, { estimateMiB: est, measuredMiB: big, exclusive: true })
  expect(r.recorded).toBe(true)
  const again = await svc!.checkProfile(model(), '默认')
  expect(again.basis).toBe('measured')
  expect(again.estimate!.total.totalMiB).toBeGreaterThan(c.estimate!.total.totalMiB + 4000)
  // another profile (another key) is not affected
  expect((await svc!.checkProfile(model(), '锁定')).basis).toBe('formula')
})

test('a measurement does not outlive the model file it was taken for (CR-020)', async () => {
  multi(true)
  freeOf(22000)
  const c = await svc!.checkProfile(model(), '默认')
  ctx!.vramStats.record(c.statsKey, { estimateMiB: c.estimate!.pools.map(p => p.totalMiB), measuredMiB: c.estimate!.pools.map(p => p.totalMiB + 100), exclusive: true })
  expect((await svc!.checkProfile(model(), '默认')).basis).toBe('measured')
  const file = join(dir, 'models', 'm.gguf')
  const bigger = spec()
  bigger.tensors!.push({ dims: [256, 256], type: 12, name: 'blk.8.attn_q.weight' })
  writeGguf(file, bigger) // same path and arguments, other content
  const after = await svc!.checkProfile(model(), '默认')
  expect(after.statsKey).not.toBe(c.statsKey)
  expect(after.basis).toBe('formula')
  writeGguf(file, spec())
})

test('mlock that would lock more than the free memory is dropped (only with the switch on)', async () => {
  ctx!.getMemoryProbe = async () => ({ list: devices, fallbackGpus: [], system: { totalMiB: 64000, availableMiB: 0.0001 } })
  // The Windows CUDA defaults carry `--load-mode mlock` and every profile inherits them; the control profile needs defaults without it.
  const defaultExtra = ctx!.getSettings().defaults.extraArgs
  try {
    multi(true)
    freeOf(22000)
    if (win) {
      expect(defaultExtra).toContain('mlock')
      expect((await svc!.checkProfile(model(), '默认')).mlockDropped).toBe(true) // inherited, so dropped as well
    }
    ctx!.updateSettings((s) => { s.defaults.extraArgs = '' })
    const on = await svc!.checkProfile(model(), '锁定')
    expect(on.mlockDropped).toBe(true)
    expect((await adm!.admitTarget({ modelId: 'm', profile: '锁定' }, [])).data).toMatchObject({ dropMlock: true })
    expect((await svc!.checkProfile(model(), '默认')).mlockDropped).toBe(false)
    multi(false)
    expect((await svc!.checkProfile(model(), '锁定')).mlockDropped).toBe(false)
  } finally {
    ctx!.updateSettings((s) => { s.defaults.extraArgs = defaultExtra })
    ctx!.getMemoryProbe = async () => ({ list: devices, fallbackGpus: [], system: { totalMiB: 64000, availableMiB: 60000 } })
  }
})
