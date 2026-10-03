// Decisions 36 / 37: CPU defaults and CPU channel version (settings v6), defaults chosen by the type of the
// runtime a launch ends up on, the automatic CUDA runtime choice, and the per-channel current version.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  currentTagFor, DEFAULT_CPU_DEFAULTS, defaultSettings, defaultsFor, normalizeModels, normalizeSettings, SETTINGS_MIGRATIONS, SETTINGS_VERSION,
  type ModelsDoc, type Settings,
} from '../../server/core/config'
import { DEFAULT_LAUNCH_DEFAULTS } from '../../server/core/args'
import { planLaunch, previewLaunch } from '../../server/core/launch'
import { installLatest, resolveLatest, versionsDir } from '../../server/core/llamacpp'
import type { RuntimeTarget } from '../../server/core/platform'
import { applyDefaults, applySettingsPatch, SettingsError } from '../../server/core/settings-admin'
import { DeleteError, RuntimeManager } from '../../server/core/runtime-manager'
import { RuntimeRegistry, type RuntimeEntry } from '../../server/core/runtimes'
import { Updater } from '../../server/core/updater'
import { sha } from '../fixtures/fake-github'

let data: string
beforeEach(() => { data = mkdtempSync(join(tmpdir(), 'lw-ch-')) })
afterEach(() => { rmSync(data, { recursive: true, force: true }) })

const cuda: RuntimeTarget = { os: 'win32', arch: 'x64', acceleration: 'cuda' }
const cpu: RuntimeTarget = { ...cuda, acceleration: 'cpu' }
const mac: RuntimeTarget = { os: 'darwin', arch: 'arm64', acceleration: 'metal' }
const install = (t: RuntimeTarget, tag: string) => {
  const dir = join(versionsDir(data), `${t.os}-${t.arch}-${t.acceleration}`, tag)
  mkdirSync(dir, { recursive: true })
  const exe = join(dir, t.os === 'win32' ? 'llama-server.exe' : 'llama-server')
  writeFileSync(exe, '')
  return exe
}

