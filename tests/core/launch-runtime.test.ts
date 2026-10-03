import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultSettings, normalizeModels, type ModelsDoc, type Settings } from '../../server/core/config'
import { LaunchConfigError, planLaunch, previewLaunch } from '../../server/core/launch'
import { versionsDir } from '../../server/core/llamacpp'
import type { RuntimeTarget } from '../../server/core/platform'
import { sanitizeForm, saveProfile, setModelRuntime, ProfileError } from '../../server/core/models-admin'
import { customDir, selectableHere, type RuntimeEntry, type RuntimeEnv } from '../../server/core/runtimes'

let data: string
beforeEach(() => { data = mkdtempSync(join(tmpdir(), 'lw-lr-')) })
afterEach(() => { rmSync(data, { recursive: true, force: true }) })

const win: RuntimeTarget = { os: 'win32', arch: 'x64', acceleration: 'cuda' }
const install = (t: RuntimeTarget, tag: string) => {
  const dir = join(versionsDir(data), `${t.os}-${t.arch}-${t.acceleration}`, tag)
  mkdirSync(dir, { recursive: true })
  const exe = join(dir, 'llama-server.exe')
  writeFileSync(exe, '')
  return exe
}
const entry = (id: string, over: Partial<RuntimeEntry> = {}): RuntimeEntry => ({
  id, label: 'my build', source: { kind: 'dir', from: 'X:\\src' }, os: 'win32', arch: 'x64', accel: 'cuda', tag: '', addedAt: '', ...over,
})
const custom = (e: RuntimeEntry) => {
  mkdirSync(customDir(data, e.id), { recursive: true })
  const exe = join(customDir(data, e.id), 'llama-server.exe')
  writeFileSync(exe, '')
  return exe
}

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
  llamacpp: { ...defaultSettings().llamacpp, current: 'b300' },
})
const input = (m: ModelsDoc, entries: RuntimeEntry[] = []) => {
  const runtimeEnv: RuntimeEnv = { dataDir: data, target: win, entries }
  return { dataDir: data, settings: settings(), models: m, host: '127.0.0.1', target: win, platform: 'win32' as const, runtimeEnv, exists: (p: string) => p.endsWith('.gguf') || existsSync(p) } // the model file itself is not under test
}
const plan = (m: ModelsDoc, entries: RuntimeEntry[] = []) => planLaunch({ modelId: 'm', profile: 'default' }, input(m, entries))

describe('planLaunch follows the runtime reference', () => {
  test('no reference: the global current version, exactly as before', () => {
    const exe = install(win, 'b300')
    install(win, 'b200')
    const p = plan(models())
    expect(p.exe).toBe(exe)
    expect(p.runtime).toEqual({ ref: null, label: 'b300', fallback: null })
  })
  test('model reference, and the profile reference wins over it', () => {
    install(win, 'b300')
    const b200 = install(win, 'b200')
    const b100 = install(win, 'b100')
    expect(plan(models('cuda:b200')).exe).toBe(b200)
    expect(plan(models('cuda:b200', 'cuda:b100')).exe).toBe(b100)
    expect(plan(models('cuda:b200', 'cuda:b100')).runtime).toEqual({ ref: 'cuda:b100', label: 'b100', fallback: null })
  })
  test('a hand-added build', () => {
    install(win, 'b300')
    const e = entry('r1')
    const exe = custom(e)
    const p = plan(models('custom:r1'), [e])
    expect(p.exe).toBe(exe)
    expect(p.runtime).toEqual({ ref: 'custom:r1', label: 'my build', fallback: null })
  })
  test('the CPU channel build is used when asked for, although the global channel is CUDA', () => {
    install(win, 'b300')
    const cpu = install({ ...win, acceleration: 'cpu' }, 'b250')
    expect(plan(models(undefined, 'cpu:b250')).exe).toBe(cpu)
  })
  test('missing version: newest official of the same channel, reported, saved configuration untouched', () => {
    install(win, 'b300')
    const newest = install(win, 'b350')
    const m = models('cuda:b1')
    const p = plan(m)
    expect(p.exe).toBe(newest)
    expect(p.runtime.fallback).toEqual({ from: 'cuda:b1', reason: 'missing', to: 'cuda:b350' })
    expect(m.models[0]!.runtime).toBe('cuda:b1')
  })
  test('another platform / deleted hand-added build fall back the same way', () => {
    const exe = install(win, 'b300')
    expect(plan(models('metal:b9')).runtime.fallback?.reason).toBe('other-platform')
    expect(plan(models('custom:rgone')).runtime.fallback?.reason).toBe('missing')
    const mac = entry('r2', { os: 'darwin', arch: 'arm64', accel: 'metal' })
    const p = plan(models(undefined, 'custom:r2'), [mac])
    expect(p.exe).toBe(exe)
    expect(p.runtime.fallback).toEqual({ from: 'custom:r2', reason: 'other-platform', to: 'cuda:b300' })
  })
  test('the channel has no official build: the launch fails as no-runtime (download first)', () => {
    let code = 'none'
    try { plan(models('cuda:b1')) } catch (e) { code = e instanceof LaunchConfigError ? e.code : 'other' }
    expect(code).toBe('no-runtime')
  })
})

