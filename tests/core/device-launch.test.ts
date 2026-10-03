// Device choice (decision 39, package 8-3): value rules, argument assembly, resolution order
// profile <- model <- global, the Mac exception, saving and failure diagnosis.
import { describe, expect, test } from 'bun:test'
import { join, resolve } from 'node:path'
import {
  buildLaunchArgs, deviceArgs, DEFAULT_LAUNCH_DEFAULTS, normalizeDevice, paramValueOk, resolveDevice, type BuildInput, type LaunchDefaults,
} from '../../server/core/args'
import { DEFAULT_CPU_DEFAULTS, defaultSettings, hasDeviceSelection, normalizeModels, normalizeSettings, type ModelsDoc, type Settings } from '../../server/core/config'
import { classify, diagnose } from '../../server/core/errors'
import { LaunchConfigError, planLaunch, previewLaunch } from '../../server/core/launch'
import { ProfileError, sanitizeDevice, sanitizeForm, sanitizeOverrides, saveProfile, setModelDevice } from '../../server/core/models-admin'
import { applyDefaults, applySettingsPatch, SettingsError } from '../../server/core/settings-admin'

const defaults = (over: Partial<LaunchDefaults> = {}): LaunchDefaults => ({ ...DEFAULT_LAUNCH_DEFAULTS, extraArgs: '', ...over })
const build = (over: Partial<BuildInput> = {}) => buildLaunchArgs({ paths: { model: 'X:\\m.gguf' }, defaults: defaults(), host: '127.0.0.1', port: 7100, ...over })
const after = (args: string[], flag: string) => args[args.indexOf(flag) + 1]

describe('device values', () => {
  test('normalizeDevice keeps one valid value', () => {
    expect(normalizeDevice(undefined)).toBe('')
    expect(normalizeDevice(null)).toBe('')
    expect(normalizeDevice('  ')).toBe('')
    expect(normalizeDevice('AUTO')).toBe('auto')
    expect(normalizeDevice('CPU')).toBe('cpu')
    expect(normalizeDevice(' CUDA0 ')).toBe('CUDA0')
    expect(normalizeDevice('Vulkan1')).toBe('Vulkan1')
  })
  test('several devices, none, flags, spaces and wrong types are refused', () => {
    for (const bad of ['CUDA0,CUDA1', 'none', 'NONE', '--device', 'CUDA0 CUDA1', '0', 'CUDA0;rm', '"CUDA0"', 5, {}, ['CUDA0']]) {
      expect(normalizeDevice(bad)).toBeNull()
    }
  })
  test('resolveDevice takes the first non-empty layer and defaults to auto', () => {
    expect(resolveDevice(null, undefined, '')).toBe('auto')
    expect(resolveDevice('', 'CUDA1', 'CUDA0')).toBe('CUDA1')
    expect(resolveDevice('cpu', 'CUDA1', 'CUDA0')).toBe('cpu')
    expect(resolveDevice('auto', 'CUDA1')).toBe('auto') // an explicit auto overrides a lower layer's card
    expect(resolveDevice('bogus value', 'CUDA1')).toBe('CUDA1')
  })
})