describe('settings version 6', () => {
  test('the version and the new defaults', () => {
    expect(SETTINGS_VERSION).toBe(6)
    const d = defaultSettings()
    expect(d.version).toBe(6)
    expect(d.defaultsCpu).toEqual(DEFAULT_CPU_DEFAULTS)
    expect(d.llamacpp.currentCpu).toBe('')
    expect(d.llamacpp.cudaRuntime).toBe('') // new installations choose the CUDA runtime automatically
    // The CPU defaults do not assume a GPU.
    expect(DEFAULT_CPU_DEFAULTS).toMatchObject({ gpuLayers: 0, cacheTypeK: null, cacheTypeV: null, flashAttn: null })
    expect(DEFAULT_CPU_DEFAULTS.extraArgs).not.toContain('mlock')
    expect(DEFAULT_LAUNCH_DEFAULTS.extraArgs).toContain('mlock') // the GPU defaults are exactly as before
  })

  test('migration 5 -> 6 only adds what is missing; the old default CUDA runtime 13.3 becomes automatic', () => {
    const old = {
      version: 5, defaults: { ctxSize: 4096, extraArgs: '--x' }, llamacpp: { cudaRuntime: '13.3', current: 'b300', keepVersions: 3, autoUpdate: false, acceleration: 'cuda' },
    }
    const next = SETTINGS_MIGRATIONS[5]!(structuredClone(old))
    expect(next.defaults).toEqual(old.defaults)
    expect(next.llamacpp).toEqual({ ...old.llamacpp, cudaRuntime: '', currentCpu: '' })
    expect(next.defaultsCpu).toEqual(DEFAULT_CPU_DEFAULTS)
    const doc = normalizeSettings({ ...defaultSettings(), ...next })
    expect(doc.llamacpp).toMatchObject({ cudaRuntime: '', current: 'b300', currentCpu: '', keepVersions: 3, autoUpdate: false })
    expect(doc.defaults).toMatchObject({ ctxSize: 4096, extraArgs: '--x' })
  })

  test('a CUDA runtime typed by hand (anything but the old default) stays as the override', () => {
    expect(SETTINGS_MIGRATIONS[5]!({ llamacpp: { cudaRuntime: '12.4' } }).llamacpp.cudaRuntime).toBe('12.4')
  })

  test('a CPU-only installation keeps its version as the CPU channel one; existing values are never overwritten', () => {
    expect(SETTINGS_MIGRATIONS[5]!({ llamacpp: { acceleration: 'cpu', current: 'b200' } }).llamacpp.currentCpu).toBe('b200')
    expect(SETTINGS_MIGRATIONS[5]!({ llamacpp: { acceleration: 'cuda', current: 'b200' } }).llamacpp.currentCpu).toBe('')
    const keep = SETTINGS_MIGRATIONS[5]!({ llamacpp: { currentCpu: 'b9' }, defaultsCpu: { ctxSize: 1 } })
    expect(keep.llamacpp.currentCpu).toBe('b9')
    expect(keep.defaultsCpu).toEqual({ ctxSize: 1 })
    expect(SETTINGS_MIGRATIONS[5]!({}).llamacpp.currentCpu).toBe('') // no llamacpp section at all
    // a CPU-only installation keeps the launch parameters it had; the others get the built-in CPU set
    const custom = { ...DEFAULT_LAUNCH_DEFAULTS, ctxSize: 4096, threads: 8, extraArgs: '--jinja --no-warmup' }
    const cpuUser = normalizeSettings(SETTINGS_MIGRATIONS[5]!({ llamacpp: { acceleration: 'cpu', current: 'b200' }, defaults: custom }))
    expect(defaultsFor(cpuUser, { os: 'win32' }, 'cpu')).toMatchObject({ ctxSize: 4096, threads: 8, extraArgs: '--jinja --no-warmup' })
    const cudaUser = normalizeSettings(SETTINGS_MIGRATIONS[5]!({ llamacpp: { acceleration: 'cuda' }, defaults: custom }))
    expect(defaultsFor(cudaUser, { os: 'win32' }, 'cpu')).toMatchObject({ ctxSize: DEFAULT_CPU_DEFAULTS.ctxSize, extraArgs: DEFAULT_CPU_DEFAULTS.extraArgs })
    expect(defaultsFor(cudaUser, { os: 'win32' }, 'cuda')).toMatchObject({ ctxSize: 4096 })
  })

  test('the whole chain from version 1 reaches 6 and normalizes', () => {
    let doc: any = { version: 1, public: { enabled: false, port: 8080, domain: '' } }
    for (let v = 1; v < SETTINGS_VERSION; v++) doc = SETTINGS_MIGRATIONS[v]!(doc)
    const s = normalizeSettings(doc)
    expect(s.defaultsCpu).toEqual(DEFAULT_CPU_DEFAULTS)
    expect(s.llamacpp.acceleration).toBe('cuda') // old installations are Windows CUDA
  })

  test('a hand-edited defaultsCpu with missing keys is filled from the built-in values', () => {
    const s = normalizeSettings({ ...defaultSettings(), defaultsCpu: { ctxSize: 8192 } } as never)
    expect(s.defaultsCpu).toEqual({ ...DEFAULT_CPU_DEFAULTS, ctxSize: 8192 })
  })
})

describe('current version and defaults by channel', () => {
  const s = (): Settings => ({ ...defaultSettings(), llamacpp: { ...defaultSettings().llamacpp, current: 'b300', currentCpu: 'b200' }, defaultsCpu: { ...DEFAULT_CPU_DEFAULTS, ctxSize: 1111 } })
  test('Windows has a CPU channel with its own version and defaults; a Mac has one of each', () => {
    expect(currentTagFor(s(), { os: 'win32' }, 'cuda')).toBe('b300')
    expect(currentTagFor(s(), { os: 'win32' }, 'cpu')).toBe('b200')
    expect(currentTagFor(s(), { os: 'darwin' }, 'cpu')).toBe('b300') // Intel Mac: the only channel
    expect(currentTagFor(s(), { os: 'darwin' }, 'metal')).toBe('b300')
    expect(defaultsFor(s(), { os: 'win32' }, 'cpu').ctxSize).toBe(1111)
    expect(defaultsFor(s(), { os: 'win32' }, 'cuda').ctxSize).toBe(s().defaults.ctxSize)
    expect(defaultsFor(s(), { os: 'darwin' }, 'cpu').ctxSize).toBe(s().defaults.ctxSize)
  })
})

