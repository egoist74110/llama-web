import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { currentTagFor, defaultSettings, defaultsFor, normalizeSettings, SETTINGS_MIGRATIONS, SETTINGS_VERSION } from '../../server/core/config'
import { chooseExe } from '../../server/core/launch'
import { classify } from '../../server/core/errors'
import { installedDir, installLatest, listInstalled, resolveLatest } from '../../server/core/llamacpp'
import { gpuChannelFor, isIntegratedGpuName, platformInfo, runtimeTarget, type Acceleration, type RuntimeTarget } from '../../server/core/platform'
import { detectAccel, pickAsset, RuntimeInstaller } from '../../server/core/runtime-add'
import { channelsFor, normalizeRuntimes, parseRuntimeRef, refOfExe, resolveRuntimeRef, RuntimeRegistry, selectableHere, type RuntimeEntry } from '../../server/core/runtimes'
import { RuntimeManager } from '../../server/core/runtime-manager'
import { JsonStore } from '../../server/core/store'
import { Updater, versionOfExe } from '../../server/core/updater'
import { peX64 } from '../fixtures/fake-binary'
import { fakeExtract, sha } from '../fixtures/fake-github'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lw-vulkan-')) })
afterEach(() => { rmSync(dir, { recursive: true, force: true }) })
const vulkan: RuntimeTarget = { os: 'win32', arch: 'x64', acceleration: 'vulkan', gpuChannel: 'vulkan' }
const cpu: RuntimeTarget = { ...vulkan, acceleration: 'cpu' }
const bin = 'llama-b1234-bin-win-vulkan-x64.zip'
const entry = (accel: RuntimeEntry['accel']): RuntimeEntry => ({ id: accel, label: accel, accel, os: 'win32', arch: 'x64', tag: 'b1234', addedAt: '', source: { kind: 'dir', from: 'X:\\build' } })
const github = (present = true) => {
  const calls: string[] = []
  const fetch = async (url: string) => {
    calls.push(url)
    if (url.endsWith('/releases/latest')) return Response.json({ assets: [{ name: 'nightly-tag.txt', browser_download_url: 'https://example.com/nightly-tag.txt' }] })
    if (url.endsWith('nightly-tag.txt')) return new Response('b1234')
    if (url.endsWith('/releases/tags/b1234')) return Response.json({ assets: present ? [{ name: bin, browser_download_url: `https://example.com/${bin}`, digest: `sha256:${sha('zip')}` }] : [] })
    if (url.endsWith(bin)) return new Response('zip')
    throw new Error(`Unexpected request ${url}`)
  }
  return { fetch, calls }
}

test('startup GPU-channel matrix is independent of the automatic launch target', () => {
  for (const nvidia of ['found', 'none', 'missing', 'failed'] as const) {
    const info = platformInfo('win32', 'x64', nvidia)
    for (const wanted of ['auto', 'cpu', 'cuda', 'vulkan', 'metal'] as Acceleration[]) {
      expect(gpuChannelFor(info, wanted)).toBe(wanted === 'cuda' ? 'cuda' : wanted === 'vulkan' ? 'vulkan' : nvidia === 'found' || nvidia === 'failed' ? 'cuda' : 'vulkan')
    }
    if (nvidia === 'missing' || nvidia === 'failed') expect(() => runtimeTarget(info, 'auto')).toThrow()
    else expect(runtimeTarget(info, 'auto').acceleration).toBe(nvidia === 'found' ? 'cuda' : 'cpu')
    expect(runtimeTarget(info, 'vulkan').acceleration).toBe('vulkan')
  }
  for (const arch of ['arm64', 'x64']) expect(() => runtimeTarget(platformInfo('darwin', arch), 'vulkan')).toThrow()
  expect(() => runtimeTarget(platformInfo('win32', 'arm64', false), 'vulkan')).toThrow()
  expect(channelsFor(cpu)).toEqual(['vulkan', 'cpu'])
  expect(channelsFor({ ...cpu, gpuChannel: 'cuda' })).toEqual(['cuda', 'cpu'])
  expect(channelsFor({ os: 'win32', arch: 'x64' })).toEqual(['cuda', 'cpu'])
  expect(channelsFor({ os: 'darwin', arch: 'arm64', gpuChannel: 'vulkan' })).toEqual(['metal'])
})

