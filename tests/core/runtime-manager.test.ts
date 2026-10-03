import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultSettings, normalizeModels, type ModelsDoc, type Settings } from '../../server/core/config'
import { listInstalled, versionsDir } from '../../server/core/llamacpp'
import type { RuntimeTarget } from '../../server/core/platform'
import { cleanupResidue } from '../../server/core/residue'
import { DeleteError, RuntimeManager } from '../../server/core/runtime-manager'
import { customDir, RuntimeRegistry, type RuntimeEntry } from '../../server/core/runtimes'
import { PidRegistry } from '../../server/core/runner'
import { Updater } from '../../server/core/updater'

let data: string
beforeEach(() => { data = mkdtempSync(join(tmpdir(), 'lw-mgr-')) })
afterEach(() => { rmSync(data, { recursive: true, force: true }) })

const win: RuntimeTarget = { os: 'win32', arch: 'x64', acceleration: 'cuda' }
const mac: RuntimeTarget = { os: 'darwin', arch: 'arm64', acceleration: 'metal' }
const exeOf = (t: RuntimeTarget) => (t.os === 'win32' ? 'llama-server.exe' : 'llama-server')
const install = (t: RuntimeTarget, tag: string) => {
  const dir = join(versionsDir(data), `${t.os}-${t.arch}-${t.acceleration}`, tag)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, exeOf(t)), '')
  return join(dir, exeOf(t))
}
const entry = (id: string, over: Partial<RuntimeEntry> = {}): RuntimeEntry => ({
  id, label: id, source: { kind: 'dir', from: 'X:\\src' }, os: 'win32', arch: 'x64', accel: 'cuda', tag: '', addedAt: '', ...over,
})
const addCustom = (reg: RuntimeRegistry, e: RuntimeEntry) => {
  reg.add(e)
  mkdirSync(customDir(data, e.id), { recursive: true })
  writeFileSync(join(customDir(data, e.id), exeOf({ ...win, os: e.os })), '')
  return join(customDir(data, e.id), exeOf({ ...win, os: e.os }))
}
const model = (id: string, runtime?: string, profiles: Record<string, string | undefined> = { default: undefined }) => ({
  id, name: id, backend: 'llama-server', file: { dirId: 'd', rel: `${id}.gguf` }, mmproj: null, draft: null, activeProfile: 'default',
  ...(runtime ? { runtime } : {}),
  profiles: Object.fromEntries(Object.entries(profiles).map(([n, r]) => [n, { overrides: {}, extraArgs: '', ...(r ? { runtime: r } : {}) }])),
})

function setup(opts: { target?: RuntimeTarget, models?: ModelsDoc, current?: string, used?: string[] } = {}) {
  const target = opts.target ?? win
  const registry = new RuntimeRegistry(data)
  let settings: Settings = { ...defaultSettings(), llamacpp: { ...defaultSettings().llamacpp, current: opts.current ?? '' } }
  let models: ModelsDoc = opts.models ?? { version: 1, models: [] }
  const used: string[] = opts.used ?? []
  let changed = 0
  const mgr = new RuntimeManager({
    dataDir: data, target, registry,
    getSettings: () => settings, getModels: () => models, usedExes: () => used,
    setCurrent: (tag) => { settings = { ...settings, llamacpp: { ...settings.llamacpp, current: tag } } },
    updateModels: (fn) => { const d = structuredClone(models); fn(d); models = normalizeModels(d) },
    onChanged: () => { changed++ },
  })
  return { mgr, registry, used, get settings() { return settings }, get models() { return models }, get changed() { return changed } }
}

const codeOf = (fn: () => unknown) => {
  try { fn() } catch (e) { return e instanceof DeleteError ? e.code : `other:${(e as Error).message}` }
  return 'none'
}

