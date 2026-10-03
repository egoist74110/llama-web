import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultSettings } from '../../server/core/config'
import { DeviceProbe, type DeviceList } from '../../server/core/devices'
import { customDir } from '../../server/core/runtimes'

// The real context wiring (not a hand-built `usedExes`): a build that a start is still probing devices for
// must not be deletable, and the protection ends when the start fails.
const win = process.platform === 'win32'
let dir = ''
let ctx: ReturnType<typeof import('../../server/service/context').getContext> | undefined
const realList = DeviceProbe.prototype.list
let gate: Promise<void> = Promise.resolve()
let probing: () => void = () => {}
let devices: DeviceList = { source: 'list-devices', gpus: [{ id: 'CUDA0', name: 'Fake GPU', totalMiB: 1000, freeMiB: 900 }] }

beforeAll(async () => {
  if (!win) return
  dir = mkdtempSync(join(tmpdir(), 'lw-launch-prot-'))
  const models = join(dir, 'models')
  mkdirSync(models)
  writeFileSync(join(models, 'm.gguf'), 'GGUF')
  const s = defaultSettings()
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({
    ...s, llamacpp: { ...s.llamacpp, autoUpdate: false },
    modelDirs: [{ id: 'd', path: models, enabled: true, maxDepth: 0 }],
  }))
  writeFileSync(join(dir, 'models.json'), JSON.stringify({
    version: 1, models: [{
      id: 'm', name: 'm', backend: 'llama-server', file: { dirId: 'd', rel: 'm.gguf' }, mmproj: null, draft: null, activeProfile: 'default',
      runtime: 'custom:r1', device: 'CUDA0', profiles: { default: { overrides: {}, extraArgs: '' } },
    }],
  }))
  writeFileSync(join(dir, 'runtimes.json'), JSON.stringify({
    version: 1, entries: [{ id: 'r1', label: 'r1', source: { kind: 'dir', from: 'X:\\src' }, os: 'win32', arch: process.arch, accel: 'cuda', tag: 'b1', addedAt: '' }],
  }))
  mkdirSync(customDir(dir, 'r1'), { recursive: true })
  writeFileSync(join(customDir(dir, 'r1'), 'llama-server.exe'), 'MZ')
  process.env.LLAMA_WEB_DATA = dir
  DeviceProbe.prototype.list = async function () { probing(); await gate; return devices }
  const { getContext } = await import('../../server/service/context')
  ctx = getContext()
})
afterAll(async () => {
  DeviceProbe.prototype.list = realList
  await ctx?.shutdown()
  delete process.env.LLAMA_WEB_DATA
  if (dir) rmSync(dir, { recursive: true, force: true })
})

test.skipIf(!win)('a build stays protected while the device list is probed, and again unprotected after a failed start', async () => {
  const c = ctx!
  const exe = join(customDir(dir, 'r1'), 'llama-server.exe')
  expect(c.runtimes.plan('custom:r1').blocked).toBeNull()

  // 1) start waits on the probe: the build is protected
  let release: () => void = () => {}
  gate = new Promise<void>((r) => { release = r })
  const seen = new Promise<void>((r) => { probing = r })
  let started = 0
  c.runner.start = (async () => { started++; throw new Error('fake start failure') }) as typeof c.runner.start
  const work = c.ops.start({ modelId: 'm', profile: 'default' }).catch(() => {})
  await seen
  try {
    expect(c.runtimes.plan('custom:r1').blocked).not.toBeNull()
    expect(() => c.runtimes.remove('custom:r1', { confirm: true })).toThrow()
    expect(existsSync(exe)).toBe(true)
  } finally { release() }

  // 2) the probe finishes, the start fails: protection is gone
  release()
  await work
  await new Promise(r => setTimeout(r, 50))
  expect(started).toBe(1)
  expect(c.runtimes.plan('custom:r1').blocked).toBeNull()

  // 3) a probe that reports no such device (device-missing) also releases it
  devices = { source: 'list-devices', gpus: [] }
  gate = Promise.resolve()
  probing = () => {}
  await c.ops.start({ modelId: 'm', profile: 'default' }).catch(() => {})
  await new Promise(r => setTimeout(r, 50))
  expect(started).toBe(1)
  expect(c.runtimes.plan('custom:r1').blocked).toBeNull()
})