test('official references, custom enums, resolution, visibility and namespaced executable paths', () => {
  expect(parseRuntimeRef('vulkan:b1234')).toEqual({ kind: 'official', accel: 'vulkan', tag: 'b1234' })
  for (const accel of ['sycl', 'rocm']) expect(parseRuntimeRef(`${accel}:b1234`)).toBeNull()
  const entries = normalizeRuntimes({ version: 1, entries: ['cuda', 'rocm', 'sycl', 'vulkan', 'cpu', 'metal'].map(a => entry(a as RuntimeEntry['accel'])) }).entries
  expect(entries.map(e => e.accel)).toEqual(['cuda', 'rocm', 'sycl', 'vulkan', 'cpu', 'metal'])
  const exe = join(installedDir(dir, 'b1234', vulkan), 'llama-server.exe')
  mkdirSync(installedDir(dir, 'b1234', vulkan), { recursive: true })
  writeFileSync(exe, '')
  expect(exe).toBe(join(dir, 'runtime', 'llama.cpp', 'win32-x64-vulkan', 'b1234', 'llama-server.exe'))
  expect(listInstalled(dir, 'win32', vulkan)).toEqual(['b1234'])
  expect(refOfExe(dir, exe, 'win32')).toBe('vulkan:b1234')
  expect(versionOfExe(dir, exe, 'win32')).toBe('b1234')
  const env = { dataDir: dir, target: cpu, entries }
  expect(selectableHere('vulkan:b1234', env)).toBe(true)
  expect(selectableHere('cuda:b1234', env)).toBe(false)
  expect(resolveRuntimeRef('vulkan:b9', env).fallback?.to).toBe('vulkan:b1234')
  expect(resolveRuntimeRef('vulkan:b1234', env).exe).toBe(exe)
  const reg = new RuntimeRegistry(dir)
  try {
    for (const e of entries) reg.add(e)
    expect(reg.list().map(e => e.accel)).toEqual(entries.map(e => e.accel))
    const mgr = new RuntimeManager({ dataDir: dir, target: cpu, registry: reg, getSettings: defaultSettings, getModels: () => ({ version: 1, models: [] }), usedExes: () => [], setCurrent: () => {}, updateModels: () => {}, onChanged: () => {} })
    expect(mgr.list().rows.filter(r => r.kind === 'official').map(c => c.accel)).toEqual(['vulkan'])
    expect(resolveRuntimeRef('custom:sycl', { ...env, installed: () => ['b1234'], exists: () => false }).fallback?.to).toBe('cpu:b1234')
    expect(resolveRuntimeRef('custom:rocm', { ...env, target: vulkan, exists: () => false }).fallback?.to).toBe('vulkan:b1234')
  } finally { reg.close() }
})

test('v11 migration adds only currentVulkan, preserves saved values and rejects newer documents', () => {
  const old: any = defaultSettings()
  old.version = 11
  delete old.llamacpp.currentVulkan
  old.llamacpp.current = 'b100'
  old.llamacpp.currentCpu = 'b99'
  old.defaults.gpuLayers = 17
  const bytes = JSON.stringify(old)
  writeFileSync(join(dir, 'settings.json'), bytes)
  const store = new JsonStore({ dataDir: dir, name: 'settings.json', version: SETTINGS_VERSION, defaults: defaultSettings, validate: normalizeSettings, migrations: SETTINGS_MIGRATIONS })
  try {
    expect(store.load()).toEqual({ ...old, version: 12, llamacpp: { ...old.llamacpp, currentVulkan: '' } })
    expect(readFileSync(join(dir, 'backups', readdirSync(join(dir, 'backups'))[0]!), 'utf8')).toBe(bytes)
  } finally { store.close() }
  const existing = { llamacpp: { currentVulkan: 'b88', acceleration: 'vulkan' } }
  expect(SETTINGS_MIGRATIONS[11]!(structuredClone(existing))).toEqual(existing)
  expect(SETTINGS_MIGRATIONS[11]!({}).llamacpp.currentVulkan).toBe('')
  const s = normalizeSettings({ ...defaultSettings(), llamacpp: { ...defaultSettings().llamacpp, acceleration: 'vulkan', currentVulkan: 'b88' } })
  expect(currentTagFor(s, cpu, 'vulkan')).toBe('b88')
  for (const accel of ['vulkan', 'sycl', 'rocm']) expect(defaultsFor(s, cpu, accel)).toEqual({ ...s.defaults, flashAttn: null, cacheTypeK: null, cacheTypeV: null })
  expect(defaultSettings(platformInfo('win32', 'x64', false)).llamacpp.acceleration).toBe('auto')
  writeFileSync(join(dir, 'settings.json'), JSON.stringify({ ...old, version: 13 }))
  const newer = new JsonStore({ dataDir: dir, name: 'settings.json', version: SETTINGS_VERSION, defaults: defaultSettings, validate: normalizeSettings, migrations: SETTINGS_MIGRATIONS })
  try { expect(() => newer.load()).toThrow() } finally { newer.close() }
})

