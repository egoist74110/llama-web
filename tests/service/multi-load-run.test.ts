// Several real processes through the real context (POSIX; the stand-in llama-server of the runner tests behind a shell
// wrapper): two models online at once on different ports, a request that needs room unloads the least recently used
// one and really kills its process, a refusal starts nothing, and shutting down leaves no process behind.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultSettings } from '../../server/core/config'
import { DeviceProbe, type DeviceList } from '../../server/core/devices'
import { isAlive } from '../../server/core/runner'
import { customDir } from '../../server/core/runtimes'
import { SchedulerError } from '../../server/core/scheduler'
import { writeGguf, type FakeGguf, type KvValue } from '../fixtures/gguf-builder'

const posix = process.platform !== 'win32'
const t = posix ? test : test.skip
let dir = ''
let ctx: ReturnType<typeof import('../../server/service/context').getContext> | undefined
const realList = DeviceProbe.prototype.list
let devices: DeviceList = { source: 'list-devices', gpus: [{ id: 'MTL0', name: 'Fake card', totalMiB: 24000, freeMiB: 22000 }] }
const system = { totalMiB: 64000, availableMiB: 60000 }

const u32 = (v: number): KvValue => ({ t: 'u32', v })
const spec = (): FakeGguf => ({
  kvs: [
    ['general.architecture', { t: 'str', v: 'llama' }], ['general.file_type', u32(15)], ['llama.context_length', u32(8192)],
    ['llama.block_count', u32(8)], ['llama.embedding_length', u32(256)], ['llama.feed_forward_length', u32(512)],
    ['llama.attention.head_count', u32(4)], ['llama.attention.head_count_kv', u32(2)], ['tokenizer.ggml.tokens', { t: 'strarr', v: ['a', 'b'] }],
  ],
  tensors: [{ dims: [256, 1024], type: 12, name: 'token_embd.weight' }, ...Array.from({ length: 8 }, (_, i) => ({ dims: [256, 256], type: 12, name: `blk.${i}.attn_q.weight` }))],
})