describe('argument assembly', () => {
  test('auto adds nothing', () => {
    expect(build({ device: 'auto' }).args).not.toContain('--device')
    expect(build().args).not.toContain('--split-mode')
    expect(deviceArgs('auto')).toEqual([])
  })
  test('one GPU: --device <id> and --split-mode none, no main-gpu or tensor-split', () => {
    const r = build({ device: 'CUDA0' })
    expect(after(r.args, '--device')).toBe('CUDA0')
    expect(after(r.args, '--split-mode')).toBe('none')
    expect(r.args).not.toContain('--main-gpu')
    expect(r.args).not.toContain('--tensor-split')
    expect(r.args.filter(a => a === '--device')).toHaveLength(1)
    expect(r.warnings).toEqual([])
  })
  test('CPU: --device none and zero layers whatever the form says', () => {
    const r = build({ device: 'cpu', defaults: defaults({ gpuLayers: 999 }), profile: { overrides: { gpuLayers: 80 } } })
    expect(after(r.args, '--device')).toBe('none')
    expect(after(r.args, '--n-gpu-layers')).toBe('0')
    expect(r.effective.gpuLayers).toBe(0)
    expect(r.args).not.toContain('--split-mode')
  })
  test('host and port stay last and cannot be set through extra args or the device', () => {
    const r = build({ device: 'CUDA0', profile: { extraArgs: '--host 0.0.0.0 --port 1' }, port: 7101 })
    expect(r.args.slice(-4)).toEqual(['--host', '127.0.0.1', '--port', '7101'])
    expect(r.args.filter(a => a === '--host' || a === '--port')).toHaveLength(2)
    expect(r.warnings.map(w => w.code)).toEqual(['reserved-flag-removed', 'reserved-flag-removed'])
  })
  test('extra args about the device win, with a warning', () => {
    const r = build({ device: 'CUDA0', profile: { extraArgs: '-dev CUDA1 -sm layer' } })
    expect(r.args.filter(a => a === '--device' || a === '-dev')).toHaveLength(1)
    expect(r.args).toContain('CUDA1')
    expect(r.args).not.toContain('CUDA0')
    expect(r.args).not.toContain('none')
    expect(r.warnings.filter(w => w.code === 'extra-overrides-device').map(w => w.flag).sort()).toEqual(['--device', '--split-mode'])
  })
  test('multi-device extra args are warned about, selected device or not', () => {
    for (const device of ['auto', 'CUDA0']) {
      const ts = build({ device, profile: { extraArgs: '--tensor-split 3,1' } })
      expect(ts.warnings.some(w => w.code === 'extra-multi-device' && w.flag === '--tensor-split')).toBe(true)
      const multi = build({ device, profile: { extraArgs: '--device CUDA0,CUDA1' } })
      expect(multi.warnings.some(w => w.code === 'extra-multi-device' && w.flag === '--device')).toBe(true)
      const eq = build({ device, profile: { extraArgs: '--device=CUDA0,CUDA1' } })
      expect(eq.warnings.some(w => w.code === 'extra-multi-device')).toBe(true)
    }
    expect(build({ device: 'auto', profile: { extraArgs: '--device CUDA1' } }).warnings).toEqual([])
  })
})

describe('CPU tuning parameters', () => {
  test('threads, numa and cpu-mask become flags only when set', () => {
    expect(build().args).not.toContain('--threads')
    const r = build({ profile: { overrides: { threads: 8, numa: 'distribute', cpuMask: 'ff' } } })
    expect(after(r.args, '--threads')).toBe('8')
    expect(after(r.args, '--numa')).toBe('distribute')
    expect(after(r.args, '--cpu-mask')).toBe('ff')
  })
  test('extra args with the short names replace them and are reported', () => {
    const r = build({ profile: { overrides: { threads: 8, cpuMask: 'ff' }, extraArgs: '-t 4 -C f0' } })
    expect(r.args.filter(a => a === '--threads' || a === '-t')).toHaveLength(1)
    expect(after(r.args, '-t')).toBe('4')
    expect(r.warnings.filter(w => w.code === 'extra-overrides-form').map(w => w.flag).sort()).toEqual(['--cpu-mask', '--threads'])
  })
  test('value rules', () => {
    expect(paramValueOk('threads', 8)).toBe(true)
    expect(paramValueOk('threads', -1)).toBe(true)
    expect(paramValueOk('threads', '12')).toBe(true)
    for (const bad of [0.5, -2, 5000, 'many']) expect(paramValueOk('threads', bad)).toBe(false)
    for (const ok of ['distribute', 'isolate', 'numactl']) expect(paramValueOk('numa', ok)).toBe(true)
    expect(paramValueOk('numa', 'bogus')).toBe(false)
    for (const ok of ['ff', '0xFF', 'f0f0f0f0f0f0f0f0f0']) expect(paramValueOk('cpuMask', ok)).toBe(true)
    for (const bad of ['zz', '', '0x', 'ff ff', 255]) expect(paramValueOk('cpuMask', bad)).toBe(false)
    expect(paramValueOk('numa', null)).toBe(true)
    expect(paramValueOk('ctxSize', 'anything')).toBe(true)
  })
  test('the profile and settings sanitizers refuse bad values', () => {
    expect(sanitizeOverrides({ threads: 8, numa: 'isolate', cpuMask: 'ff' })).toEqual({ threads: 8, numa: 'isolate', cpuMask: 'ff' })
    expect(() => sanitizeOverrides({ numa: 'bogus' })).toThrow(ProfileError)
    expect(() => sanitizeOverrides({ cpuMask: 'zz' })).toThrow(ProfileError)
    expect(() => applyDefaults(defaultSettings(), { threads: -5 })).toThrow(SettingsError)
    const s = defaultSettings()
    applyDefaults(s, { threads: 6, numa: 'distribute' })
    expect(s.defaults.threads).toBe(6)
  })
})

// ---- resolution through planLaunch / previewLaunch ----