test('Vulkan release asset is installed without cudart; absence fails explicitly', async () => {
  const f = github()
  expect(await resolveLatest(f.fetch, '', 'win32', {}, vulkan)).toMatchObject({ tag: 'b1234', bin: { name: bin } })
  expect((await resolveLatest(f.fetch, '', 'win32', {}, vulkan)).cudart).toBeUndefined()
  await expect(resolveLatest(github(false).fetch, '', 'win32', {}, vulkan)).rejects.toMatchObject({ code: 'asset-missing' })
  await expect(resolveLatest(f.fetch, '', 'win32', {}, { ...vulkan, arch: 'arm64' })).rejects.toMatchObject({ code: 'asset-missing' })
  await expect(resolveLatest(f.fetch, '', 'darwin', {}, { ...vulkan, os: 'darwin' })).rejects.toMatchObject({ code: 'asset-missing' })
  await installLatest({ dataDir: dir, cudaRuntime: '', platform: 'win32', target: vulkan, fetch: f.fetch, extract: fakeExtract() })
  expect(readdirSync(installedDir(dir, 'b1234', vulkan))).toEqual(['llama-server.exe'])
  expect(f.calls.some(c => c.includes('cudart'))).toBe(false)
  expect(pickAsset([bin, 'llama-b1234-bin-win-cpu-x64.zip'], vulkan, 'vulkan')).toEqual({ bin, accel: 'vulkan' })
  expect(pickAsset(['llama-b1234-bin-win-cpu-x64.zip'], vulkan, 'vulkan')).toBeNull()
})

test('Vulkan updater uses its own current field and preserves the CUDA and CPU tags', async () => {
  const s = defaultSettings()
  s.llamacpp.current = 'b100'
  s.llamacpp.currentCpu = 'b99'
  const updater = new Updater({ dataDir: dir, target: vulkan, platform: 'win32', fetch: github().fetch, extract: fakeExtract(), usedExes: () => [], llamacpp: () => ({ ...s.llamacpp, current: currentTagFor(s, cpu, 'vulkan') }), setCurrent: tag => { s.llamacpp.currentVulkan = tag } })
  try {
    expect((await updater.run()).state).toBe('disabled')
    expect(s.llamacpp.currentVulkan).toBe('')
    expect((await updater.run({ force: true })).state).toBe('ready')
    expect(s.llamacpp).toMatchObject({ current: 'b100', currentCpu: 'b99', currentVulkan: 'b1234' })
    expect(updater.versions()).toEqual([expect.objectContaining({ tag: 'b1234', current: true })])
  } finally { await updater.stop() }
})

test('manual backend detection priority and preview labels survive registration', async () => {
  const names = ['LiBggml-VuLkAn.dll', 'ggml-SYCL.dll', 'libggml-HIP.dll', 'ggml-CUDA.dll']
  const expected = ['vulkan', 'sycl', 'rocm', 'cuda'] as const
  const root = join(dir, 'source')
  mkdirSync(root)
  writeFileSync(join(root, 'llama-server.exe'), peX64())
  expect(detectAccel(root, cpu)).toBe('cpu')
  for (let i = 0; i < names.length; i++) {
    writeFileSync(join(root, names[i]!), '')
    expect(detectAccel(root, cpu)).toBe(expected[i]!)
  }
  const reg = new RuntimeRegistry(dir)
  const installer = new RuntimeInstaller({ dataDir: dir, target: cpu, registry: reg, runVersion: async () => 'version: 0.5 (build 1234, commit abc)', freeBytes: () => null })
  try {
    for (const [accel, label] of [['cuda', 'CUDA'], ['rocm', 'ROCm'], ['sycl', 'SYCL'], ['vulkan', 'Vulkan'], ['cpu', 'CPU']] as const) {
      const preview = await installer.preview({ kind: 'dir', path: root })
      expect(preview.accel).toBe(accel)
      expect(preview.suggestedLabel).toContain(label)
      const saved = installer.confirm(preview.stageId)
      expect(reg.get(saved.id)?.accel).toBe(accel)
      const s = defaultSettings()
      s.defaults.gpuLayers = 33
      const chosen = chooseExe(`custom:${saved.id}`, { dataDir: dir, settings: s, runtimeEnv: { dataDir: dir, target: cpu, entries: reg.list() } })
      expect(chosen.runtime.accel).toBe(accel)
      expect(defaultsFor(s, cpu, chosen.runtime.accel).gpuLayers).toBe(accel === 'cpu' ? 0 : 33)
      const n = names.pop()
      if (n) rmSync(join(root, n))
    }
    expect(detectAccel(root, { os: 'darwin', arch: 'arm64', acceleration: 'metal' })).toBe('metal')
  } finally { installer.dispose(); reg.close() }
})

