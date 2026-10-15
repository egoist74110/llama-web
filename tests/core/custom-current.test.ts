import { afterEach, beforeEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { customCurrentChannel, currentTagFor, defaultModels, defaultSettings, type ModelsDoc } from '../../server/core/config'
import { chooseExe, LaunchConfigError, planLaunch } from '../../server/core/launch'
import { installedDir, versionsDir } from '../../server/core/llamacpp'
import { RuntimeManager } from '../../server/core/runtime-manager'
import { customDir, isSafeExeName, normalizeRuntimes, RuntimeRegistry, type RuntimeEntry } from '../../server/core/runtimes'
import type { RuntimeTarget } from '../../server/core/platform'
import { Updater } from '../../server/core/updater'
import { fakeExtract, fakeGithub } from '../fixtures/fake-github'

let dir: string
const closers: Array<() => unknown> = []
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'lw-custom-current-')) })
afterEach(async () => { for (const close of closers.splice(0)) await close(); rmSync(dir, { recursive: true, force: true }) })
const win: RuntimeTarget = { os: 'win32', arch: 'x64', acceleration: 'cpu', gpuChannel: 'vulkan' }
const entry = (id: string, over: Partial<RuntimeEntry> = {}): RuntimeEntry => ({ id, label: 'Fork build', os: 'win32', arch: 'x64', accel: 'rocm', exe: '自定义 server (1).exe', tag: '', source: { kind: 'exe', from: 'X:\\build' }, addedAt: '', ...over })
function setup(target: RuntimeTarget = win) {
  const settings = defaultSettings()
  let models: ModelsDoc = defaultModels()
  const registry = new RuntimeRegistry(dir)
  closers.push(() => registry.close())
  const setCurrent = (tag: string, accel: string) => {
    if (accel === 'cpu' && target.os === 'win32') settings.llamacpp.currentCpu = tag
    else if (accel === 'vulkan') settings.llamacpp.currentVulkan = tag
    else settings.llamacpp.current = tag
  }
  const used: string[] = []
  const manager = new RuntimeManager({ dataDir: dir, target, registry, getSettings: () => settings, getModels: () => models, usedExes: () => used, setCurrent,
    updateModels: fn => { const next = structuredClone(models); fn(next); models = next },
  })
  const register = (e: RuntimeEntry) => {
    registry.add(e); mkdirSync(customDir(dir, e.id), { recursive: true }); const exe = join(customDir(dir, e.id), e.exe ?? 'llama-server.exe'); writeFileSync(exe, 'binary'); return exe
  }
  const official = (tag: string, accel: RuntimeTarget['acceleration']) => {
    const dest = installedDir(dir, tag, { ...target, acceleration: accel }); mkdirSync(dest, { recursive: true }); writeFileSync(join(dest, target.os === 'win32' ? 'llama-server.exe' : 'llama-server'), 'binary')
    return join(dest, target.os === 'win32' ? 'llama-server.exe' : 'llama-server')
  }
  return { settings, manager, registry, setCurrent, register, official, used }
}

test('one pure helper selects CPU vs the active GPU channel on Windows, and the single channel on Mac', () => {
  for (const accel of ['cuda', 'vulkan', 'sycl', 'rocm', 'metal']) {
    expect(customCurrentChannel(win, accel)).toBe('vulkan')
    expect(customCurrentChannel({ ...win, gpuChannel: 'cuda' }, accel)).toBe('cuda')
  }
  expect(customCurrentChannel(win, 'cpu')).toBe('cpu')
  for (const accel of ['cpu', 'metal', 'cuda']) expect(customCurrentChannel({ os: 'darwin', acceleration: 'metal' }, accel)).toBe('metal')
})