const root = resolve('/X')
const dataDir = join(root, 'data')
const settings = (): Settings => ({
  ...defaultSettings(),
  modelDirs: [{ id: 'main', path: join(root, 'models'), enabled: true, maxDepth: 4 }],
  llamacpp: { ...defaultSettings().llamacpp, current: 'b1234', currentCpu: 'b1234' },
})
const models = (): ModelsDoc => ({
  version: 1,
  models: [{
    id: 'm', name: 'M', backend: 'llama-server', file: { dirId: 'main', rel: 'm.gguf' }, mmproj: null, draft: null,
    activeProfile: 'a',
    profiles: { a: { overrides: {}, extraArgs: '' }, b: { overrides: {}, extraArgs: '', device: 'CUDA1' }, c: { overrides: {}, extraArgs: '', device: 'cpu' } },
  }],
})
const all = () => true
const target = (os: NodeJS.Platform, acceleration: string) => ({ os, arch: os === 'darwin' ? 'arm64' : 'x64', acceleration }) as never
const plan = (profile: string, s = settings(), m = models(), os: NodeJS.Platform = 'win32', accel = os === 'darwin' ? 'metal' : 'cuda') =>
  planLaunch({ modelId: 'm', profile }, { dataDir, settings: s, models: m, host: '127.0.0.1', exists: all, platform: os, target: target(os, accel) })

describe('planLaunch device', () => {
  test('nothing chosen: automatic, no device flags', () => {
    const p = plan('a')
    expect(p.device).toBe('auto')
    expect(p.args(7100)).not.toContain('--device')
  })
  test('profile beats model beats global', () => {
    const s = settings(); s.defaults.device = 'CUDA3'
    const m = models(); m.models[0]!.device = 'CUDA2'
    expect(plan('a', s, m).device).toBe('CUDA2')
    expect(plan('b', s, m).device).toBe('CUDA1')
    expect(plan('c', s, m).device).toBe('cpu')
    expect(plan('a', s).device).toBe('CUDA3')
  })
  test('the profile device reaches the arguments; cpu forces zero layers', () => {
    const b = plan('b').args(7100)
    expect(after(b, '--device')).toBe('CUDA1')
    expect(after(b, '--split-mode')).toBe('none')
    const c = plan('c').args(7100)
    expect(after(c, '--device')).toBe('none')
    expect(after(c, '--n-gpu-layers')).toBe('0')
    expect(c.slice(-4)).toEqual(['--host', '127.0.0.1', '--port', '7100'])
  })
  test('the global device lives in the defaults set of the runtime type that runs', () => {
    const s = settings(); s.defaults.device = 'CUDA0'
    expect(plan('a', s).device).toBe('CUDA0') // GPU build: defaults
    expect(plan('a', s, models(), 'win32', 'cpu').device).toBe('auto') // CPU build: defaultsCpu has no device
  })
  test('a Mac ignores any stored device', () => {
    const s = settings(); s.defaults.device = 'CUDA0'
    const m = models(); m.models[0]!.device = 'CUDA1'
    for (const profile of ['a', 'b', 'c']) {
      const p = plan(profile, s, m, 'darwin')
      expect(p.device).toBe('auto')
      expect(p.args(7100)).not.toContain('--device')
      expect(p.args(7100)).not.toContain('--split-mode')
    }
    expect(hasDeviceSelection({ os: 'darwin' })).toBe(false)
    expect(hasDeviceSelection({ os: 'win32' })).toBe(true)
  })
  test('LaunchConfigError carries the device-missing code', () => {
    const e = new LaunchConfigError('device-missing', 'x')
    expect(diagnose(e)?.kind).toBe('device-missing')
  })
})

describe('previewLaunch device', () => {
  const input = (device: string | null | undefined, os: NodeJS.Platform = 'win32') => ({
    dataDir, settings: settings(), model: models().models[0]!, host: '127.0.0.1', exists: all, platform: os,
    target: target(os, os === 'darwin' ? 'metal' : 'cuda'),
    form: { overrides: {}, extraArgs: '', chatTemplate: null, device },
  })
  test('shows the device in the command and in the result', () => {
    const r = previewLaunch(input('CUDA0'))
    expect(r.device).toBe('CUDA0')
    expect(r.command).toContain('--device CUDA0')
    expect(r.command).toContain('--split-mode none')
    expect(previewLaunch(input('cpu')).command).toContain('--device none')
    expect(previewLaunch(input(null)).device).toBe('auto')
  })
  test('on a Mac the preview has no device', () => {
    const r = previewLaunch(input('CUDA0', 'darwin'))
    expect(r.device).toBe('auto')
    expect(r.command).not.toContain('--device')
  })
})