beforeAll(async () => {
  if (!posix) return
  dir = mkdtempSync(join(tmpdir(), 'lw-multirun-'))
  const models = join(dir, 'models')
  writeGguf(join(models, 'm.gguf'), spec())
  const s = defaultSettings()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    ...s, llamacpp: { ...s.llamacpp, autoUpdate: false }, modelDirs: [{ id: 'd', path: models, enabled: true, maxDepth: 0 }],
  }))
  const entry = (id: string) => ({
    id, name: id, backend: 'llama-server', file: { dirId: 'd', rel: 'm.gguf' }, mmproj: null, draft: null, activeProfile: '默认',
    profiles: { 默认: { overrides: {}, extraArgs: '' } }, runtime: 'custom:r1',
  })
  writeFileSync(join(dir, 'models.json'), JSON.stringify({ version: 1, models: [entry('m'), entry('n'), entry('o')] }))
  writeFileSync(join(dir, 'runtimes.json'), JSON.stringify({
    version: 1, entries: [{ id: 'r1', label: 'r1', source: { kind: 'dir', from: '/src' }, os: process.platform, arch: process.arch, accel: 'metal', tag: 'b1', addedAt: '' }],
  }))
  mkdirSync(customDir(dir, 'r1'), { recursive: true })
  const exe = join(customDir(dir, 'r1'), 'llama-server')
  writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "${resolve('tests/fixtures/fake-llama-server.ts')}" --fake-delay 50 "$@"\n`)
  chmodSync(exe, 0o755)
  process.env.LLAMA_WEB_DATA = dir
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('llama-web.context')]
  DeviceProbe.prototype.list = async () => devices
  const { getContext } = await import('../../server/service/context')
  ctx = getContext()
  ctx.getMemoryProbe = async () => ({ list: devices, fallbackGpus: [], system })
  ctx.updateSettings((x) => { x.scheduler.multiLoad = true; x.scheduler.maxLoaded = 3; x.scheduler.onNoRoom = 'unload'; x.scheduler.drainTimeoutSec = 5 })
})
afterAll(async () => {
  DeviceProbe.prototype.list = realList
  await ctx?.shutdown()
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('llama-web.context')]
  delete process.env.LLAMA_WEB_DATA
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const target = (modelId: string) => ({ modelId, profile: '默认' })
const free = (miB: number) => { devices = { source: 'list-devices', gpus: [{ id: 'MTL0', name: 'Fake card', totalMiB: 24000, freeMiB: miB }] } }
const pidOf = (modelId: string) => ctx!.runner.list().find(p => p.spec.tag === `${modelId}:默认`)

t('two models run at once on different ports; a third that needs room unloads the least recently used and kills its process', async () => {
  free(22000)
  ;(await ctx!.scheduler.acquire(target('m'))).release()
  ;(await ctx!.scheduler.acquire(target('n'))).release()
  const m = pidOf('m')!
  const n = pidOf('n')!
  expect(m.port).not.toBe(n.port)
  expect(isAlive(m.pid!)).toBe(true)
  expect(isAlive(n.pid!)).toBe(true)
  expect((await fetch(`${m.url}/health`)).status).toBe(200)
  expect((await fetch(`${n.url}/health`)).status).toBe(200)
  ;(await ctx!.scheduler.acquire(target('m'))).release() // n is now the least recently used

  // The next model fits only while one of the two is gone (the stub does not know what the processes really take).
  free(1)
  const refused = await ctx!.scheduler.acquire(target('o')).catch(e => e)
  // Everything that could be unloaded was, and it still does not fit: refused, nothing of "o" was started.
  expect((refused as SchedulerError).code).toBe('no-room')
  expect(ctx!.scheduler.stateOf(target('m'))).toBe('stopped')
  expect(ctx!.scheduler.stateOf(target('n'))).toBe('stopped')
  expect(isAlive(m.pid!)).toBe(false)
  expect(isAlive(n.pid!)).toBe(false)
  expect(pidOf('o')).toBeUndefined()
  expect(ctx!.runner.list()).toEqual([])
}, 30000)

t('the measurement after a load is taken before the next load starts, and each load records only its own memory', async () => {
  free(22000)
  const realUsed = ctx!.measure.used
  const calls: string[] = []
  let releaseAfter!: (v: Array<number | null>) => void
  let n = 0
  ctx!.measure.used = (ids) => {
    n++
    calls.push(`call${n}`)
    if (n === 1) return Promise.resolve(ids.map(() => 100)) // before the first load
    if (n === 2) return new Promise(r => { releaseAfter = r }) // after the first load: held back
    return Promise.resolve(ids.map(() => (n === 3 ? 1100 : 2100))) // the second load: before 1100, after 2100
  }
  try {
    const a = ctx!.scheduler.acquire(target('m')).then(l => l.release())
    const b = ctx!.scheduler.acquire(target('n')).then(l => l.release())
    const end = Date.now() + 10000
    while (n < 2 && Date.now() < end) await new Promise(r => setTimeout(r, 10))
    expect(n).toBe(2)
    await new Promise(r => setTimeout(r, 400))
    // The first model is up but its measurement is pending: the second load has not begun (no reading, no process).
    expect(n).toBe(2)
    expect(pidOf('n')).toBeUndefined()
    releaseAfter([1100])
    await Promise.all([a, b])
    expect(pidOf('n')).toBeDefined()
    // Earlier tests left records of their own: look at the two newest (the loads of this test).
    const all = Object.values(JSON.parse(readFileSync(join(dir, 'vram-stats.json'), 'utf8')).entries as Record<string, { at: number, measuredMiB: number[] }>)
    const entries = all.sort((x, y) => y.at - x.at).slice(0, 2)
    // First load: 1100 - 100; second load: 2100 - 1100. Neither contains the other's memory.
    expect(entries.map(e => e.measuredMiB[0]!)).toEqual([1000, 1000])
  } finally {
    ctx!.measure.used = realUsed
    await ctx!.scheduler.unload(target('m'))
    await ctx!.scheduler.unload(target('n'))
  }
}, 30000)

t('a process that exits while its load is being measured is a failed load, not a ready model', async () => {
  free(22000)
  const realUsed = ctx!.measure.used
  let n = 0
  let releaseAfter!: (v: Array<number | null>) => void
  ctx!.measure.used = (ids) => {
    n++
    if (n === 1) return Promise.resolve(ids.map(() => 100))
    return new Promise(r => { releaseAfter = r })
  }
  try {
    const waiting = ctx!.scheduler.acquire(target('o')).then(l => l, e => e)
    const end = Date.now() + 10000
    while (n < 2 && Date.now() < end) await new Promise(r => setTimeout(r, 10))
    expect(n).toBe(2)
    const proc = pidOf('o')!
    expect(ctx!.scheduler.stateOf(target('o'))).toBe('loading') // healthy, but the measurement is pending
    process.kill(proc.pid!, 'SIGKILL')
    await proc.exited
    releaseAfter?.([1100])
    const got = await waiting
    expect((got as SchedulerError).code).toBe('failed')
    expect(ctx!.scheduler.stateOf(target('o'))).not.toBe('ready')
    expect(isAlive(proc.pid!)).toBe(false)
  } finally {
    ctx!.measure.used = realUsed
    await ctx!.scheduler.stop('o').catch(() => {}) // clears the failed state for the tests after this one
  }
}, 30000)

t('after room is back the models load again; shutting down leaves no process', async () => {
  free(22000)
  ;(await ctx!.scheduler.acquire(target('m'))).release()
  ;(await ctx!.scheduler.acquire(target('o'))).release()
  const pids = ctx!.runner.list().map(p => p.pid!)
  expect(pids).toHaveLength(2)
  await ctx!.scheduler.shutdown()
  await ctx!.runner.stopAll()
  expect(pids.some(isAlive)).toBe(false)
  expect(ctx!.runner.list()).toEqual([])
}, 30000)