test('custom current resolves its renamed executable, model/profile still overrides; missing global falls back in its saved channel', () => {
  const s = setup({ ...win, acceleration: 'vulkan' })
  const e = entry('fork'), exe = s.register(e)
  s.manager.useCurrent('vulkan', 'custom:fork')
  expect(s.settings.llamacpp.currentVulkan).toBe('custom:fork')
  const input = { dataDir: dir, settings: s.settings, target: { ...win, acceleration: 'vulkan' as const }, runtimeEnv: s.manager.env() }
  expect(chooseExe('', input)).toEqual({ exe, runtime: { ref: 'custom:fork', label: e.label, accel: 'rocm', fallback: null } })
  const official = s.official('b100', 'vulkan')
  expect(chooseExe('vulkan:b100', input).exe).toBe(official)
  rmSync(customDir(dir, e.id), { recursive: true })
  expect(chooseExe('', input)).toEqual({ exe: official, runtime: { ref: 'vulkan:b100', label: 'b100', accel: 'vulkan', fallback: { from: 'custom:fork', reason: 'missing', to: 'vulkan:b100' } } })
  expect(s.settings.llamacpp.currentVulkan).toBe('custom:fork')
  rmSync(installedDir(dir, 'b100', input.target), { recursive: true })
  const models: ModelsDoc = { version: 1, models: [{ id: 'm', name: 'm', backend: 'llama-server', file: { dirId: 'd', rel: 'm.gguf' }, mmproj: null, draft: null, activeProfile: 'p', profiles: { p: { overrides: {}, extraArgs: '' } } }] }
  expect(() => planLaunch({ modelId: 'm', profile: 'p' }, { ...input, models, host: '127.0.0.1' })).toThrow(LaunchConfigError)
})

test('unknown and other-platform global references fall back without changing saved settings', () => {
  const target: RuntimeTarget = { os: 'win32', arch: 'x64', acceleration: 'vulkan', gpuChannel: 'vulkan' }
  const s = setup(target)
  const exe = s.official('b9', 'vulkan')
  s.registry.add(entry('foreign', { os: 'darwin', arch: 'arm64', accel: 'metal' }))
  for (const [id, reason] of [['foreign', 'other-platform'], ['missing', 'missing']]) {
    s.settings.llamacpp.currentVulkan = `custom:${id}`
    expect(chooseExe('', { dataDir: dir, settings: s.settings, target, runtimeEnv: s.manager.env() })).toMatchObject({ exe, runtime: { fallback: { from: `custom:${id}`, reason, to: 'vulkan:b9' } } })
    expect(s.settings.llamacpp.currentVulkan).toBe(`custom:${id}`)
  }
})

test('runtime rows mark custom current and in-use; deletion falls back to newest official or clears an empty channel', () => {
  const s = setup()
  const exe = s.register(entry('fork'))
  s.manager.useCurrent('cpu', 'custom:fork')
  expect(s.settings.llamacpp.currentVulkan).toBe('custom:fork')
  s.used.push(exe)
  expect(s.manager.list().rows.find(r => r.ref === 'custom:fork')).toMatchObject({ current: true, inUse: true, deletable: false })
  expect(() => s.manager.remove('custom:fork', { confirm: true })).toThrow()
  s.used.length = 0
  s.official('b10', 'vulkan'); s.official('b20', 'vulkan')
  expect(s.manager.plan('custom:fork')).toMatchObject({ isCurrent: true, becomesCurrent: 'b20', needsConfirm: true })
  s.manager.remove('custom:fork', { confirm: true })
  expect(s.settings.llamacpp.currentVulkan).toBe('b20')
  expect(existsSync(customDir(dir, 'fork'))).toBe(false)
  const cpu = entry('cpu', { accel: 'cpu' }); s.register(cpu)
  s.manager.useCurrent('vulkan', 'custom:cpu')
  s.manager.remove('custom:cpu', { confirm: true })
  expect(s.settings.llamacpp.currentCpu).toBe('')
})

test('scheduled installation preserves custom current; explicit update switches even if latest is already installed', async () => {
  const s = setup({ ...win, acceleration: 'cuda', gpuChannel: 'cuda' })
  const e = entry('fork', { accel: 'cuda' }); s.register(e)
  s.settings.llamacpp.current = 'custom:fork'
  const gh = fakeGithub({ tag: 'b300' })
  const u = new Updater({ dataDir: dir, target: { ...win, acceleration: 'cuda', gpuChannel: 'cuda' }, platform: 'win32', fetch: gh.fetchFn, extract: fakeExtract(),
    llamacpp: () => ({ ...s.settings.llamacpp, autoUpdate: true }), usedExes: () => [], setCurrent: t => { s.settings.llamacpp.current = t }, customRuntime: r => r === 'custom:fork' ? e : undefined,
  })
  closers.unshift(() => u.stop())
  expect(await u.run()).toMatchObject({ state: 'ready', tag: 'custom:fork', label: 'Fork build', note: 'pinned', digestSource: 'github' })
  expect(s.settings.llamacpp.current).toBe('custom:fork')
  expect(await u.run({ force: true })).toMatchObject({ state: 'ready', tag: 'b300' })
  expect(s.settings.llamacpp.current).toBe('b300')
  s.settings.llamacpp.current = 'custom:fork'
  expect(u.use('custom:fork')).toBe('custom:fork')
  expect(() => u.use('custom:unknown')).toThrow()
})