describe('previewLaunch shows the build that runs', () => {
  const form = (runtime?: string | null) => ({ overrides: {}, extraArgs: '', chatTemplate: null, ...(runtime === undefined ? {} : { runtime }) })
  test('unsaved selection from the form is previewed, with the fallback marked', () => {
    install(win, 'b300')
    const b200 = install(win, 'b200')
    const m = models()
    const ok = previewLaunch({ ...input(m), model: m.models[0]!, form: form('cuda:b200') })
    expect(ok.runtime).toEqual({ ref: 'cuda:b200', label: 'b200', fallback: null })
    expect(ok.command).toContain(b200)
    const fb = previewLaunch({ ...input(m), model: m.models[0]!, form: form('cuda:b5') })
    expect(fb.runtime.fallback).toMatchObject({ from: 'cuda:b5', reason: 'missing', to: 'cuda:b300' })
    expect(fb.missing).not.toContain('runtime')
  })
  test('the model-level reference is used when the form has none; no official build reports "runtime" as missing', () => {
    const m = models('cuda:b9')
    const p = previewLaunch({ ...input(m), model: m.models[0]!, form: form() })
    expect(p.missing).toContain('runtime')
    expect(p.command.startsWith('llama-server.exe ')).toBe(true)
  })
})

describe('saving a choice', () => {
  test('sanitizeForm / saveProfile / setModelRuntime accept references of this computer only', () => {
    const m = models()
    const env = { target: win, entries: [entry('r1'), entry('r2', { os: 'darwin', arch: 'arm64', accel: 'metal' })] }
    const ok = (ref: string) => selectableHere(ref, env)
    expect(sanitizeForm({ overrides: {}, extraArgs: '', runtime: '' }).runtime).toBeNull()
    expect(sanitizeForm({ overrides: {}, extraArgs: '' }).runtime).toBeUndefined()
    expect(() => sanitizeForm({ overrides: {}, extraArgs: '', runtime: 'garbage' })).toThrow(ProfileError)
    expect(() => sanitizeForm({ overrides: {}, extraArgs: '', runtime: 5 })).toThrow(ProfileError)

    saveProfile(m, 'm', 'default', { overrides: {}, extraArgs: '', chatTemplate: null, runtime: 'custom:r1' }, [], ok)
    expect(m.models[0]!.profiles.default!.runtime).toBe('custom:r1')
    saveProfile(m, 'm', 'default', { overrides: {}, extraArgs: '', chatTemplate: null }, [], ok) // not in the form: unchanged
    expect(m.models[0]!.profiles.default!.runtime).toBe('custom:r1')
    expect(() => saveProfile(m, 'm', 'default', { overrides: {}, extraArgs: '', chatTemplate: null, runtime: 'custom:r2' }, [], ok)).toThrow(ProfileError)
    expect(() => saveProfile(m, 'm', 'default', { overrides: {}, extraArgs: '', chatTemplate: null, runtime: 'metal:b1' }, [], ok)).toThrow(ProfileError)
    saveProfile(m, 'm', 'default', { overrides: {}, extraArgs: '', chatTemplate: null, runtime: null }, [], ok)
    expect(m.models[0]!.profiles.default!.runtime).toBeUndefined()

    setModelRuntime(m, 'm', 'cuda:b100', ok)
    expect(m.models[0]!.runtime).toBe('cuda:b100')
    expect(() => setModelRuntime(m, 'm', 'custom:r2', ok)).toThrow(ProfileError)
    setModelRuntime(m, 'm', null, ok)
    expect(m.models[0]!.runtime).toBeUndefined()
  })
  test('models.json: a non-string runtime is dropped on load; old files without the field work unchanged', () => {
    const doc = normalizeModels({ version: 1, models: [{ id: 'x', runtime: 5, profiles: { a: { overrides: {}, extraArgs: '', runtime: {} } } }] } as never)
    expect(doc.models[0]!.runtime).toBeUndefined()
    expect(doc.models[0]!.profiles.a!.runtime).toBeUndefined()
  })
})