describe('list', () => {
  test('official builds per channel (newest first), hand-added builds, other-platform entries hidden', () => {
    install(win, 'b100'); install(win, 'b300'); install({ ...win, acceleration: 'cpu' }, 'b200')
    const s = setup({ current: 'b100' })
    addCustom(s.registry, entry('r1', { tag: 'b999' }))
    s.registry.add(entry('r2', { os: 'darwin', arch: 'arm64', accel: 'metal' }))
    const l = s.mgr.list()
    expect(l.hiddenOtherPlatform).toBe(1)
    expect(l.rows.map(r => [r.ref, r.current, r.latestOfficial, r.deletable])).toEqual([
      ['cuda:b300', false, true, false], ['cuda:b100', true, false, true],
      ['cpu:b200', false, true, false], ['custom:r1', false, false, true],
    ])
  })
  test('Mac lists only its own channel', () => {
    install(mac, 'b5')
    const s = setup({ target: mac })
    addCustom(s.registry, entry('r1', { os: 'win32' })) // would be a Windows entry in a copied data directory
    expect(s.mgr.list().rows.map(r => r.ref)).toEqual(['metal:b5'])
    expect(s.mgr.list().hiddenOtherPlatform).toBe(1)
  })
  test('builds in use are marked and cannot be deleted', () => {
    const exe = install(win, 'b100')
    install(win, 'b300')
    const s = setup({ used: [exe] })
    expect(s.mgr.list().rows.find(r => r.ref === 'cuda:b100')).toMatchObject({ inUse: true, deletable: false })
  })
})