describe('launch picks the defaults of the runtime it ends up on', () => {
  const models = (modelRuntime?: string, profileRuntime?: string): ModelsDoc => normalizeModels({
    version: 1,
    models: [{
      id: 'm', name: 'M', backend: 'llama-server', file: { dirId: 'main', rel: 'm.gguf' }, mmproj: null, draft: null, activeProfile: 'default',
      ...(modelRuntime ? { runtime: modelRuntime } : {}),
      profiles: { default: { overrides: {}, extraArgs: '', ...(profileRuntime ? { runtime: profileRuntime } : {}) } },
    }],
  })
  const settings = (): Settings => ({
    ...defaultSettings(),
    modelDirs: [{ id: 'main', path: join(data, 'models'), enabled: true, maxDepth: 2 }],
    llamacpp: { ...defaultSettings().llamacpp, current: 'b300', currentCpu: 'b200' },
    defaults: { ...DEFAULT_LAUNCH_DEFAULTS, ctxSize: 65536, extraArgs: '--gpu-flag' },
    defaultsCpu: { ...DEFAULT_CPU_DEFAULTS, ctxSize: 4096, extraArgs: '--cpu-flag' },
  })
  const input = (m: ModelsDoc, target: RuntimeTarget = cuda) => ({
    dataDir: data, settings: settings(), models: m, host: '127.0.0.1', target, platform: target.os,
    runtimeEnv: { dataDir: data, target, entries: [] as RuntimeEntry[] }, exists: (p: string) => p.endsWith('.gguf') || existsSync(p),
  })
  const run = (m: ModelsDoc, target?: RuntimeTarget) => planLaunch({ modelId: 'm', profile: 'default' }, input(m, target))
  const has = (args: string[], flag: string, value?: string) => {
    const i = args.indexOf(flag)
    return i >= 0 && (value === undefined || args[i + 1] === value)
  }

  test('a GPU build gets the GPU defaults; a profile that picks a CPU build gets the CPU ones', () => {
    install(cuda, 'b300'); install(cpu, 'b200')
    const gpu = run(models()).args(7100)
    expect(has(gpu, '--ctx-size', '65536') && gpu.includes('--gpu-flag') && !gpu.includes('--cpu-flag')).toBe(true)
    const p = run(models(undefined, 'cpu:b200'))
    const a = p.args(7100)
    expect(p.runtime).toMatchObject({ ref: 'cpu:b200', accel: 'cpu' })
    expect(has(a, '--ctx-size', '4096') && has(a, '--n-gpu-layers', '0') && a.includes('--cpu-flag') && !a.includes('--gpu-flag')).toBe(true)
    expect(a).not.toContain('--cache-type-k')
    expect(a).not.toContain('--flash-attn')
  })

  test('the model\'s own choice counts too, and the profile\'s wins over the model\'s', () => {
    install(cuda, 'b300'); install(cpu, 'b200')
    expect(has(run(models('cpu:b200')).args(1), '--ctx-size', '4096')).toBe(true)
    expect(has(run(models('cpu:b200', 'cuda:b300')).args(1), '--ctx-size', '65536')).toBe(true)
  })

  test('a missing reference falls back inside its own channel, and the defaults follow the fallback', () => {
    install(cuda, 'b300'); install(cpu, 'b210')
    const p = run(models('cpu:b1'))
    expect(p.runtime).toMatchObject({ ref: 'cpu:b210', accel: 'cpu', fallback: { from: 'cpu:b1', reason: 'missing', to: 'cpu:b210' } })
    expect(has(p.args(1), '--ctx-size', '4096')).toBe(true)
  })

  test('global channel cpu: the CPU channel version and the CPU defaults, no reference needed', () => {
    const exe = install(cpu, 'b200')
    install(cpu, 'b100')
    const p = run(models(), cpu)
    expect(p.exe).toBe(exe) // currentCpu, not `current`
    expect(p.runtime).toMatchObject({ ref: null, label: 'b200', accel: 'cpu' })
    expect(has(p.args(1), '--ctx-size', '4096')).toBe(true)
  })

  test('the command preview uses the same defaults', () => {
    install(cuda, 'b300'); install(cpu, 'b200')
    const m = models()
    const form = (runtime: string | null) => ({ overrides: {}, extraArgs: '', chatTemplate: null, runtime })
    const base = { dataDir: data, settings: settings(), model: m.models[0]!, host: '127.0.0.1', target: cuda, platform: 'win32' as const, runtimeEnv: input(m).runtimeEnv, exists: (p: string) => p.endsWith('.gguf') || existsSync(p) }
    expect(previewLaunch({ ...base, form: form(null) }).effective.ctxSize).toBe(65536)
    expect(previewLaunch({ ...base, form: form('cpu:b200') }).effective).toMatchObject({ ctxSize: 4096, gpuLayers: 0 })
  })

  test('a Mac always uses the one set of defaults, whatever the build type', () => {
    const exe = install(mac, 'b300')
    const m = models()
    const p = planLaunch({ modelId: 'm', profile: 'default' }, { ...input(m, mac), runtimeEnv: { dataDir: data, target: mac, entries: [] } })
    expect(p.exe).toBe(exe)
    expect(has(p.args(1), '--ctx-size', '65536')).toBe(true)
    expect(p.runtime.accel).toBe('metal')
  })
})

