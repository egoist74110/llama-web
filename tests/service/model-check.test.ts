// The save-time check wired to the real context (stores, runtime registry, device probe): a profile that cannot start is
// refused, warnings and memory tiers are returned but never block, profiles are calculated separately, nothing is
// written by a check, and an old config without device / runtime fields works. The device list and the system memory
// are stubbed; the model file is a constructed header.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultSettings } from '../../server/core/config'
import { DeviceProbe, type DeviceList } from '../../server/core/devices'
import { customDir } from '../../server/core/runtimes'
import { writeGguf, type FakeGguf, type KvValue } from '../fixtures/gguf-builder'

const win = process.platform === 'win32'
const gpuId = win ? 'CUDA0' : 'MTL0'
let dir = ''
let ctx: ReturnType<typeof import('../../server/service/context').getContext> | undefined
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
  dir = mkdtempSync(join(tmpdir(), 'lw-check-'))
  const models = join(dir, 'models')
  writeGguf(join(models, 'm.gguf'), spec())
  const s = defaultSettings()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    ...s, llamacpp: { ...s.llamacpp, autoUpdate: false },
    modelDirs: [{ id: 'd', path: models, enabled: true, maxDepth: 0 }],
  }))
  // One model with a runtime reference and one old-style entry that has neither `runtime` nor `device`.
  const profiles = { 默认: { overrides: {}, extraArgs: '' }, 长上下文: { overrides: { ctxSize: 8192, cacheTypeK: 'q8_0', cacheTypeV: 'q8_0' }, extraArgs: '' } }
  const entry = { backend: 'llama-server', file: { dirId: 'd', rel: 'm.gguf' }, mmproj: null, draft: null, activeProfile: '默认', profiles }
  writeFileSync(join(dir, 'models.json'), JSON.stringify({
    version: 1, models: [{ id: 'm', name: 'm', ...entry, runtime: 'custom:r1' }, { id: 'old', name: 'old', ...entry }],
  }))
  writeFileSync(join(dir, 'runtimes.json'), JSON.stringify({
    version: 1, entries: [{ id: 'r1', label: 'r1', source: { kind: 'dir', from: 'X:\\src' }, os: process.platform, arch: process.arch, accel: win ? 'cuda' : 'metal', tag: 'b1', addedAt: '' }],
  }))
  mkdirSync(customDir(dir, 'r1'), { recursive: true })
  writeFileSync(join(customDir(dir, 'r1'), win ? 'llama-server.exe' : 'llama-server'), 'x')
  process.env.LLAMA_WEB_DATA = dir
  DeviceProbe.prototype.list = async () => devices
  const { getContext } = await import('../../server/service/context')
  ctx = getContext()
  svc = await import('../../server/service/model-check')
})
afterAll(async () => {
  DeviceProbe.prototype.list = realList
  await ctx?.shutdown()
  delete process.env.LLAMA_WEB_DATA
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const model = (id = 'm') => ctx!.getModels().models.find(m => m.id === id)!
const form = (over: Record<string, unknown> = {}) => ({ overrides: {}, extraArgs: '', chatTemplate: null, ...over })

test('a profile is checked as saved: estimate from the real file header, pools, tier, no issues', async () => {
  const c = await svc!.checkProfile(model(), '默认')
  expect(c.estimate).not.toBeNull()
  expect(c.estimate!.total.weightsMiB).toBeGreaterThan(0)
  expect(c.estimate!.kv.ctx).toBeGreaterThan(0)
  expect(c.tier).toBe('ok')
  expect(c.issues.filter(i => i.code !== 'ctx-over-train')).toEqual([])
  expect(c.online).toBe(false)
  expect(c.estimate!.pools.every(p => (win ? ['separate', 'host'] : ['shared']).includes(p.kind))).toBe(true)
})

test('two profiles are calculated on their own; the check does not write the models file', async () => {
  const before = readFileSync(join(dir, 'models.json'), 'utf8')
  const a = await svc!.checkProfile(model(), '默认')
  const b = await svc!.checkProfile(model(), '长上下文')
  expect(b.estimate!.kv.ctx).toBe(8192)
  expect(b.estimate!.total.kvMiB).not.toBe(a.estimate!.total.kvMiB)
  expect(readFileSync(join(dir, 'models.json'), 'utf8')).toBe(before)
})

test('values on screen are checked without being saved', async () => {
  const c = await svc!.checkProfile(model(), '默认', { form: form({ overrides: { ctxSize: 32768 } }) })
  expect(c.estimate!.kv.ctx).toBe(32768)
  expect(c.issues.map(i => i.code)).toContain('ctx-over-train')
  expect(model().profiles['默认']!.overrides).toEqual({})
})

test('an old entry without runtime / device fields is checked like any other', async () => {
  const c = await svc!.checkProfile(model('old'), '默认')
  expect(c.estimate).not.toBeNull()
  expect(c.blocked).toBe(false)
})

test('a quantised V cache without flash attention is refused at save with a Chinese reason; nothing is stored', async () => {
  const bad = form({ overrides: { cacheTypeV: 'q8_0', flashAttn: 'off' } })
  const err = await svc!.checkBeforeSave(model(), '默认', { form: bad }).catch(e => e)
  expect(err.code).toBe('check-failed')
  expect(err.detail).toContain('Flash Attention')
  expect(model().profiles['默认']!.overrides).toEqual({})
})

test('warnings and a full memory never block the save; the check comes back for the interface', async () => {
  const warn = await svc!.checkBeforeSave(model(), '默认', { form: form({ overrides: { ctxSize: 32768, batchSize: 256, ubatchSize: 512 } }) })
  expect(warn!.issues.map(i => i.code)).toEqual(expect.arrayContaining(['ctx-over-train', 'ubatch-over-batch']))
  devices = { source: 'list-devices', gpus: [{ id: gpuId, name: 'Fake card', totalMiB: 24000, freeMiB: 1 }] }
  try {
    const full = await svc!.checkBeforeSave(model(), '默认', { form: form() })
    // the pool that holds the model is out of memory (a Mac's pool is also bounded by the system, so only a separate card is certain)
    if (win) expect(full!.tier).toBe('nofit')
    expect(full!.blocked).toBe(false)
  } finally {
    devices = { source: 'list-devices', gpus: [{ id: gpuId, name: 'Fake card', totalMiB: 24000, freeMiB: 22000 }] }
  }
})

test.skipIf(!win)('a device the build does not list is refused at save (Windows: devices can be chosen)', async () => {
  const err = await svc!.checkBeforeSave(model(), '默认', { form: form({ device: 'CUDA7' }) }).catch(e => e)
  expect(err.code).toBe('check-failed')
  expect(err.detail).toContain('CUDA7')
  const ok = await svc!.checkBeforeSave(model(), '默认', { form: form({ device: 'CUDA0' }) })
  expect(ok!.blocked).toBe(false)
})

test('a check that fails by itself never blocks a save (returns null)', async () => {
  const real = ctx!.getMemoryProbe
  ctx!.getMemoryProbe = async () => { throw new Error('probe broke') }
  const quiet = console.error
  console.error = () => {}
  try { expect(await svc!.checkBeforeSave(model(), '默认', { form: form() })).toBeNull() }
  finally { ctx!.getMemoryProbe = real; console.error = quiet }
})