describe('delete protection', () => {
  test('the newest official build of each channel cannot be deleted (and nothing changes)', () => {
    install(win, 'b100'); install(win, 'b300'); install({ ...win, acceleration: 'cpu' }, 'b50')
    const s = setup()
    expect(codeOf(() => s.mgr.remove('cuda:b300'))).toBe('latest-official')
    expect(codeOf(() => s.mgr.remove('cpu:b50', { confirm: true }))).toBe('latest-official')
    expect(listInstalled(data, 'win32', win)).toEqual(['b300', 'b100'])
  })
  test('a build in use cannot be deleted, official or hand-added', () => {
    const o = install(win, 'b100')
    install(win, 'b300')
    const s = setup({ used: [o] })
    const c = addCustom(s.registry, entry('r1'))
    s.used.push(c)
    expect(codeOf(() => s.mgr.remove('cuda:b100'))).toBe('in-use')
    expect(codeOf(() => s.mgr.remove('custom:r1', { confirm: true }))).toBe('in-use')
    expect(existsSync(o) && existsSync(c)).toBe(true)
  })
  test('unknown / invalid / other-platform references', () => {
    install(win, 'b300')
    const s = setup()
    s.registry.add(entry('r2', { os: 'darwin', arch: 'arm64', accel: 'metal' }))
    expect(codeOf(() => s.mgr.remove('nonsense'))).toBe('bad-ref')
    expect(codeOf(() => s.mgr.remove('cuda:b1'))).toBe('not-found')
    expect(codeOf(() => s.mgr.remove('metal:b300'))).toBe('not-found')
    expect(codeOf(() => s.mgr.remove('custom:r2'))).toBe('not-found') // hidden, never deleted
    expect(s.registry.list().map(e => e.id)).toEqual(['r2'])
  })
  test('a plain old version is deleted: directory gone, no trash left', () => {
    install(win, 'b100'); install(win, 'b300')
    const s = setup({ current: 'b300' })
    const plan = s.mgr.remove('cuda:b100')
    expect(plan).toMatchObject({ affected: [], needsConfirm: false })
    expect(listInstalled(data, 'win32', win)).toEqual(['b300'])
    expect(readdirSync(join(versionsDir(data), 'win32-x64-cuda'))).toEqual(['b300'])
    expect(s.changed).toBe(1)
  })
  test('models and profiles that picked it are listed; deleting needs confirmation and then clears them', () => {
    install(win, 'b100'); install(win, 'b300')
    const doc = normalizeModels({ version: 1, models: [model('a', 'cuda:b100'), model('b', undefined, { default: 'cuda:b100', fast: 'cuda:b300' }), model('c', 'cuda:b300')] })
    const s = setup({ models: doc, current: 'b300' })
    const plan = s.mgr.plan('cuda:b100')
    expect(plan.affected).toEqual([{ modelId: 'a', profile: null }, { modelId: 'b', profile: 'default' }])
    expect(plan.needsConfirm).toBe(true)
    try { s.mgr.remove('cuda:b100') } catch (e) {
      expect((e as DeleteError).code).toBe('needs-confirm')
      expect(((e as DeleteError).detail as { affected: unknown[] }).affected.length).toBe(2)
    }
    expect(existsSync(join(versionsDir(data), 'win32-x64-cuda', 'b100'))).toBe(true) // nothing happened yet
    s.mgr.remove('cuda:b100', { confirm: true })
    expect(s.models.models.map(m => [m.runtime, Object.values(m.profiles).map(p => p.runtime)])).toEqual([
      [undefined, [undefined]], [undefined, [undefined, 'cuda:b300']], ['cuda:b300', [undefined]],
    ])
  })
  test('deleting the global current version moves the global version to the newest official build (after confirmation)', () => {
    install(win, 'b100'); install(win, 'b300')
    const s = setup({ current: 'b100' })
    const plan = s.mgr.plan('cuda:b100')
    expect(plan).toMatchObject({ isCurrent: true, becomesCurrent: 'b300', needsConfirm: true })
    expect(codeOf(() => s.mgr.remove('cuda:b100'))).toBe('needs-confirm')
    s.mgr.remove('cuda:b100', { confirm: true })
    expect(s.settings.llamacpp.current).toBe('b300')
  })
  test('deleting a CPU build does not touch the global CUDA version', () => {
    install(win, 'b300'); install({ ...win, acceleration: 'cpu' }, 'b200'); install({ ...win, acceleration: 'cpu' }, 'b100')
    const s = setup({ current: 'b300' })
    expect(s.mgr.plan('cpu:b100').isCurrent).toBe(false)
    s.mgr.remove('cpu:b100')
    expect(s.settings.llamacpp.current).toBe('b300')
  })
  test('a hand-added build: directory and entry removed, references cleared', () => {
    install(win, 'b300')
    const doc = normalizeModels({ version: 1, models: [model('a', 'custom:r1')] })
    const s = setup({ models: doc })
    addCustom(s.registry, entry('r1'))
    s.mgr.remove('custom:r1', { confirm: true })
    expect(s.registry.list()).toEqual([])
    expect(existsSync(customDir(data, 'r1'))).toBe(false)
    expect(readdirSync(join(versionsDir(data), 'custom'))).toEqual([])
    expect(s.models.models[0]!.runtime).toBeUndefined()
  })
  test('files held open: renaming fails, the version stays intact and nothing else changes', () => {
    install(win, 'b100'); install(win, 'b300')
    const doc = normalizeModels({ version: 1, models: [model('a', 'cuda:b100')] })
    const registry = new RuntimeRegistry(data)
    const mgr = new RuntimeManager({
      dataDir: data, target: win, registry, getSettings: () => defaultSettings(), getModels: () => doc, usedExes: () => [],
      setCurrent: () => {}, updateModels: () => { throw new Error('must not be called') },
      rename: () => { throw new Error('EBUSY') },
    })
    expect(codeOf(() => mgr.remove('cuda:b100', { confirm: true }))).toBe('locked')
    expect(doc.models[0]!.runtime).toBe('cuda:b100')
    expect(listInstalled(data, 'win32', win)).toEqual(['b300', 'b100'])
  })
  test('a failing configuration write puts the directory back', () => {
    install(win, 'b100'); install(win, 'b300')
    const doc = normalizeModels({ version: 1, models: [model('a', 'cuda:b100')] })
    const registry = new RuntimeRegistry(data)
    const mgr = new RuntimeManager({
      dataDir: data, target: win, registry, getSettings: () => defaultSettings(), getModels: () => doc, usedExes: () => [],
      setCurrent: () => {}, updateModels: () => { throw new Error('models.json is invalid') },
    })
    expect(codeOf(() => mgr.remove('cuda:b100', { confirm: true }))).toBe('failed')
    expect(listInstalled(data, 'win32', win)).toEqual(['b300', 'b100'])
    expect(readdirSync(join(versionsDir(data), 'win32-x64-cuda')).filter(n => n.startsWith('.del-'))).toEqual([])
  })
  test('a registry write failing after the models were saved restores the model and profile references', () => {
    const doc = normalizeModels({ version: 1, models: [model('a', 'custom:r1', { default: undefined, fast: 'custom:r1' }), model('b', 'custom:r2')] })
    const s = setup({ models: doc })
    addCustom(s.registry, entry('r1')); addCustom(s.registry, entry('r2'))
    s.registry.remove = () => { throw new Error('runtimes.json is read-only') }
    expect(codeOf(() => s.mgr.remove('custom:r1', { confirm: true }))).toBe('failed')
    expect(s.models.models[0]!.runtime).toBe('custom:r1')
    expect(s.models.models[0]!.profiles.fast!.runtime).toBe('custom:r1')
    expect(s.models.models[1]!.runtime).toBe('custom:r2')
    expect(s.registry.list().map(e => e.id).sort()).toEqual(['r1', 'r2'])
    expect(existsSync(join(customDir(data, 'r1'), 'llama-server.exe'))).toBe(true)
    expect(readdirSync(join(versionsDir(data), 'custom')).filter(n => n.startsWith('.del-'))).toEqual([])
  })
  test('a settings write failing after models and registry were saved undoes both', () => {
    install(win, 'b100'); install(win, 'b300')
    let models = normalizeModels({ version: 1, models: [model('a', 'cuda:b100')] })
    const registry = new RuntimeRegistry(data)
    const mgr = new RuntimeManager({
      dataDir: data, target: win, registry, getSettings: () => ({ ...defaultSettings(), llamacpp: { ...defaultSettings().llamacpp, current: 'b100' } }), getModels: () => models, usedExes: () => [],
      setCurrent: () => { throw new Error('settings.json is read-only') },
      updateModels: (fn) => { const d = structuredClone(models); fn(d); models = normalizeModels(d) },
    })
    expect(codeOf(() => mgr.remove('cuda:b100', { confirm: true }))).toBe('failed')
    expect(models.models[0]!.runtime).toBe('cuda:b100')
    expect(listInstalled(data, 'win32', win)).toEqual(['b300', 'b100'])
  })
  test('the old flat Windows layout can be deleted too', () => {
    const flat = join(versionsDir(data), 'b50')
    mkdirSync(flat, { recursive: true })
    writeFileSync(join(flat, 'llama-server.exe'), '')
    install(win, 'b300')
    const s = setup()
    s.mgr.remove('cuda:b50')
    expect(existsSync(flat)).toBe(false)
  })
})