// A fake release with several CUDA runtimes and a CPU build.
function release(tag: string, cudaVersions: string[], opts: { cpu?: boolean } = {}) {
  const names = [
    ...cudaVersions.flatMap(v => [`llama-${tag}-bin-win-cuda-${v}-x64.zip`, `cudart-llama-bin-win-cuda-${v}-x64.zip`]),
    ...(opts.cpu === false ? [] : [`llama-${tag}-bin-win-cpu-x64.zip`]),
  ]
  const calls: string[] = []
  const asset = (name: string) => ({ name, browser_download_url: `https://dl.test/${name}`, digest: `sha256:${sha('ZIP')}` })
  const fetchFn = async (url: string) => {
    calls.push(url)
    if (url.endsWith('/releases/latest')) return Response.json({ assets: [{ name: 'nightly-tag.txt', browser_download_url: 'https://dl.test/nightly-tag.txt' }] })
    if (url === 'https://dl.test/nightly-tag.txt') return new Response(`${tag}\n`)
    if (url.endsWith(`/releases/tags/${tag}`)) return Response.json({ assets: names.map(asset) })
    if (names.includes(url.replace('https://dl.test/', ''))) return new Response('ZIP')
    return new Response('nope', { status: 404 })
  }
  const extract = async (zip: string, dest: string) => {
    mkdirSync(dest, { recursive: true })
    writeFileSync(join(dest, zip.includes('cudart') ? 'cudart64.dll' : 'llama-server.exe'), 'x')
  }
  const downloads = () => calls.filter(c => c.endsWith('.zip'))
  return { fetchFn, extract, calls, downloads }
}

describe('automatic CUDA runtime choice', () => {
  const rel = () => release('b500', ['12.4', '13.1'])
  test('resolveLatest: the newest runtime the machine allows; a value is an override', async () => {
    const r = rel()
    expect((await resolveLatest(r.fetchFn, '', 'win32', {}, cuda, { maxMajor: 13, maxComputeCap: 12 })).bin.name).toBe('llama-b500-bin-win-cuda-13.1-x64.zip')
    expect((await resolveLatest(r.fetchFn, '', 'win32', {}, cuda, { maxMajor: 12, maxComputeCap: 8.9 })).bin.name).toBe('llama-b500-bin-win-cuda-12.4-x64.zip')
    expect((await resolveLatest(r.fetchFn, '', 'win32', {}, cuda, { maxMajor: 13, maxComputeCap: 6.1 })).cudart?.name).toBe('cudart-llama-bin-win-cuda-12.4-x64.zip')
    expect((await resolveLatest(r.fetchFn, '', 'win32', {}, cuda, null)).bin.name).toBe('llama-b500-bin-win-cuda-12.4-x64.zip') // unknown: the widely supported one
    expect((await resolveLatest(r.fetchFn, '12.4', 'win32', {}, cuda, { maxMajor: 13, maxComputeCap: 12 })).bin.name).toBe('llama-b500-bin-win-cuda-12.4-x64.zip') // override wins
  })

  test('nothing the machine can run: an explicit error, no download, nothing installed', async () => {
    const r = release('b500', ['13.1'])
    await expect(installLatest({ dataDir: data, cudaRuntime: '', cudaLimits: { maxMajor: 12, maxComputeCap: 8 }, fetch: r.fetchFn, extract: r.extract, platform: 'win32', target: cuda }))
      .rejects.toMatchObject({ code: 'no-compatible-cuda', detail: '13.1: driver-too-old' })
    expect(r.downloads()).toEqual([])
    expect(existsSync(join(versionsDir(data), 'win32-x64-cuda', 'b500'))).toBe(false)
  })

  test('the CPU channel does not use CUDA limits at all', async () => {
    const r = release('b500', ['13.1'])
    const b = await resolveLatest(r.fetchFn, '', 'win32', {}, cpu, { maxMajor: 12, maxComputeCap: 8 })
    expect(b.bin.name).toBe('llama-b500-bin-win-cpu-x64.zip')
  })
})