test('current.post accepts registered custom builds, chooses their channel, rejects unknown/foreign, and exposes the label', async () => {
  const s = setup()
  s.register(entry('fork'))
  s.register(entry('cpu', { accel: 'cpu' }))
  s.registry.add(entry('foreign', { os: 'darwin', arch: 'arm64' }))
  const globals = globalThis as Record<string | symbol, unknown>, key = Symbol.for('llama-web.context')
  const bindings = { defineEventHandler: (f: unknown) => f, readBody: async (e: { body: unknown }) => e.body, createError: (info: unknown) => Object.assign(new Error('API error'), info) }
  const old = [...Object.keys(bindings).map(k => [k, globals[k]] as const), [key, globals[key]] as const]
  const updater = { refresh: () => [], versions: () => [], getStatus: () => ({ state: 'idle' }), getUpdateCheck: () => ({ state: 'idle' }), rollbackTarget: () => null }
  Object.assign(globals, bindings)
  globals[key] = { getSettings: () => s.settings, runtimeTarget: win, platform: win, runtimes: s.manager, updater, secondary: null }
  try {
    const route = (await import('../../server/api/llamacpp/current.post')).default
    const response = await route({ body: { tag: 'custom:fork' } } as never)
    expect(response.runtimes?.rows.find(r => r.ref === 'custom:fork')).toMatchObject({ current: true, label: 'Fork build' })
    expect(s.settings.llamacpp.currentVulkan).toBe('custom:fork')
    await route({ body: { tag: 'custom:cpu' } } as never)
    expect(currentTagFor(s.settings, win, 'cpu')).toBe('custom:cpu')
    for (const tag of ['custom:missing', 'custom:foreign']) await expect(route({ body: { tag } } as never)).rejects.toMatchObject({ statusCode: 404 })
  } finally { for (const [k, v] of old) { if (v === undefined) delete globals[k]; else globals[k] = v } }
})

test('portable executable names accept spaces, parentheses, non-ASCII and embedded dots; reject paths, control and reserved characters', () => {
  const good = ['llama server.exe', '服务端 (CUDA).exe', 'a..b.exe', 'server_1.2+cuda.exe', '-server.exe']
  const bad = ['', '..', '.', '../a', 'a/b', 'a\\b', 'bad<.exe', 'bad>.exe', 'a:b', 'a"b', 'a|b', 'a?b', 'a*b', 'a\u0000', 'a\u007f', ' file.exe', 'file.exe ', '.file', 'file.', 'a'.repeat(101)]
  for (const name of good) {
    expect(isSafeExeName(name)).toBe(true)
    expect(normalizeRuntimes({ version: 1, entries: [entry('e', { exe: name })] }).entries[0]?.exe).toBe(name)
  }
  for (const name of bad) {
    expect(isSafeExeName(name)).toBe(false)
    expect(normalizeRuntimes({ version: 1, entries: [entry('e', { exe: name })] }).entries[0]?.exe).toBeUndefined()
  }
})

test('successful add response includes selectable for this host', async () => {
  const s = setup()
  const globals = globalThis as Record<string | symbol, unknown>, key = Symbol.for('llama-web.context')
  const bindings = { defineEventHandler: (f: unknown) => f, readBody: async (e: { body: unknown }) => e.body, createError: (info: unknown) => Object.assign(new Error('API error'), info) }
  const previous = [...Object.keys(bindings).map(k => [k, globals[k]] as const), [key, globals[key]] as const]
  const e = entry('fork'); s.register(e)
  const updater = { refresh: () => [], versions: () => [], getStatus: () => ({ state: 'idle' }), getUpdateCheck: () => ({ state: 'idle' }), rollbackTarget: () => null }
  Object.assign(globals, bindings)
  globals[key] = { getSettings: () => s.settings, runtimeTarget: win, platform: win, runtimes: s.manager, updater, secondary: null, runtimeAdd: { confirm: () => e }, live: { notify: () => {} } }
  try {
    const route = (await import('../../server/api/llamacpp/add/confirm.post')).default
    expect(await route({ body: { stageId: 'preview', label: 'Fork build' } } as never)).toMatchObject({ entry: { id: 'fork' }, selectable: true })
  } finally { for (const [k, v] of previous) { if (v === undefined) delete globals[k]; else globals[k] = v } }
})
