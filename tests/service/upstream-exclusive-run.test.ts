// Machine-exclusive upstream with a REAL process (decision 56 ⑨): the stand-in llama-server of the runner tests runs as a
// child process through the real context. When the external upstream starts answering, the process is really stopped
// (after its running request), nothing starts while the upstream is there, and after it is gone loading works again.
// Windows: the stand-in is compiled to llama-server.exe; POSIX: a shell wrapper. No GPU is used.
import { afterAll, beforeAll, expect, test } from 'bun:test'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { defaultSettings } from '../../server/core/config'
import { DeviceProbe, type DeviceList } from '../../server/core/devices'
import { isAlive } from '../../server/core/runner'
import { customDir } from '../../server/core/runtimes'
import { createUpstream, updateUpstream } from '../../server/core/upstreams'
import { writeGguf, type FakeGguf, type KvValue } from '../fixtures/gguf-builder'

const win = process.platform === 'win32'
let dir = ''
let ctx: ReturnType<typeof import('../../server/service/context').getContext> | undefined
let up: ReturnType<typeof Bun.serve> | undefined
let upstreamId = ''
const realList = DeviceProbe.prototype.list
const gpuId = win ? 'CUDA0' : 'MTL0'
const devices: DeviceList = { source: 'list-devices', gpus: [{ id: gpuId, name: 'Fake card', totalMiB: 24000, freeMiB: 22000 }] }
const edit = { localNames: [], selfPorts: [] }

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
  dir = mkdtempSync(join(tmpdir(), 'lw-exclrun-'))
  const models = join(dir, 'models')
  writeGguf(join(models, 'm.gguf'), spec())
  const s = defaultSettings()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    ...s, llamacpp: { ...s.llamacpp, autoUpdate: false }, modelDirs: [{ id: 'd', path: models, enabled: true, maxDepth: 0 }],
  }))
  writeFileSync(join(dir, 'models.json'), JSON.stringify({
    version: 1, models: [{
      id: 'm', name: 'm', backend: 'llama-server', file: { dirId: 'd', rel: 'm.gguf' }, mmproj: null, draft: null, activeProfile: '默认',
      profiles: { 默认: { overrides: {}, extraArgs: '' } }, runtime: 'custom:r1', ...(win ? { device: 'CUDA0' } : {}),
    }],
  }))
  writeFileSync(join(dir, 'runtimes.json'), JSON.stringify({
    version: 1, entries: [{ id: 'r1', label: 'r1', source: { kind: 'dir', from: win ? 'X:\\src' : '/src' }, os: process.platform, arch: process.arch, accel: win ? 'cuda' : 'metal', tag: 'b1', addedAt: '' }],
  }))
  mkdirSync(customDir(dir, 'r1'), { recursive: true })
  const fixture = resolve('tests/fixtures/fake-llama-server.ts')
  if (win) {
    const exe = join(customDir(dir, 'r1'), 'llama-server.exe')
    const built = Bun.spawnSync([process.execPath, 'build', '--compile', fixture, '--outfile', exe], { stdout: 'pipe', stderr: 'pipe' })
    if (built.exitCode !== 0) throw new Error(`could not compile the stand-in llama-server: ${built.stderr.toString()}`)
  } else {
    const exe = join(customDir(dir, 'r1'), 'llama-server')
    writeFileSync(exe, `#!/bin/sh\nexec "${process.execPath}" "${fixture}" --fake-delay 50 "$@"\n`)
    chmodSync(exe, 0o755)
  }
  process.env.LLAMA_WEB_DATA = dir
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('llama-web.context')]
  DeviceProbe.prototype.list = async () => devices
  up = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: () => Response.json({ data: [{ id: 'flash' }] }) })
  const { getContext } = await import('../../server/service/context')
  ctx = getContext()
  ctx.updateSettings((x) => { x.scheduler.drainTimeoutSec = 10 })
  ctx.updateUpstreams((d) => { upstreamId = createUpstream(d, { name: 'Strata', baseUrl: `http://127.0.0.1:${up!.port}/v1`, exclusive: false }, edit).id })
}, 60_000)
afterAll(async () => {
  DeviceProbe.prototype.list = realList
  up?.stop(true)
  await ctx?.shutdown()
  delete (globalThis as Record<symbol, unknown>)[Symbol.for('llama-web.context')]
  delete process.env.LLAMA_WEB_DATA
  if (dir) rmSync(dir, { recursive: true, force: true })
})

const M = { modelId: 'm', profile: '默认' }
const proc = () => ctx!.runner.list().find(p => p.spec.tag === 'm:默认')
const until = async (cond: () => boolean, ms = 8000) => {
  const end = Date.now() + ms
  while (!cond()) { if (Date.now() > end) throw new Error('condition not reached'); await new Promise(r => setTimeout(r, 25)) }
}
const reasonOf = async (p: Promise<unknown>) => ((await p.then(() => null, e => e)) as { cause?: { reason?: string } } | null)?.cause?.reason

test('a model runs; the upstream answers but is not exclusive: the process stays', async () => {
  ;(await ctx!.scheduler.acquire(M)).release()
  expect(isAlive(proc()!.pid!)).toBe(true)
  await ctx!.health.tick()
  expect(ctx!.health.isUp(upstreamId)).toBe(true)
  expect(ctx!.health.holder()).toBeNull()
  expect(ctx!.scheduler.stateOf(M)).toBe('ready')
})

test('exclusive on: the running request finishes first, then the real process is stopped', async () => {
  const lease = await ctx!.scheduler.acquire(M)
  const pid = proc()!.pid!
  ctx!.updateUpstreams((d) => { updateUpstream(d, upstreamId, { exclusive: true }, edit) })
  await ctx!.health.tick()
  await until(() => ctx!.scheduler.stateOf(M) === 'draining')
  await new Promise(r => setTimeout(r, 300))
  expect(isAlive(pid)).toBe(true) // a request is still running: not cut off
  lease.release('ok')
  await until(() => !isAlive(pid))
  await until(() => ctx!.scheduler.stateOf(M) === 'stopped')
  expect(proc()).toBeUndefined()
})

test('while it holds the machine nothing starts: no process, `exclusive` as the reason', async () => {
  expect(await reasonOf(ctx!.scheduler.acquire(M))).toBe('exclusive')
  expect(await reasonOf(ctx!.ops.start(M))).toBe('exclusive')
  expect(proc()).toBeUndefined()
  expect(ctx!.runner.list()).toEqual([])
})

test('after the upstream is gone for three probes the model loads again, as a new process', async () => {
  up!.stop(true)
  for (let i = 0; i < 3; i++) await ctx!.health.tick()
  expect(ctx!.health.holder()).toBeNull()
  ;(await ctx!.scheduler.acquire(M)).release()
  expect(isAlive(proc()!.pid!)).toBe(true)
})

test('shutting down leaves no process behind', async () => {
  const pid = proc()!.pid!
  await ctx!.shutdown()
  expect(isAlive(pid)).toBe(false)
})