describe('the other channel (decision 36)', () => {
  function updater(target: RuntimeTarget, state: { current: string, autoUpdate: boolean }, r: ReturnType<typeof release>, limits = { maxMajor: 13, maxComputeCap: 12 as number | null }) {
    return new Updater({
      dataDir: data, target, platform: 'win32', fetch: r.fetchFn, extract: r.extract,
      llamacpp: () => ({ cudaRuntime: '', current: state.current, keepVersions: 2, autoUpdate: state.autoUpdate }),
      setCurrent: (t) => { state.current = t },
      cudaLimits: () => limits,
      usedExes: () => [],
    })
  }

  test('a CPU channel that was never downloaded stays untouched by the startup rule (the caller only runs an installed channel)', () => {
    const state = { current: '', autoUpdate: true }
    const u = updater(cpu, state, release('b500', ['13.1']))
    expect(u.refresh()).toEqual([]) // nothing installed: the host does not call run() on its own
  })

  test('the first download is forced even with auto update off, and fills the CPU channel only', async () => {
    const r = release('b500', ['13.1'])
    const state = { current: '', autoUpdate: false }
    const u = updater(cpu, state, r)
    expect(await u.run()).toEqual({ state: 'disabled' }) // not forced: auto update off means no download
    expect(r.calls).toEqual([])
    const st = await u.run({ force: true })
    expect(st).toMatchObject({ state: 'ready', tag: 'b500', note: 'updated' })
    expect(state.current).toBe('b500')
    expect(existsSync(join(versionsDir(data), 'win32-x64-cpu', 'b500', 'llama-server.exe'))).toBe(true)
    expect(existsSync(join(versionsDir(data), 'win32-x64-cuda'))).toBe(false)
    expect(r.downloads()).toEqual(['https://dl.test/llama-b500-bin-win-cpu-x64.zip'])
  })

  test('once installed, the channel follows new releases like the main one', async () => {
    const state = { current: 'b400', autoUpdate: true }
    install(cpu, 'b400')
    const r = release('b500', ['13.1'])
    const u = updater(cpu, state, r)
    expect(u.refresh()).toEqual(['b400'])
    expect(await u.run()).toMatchObject({ state: 'ready', tag: 'b500', note: 'updated', from: 'b400' })
    expect(state.current).toBe('b500')
  })

  test('the main CUDA channel uses the hardware limits for its download', async () => {
    const r = release('b500', ['12.4', '13.1'])
    const state = { current: '', autoUpdate: true }
    await updater(cuda, state, r, { maxMajor: 12, maxComputeCap: 8.9 }).run()
    expect(r.downloads()).toEqual(['https://dl.test/llama-b500-bin-win-cuda-12.4-x64.zip', 'https://dl.test/cudart-llama-bin-win-cuda-12.4-x64.zip'])
  })

  test('an unusable CUDA release ends as an error status that names the reason', async () => {
    const r = release('b500', ['13.1'])
    const u = updater(cuda, { current: '', autoUpdate: true }, r, { maxMajor: 12, maxComputeCap: 8.9 })
    expect(await u.run()).toMatchObject({ state: 'error', code: 'no-compatible-cuda', detail: '13.1: driver-too-old' })
    expect(r.downloads()).toEqual([])
  })
})