test('integrated-device name table distinguishes Arc discrete cards and Radeon workstation GPUs', () => {
  for (const name of ['Intel Arc(TM) 140V GPU', 'Intel Arc(TM) Graphics', 'Intel UHD Graphics', 'Intel Iris Xe Graphics', 'AMD Radeon(TM) Graphics', 'Radeon 780M Graphics', 'Radeon(TM) 8060S Graphics']) expect(isIntegratedGpuName(name)).toBe(true)
  for (const name of ['Intel Arc(TM) A770', 'Intel Arc(TM) B580', 'Intel Arc(TM) Pro B60', 'Arc A380', 'Radeon RX 7900 XTX', 'Radeon PRO W7900', 'Radeon Pro W6600', 'Radeon AI PRO R9700', 'AMD Instinct MI300', 'NVIDIA GeForce RTX 5090', 'Unknown graphics']) expect(isIntegratedGpuName(name)).toBe(false)
})

test('backend initialization errors keep CUDA classification and give memory exhaustion priority', () => {
  for (const line of ['ggml_vulkan: No devices found', 'vk::SystemError', 'vk::createDevice: Error', 'ErrorDeviceLost', 'hipErrorNoDevice', 'ROCm error: init failed', 'SYCL error: device init failed', 'ggml_sycl_init: failed']) expect(classify('exited', 1, [line])).toBe('gpu-error')
  for (const line of ['SYCL out of memory', 'UR_RESULT_ERROR_OUT_OF_DEVICE_MEMORY', 'ur_result_error_out_of_host_memory', 'vk::ErrorOutOfDeviceMemory', 'hipErrorOutOfMemory']) expect(classify('exited', 1, [line])).toBe('oom')
  expect(classify('exited', 1, ['CUDA error: init failed'])).toBe('cuda-error')
  for (const line of ['SYCL device found', 'Vulkan initialized', 'UR_RESULT_ERROR_INVALID_VALUE', 'out of memory example']) expect(classify('exited', 1, [line])).toBe('exited')
})


test('GitHub manual Vulkan addition downloads one archive and cleans up a missing-asset failure', async () => {
  const reg = new RuntimeRegistry(dir)
  const calls: string[] = []
  let present = true
  const installer = new RuntimeInstaller({
    dataDir: dir, target: vulkan, registry: reg, freeBytes: () => null,
    runVersion: async () => 'version: 0.5 (build 1234, commit abc)',
    fetch: async url => {
      calls.push(url)
      if (url.includes('/releases/tags/b1234')) return Response.json({ assets: present ? [{ name: bin, browser_download_url: `https://github.com/example/llama.cpp/releases/download/b1234/${bin}`, digest: `sha256:${sha('zip')}` }] : [] })
      return new Response('zip')
    },
    extract: async (_, dest) => { mkdirSync(dest, { recursive: true }); writeFileSync(join(dest, 'llama-server.exe'), peX64()); writeFileSync(join(dest, 'ggml-vulkan.dll'), '') },
  })
  try {
    const preview = await installer.preview({ kind: 'github', url: 'https://github.com/example/llama.cpp/releases/tag/b1234', accel: 'vulkan' })
    expect(preview.accel).toBe('vulkan')
    expect(preview.suggestedLabel).toContain('Vulkan')
    expect(installer.confirm(preview.stageId).accel).toBe('vulkan')
    expect(calls.filter(c => c.endsWith('.zip'))).toEqual([`https://github.com/example/llama.cpp/releases/download/b1234/${bin}`])
    present = false
    await expect(installer.preview({ kind: 'github', url: 'https://github.com/example/llama.cpp/releases/tag/b1234', accel: 'vulkan' })).rejects.toMatchObject({ code: 'no-asset' })
    expect(readdirSync(join(dir, 'runtime', 'llama.cpp', 'custom')).some(n => n.startsWith('.stage-'))).toBe(false)
  } finally { installer.dispose(); reg.close() }
})