describe('automatic pruning keeps what models picked', () => {
  test('protectedTags covers model and profile choices of the managed channel only', () => {
    const doc = normalizeModels({ version: 1, models: [model('a', 'cuda:b100', { default: 'cuda:b200', x: 'cpu:b300' }), model('b', 'custom:r1')] })
    const s = setup({ models: doc })
    expect([...s.mgr.protectedTags()].sort()).toEqual(['b100', 'b200'])
    expect([...s.mgr.protectedTags('cpu')]).toEqual(['b300'])
  })
  test('Updater.prune leaves a picked old version and never touches hand-added builds', () => {
    for (const t of ['b1', 'b2', 'b3', 'b4']) install(win, t)
    const doc = normalizeModels({ version: 1, models: [model('a', 'cuda:b1')] })
    const s = setup({ models: doc, current: 'b4' })
    addCustom(s.registry, entry('r1'))
    const up = new Updater({
      dataDir: data, target: win, llamacpp: () => ({ cudaRuntime: '13.3', current: 'b4', keepVersions: 2, autoUpdate: false }),
      setCurrent: () => {}, usedExes: () => [], protect: () => s.mgr.protectedTags(),
    })
    up.prune()
    expect(listInstalled(data, 'win32', win)).toEqual(['b4', 'b3', 'b1'])
    expect(existsSync(customDir(data, 'r1'))).toBe(true)
  })
})

describe('residue cleanup still only kills processes under data/runtime (custom/ included)', () => {
  test('a hand-added build under data/runtime is cleaned, the user own llama-server is not', async () => {
    const reg = new PidRegistry(join(data, 'pids.json'))
    const ours = join(customDir(data, 'r1'), 'llama-server.exe')
    const theirs = 'C:\\tools\\llama-server.exe'
    const rec = (pid: number, exe: string) => ({ pid, exe, port: 7100, tag: 'm:default', startedAt: '2026-01-01T00:00:00Z', birth: `b${pid}` })
    reg.add(rec(1, ours))
    reg.add(rec(2, theirs))
    const killed: number[] = []
    await cleanupResidue(reg, join(data, 'runtime'), {
      platform: process.platform,
      isAlive: () => true,
      identities: async pids => new Map(reg.list().filter(r => pids.includes(r.pid)).map(r => [r.pid, { exe: r.exe, birth: r.birth! }])),
      getExePaths: async () => new Map([[1, ours], [2, theirs]]),
      killTree: async (pid) => { killed.push(pid) },
    })
    expect(killed).toEqual(process.platform === 'win32' ? [1] : []) // POSIX path semantics differ for the Windows-style test paths
  })
})