describe('saving', () => {
  test('sanitizeDevice: valid values, empty clears, others are refused', () => {
    expect(sanitizeDevice('CUDA0')).toBe('CUDA0')
    expect(sanitizeDevice('CPU')).toBe('cpu')
    expect(sanitizeDevice('')).toBeNull()
    expect(sanitizeDevice(null)).toBeNull()
    expect(() => sanitizeDevice('CUDA0,CUDA1')).toThrow(ProfileError)
    expect(() => sanitizeDevice(7)).toThrow(ProfileError)
  })
  test('the profile form carries the device only when it was sent', () => {
    expect('device' in sanitizeForm({ overrides: {}, extraArgs: '' })).toBe(false)
    expect(sanitizeForm({ overrides: {}, extraArgs: '', device: 'CUDA1' }).device).toBe('CUDA1')
    expect(sanitizeForm({ overrides: {}, extraArgs: '', device: '' }).device).toBeNull()
  })
  test('saveProfile sets, keeps and clears the profile device; the host check can refuse it', () => {
    const doc = models()
    const form = (device?: string | null) => ({ overrides: {}, extraArgs: '', chatTemplate: null, ...(device === undefined ? {} : { device }) })
    saveProfile(doc, 'm', 'a', form('CUDA0'), [])
    expect(doc.models[0]!.profiles.a!.device).toBe('CUDA0')
    saveProfile(doc, 'm', 'a', form(), [])
    expect(doc.models[0]!.profiles.a!.device).toBe('CUDA0')
    saveProfile(doc, 'm', 'a', form(null), [])
    expect('device' in doc.models[0]!.profiles.a!).toBe(false)
    expect(() => saveProfile(doc, 'm', 'a', form('CUDA0'), [], undefined, () => false)).toThrow(ProfileError)
    expect('device' in doc.models[0]!.profiles.a!).toBe(false)
    saveProfile(doc, 'm', 'a', form(null), [], undefined, () => false) // clearing is always allowed
  })
  test('setModelDevice sets and clears; a Mac check refuses', () => {
    const doc = models()
    setModelDevice(doc, 'm', 'cpu')
    expect(doc.models[0]!.device).toBe('cpu')
    setModelDevice(doc, 'm', null)
    expect('device' in doc.models[0]!).toBe(false)
    expect(() => setModelDevice(doc, 'm', 'CUDA0', () => false)).toThrow(ProfileError)
    expect(() => setModelDevice(doc, 'nope', 'CUDA0')).toThrow(ProfileError)
  })
  test('global default device: valid value is stored, empty clears, bad or Mac is refused', () => {
    const s = defaultSettings()
    applyDefaults(s, { device: 'CUDA0' })
    expect(s.defaults.device).toBe('CUDA0')
    applyDefaults(s, { device: '' })
    expect('device' in s.defaults).toBe(false)
    expect(() => applyDefaults(s, { device: 'CUDA0,CUDA1' })).toThrow(SettingsError)
    expect(() => applyDefaults(s, { device: 'CUDA0' }, 'defaults', { os: 'darwin' })).toThrow(SettingsError)
    applyDefaults(s, { device: '' }, 'defaults', { os: 'darwin' }) // clearing is fine
    expect(() => applySettingsPatch(s, { defaults: { device: 'cpu' } }, { version: 1, models: [] }, { os: 'darwin' })).toThrow(SettingsError)
  })
  test('hand-edited files: a bad device is dropped on load, a valid one is kept', () => {
    const doc = models()
    doc.models[0]!.device = 'CUDA0,CUDA1'
    doc.models[0]!.profiles.a!.device = 'none'
    doc.models[0]!.profiles.b!.device = 'CUDA2'
    const n = normalizeModels(doc)
    expect('device' in n.models[0]!).toBe(false)
    expect('device' in n.models[0]!.profiles.a!).toBe(false)
    expect(n.models[0]!.profiles.b!.device).toBe('CUDA2')
    const s = defaultSettings()
    s.defaults.device = 'x y'
    s.defaultsCpu.device = 'CUDA1'
    const ns = normalizeSettings(s)
    expect('device' in ns.defaults).toBe(false)
    expect(ns.defaultsCpu.device).toBe('CUDA1')
    expect(DEFAULT_CPU_DEFAULTS.threads).toBeNull()
  })
})

describe('failure diagnosis', () => {
  test('llama-server output for an unknown device (checked on b11146) is device-missing, not unknown-arg', () => {
    const tail = ['error while handling argument "--device": invalid device: CUDA7', '', 'usage:']
    expect(classify('exited', 1, tail)).toBe('device-missing')
  })
  test('an unrelated bad argument is still unknown-arg', () => {
    expect(classify('exited', 1, ['error while handling argument "--numa": invalid value'])).toBe('unknown-arg')
  })
})