describe('RuntimeManager with two channels', () => {
  function setup(target: RuntimeTarget = cuda, s0: Partial<Settings['llamacpp']> = {}) {
    const registry = new RuntimeRegistry(data)
    let settings: Settings = { ...defaultSettings(), llamacpp: { ...defaultSettings().llamacpp, ...s0 } }
    const set: Array<[string, string]> = []
    const mgr = new RuntimeManager({
      dataDir: data, target, registry, getSettings: () => settings, getModels: () => ({ version: 1, models: [] }), usedExes: () => [],
      setCurrent: (tag, accel) => {
        set.push([tag, accel])
        settings = { ...settings, llamacpp: { ...settings.llamacpp, ...(accel === 'cpu' && target.os === 'win32' ? { currentCpu: tag } : { current: tag }) } }
      },
      updateModels: () => {},
    })
    return { mgr, set }
  }

  test('each channel marks its own current version', () => {
    install(cuda, 'b300'); install(cuda, 'b100'); install(cpu, 'b250'); install(cpu, 'b50')
    const { mgr } = setup(cuda, { current: 'b100', currentCpu: 'b50' })
    expect(mgr.list().rows.map(r => [r.ref, r.current])).toEqual([['cuda:b300', false], ['cuda:b100', true], ['cpu:b250', false], ['cpu:b50', true]])
  })

  test('deleting the current version of the CPU channel moves that channel to its newest official build', () => {
    install(cuda, 'b300'); install(cpu, 'b250'); install(cpu, 'b50')
    const { mgr, set } = setup(cuda, { current: 'b300', currentCpu: 'b50' })
    expect(mgr.plan('cpu:b50')).toMatchObject({ isCurrent: true, becomesCurrent: 'b250', needsConfirm: true })
    mgr.remove('cpu:b50', { confirm: true })
    expect(set).toEqual([['b250', 'cpu']])
  })

  test('deleting a version that is not the channel\'s current one changes nothing about the current versions', () => {
    install(cuda, 'b300'); install(cuda, 'b100'); install(cpu, 'b100'); install(cpu, 'b250')
    // `current` = cuda b300; the cpu channel's current is b250: cpu:b100 is neither.
    const { mgr, set } = setup(cuda, { current: 'b300', currentCpu: 'b250' })
    expect(mgr.plan('cpu:b100').isCurrent).toBe(false)
    mgr.remove('cpu:b100')
    mgr.remove('cuda:b100')
    expect(set).toEqual([])
  })

  test('useCurrent switches one channel; a version of another channel or a missing one is refused', () => {
    install(cuda, 'b300'); install(cpu, 'b250'); install(cpu, 'b50')
    const { mgr, set } = setup(cuda, { current: 'b300', currentCpu: 'b250' })
    mgr.useCurrent('cpu', 'b50')
    expect(set).toEqual([['b50', 'cpu']])
    const code = (fn: () => void) => { try { fn() } catch (e) { return e instanceof DeleteError ? e.code : 'other' } return 'none' }
    expect(code(() => mgr.useCurrent('cpu', 'b300'))).toBe('not-found') // b300 exists only for CUDA
    expect(code(() => mgr.useCurrent('cpu', '../x'))).toBe('bad-ref')
    expect(code(() => mgr.useCurrent('metal', 'b50'))).toBe('not-found') // not a channel of this host
    expect(set.length).toBe(1)
  })

  test('a Mac has one channel and one current version', () => {
    install(mac, 'b9'); install(mac, 'b5')
    const { mgr, set } = setup(mac, { current: 'b5' })
    expect(mgr.list().rows.map(r => [r.ref, r.current])).toEqual([['metal:b9', false], ['metal:b5', true]])
    expect(() => mgr.useCurrent('cpu', 'b9')).toThrow() // no such channel here
    mgr.useCurrent('metal', 'b9')
    expect(set).toEqual([['b9', 'metal']])
  })
})

describe('saving the CPU defaults', () => {
  const win = { os: 'win32' as const }
  test('the CPU defaults are saved like the GPU ones, separately', () => {
    const s = defaultSettings()
    applyDefaults(s, { ctxSize: 2048, extraArgs: '--jinja' }, 'defaultsCpu')
    expect(s.defaultsCpu).toMatchObject({ ctxSize: 2048, extraArgs: '--jinja', gpuLayers: 0 })
    expect(s.defaults.ctxSize).toBe(DEFAULT_LAUNCH_DEFAULTS.ctxSize)
    applySettingsPatch(s, { defaultsCpu: { ctxSize: 1024 } }, { version: 1, models: [] }, win)
    expect(s.defaultsCpu.ctxSize).toBe(1024)
  })

  test('invalid values are refused with nothing written; a Mac has no CPU defaults', () => {
    const s = defaultSettings()
    const code = (fn: () => void) => { try { fn() } catch (e) { return (e as SettingsError).code } return 'none' }
    expect(code(() => applySettingsPatch(s, { defaultsCpu: { ctxSize: {} } }, { version: 1, models: [] }, win))).toBe('bad-param')
    expect(code(() => applySettingsPatch(s, { defaultsCpu: { ctxSize: 5 } }, { version: 1, models: [] }, { os: 'darwin' }))).toBe('bad-request')
    expect(s.defaultsCpu).toEqual(DEFAULT_CPU_DEFAULTS)
  })
})
